import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteAuditSnapshots,
  siteAuditPages,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlFindings,
  siteCrawlPages,
  siteCrawlRunRequests,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import type {
  SiteAuditFactorSummaryDto,
  SiteAuditPagesResponseDto,
  SiteAuditScoreDto,
  SiteAuditTrendResponseDto,
  SiteCrawlDeadLinksResponseDto,
  SiteCrawlInternalLinksResponseDto,
  SiteCrawlNeighborsResponseDto,
  SiteCrawlPagesResponseDto,
  SiteCrawlStructureResponseDto,
  SiteCrawlSummaryDto,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  runA: string
  runB: string
  probeRun: string
  siteAuditRequested: Array<{
    runId: string
    projectId: string
    opts?: {
      sitemapUrl?: string
      limit?: number
      maxPages?: number
      maxEdges?: number
      maxDepth?: number
      checkDeadLinks?: boolean
    }
  }>
}

const FACTORS_B: SiteAuditFactorSummaryDto[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12, avgScore: 80, status: 'pass', pagesPassing: 2, pagesPartial: 0, pagesFailing: 0 },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4, avgScore: 30, status: 'fail', pagesPassing: 0, pagesPartial: 0, pagesFailing: 2 },
]

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tech-aeo-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  const siteAuditRequested: Ctx['siteAuditRequested'] = []
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onSiteAuditRequested: (runId, projectId, opts) => { siteAuditRequested.push({ runId, projectId, opts }) },
  })

  const now = Date.now()
  const tA = new Date(now - 120_000).toISOString()
  const tB = new Date(now - 60_000).toISOString()
  const tProbe = new Date(now).toISOString()

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'tech-aeo',
    displayName: 'Tech AEO',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    locations: [],
    createdAt: tA,
    updatedAt: tA,
  }).run()

  function seedRun(status: string, trigger: string, createdAt: string): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status, trigger, createdAt, finishedAt: createdAt }).run()
    return id
  }

  // Run A — older real audit, score 60.
  const runA = seedRun('completed', 'manual', tA)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runA,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tA,
    aggregateScore: 60, aggregateGrade: 'D-', pagesDiscovered: 2, pagesAudited: 2, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: tA,
  }).run()
  db.insert(siteAuditPages).values({
    id: crypto.randomUUID(), projectId, runId: runA, url: 'https://example.com/old',
    overallScore: 60, overallGrade: 'D-', status: 'success', error: null, factors: [], createdAt: tA,
  }).run()

  // Run B — newer real audit, score 72 (+12 vs A → trend up). This is the surfaceable latest.
  const runB = seedRun('completed', 'manual', tB)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runB,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tB,
    aggregateScore: 72, aggregateGrade: 'C-', pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 1, pagesErrored: 1,
    factorAverages: FACTORS_B,
    crossCuttingIssues: [{ factorId: 'ai-crawler-access', factorName: 'AI Crawler Access', avgScore: 30, affectedPages: 2, totalPages: 2, affectedPct: 100, topRecommendations: ['Allow GPTBot in robots.txt'] }],
    prioritizedFixes: ['AI Crawler Access (avg F, affects 100% of pages): Allow GPTBot in robots.txt'],
    createdAt: tB,
  }).run()
  db.insert(siteAuditPages).values([
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/good', overallScore: 80, overallGrade: 'B-', status: 'success', error: null, factors: [], createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/weak', overallScore: 30, overallGrade: 'F', status: 'success', error: null, factors: [], createdAt: tB },
    { id: crypto.randomUUID(), projectId, runId: runB, url: 'https://example.com/dead', overallScore: 0, overallGrade: 'F', status: 'error', error: 'TIMEOUT', factors: [], createdAt: tB },
  ]).run()

  // New persisted crawl data for run B. It deliberately coexists with the
  // legacy scorecard rows above; callers must never infer it from them.
  const crawlAttemptId = crypto.randomUUID()
  db.insert(siteCrawlAttempts).values({
    id: crawlAttemptId, projectId, runId: runB, attemptNumber: 1, state: 'completed',
    pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2,
    startedAt: tB, finishedAt: tB, createdAt: tB, updatedAt: tB,
  }).run()
  db.insert(siteCrawlSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId,
    rootUrl: 'https://example.com/', crawlSchemaVersion: '1.0', engineVersion: 'crawl-test',
    normalizationVersion: 'url-v1', indexabilityVersion: 'index-v1', linkScoreVersion: 'links-v1',
    effectiveOptions: { maxPages: 100, checkDeadLinks: true }, checkDeadLinks: true,
    complete: true, termination: 'completed', detailsAvailable: true,
    pagesDiscovered: 3, pagesFetched: 3, pagesEligible: 2, edgesDiscovered: 2, findingsCount: 1,
    deadLinkState: 'complete', deadLinksChecked: 2, deadLinksFound: 1, createdAt: tB, updatedAt: tB,
  }).run()
  db.insert(siteCrawlPages).values([
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'home',
      url: 'https://example.com/', finalUrl: 'https://example.com/', path: '/', parentPath: '/', discoverySource: 'sitemap',
      fetchState: 'fetched', httpStatus: 200, indexabilityState: 'eligible', auditState: 'complete', auditScore: 88,
      inventoryEligible: true, depth: 0, outboundUniqueEdges: 2, outboundOccurrences: 3, linkScoreRaw: 10, linkScoreNormalized: 1,
      createdAt: tB, updatedAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'guide',
      url: 'https://example.com/guide', finalUrl: 'https://example.com/guide', path: '/guide', parentPath: '/', discoverySource: 'link',
      fetchState: 'fetched', httpStatus: 200, indexabilityState: 'eligible', auditState: 'complete', auditScore: 42,
      inventoryEligible: true, depth: 1, inboundUniqueEdges: 1, inboundOccurrences: 2, linkScoreRaw: 4, linkScoreNormalized: 0.4,
      createdAt: tB, updatedAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, nodeKey: 'gone',
      url: 'https://example.com/gone', path: '/gone', parentPath: '/', discoverySource: 'link', fetchState: 'fetched', httpStatus: 404,
      indexabilityState: 'ineligible', auditState: 'skipped', inventoryEligible: false, depth: 1, createdAt: tB, updatedAt: tB,
    },
  ]).run()
  db.insert(siteCrawlEdges).values([
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, edgeKey: 'home-guide',
      sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'guide', targetUrl: 'https://example.com/guide',
      relation: 'a', internal: true, followable: true, occurrences: 2, followableOccurrences: 2, nofollowOccurrences: 0,
      anchors: ['Guide'], createdAt: tB, updatedAt: tB,
    },
    {
      id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, edgeKey: 'home-gone',
      sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'gone', targetUrl: 'https://example.com/gone',
      relation: 'a', internal: true, followable: false, occurrences: 1, followableOccurrences: 0, nofollowOccurrences: 1,
      anchors: ['Old'], createdAt: tB, updatedAt: tB,
    },
  ]).run()
  db.insert(siteCrawlFindings).values({
    id: crypto.randomUUID(), projectId, runId: runB, attemptId: crawlAttemptId, findingKey: 'dead:gone', findingType: 'dead-link', severity: 'high',
    sourceNodeKey: 'home', sourceUrl: 'https://example.com/', targetNodeKey: 'gone', targetUrl: 'https://example.com/gone', evidence: { status: 404 },
    createdAt: tB, updatedAt: tB,
  }).run()

  // Probe run — newest, intentionally a wildly different score. MUST be excluded.
  const probeRun = seedRun('completed', 'probe', tProbe)
  db.insert(siteAuditSnapshots).values({
    id: crypto.randomUUID(), projectId, runId: probeRun,
    sitemapUrl: 'https://example.com/sitemap.xml', auditedAt: tProbe,
    aggregateScore: 5, aggregateGrade: 'F', pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, pagesErrored: 0,
    factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: tProbe,
  }).run()

  return { app, db, tmpDir, projectId, runA, runB, probeRun, siteAuditRequested }
}

