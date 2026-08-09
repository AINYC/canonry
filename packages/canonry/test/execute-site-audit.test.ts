import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteAuditPages,
  siteAuditSnapshots,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlEventReceipts,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'

// The executor is intentionally tested at the event boundary.  The audit
// engine has its own HTTP/BFS suite; Canonry owns receipt, graph, and publish
// semantics.
vi.mock('@canonry/aeo-audit', () => ({ runSiteCrawl: vi.fn() }))
vi.mock('@ainyc/canonry-api-routes', () => ({ resolveWebhookTarget: vi.fn().mockResolvedValue({ ok: true }) }))
import { runSiteCrawl } from '@canonry/aeo-audit'
import {
  clampSiteAuditLimit,
  computeFactorAverages,
  executeSiteAudit,
  SITE_AUDIT_DEFAULT_PAGE_LIMIT,
  SITE_AUDIT_MAX_PAGE_LIMIT,
} from '../src/execute-site-audit.js'

const NOW = '2026-08-08T00:00:00.000Z'

function scoredFactor(id: string, name: string, weight: number, score: number) {
  return { id, name, weight, score, findings: [], recommendations: [] }
}

function page(key: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    requestedUrl: url,
    finalUrl: url,
    state: 'html',
    depth: key === 'page:root' ? 0 : 1,
    provenance: { discoveredFrom: [], sitemapSources: [], root: key === 'page:root' },
    statusCode: 200,
    contentType: 'text/html',
    redirectChain: [],
    canonicalUrl: url,
    metaRobots: [],
    xRobots: [],
    path: new URL(url).pathname,
    directory: '/',
    indexability: { state: 'indexable', reasons: [], rulesetVersion: '1.0.0' },
    audit: {
      url,
      finalUrl: url,
      auditedAt: NOW,
      overallScore: 88,
      factors: [scoredFactor('sd', 'Structured Data', 12, 88)],
    },
    error: null,
    metrics: {
      inbound: { totalOccurrences: 0, uniqueEdges: 0 },
      outbound: { totalOccurrences: 0, uniqueEdges: 0 },
      shortestFollowableAnchorDepth: key === 'page:root' ? 0 : 1,
      linkScoreRaw: 0.5,
      linkScore: 100,
    },
    ...overrides,
  }
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    crawlSchemaVersion: '1.0',
    engineVersion: '4.5.0',
    crawlEngineVersion: '1.0.0',
    urlNormalizationVersion: '1.0.0',
    indexabilityRulesetVersion: '1.0.0',
    linkScoreAlgorithmVersion: 'pagerank-1.0.0',
    rootUrl: 'https://example.com/',
    finalRootUrl: 'https://example.com/',
    startedAt: NOW,
    completedAt: NOW,
    complete: true,
    terminationReason: null,
    pagesDiscovered: 2,
    pagesFetched: 2,
    pagesObserved: 2,
    edgesObserved: 1,
    bytesRead: 100,
    fetchesStarted: 2,
    elapsedMs: 10,
    limits: {
      maxPages: 500,
      maxEdges: 10_000,
      maxFetches: 5000,
      maxDurationMs: 120000,
      maxBytes: 1000000,
      maxPageBytes: 100000,
      maxDepth: 10,
      maxLinksPerPage: 1000,
      maxQueryVariants: 10,
      maxSitemapFanout: 1000,
      maxSitemapUrls: 50000,
      concurrency: 1,
    },
    auditRollup: { auditedPages: 2, aggregateScore: 88, factors: [{ id: 'sd', name: 'Structured Data', count: 2, averageScore: 88 }] },
    ...overrides,
  }
}

async function emitCompleteGraph(options: { onEvent?: (event: unknown) => Promise<void> | void }, complete = true) {
  await options.onEvent?.({
    type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages-checksum',
    rows: [page('page:root', 'https://example.com/'), page('page:a', 'https://example.com/a')],
  })
  await options.onEvent?.({
    type: 'edges', sequence: 2, batchId: 'edges-1', checksum: 'edges-checksum',
    rows: [{
      key: 'edge:root-a', from: 'https://example.com/', to: 'https://example.com/a', type: 'anchor', classification: 'internal',
      totalOccurrences: 2, followableOccurrences: 2, nofollowOccurrences: 0, anchorSummaries: [{ text: 'A', occurrences: 2 }],
    }],
  })
  await options.onEvent?.({
    type: 'metrics', sequence: 3, batchId: 'metrics-1', checksum: 'metrics-checksum',
    rows: [
      { key: 'page:root', metrics: page('page:root', 'https://example.com/').metrics },
      { key: 'page:a', metrics: page('page:a', 'https://example.com/a').metrics },
    ],
  })
  const endSummary = summary(complete ? {} : { complete: false, terminationReason: 'max-pages' })
  await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary-1', checksum: complete ? 'summary-ok' : 'summary-partial', summary: endSummary })
  return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [] } }
}

describe('computeFactorAverages', () => {
  it('averages successful audit reports and preserves per-band counts', () => {
    const pages = [
      { audit: { factors: [scoredFactor('sd', 'Structured Data', 12, 90)] } },
      { audit: { factors: [scoredFactor('sd', 'Structured Data', 12, 50)] } },
      { audit: null },
    ]
    const [sd] = computeFactorAverages(pages as never)
    expect(sd).toMatchObject({ id: 'sd', avgScore: 70, pagesPassing: 1, pagesPartial: 1, pagesFailing: 0 })
  })
})

describe('clampSiteAuditLimit', () => {
  it('defaults and clamps page budget', () => {
    expect(clampSiteAuditLimit(undefined)).toBe(SITE_AUDIT_DEFAULT_PAGE_LIMIT)
    expect(clampSiteAuditLimit(0)).toBe(1)
    expect(clampSiteAuditLimit(99999)).toBe(SITE_AUDIT_MAX_PAGE_LIMIT)
  })
})

describe('executeSiteAudit', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-exec-site-audit-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [],
      createdAt: NOW, updatedAt: NOW,
    }).run()
    vi.mocked(runSiteCrawl).mockReset()
  })

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  function seedRun(): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: NOW }).run()
    return id
  }

  it('persists checkpoint batches, publishes a complete immutable graph, and keeps legacy audit reads populated', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options))
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { maxPages: 500, maxEdges: 10_000 })

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()
    expect(attempt).toMatchObject({ state: 'completed', lastEventSequence: 4 })
    expect(db.select().from(siteCrawlEventReceipts).where(eq(siteCrawlEventReceipts.attemptId, attempt!.id)).all()).toHaveLength(4)
    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.attemptId, attempt!.id)).all()).toHaveLength(2)
    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.attemptId, attempt!.id)).get()).toMatchObject({ occurrences: 2, followable: true })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({ complete: true, detailsAvailable: true })
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toMatchObject({ aggregateScore: 88 })
    expect(db.select().from(siteAuditPages).where(eq(siteAuditPages.runId, runId)).all()).toHaveLength(2)
  })

  it('keeps technically indexable HTML in inventory when factor analysis fails', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const rows = [
        page('page:root', 'https://example.com/'),
        page('page:analysis-failed', 'https://example.com/analysis-failed', { audit: null }),
      ]
      await options.onEvent?.({ type: 'pages', sequence: 1, batchId: 'pages', checksum: 'pages', rows })
      const endSummary = summary({ auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)
    const row = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.nodeKey, 'page:analysis-failed')).get()
    expect(row).toMatchObject({ inventoryEligible: true, auditState: 'not-applicable' })
  })

  it('backfills an inbound edge node key when its target page arrives later', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'root', checksum: 'root', rows: [page('page:root', 'https://example.com/')],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edge', checksum: 'edge', rows: [{
          key: 'edge:root-a', from: 'https://example.com/', to: 'https://example.com/a', type: 'anchor', classification: 'internal',
          totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [{ text: 'A', occurrences: 1 }],
        }],
      })
      await options.onEvent?.({
        type: 'pages', sequence: 3, batchId: 'target', checksum: 'target', rows: [page('page:a', 'https://example.com/a')],
      })
      const endSummary = summary()
      await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)
    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.edgeKey, 'edge:root-a')).get()?.targetNodeKey).toBe('page:a')
  })

  it('prefers the terminal HTML node and rebinds references after a redirect alias arrives first', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const newUrl = 'https://example.com/new'
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages-initial', checksum: 'pages-initial', rows: [
          page('page:root', 'https://example.com/', { canonicalUrl: newUrl }),
          page('page:old', 'https://example.com/old', {
            finalUrl: newUrl,
            state: 'redirect',
            canonicalUrl: null,
            audit: null,
            indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
          }),
        ],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edges-to-new', checksum: 'edges-to-new', rows: [{
          key: 'edge:root-new', from: 'https://example.com/', to: newUrl, type: 'anchor', classification: 'internal',
          totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [{ text: 'New', occurrences: 1 }],
        }],
      })
      await options.onEvent?.({
        type: 'pages', sequence: 3, batchId: 'page-final', checksum: 'page-final', rows: [page('page:new', newUrl)],
      })
      const endSummary = summary()
      await options.onEvent?.({ type: 'summary', sequence: 4, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)

    expect(db.select().from(siteCrawlEdges).where(eq(siteCrawlEdges.edgeKey, 'edge:root-new')).get()?.targetNodeKey).toBe('page:new')
    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.nodeKey, 'page:root')).get()?.canonicalNodeKey).toBe('page:new')
  })

  it('counts only attempted internal anchor targets for opted-in dead-link checks', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const anchorTarget = page('page:anchor', 'https://example.com/anchor')
      const canonicalTarget = page('page:canonical', 'https://example.com/canonical')
      const redirectTarget = page('page:redirect', 'https://example.com/redirect', {
        state: 'redirect', audit: null,
        indexability: { state: 'redirect', reasons: ['redirect'], rulesetVersion: '1.0.0' },
      })
      const undiscoveredTarget = page('page:discovered', 'https://example.com/discovered', {
        state: 'discovered', audit: null,
        indexability: { state: 'unknown', reasons: [], rulesetVersion: '1.0.0' },
      })
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'pages', checksum: 'pages',
        rows: [page('page:root', 'https://example.com/'), anchorTarget, canonicalTarget, redirectTarget, undiscoveredTarget],
      })
      await options.onEvent?.({
        type: 'edges', sequence: 2, batchId: 'edges', checksum: 'edges', rows: [
          { key: 'anchor', from: 'https://example.com/', to: anchorTarget.requestedUrl, type: 'anchor', classification: 'internal', totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [] },
          { key: 'canonical', from: 'https://example.com/', to: canonicalTarget.requestedUrl, type: 'canonical', classification: 'internal', totalOccurrences: 1, followableOccurrences: 0, nofollowOccurrences: 0, anchorSummaries: [] },
          { key: 'redirect', from: 'https://example.com/', to: redirectTarget.requestedUrl, type: 'redirect', classification: 'internal', totalOccurrences: 1, followableOccurrences: 0, nofollowOccurrences: 0, anchorSummaries: [] },
          { key: 'unfetched-anchor', from: 'https://example.com/', to: undiscoveredTarget.requestedUrl, type: 'anchor', classification: 'internal', totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [] },
        ],
      })
      const endSummary = summary({ pagesDiscovered: 5, pagesFetched: 4, pagesObserved: 5, edgesObserved: 4, auditRollup: { auditedPages: 3, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'complete', findings: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { checkDeadLinks: true })

    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()?.deadLinksChecked).toBe(1)
  })

  it('keeps a partial snapshot inspectable without replacing the last complete graph', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options, true))
    const goodRun = seedRun()
    await executeSiteAudit(db, goodRun, projectId)

    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitCompleteGraph(options, false))
    const partialRun = seedRun()
    await executeSiteAudit(db, partialRun, projectId)

    expect(db.select().from(runs).where(eq(runs.id, partialRun)).get()?.status).toBe('partial')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, partialRun)).get()).toMatchObject({
      complete: false,
      termination: 'max-pages',
      detailsAvailable: true,
    })
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, goodRun)).get()).toBeDefined()
    expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, partialRun)).get()?.state).toBe('partial')
  })

  it('publishes a zero-audit terminated crawl as an inspectable partial graph', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const failedPage = page('page:failed', 'https://example.com/unreachable', {
        state: 'fetch-error', statusCode: null, audit: null, error: 'timeout',
        indexability: { state: 'unknown', reasons: ['fetch-error'], rulesetVersion: '1.0.0' },
      })
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'failed-page', checksum: 'failed-page', rows: [failedPage],
      })
      const endSummary = summary({
        complete: false,
        terminationReason: 'max-duration',
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        edgesObserved: 0,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'partial', findings: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()!
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('partial')
    expect(attempt.state).toBe('partial')
    expect(db.select().from(siteCrawlEventReceipts).where(eq(siteCrawlEventReceipts.attemptId, attempt.id)).all()).toHaveLength(2)
    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.attemptId, attempt.id)).all()).toHaveLength(1)
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toMatchObject({
      complete: false,
      termination: 'max-duration',
      detailsAvailable: true,
      pagesErrored: 1,
    })
    // A zero-audit traversal has no scorecard; only its historical crawl graph
    // is published, so it cannot create a deceptive latest score of zero.
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toBeUndefined()
    expect(db.select().from(siteAuditPages).where(eq(siteAuditPages.runId, runId)).all()).toEqual([])
  })

  it('keeps fetchedAt null for robots-blocked page inserts and upserts', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const robotsPage = (key: string, url: string) => page(key, url, {
        state: 'robots-blocked', statusCode: null, audit: null, error: null,
        indexability: { state: 'blocked', reasons: ['robots-blocked'], rulesetVersion: '1.0.0' },
      })
      const inserted = robotsPage('page:robots-insert', 'https://example.com/robots-insert')
      const upserted = robotsPage('page:robots-upsert', 'https://example.com/robots-upsert')
      await options.onEvent?.({
        type: 'pages', sequence: 1, batchId: 'robots-pages', checksum: 'robots-pages', rows: [inserted, upserted],
      })
      await options.onEvent?.({
        type: 'pages', sequence: 2, batchId: 'robots-upsert', checksum: 'robots-upsert', rows: [upserted],
      })
      const endSummary = summary({
        complete: false,
        terminationReason: 'max-depth',
        pagesDiscovered: 2,
        pagesFetched: 0,
        pagesObserved: 2,
        edgesObserved: 0,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
      })
      await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'partial', findings: [] } }
    })
    const runId = seedRun()

    await executeSiteAudit(db, runId, projectId)

    const rows = db.select().from(siteCrawlPages).where(eq(siteCrawlPages.runId, runId)).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.fetchedAt)).toEqual([null, null])
  })

  it('replays matching event receipts without duplicating graph rows and rejects a mismatched replay', async () => {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const event = { type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'same', rows: [page('page:root', 'https://example.com/')] }
      await options.onEvent?.(event)
      await options.onEvent?.(event)
      await expect(options.onEvent?.({ ...event, checksum: 'different' })).rejects.toThrow(/checksum/i)
      const endSummary = summary({ pagesDiscovered: 1, pagesFetched: 1, pagesObserved: 1, edgesObserved: 0, auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [] } })
      await options.onEvent?.({ type: 'summary', sequence: 2, batchId: 'summary', checksum: 'summary', summary: endSummary })
      return { mode: 'summary', summary: endSummary, deadLinks: { state: 'disabled', findings: [] } }
    })
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId)
    const attempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()!
    expect(db.select().from(siteCrawlPages).where(eq(siteCrawlPages.attemptId, attempt.id)).all()).toHaveLength(1)
    expect(db.select().from(siteCrawlEventReceipts).where(eq(siteCrawlEventReceipts.attemptId, attempt.id)).all()).toHaveLength(2)
  })

  it('keeps a cancelled run cancelled when the engine rejects with its abort signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by user'))
    vi.mocked(runSiteCrawl).mockImplementation(async () => { throw controller.signal.reason })
    const runId = seedRun()
    await expect(executeSiteAudit(db, runId, projectId, { signal: controller.signal })).rejects.toThrow('Cancelled by user')
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('cancelled')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toBeUndefined()
  })

  it('does not publish audit snapshots when cancellation wins after the crawl completes', async () => {
    const runId = seedRun()
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => {
      const result = await emitCompleteGraph(options)
      db.update(runs).set({ status: 'cancelled', finishedAt: NOW }).where(eq(runs.id, runId)).run()
      return result
    })

    await expect(executeSiteAudit(db, runId, projectId)).rejects.toThrow(/cancelled before publication/i)
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('cancelled')
    expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.runId, runId)).get()?.state).toBe('cancelled')
    expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()).toBeUndefined()
    expect(db.select().from(siteAuditSnapshots).where(eq(siteAuditSnapshots.runId, runId)).get()).toBeUndefined()
  })
})