let ctx: Ctx
beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url })
  return { status: res.statusCode, body: res.json() as T }
}

describe('GET /technical-aeo (score)', () => {
  it('returns the latest real audit with delta vs the previous run, excluding the newer probe', async () => {
    const { body } = await get<SiteAuditScoreDto>('/api/v1/projects/tech-aeo/technical-aeo')
    expect(body.hasData).toBe(true)
    expect(body.runId).toBe(ctx.runB)          // not the newer probe
    expect(body.aggregateScore).toBe(72)
    expect(body.deltaScore).toBe(12)           // 72 - 60
    expect(body.trend).toBe('up')
    expect(body.previousScore).toBe(60)
    expect(body.pagesErrored).toBe(1)
    expect(body.factors).toHaveLength(2)
    expect(body.prioritizedFixes).toHaveLength(1)
    // The server-computed affected-pages share rides through to the API response verbatim.
    expect(body.crossCuttingIssues).toHaveLength(1)
    expect(body.crossCuttingIssues[0]!.affectedPct).toBe(100)
  })

  it('returns hasData=false for a project that was never audited', async () => {
    ctx.db.insert(projects).values({
      id: crypto.randomUUID(), name: 'fresh', displayName: 'Fresh', canonicalDomain: 'fresh.com',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run()
    const { body } = await get<SiteAuditScoreDto>('/api/v1/projects/fresh/technical-aeo')
    expect(body.hasData).toBe(false)
    expect(body.runId).toBeNull()
    expect(body.aggregateScore).toBe(0)
    expect(body.deltaScore).toBeNull()
    expect(body.factors).toEqual([])
  })

  it('returns a selected historical audit and computes its delta against the audit before it', async () => {
    const { body } = await get<SiteAuditScoreDto>(`/api/v1/projects/tech-aeo/technical-aeo?runId=${ctx.runA}`)
    expect(body.runId).toBe(ctx.runA)
    expect(body.aggregateScore).toBe(60)
    expect(body.deltaScore).toBeNull()
    expect(body.previousScore).toBeNull()
  })

  it('404s a run that is not a surfaceable audit for this project', async () => {
    const { status } = await get(`/api/v1/projects/tech-aeo/technical-aeo?runId=${ctx.probeRun}`)
    expect(status).toBe(404)
  })

  it('404s an unknown project', async () => {
    const { status } = await get('/api/v1/projects/nope/technical-aeo')
    expect(status).toBe(404)
  })
})

describe('GET /technical-aeo/pages', () => {
  it('returns the latest run pages sorted worst-first by default', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages')
    expect(body.runId).toBe(ctx.runB)
    expect(body.total).toBe(3)
    expect(body.pages.map((p) => p.overallScore)).toEqual([0, 30, 80]) // score-asc
  })

  it('filters to errored pages', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages?status=error')
    expect(body.total).toBe(1)
    expect(body.pages).toHaveLength(1)
    expect(body.pages[0]!.status).toBe('error')
    expect(body.pages[0]!.error).toBe('TIMEOUT')
  })

  it('sorts score-desc and paginates', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/pages?sort=score-desc&limit=1&offset=0')
    expect(body.total).toBe(3)
    expect(body.pages).toHaveLength(1)
    expect(body.pages[0]!.overallScore).toBe(80)
  })

  it('returns pages from a selected historical audit', async () => {
    const { body } = await get<SiteAuditPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/pages?runId=${ctx.runA}`)
    expect(body.runId).toBe(ctx.runA)
    expect(body.total).toBe(1)
    expect(body.pages[0]?.url).toBe('https://example.com/old')
  })
})

describe('GET /technical-aeo/trend', () => {
  it('returns oldest-first points excluding the probe', async () => {
    const { body } = await get<SiteAuditTrendResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/trend')
    expect(body.points.map((p) => p.aggregateScore)).toEqual([60, 72])
    expect(body.points.every((p) => p.runId !== ctx.probeRun)).toBe(true)
  })
})

describe('GET /technical-aeo crawl reads', () => {
  it('returns only the latest real persisted crawl, with separate legacy availability', async () => {
    const { body } = await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')
    expect(body).toMatchObject({
      hasCrawlData: true,
      legacyAuditAvailable: true,
      runId: ctx.runB,
      complete: true,
      detailsAvailable: true,
      deadLinks: { state: 'complete', checked: 2, found: 1 },
    })
    expect(body.counts.pagesEligible).toBe(2)
    expect(body.runId).not.toBe(ctx.probeRun)
  })

  it('keeps the last complete graph current when a newer partial crawl exists', async () => {
    const now = new Date(Date.now() + 60_000).toISOString()
    const partialRun = crypto.randomUUID()
    const partialAttempt = crypto.randomUUID()
    ctx.db.insert(runs).values({
      id: partialRun, projectId: ctx.projectId, kind: 'site-audit', status: 'partial', trigger: 'manual', createdAt: now, finishedAt: now,
    }).run()
    ctx.db.insert(siteCrawlAttempts).values({
      id: partialAttempt, projectId: ctx.projectId, runId: partialRun, attemptNumber: 1, state: 'partial', createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(siteCrawlSnapshots).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: partialRun, attemptId: partialAttempt,
      rootUrl: 'https://example.com/', complete: false, termination: 'max-pages', detailsAvailable: true, createdAt: now, updatedAt: now,
    }).run()

    const current = await get<SiteCrawlSummaryDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl')
    const historical = await get<SiteCrawlSummaryDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl?runId=${partialRun}`)
    expect(current.body.runId).toBe(ctx.runB)
    expect(historical.body.runId).toBe(partialRun)
    expect(historical.body.complete).toBe(false)
  })

  it('does not turn a legacy-only scorecard into crawl data', async () => {
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: 'legacy-only', displayName: 'Legacy', canonicalDomain: 'legacy.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    ctx.db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
    ctx.db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId, runId, sitemapUrl: 'https://legacy.example/sitemap.xml', auditedAt: now,
      aggregateScore: 60, aggregateGrade: 'D-', pagesDiscovered: 1, pagesAudited: 1, pagesSkipped: 0, pagesErrored: 0,
      factorAverages: [], crossCuttingIssues: [], prioritizedFixes: [], createdAt: now,
    }).run()
    const { body } = await get<SiteCrawlSummaryDto>('/api/v1/projects/legacy-only/technical-aeo/crawl')
    expect(body.hasCrawlData).toBe(false)
    expect(body.legacyAuditAvailable).toBe(true)
    expect(body.deadLinks).toEqual({ state: 'unavailable' })
  })

  it('keeps historical crawl resolution project-scoped', async () => {
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    ctx.db.insert(projects).values({
      id: projectId, name: 'other', displayName: 'Other', canonicalDomain: 'other.example',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    const { status } = await get(`/api/v1/projects/other/technical-aeo/crawl?runId=${ctx.runB}`)
    expect(status).toBe(404)
  })

  it('cursor-pages crawl inventory and preserves technical inventory eligibility', async () => {
    const first = await get<SiteCrawlPagesResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1&sort=path&inventoryEligible=true')
    expect(first.body.total).toBe(2)
    expect(first.body.pages).toHaveLength(1)
    expect(first.body.pages[0]!.inventoryEligible).toBe(true)
    expect(first.body.nextCursor).toEqual(expect.any(String))
    const second = await get<SiteCrawlPagesResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/crawl/pages?limit=1&sort=path&inventoryEligible=true&cursor=${encodeURIComponent(first.body.nextCursor!)}`)
    expect(second.body.pages).toHaveLength(1)
    expect(second.body.nextCursor).toBeNull()
  })

  it('bounds structure, internal links, neighbors, and dead-link output', async () => {
    const structure = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/&limit=1')
    expect(structure.body.children).toHaveLength(1)
    expect(structure.body.nextCursor).toEqual(expect.any(String))

    const links = await get<SiteCrawlInternalLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links?limit=1')
    expect(links.body.edges).toHaveLength(1)
    expect(links.body.nextCursor).toEqual(expect.any(String))

    const neighbors = await get<SiteCrawlNeighborsResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/internal-links/neighbors?nodeKey=home&limit=1')
    expect(neighbors.body.outbound).toHaveLength(1)
    expect(neighbors.body.outboundTruncated).toBe(true)

    const dead = await get<SiteCrawlDeadLinksResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/dead-links?limit=1')
    expect(dead.body).toMatchObject({ state: 'complete', total: 1, deadLinks: [{ targetUrl: 'https://example.com/gone' }] })
  })

  it('surfaces synthetic folder levels when no folder landing page exists', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values({
      id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'deep-guide',
      url: 'https://example.com/docs/guides/start', finalUrl: 'https://example.com/docs/guides/start',
      path: '/docs/guides/start', parentPath: '/docs/guides', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
      indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true, depth: 3, createdAt: now, updatedAt: now,
    }).run()

    const root = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/&limit=100')
    expect(root.body.children).toContainEqual(expect.objectContaining({ path: '/docs', url: null, hasPage: false, pageCount: 1 }))
    const docs = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/docs&limit=100')
    expect(docs.body.children).toContainEqual(expect.objectContaining({ path: '/docs/guides', url: null, hasPage: false, pageCount: 1 }))
    const guides = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/docs/guides&limit=100')
    expect(guides.body.children).toContainEqual(expect.objectContaining({
      path: '/docs/guides/start', url: 'https://example.com/docs/guides/start', hasPage: true, pageCount: 1,
    }))
  })

  it('treats a trailing-slash folder landing page as the folder, not its child', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'catalog',
        url: 'https://example.com/catalog/', finalUrl: 'https://example.com/catalog/',
        path: '/catalog/', parentPath: '/', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true, depth: 1, createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'catalog-item',
        url: 'https://example.com/catalog/items/one', finalUrl: 'https://example.com/catalog/items/one',
        path: '/catalog/items/one', parentPath: '/catalog/items', discoverySource: 'link', fetchState: 'html', httpStatus: 200,
        indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true, depth: 3, createdAt: now, updatedAt: now,
      },
    ]).run()

    const root = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/&limit=100')
    expect(root.body.children).toContainEqual(expect.objectContaining({
      path: '/catalog', url: 'https://example.com/catalog/', hasPage: true, pageCount: 2,
    }))
    const catalog = await get<SiteCrawlStructureResponseDto>('/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=/catalog&limit=100')
    expect(catalog.body.children.map((child) => child.path)).toEqual(['/catalog/items'])
  })

  it('treats percent and underscore path characters literally in structure parents', async () => {
    const snapshot = ctx.db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, ctx.runB)).get()!
    const now = new Date().toISOString()
    ctx.db.insert(siteCrawlPages).values([
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'underscore-real',
        url: 'https://example.com/literal_underscore/only', path: '/literal_underscore/only', parentPath: '/literal_underscore',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'underscore-wildcard-sibling',
        url: 'https://example.com/literalXunderscore/wrong', path: '/literalXunderscore/wrong', parentPath: '/literalXunderscore',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'percent-real',
        url: 'https://example.com/literal%25percent/only', path: '/literal%25percent/only', parentPath: '/literal%25percent',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId: ctx.projectId, runId: ctx.runB, attemptId: snapshot.attemptId!, nodeKey: 'percent-wildcard-sibling',
        url: 'https://example.com/literalZZ25percent/wrong', path: '/literalZZ25percent/wrong', parentPath: '/literalZZ25percent',
        discoverySource: 'link', fetchState: 'html', indexabilityState: 'indexable', auditState: 'success', inventoryEligible: true,
        createdAt: now, updatedAt: now,
      },
    ]).run()

    const underscore = await get<SiteCrawlStructureResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=${encodeURIComponent('/literal_underscore')}`)
    expect(underscore.body.children.map((child) => child.path)).toEqual(['/literal_underscore/only'])

    const percent = await get<SiteCrawlStructureResponseDto>(`/api/v1/projects/tech-aeo/technical-aeo/structure?parentPath=${encodeURIComponent('/literal%25percent')}`)
    expect(percent.body.children.map((child) => child.path)).toEqual(['/literal%25percent/only'])
  })
})

describe('POST /technical-aeo/runs', () => {
  it('creates a queued site-audit run and fires the callback', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 50 } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { runId: string; status: string }
    expect(body.status).toBe('queued')
    const row = ctx.db.select().from(runs).where(eq(runs.id, body.runId)).get()
    expect(row?.kind).toBe('site-audit')
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.siteAuditRequested[0]!.opts?.limit).toBe(50)
  })

  it('is idempotent — returns the in-flight run instead of starting a second', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 50 } })
    const firstId = (first.json() as { runId: string }).runId
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
      payload: { maxPages: 50, checkDeadLinks: false },
    })
    const secondId = (second.json() as { runId: string }).runId
    expect(secondId).toBe(firstId)
    // Only one callback fired (the second was a no-op dedupe).
    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, firstId)).get()).toMatchObject({
      projectId: ctx.projectId,
      effectiveOptions: {
        schemaVersion: 1,
        sitemapUrl: null,
        maxPages: 50,
        maxEdges: 250_000,
        maxDepth: null,
        checkDeadLinks: false,
      },
    })
  })

  it('refuses to consolidate semantically different crawl requests onto an active run', async () => {
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: {} })
    const firstId = (first.json() as { runId: string }).runId
    const variants = [
      { sitemapUrl: 'https://example.com/custom-sitemap.xml' },
      { limit: 50 },
      { maxPages: 60 },
      { maxEdges: 500 },
      { maxDepth: 4 },
      { checkDeadLinks: true },
    ]

    for (const payload of variants) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
        payload,
      })
      expect(response.statusCode, JSON.stringify(payload)).toBe(409)
      expect(response.json()).toMatchObject({
        error: {
          code: 'OPERATION_IN_PROGRESS',
          details: { activeRunId: firstId },
        },
      })
    }

    expect(ctx.siteAuditRequested).toHaveLength(1)
    expect(ctx.db.select().from(runs).where(eq(runs.projectId, ctx.projectId)).all().filter((run) => run.status === 'queued')).toHaveLength(1)
  })

  it('rejects an invalid limit over the cap', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs', payload: { limit: 99999 } })
    expect(res.statusCode).toBe(400)
  })

  it('accepts additive crawl budgets and defaults dead-link checks off', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/projects/tech-aeo/technical-aeo/runs',
      payload: { maxPages: 60, maxEdges: 500, maxDepth: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(ctx.siteAuditRequested[0]!.opts).toMatchObject({ maxPages: 60, maxEdges: 500, maxDepth: 4, checkDeadLinks: false })
  })
})
