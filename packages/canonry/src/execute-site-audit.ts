import crypto from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  projects,
  runs,
  siteAuditPages,
  siteAuditSnapshots,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlEventReceipts,
  siteCrawlFindings,
  siteCrawlPages,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import { runSiteCrawl } from '@canonry/aeo-audit'
import type {
  CrawlEdgeObservation,
  CrawlEvent,
  CrawlPageMetrics,
  CrawlPageObservation,
  SiteCrawlReport,
} from '@canonry/aeo-audit'
import {
  SITE_AUDIT_DEFAULT_EDGE_LIMIT,
  SITE_AUDIT_DEFAULT_PAGE_LIMIT,
  SITE_AUDIT_MAX_EDGE_LIMIT,
  SITE_AUDIT_MAX_PAGE_LIMIT,
  factorStatusFromScore,
  type RunStatus,
  type SiteAuditCrossCuttingIssueDto,
  type SiteAuditFactorSummaryDto,
  type SiteAuditPageFactorDto,
} from '@ainyc/canonry-contracts'
import { resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import { createLogger } from './logger.js'

const log = createLogger('SiteAudit')

export {
  SITE_AUDIT_DEFAULT_EDGE_LIMIT,
  SITE_AUDIT_DEFAULT_PAGE_LIMIT,
  SITE_AUDIT_MAX_EDGE_LIMIT,
  SITE_AUDIT_MAX_PAGE_LIMIT,
} from '@ainyc/canonry-contracts'

export interface SiteAuditOptions {
  sitemapUrl?: string
  /** @deprecated Compatibility alias for maxPages. */
  limit?: number
  maxPages?: number
  maxEdges?: number
  maxDepth?: number
  checkDeadLinks?: boolean
  /** The local server owns this controller; never accepted from an HTTP body. */
  signal?: AbortSignal
}

type AuditPage = Pick<CrawlPageObservation, 'audit'>
type AuditFactor = NonNullable<NonNullable<AuditPage['audit']>['factors']>[number]
type DatabaseTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

class SiteAuditCancelledError extends Error {
  override name = 'SiteAuditCancelledError'
}

function toHomepageUrl(canonicalDomain: string): string {
  const trimmed = canonicalDomain.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

async function assertSiteAuditUrlAllowed(rawUrl: string, field: string): Promise<void> {
  const check = await resolveWebhookTarget(rawUrl)
  if (!check.ok) throw new Error(`${field} ${check.message.replace(/^"url" /, '')}`)
}

export function clampSiteAuditLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return SITE_AUDIT_DEFAULT_PAGE_LIMIT
  return Math.max(1, Math.min(SITE_AUDIT_MAX_PAGE_LIMIT, Math.floor(limit)))
}

export function clampSiteAuditEdgeLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return SITE_AUDIT_DEFAULT_EDGE_LIMIT
  return Math.max(1, Math.min(SITE_AUDIT_MAX_EDGE_LIMIT, Math.floor(limit)))
}

function toPageFactor(factor: AuditFactor): SiteAuditPageFactorDto {
  return { id: factor.id, name: factor.name, weight: factor.weight, score: factor.score }
}

/** Aggregate the scorecard from crawl observations, not a second full report. */
export function computeFactorAverages(pages: AuditPage[]): SiteAuditFactorSummaryDto[] {
  const byId = new Map<string, { name: string; weight: number; scores: number[]; pass: number; partial: number; fail: number }>()
  for (const page of pages) {
    if (!page.audit) continue
    for (const factor of page.audit.factors) {
      const current = byId.get(factor.id) ?? { name: factor.name, weight: factor.weight, scores: [], pass: 0, partial: 0, fail: 0 }
      byId.set(factor.id, current)
      current.scores.push(factor.score)
      const status = factorStatusFromScore(factor.score)
      if (status === 'pass') current.pass++
      else if (status === 'partial') current.partial++
      else current.fail++
    }
  }
  return [...byId.entries()]
    .map(([id, value]) => {
      const avgScore = Math.round(value.scores.reduce((sum, score) => sum + score, 0) / value.scores.length)
      return {
        id,
        name: value.name,
        weight: value.weight,
        avgScore,
        status: factorStatusFromScore(avgScore),
        pagesPassing: value.pass,
        pagesPartial: value.partial,
        pagesFailing: value.fail,
      }
    })
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
}

function pagePath(page: CrawlPageObservation): string {
  if (page.path) return page.path
  try { return new URL(page.finalUrl ?? page.requestedUrl).pathname || '/' } catch { return '/' }
}

function parentPath(page: CrawlPageObservation): string {
  const path = pagePath(page)
  if (path === '/') return '/'
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash <= 0 ? '/' : trimmed.slice(0, slash) || '/'
}

function pageDiscoverySource(page: CrawlPageObservation): string {
  if (page.provenance.root) return 'root'
  if (page.provenance.sitemapSources.length > 0) return 'sitemap'
  return 'link'
}

function pageAuditState(page: CrawlPageObservation): string {
  if (page.audit) return 'success'
  if (page.state === 'fetch-error') return 'error'
  return 'not-applicable'
}

function isInventoryEligible(page: CrawlPageObservation): boolean {
  // Inventory is a crawl fact, not an analyzer-success fact. A transient
  // factor failure must not hide an otherwise canonical/indexable HTML page
  // from GSC coverage.
  return page.state === 'html' && page.indexability.state === 'indexable'
}

function isCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
  // A caller aborting its signal does not make every concurrent failure a
  // cancellation. Only the signal's exact reason (or Fetch's typed abort)
  // carries that meaning.
  if (error instanceof SiteAuditCancelledError) return true
  if (signal?.aborted && signal.reason !== undefined && error === signal.reason) return true
  return error instanceof DOMException && error.name === 'AbortError'
}

function isLegacyScorecardPage(page: CrawlPageObservation): boolean {
  // Legacy `site_audit_pages` means a page received a scorecard, or the
  // request itself failed. Crawl-only observations (robots, redirects,
  // non-HTML, and depth-budget stubs) have useful graph state but no legacy
  // audit failure to report.
  return page.audit != null || page.state === 'fetch-error'
}

function emptyCompleteCrawlError(rootUrl: string, finalRootUrl: string | null, pagesObserved: number): Error {
  if (!finalRootUrl) return new Error(`Site audit could not successfully audit any of ${pagesObserved} observed page(s).`)
  try {
    const rootHost = new URL(rootUrl).hostname
    const finalRootHost = new URL(finalRootUrl).hostname
    if (rootHost !== finalRootHost) {
      return new Error(
        `Site audit could not successfully audit any of ${pagesObserved} observed page(s): `
        + `root URL redirected off-host from ${rootHost} to ${finalRootHost} (${finalRootUrl}).`,
      )
    }
  } catch {
    // The generic error below is still truthful when an upstream URL is malformed.
  }
  return new Error(`Site audit could not successfully audit any of ${pagesObserved} observed page(s).`)
}

function toLegacyIssue(summary: SiteAuditFactorSummaryDto, totalPages: number): SiteAuditCrossCuttingIssueDto | null {
  const affected = summary.pagesPartial + summary.pagesFailing
  if (affected === 0 || summary.avgScore >= 70) return null
  return {
    factorId: summary.id,
    factorName: summary.name,
    avgScore: summary.avgScore,
    affectedPages: affected,
    totalPages,
    affectedPct: totalPages > 0 ? Math.round((affected / totalPages) * 100) : 0,
    topRecommendations: [],
  }
}

function observedErrorCount(pages: Iterable<CrawlPageObservation>): number {
  let total = 0
  for (const page of pages) if (page.state === 'fetch-error') total++
  return total
}

function deadLinkCheckedCount(edges: Iterable<CrawlEdgeObservation>, pages: Iterable<CrawlPageObservation>): number {
  // Match the engine's dead-link scope: only internal anchor targets count.
  // A discovered or robots-blocked URL was never fetched/attempted, so saying
  // it was checked would make the opt-in result deceptively optimistic.
  const attemptedUrls = new Set<string>()
  for (const page of pages) {
    if (page.state === 'discovered' || page.state === 'robots-blocked') continue
    attemptedUrls.add(page.requestedUrl)
    if (page.finalUrl) attemptedUrls.add(page.finalUrl)
  }
  return new Set([...edges]
    .filter((edge) => edge.type === 'anchor' && edge.classification === 'internal' && attemptedUrls.has(edge.to))
    .map((edge) => edge.to)).size
}

/**
 * Local full-crawl executor.
 *
 * Events update an attempt-local graph durably as they arrive.  A distinct
 * immutable `site_crawl_snapshot` records every terminal traversal. Default
 * reads publish only complete snapshots as current; an explicitly selected
 * partial run remains inspectable without replacing the last known-good graph.
 */
export async function executeSiteAudit(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: SiteAuditOptions = {},
): Promise<void> {
  const startedAt = new Date().toISOString()
  const claim = db.update(runs)
    .set({ status: 'running', startedAt })
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId), eq(runs.status, 'queued')))
    .run()
  if (claim.changes === 0) return

  const attemptNumber = (db.select({ value: sql<number>`coalesce(max(${siteCrawlAttempts.attemptNumber}), 0)` })
    .from(siteCrawlAttempts)
    .where(eq(siteCrawlAttempts.runId, runId))
    .get()?.value ?? 0) + 1
  const attemptId = crypto.randomUUID()
  db.insert(siteCrawlAttempts).values({
    id: attemptId,
    projectId,
    runId,
    attemptNumber,
    state: 'running',
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  }).run()

  const observedPages = new Map<string, CrawlPageObservation>()
  const observedEdges = new Map<string, CrawlEdgeObservation>()
  const nodeKeyByUrl = new Map<string, string>()
  const nodePriorityByUrl = new Map<string, number>()

  /**
   * A redirect observation aliases its terminal URL, but it is not the node
   * that owns that terminal response. The crawler intentionally ships pages in
   * deterministic key order (not fetch order), so keep the direct terminal
   * observation as the stable winner independent of row ordering.
   */
  const registerNode = (url: string, nodeKey: string, priority: number, changedUrls: Set<string>): void => {
    const currentPriority = nodePriorityByUrl.get(url)
    const currentNodeKey = nodeKeyByUrl.get(url)
    if (
      currentPriority == null
      || priority > currentPriority
      || (priority === currentPriority && currentNodeKey != null && nodeKey.localeCompare(currentNodeKey) < 0)
    ) {
      nodePriorityByUrl.set(url, priority)
      nodeKeyByUrl.set(url, nodeKey)
      changedUrls.add(url)
    }
  }

  const registerPageNode = (page: CrawlPageObservation, changedUrls: Set<string>): void => {
    observedPages.set(page.key, page)
    // A requested URL names the exact observation, including a redirect node.
    registerNode(page.requestedUrl, page.key, 2, changedUrls)
    // The redirect's final URL is only a fallback until its own terminal page
    // observation arrives. This is what avoids hash-sort-dependent graph keys.
    if (page.finalUrl && page.finalUrl !== page.requestedUrl) registerNode(page.finalUrl, page.key, 1, changedUrls)
  }

  const bindReferences = (tx: DatabaseTransaction, changedUrls: Iterable<string>, now: string): void => {
    for (const url of [...new Set(changedUrls)].sort()) {
      const nodeKey = nodeKeyByUrl.get(url)
      if (!nodeKey) continue
      const scope = [
        eq(siteCrawlEdges.projectId, projectId),
        eq(siteCrawlEdges.runId, runId),
        eq(siteCrawlEdges.attemptId, attemptId),
      ]
      tx.update(siteCrawlEdges).set({ sourceNodeKey: nodeKey, updatedAt: now }).where(and(
        ...scope,
        eq(siteCrawlEdges.sourceUrl, url),
      )).run()
      tx.update(siteCrawlEdges).set({ targetNodeKey: nodeKey, updatedAt: now }).where(and(
        ...scope,
        eq(siteCrawlEdges.targetUrl, url),
      )).run()
      tx.update(siteCrawlPages).set({ canonicalNodeKey: nodeKey, updatedAt: now }).where(and(
        eq(siteCrawlPages.projectId, projectId),
        eq(siteCrawlPages.runId, runId),
        eq(siteCrawlPages.attemptId, attemptId),
        eq(siteCrawlPages.canonicalUrl, url),
      )).run()
    }
  }

  const persistPage = (tx: DatabaseTransaction, page: CrawlPageObservation, now: string): void => {
    const audit = page.audit
    tx.insert(siteCrawlPages).values({
      id: crypto.randomUUID(),
      projectId,
      runId,
      attemptId,
      nodeKey: page.key,
      url: page.requestedUrl,
      path: pagePath(page),
      parentPath: parentPath(page),
      discoverySource: pageDiscoverySource(page),
      discoveryProvenance: [{
        discoveredFrom: page.provenance.discoveredFrom,
        sitemapSources: page.provenance.sitemapSources,
        root: page.provenance.root,
      }],
      sitemapMetadata: { sources: page.provenance.sitemapSources },
      fetchState: page.state,
      fetchedAt: page.state === 'discovered' || page.state === 'robots-blocked' ? null : now,
      httpStatus: page.statusCode,
      contentType: page.contentType,
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain.map((hop) => hop.to),
      directives: { metaRobots: page.metaRobots, xRobots: page.xRobots },
      canonicalUrl: page.canonicalUrl,
      canonicalNodeKey: page.canonicalUrl ? nodeKeyByUrl.get(page.canonicalUrl) ?? null : null,
      indexabilityState: page.indexability.state,
      indexabilityReasons: page.indexability.reasons,
      auditState: pageAuditState(page),
      auditScore: audit?.overallScore ?? null,
      auditFields: audit ? { factors: audit.factors.map(toPageFactor) } : {},
      inventoryEligible: isInventoryEligible(page),
      depth: page.depth,
      inboundUniqueEdges: page.metrics.inbound.uniqueEdges,
      outboundUniqueEdges: page.metrics.outbound.uniqueEdges,
      inboundOccurrences: page.metrics.inbound.totalOccurrences,
      outboundOccurrences: page.metrics.outbound.totalOccurrences,
      linkScoreRaw: page.metrics.linkScoreRaw,
      linkScoreNormalized: page.metrics.linkScore,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [siteCrawlPages.projectId, siteCrawlPages.runId, siteCrawlPages.attemptId, siteCrawlPages.nodeKey],
      set: {
        url: page.requestedUrl,
        path: pagePath(page),
        parentPath: parentPath(page),
        discoverySource: pageDiscoverySource(page),
        discoveryProvenance: [{ discoveredFrom: page.provenance.discoveredFrom, sitemapSources: page.provenance.sitemapSources, root: page.provenance.root }],
        sitemapMetadata: { sources: page.provenance.sitemapSources },
        fetchState: page.state,
        fetchedAt: page.state === 'discovered' || page.state === 'robots-blocked'
          ? null
          : sql`coalesce(${siteCrawlPages.fetchedAt}, ${now})`,
        httpStatus: page.statusCode,
        contentType: page.contentType,
        finalUrl: page.finalUrl,
        redirectChain: page.redirectChain.map((hop) => hop.to),
        directives: { metaRobots: page.metaRobots, xRobots: page.xRobots },
        canonicalUrl: page.canonicalUrl,
        canonicalNodeKey: page.canonicalUrl ? nodeKeyByUrl.get(page.canonicalUrl) ?? null : null,
        indexabilityState: page.indexability.state,
        indexabilityReasons: page.indexability.reasons,
        auditState: pageAuditState(page),
        auditScore: audit?.overallScore ?? null,
        auditFields: audit ? { factors: audit.factors.map(toPageFactor) } : {},
        inventoryEligible: isInventoryEligible(page),
        depth: page.depth,
        inboundUniqueEdges: page.metrics.inbound.uniqueEdges,
        outboundUniqueEdges: page.metrics.outbound.uniqueEdges,
        inboundOccurrences: page.metrics.inbound.totalOccurrences,
        outboundOccurrences: page.metrics.outbound.totalOccurrences,
        linkScoreRaw: page.metrics.linkScoreRaw,
        linkScoreNormalized: page.metrics.linkScore,
        updatedAt: now,
      },
    }).run()

  }

  const persistPages = (tx: DatabaseTransaction, pages: CrawlPageObservation[], now: string): void => {
    const changedUrls = new Set<string>()
    // Register a whole event before writing references: the final HTML node
    // wins even when it sorts before or after its redirect alias.
    for (const page of pages) registerPageNode(page, changedUrls)
    for (const page of pages) persistPage(tx, page, now)
    bindReferences(tx, changedUrls, now)
  }

  const persistEdge = (tx: DatabaseTransaction, edge: CrawlEdgeObservation, now: string): void => {
    observedEdges.set(edge.key, edge)
    tx.insert(siteCrawlEdges).values({
      id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: edge.key,
      sourceNodeKey: nodeKeyByUrl.get(edge.from) ?? edge.from,
      sourceUrl: edge.from,
      targetNodeKey: nodeKeyByUrl.get(edge.to) ?? null,
      targetUrl: edge.to,
      relation: edge.type,
      internal: edge.classification === 'internal',
      followable: edge.followableOccurrences > 0,
      occurrences: edge.totalOccurrences,
      followableOccurrences: edge.followableOccurrences,
      nofollowOccurrences: edge.nofollowOccurrences,
      anchors: edge.anchorSummaries.map((anchor) => anchor.text),
      createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [siteCrawlEdges.projectId, siteCrawlEdges.runId, siteCrawlEdges.attemptId, siteCrawlEdges.edgeKey],
      set: {
        sourceNodeKey: nodeKeyByUrl.get(edge.from) ?? edge.from,
        sourceUrl: edge.from,
        targetNodeKey: nodeKeyByUrl.get(edge.to) ?? null,
        targetUrl: edge.to,
        relation: edge.type,
        internal: edge.classification === 'internal',
        followable: edge.followableOccurrences > 0,
        occurrences: edge.totalOccurrences,
        followableOccurrences: edge.followableOccurrences,
        nofollowOccurrences: edge.nofollowOccurrences,
        anchors: edge.anchorSummaries.map((anchor) => anchor.text),
        updatedAt: now,
      },
    }).run()
  }

  const persistMetrics = (tx: DatabaseTransaction, key: string, metrics: CrawlPageMetrics, now: string): void => {
    tx.update(siteCrawlPages).set({
      inboundUniqueEdges: metrics.inbound.uniqueEdges,
      outboundUniqueEdges: metrics.outbound.uniqueEdges,
      inboundOccurrences: metrics.inbound.totalOccurrences,
      outboundOccurrences: metrics.outbound.totalOccurrences,
      depth: metrics.shortestFollowableAnchorDepth,
      linkScoreRaw: metrics.linkScoreRaw,
      linkScoreNormalized: metrics.linkScore,
      updatedAt: now,
    }).where(and(
      eq(siteCrawlPages.projectId, projectId),
      eq(siteCrawlPages.runId, runId),
      eq(siteCrawlPages.attemptId, attemptId),
      eq(siteCrawlPages.nodeKey, key),
    )).run()
  }

  const persistEvent = async (event: CrawlEvent): Promise<void> => {
    const now = new Date().toISOString()
    db.transaction((tx) => {
      const receipt = tx.select({ checksum: siteCrawlEventReceipts.checksum })
        .from(siteCrawlEventReceipts)
        .where(and(
          eq(siteCrawlEventReceipts.attemptId, attemptId),
          eq(siteCrawlEventReceipts.sequence, event.sequence),
          eq(siteCrawlEventReceipts.batchId, event.batchId),
        )).get()
      if (receipt) {
        if (receipt.checksum !== event.checksum) {
          throw new Error(`Crawl checkpoint checksum mismatch for ${event.batchId} (${event.sequence})`)
        }
        return
      }

      tx.insert(siteCrawlEventReceipts).values({
        id: crypto.randomUUID(), projectId, runId, attemptId,
        sequence: event.sequence, batchId: event.batchId, checksum: event.checksum,
        receipt: { type: event.type }, createdAt: now,
      }).run()

      if (event.type === 'pages') persistPages(tx, event.rows, now)
      if (event.type === 'edges') for (const edge of event.rows) persistEdge(tx, edge, now)
      if (event.type === 'metrics') for (const metric of event.rows) persistMetrics(tx, metric.key, metric.metrics, now)

      const progress = event.type === 'progress'
        ? event.progress
        : event.type === 'summary'
          ? event.summary
          : null
      if (progress) {
        tx.update(siteCrawlAttempts).set({
          lastEventSequence: event.sequence,
          lastEventChecksum: event.checksum,
          pagesDiscovered: progress.pagesDiscovered,
          pagesFetched: progress.pagesFetched,
          pagesEligible: event.type === 'summary'
            ? observedPages.size === 0 ? 0 : [...observedPages.values()].filter(isInventoryEligible).length
            : sql`${siteCrawlAttempts.pagesEligible}`,
          pagesErrored: event.type === 'summary' ? observedErrorCount(observedPages.values()) : sql`${siteCrawlAttempts.pagesErrored}`,
          edgesDiscovered: progress.edgesObserved,
          updatedAt: now,
        }).where(eq(siteCrawlAttempts.id, attemptId)).run()
      } else {
        tx.update(siteCrawlAttempts).set({
          lastEventSequence: event.sequence,
          lastEventChecksum: event.checksum,
          updatedAt: now,
        }).where(eq(siteCrawlAttempts.id, attemptId)).run()
      }
    })
  }

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project not found: ${projectId}`)

    const homepageUrl = toHomepageUrl(project.canonicalDomain)
    const maxPages = clampSiteAuditLimit(opts.maxPages ?? opts.limit)
    const maxEdges = clampSiteAuditEdgeLimit(opts.maxEdges)
    await assertSiteAuditUrlAllowed(homepageUrl, 'canonicalDomain')
    if (opts.sitemapUrl) await assertSiteAuditUrlAllowed(opts.sitemapUrl, 'sitemapUrl')

    log.info('start', { runId, projectId, homepageUrl, maxPages, maxEdges, maxDepth: opts.maxDepth ?? null })
    const report: SiteCrawlReport = await runSiteCrawl(homepageUrl, {
      mode: 'summary',
      sitemapUrl: opts.sitemapUrl,
      maxPages,
      maxEdges,
      maxDepth: opts.maxDepth,
      checkDeadLinks: opts.checkDeadLinks ?? false,
      signal: opts.signal,
      onEvent: persistEvent,
    })

    const crawlSummary = report.summary
    const hasAuditedPages = crawlSummary.auditRollup.auditedPages > 0
    if (crawlSummary.complete && !hasAuditedPages) {
      throw emptyCompleteCrawlError(crawlSummary.rootUrl, crawlSummary.finalRootUrl, crawlSummary.pagesObserved)
    }

    const finishedAt = new Date().toISOString()
    const factors = computeFactorAverages([...observedPages.values()])
    const errorCount = observedErrorCount(observedPages.values())
    const terminalStatus: RunStatus = crawlSummary.complete ? 'completed' : 'partial'
    const deadLinksChecked = opts.checkDeadLinks ? deadLinkCheckedCount(observedEdges.values(), observedPages.values()) : 0
    const deadLinksFound = report.deadLinks.findings.length
    const legacyIssues = factors.map((factor) => toLegacyIssue(factor, crawlSummary.auditRollup.auditedPages)).filter((issue): issue is SiteAuditCrossCuttingIssueDto => issue !== null)

    const published = db.transaction((tx) => {
      // Claim terminal publication first, in the same transaction as every
      // snapshot write. If cancellation already won, do not leave an orphaned
      // complete/partial graph behind a cancelled run.
      const claim = tx.update(runs).set({ status: terminalStatus, finishedAt })
        .where(and(eq(runs.id, runId), eq(runs.status, 'running'))).run()
      if (claim.changes === 0) return false

      // Preserve compatibility only when a real scorecard exists. A partial
      // traversal with zero successful page audits still publishes its graph
      // below, but must not surface a deceptive legacy score of zero.
      if (hasAuditedPages) {
        tx.insert(siteAuditSnapshots).values({
          id: crypto.randomUUID(), projectId, runId,
          sitemapUrl: opts.sitemapUrl ?? `${homepageUrl}/sitemap.xml`,
          auditedAt: crawlSummary.completedAt,
          aggregateScore: crawlSummary.auditRollup.aggregateScore ?? 0,
          pagesDiscovered: crawlSummary.pagesDiscovered,
          pagesAudited: crawlSummary.auditRollup.auditedPages,
          pagesSkipped: Math.max(0, crawlSummary.pagesDiscovered - crawlSummary.pagesObserved),
          pagesErrored: errorCount,
          factorAverages: factors,
          crossCuttingIssues: legacyIssues,
          prioritizedFixes: legacyIssues.map((issue) => `Improve ${issue.factorName}`),
          createdAt: finishedAt,
        }).run()
        for (const page of observedPages.values()) {
          if (!isLegacyScorecardPage(page)) continue
          tx.insert(siteAuditPages).values({
            id: crypto.randomUUID(), projectId, runId,
            url: page.finalUrl ?? page.requestedUrl,
            overallScore: page.audit?.overallScore ?? 0,
            status: page.audit ? 'success' : 'error',
            error: page.error,
            factors: page.audit?.factors.map(toPageFactor) ?? [],
            createdAt: finishedAt,
          }).run()
        }
      }

      tx.insert(siteCrawlSnapshots).values({
        id: crypto.randomUUID(), projectId, runId, attemptId,
        rootUrl: crawlSummary.rootUrl,
        crawlSchemaVersion: crawlSummary.crawlSchemaVersion,
        engineVersion: crawlSummary.engineVersion,
        normalizationVersion: crawlSummary.urlNormalizationVersion,
        indexabilityVersion: crawlSummary.indexabilityRulesetVersion,
        linkScoreVersion: crawlSummary.linkScoreAlgorithmVersion,
        effectiveOptions: {
          mode: 'summary', sitemapUrl: opts.sitemapUrl ?? null, maxPages, maxEdges,
          maxDepth: opts.maxDepth ?? null, checkDeadLinks: opts.checkDeadLinks ?? false,
        },
        pageBudget: maxPages,
        edgeBudget: maxEdges,
        maxDepth: opts.maxDepth ?? null,
        checkDeadLinks: opts.checkDeadLinks ?? false,
        complete: crawlSummary.complete,
        termination: crawlSummary.terminationReason ?? 'complete',
        detailsAvailable: true,
        pagesDiscovered: crawlSummary.pagesDiscovered,
        pagesFetched: crawlSummary.pagesFetched,
        pagesEligible: [...observedPages.values()].filter(isInventoryEligible).length,
        pagesErrored: errorCount,
        edgesDiscovered: crawlSummary.edgesObserved,
        findingsCount: deadLinksFound,
        deadLinkState: report.deadLinks.state,
        deadLinksChecked,
        deadLinksFound,
        createdAt: finishedAt,
        updatedAt: finishedAt,
      }).run()
      if (opts.checkDeadLinks) {
        for (const finding of report.deadLinks.findings) {
          tx.insert(siteCrawlFindings).values({
            id: crypto.randomUUID(), projectId, runId, attemptId,
            findingKey: finding.key,
            findingType: 'dead-link', severity: 'error',
            sourceNodeKey: nodeKeyByUrl.get(finding.from) ?? null,
            sourceUrl: finding.from,
            targetNodeKey: nodeKeyByUrl.get(finding.to) ?? null,
            targetUrl: finding.to,
            evidence: { statusCode: finding.statusCode, reason: finding.reason },
            createdAt: finishedAt, updatedAt: finishedAt,
          }).run()
        }
      }

      tx.update(siteCrawlAttempts).set({
        state: terminalStatus,
        pagesDiscovered: crawlSummary.pagesDiscovered,
        pagesFetched: crawlSummary.pagesFetched,
        pagesEligible: [...observedPages.values()].filter(isInventoryEligible).length,
        pagesErrored: errorCount,
        edgesDiscovered: crawlSummary.edgesObserved,
        finishedAt,
        updatedAt: finishedAt,
      }).where(eq(siteCrawlAttempts.id, attemptId)).run()
      return true
    })

    if (!published) {
      const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()
      if (current?.status === 'cancelled') throw new SiteAuditCancelledError(`Site audit cancelled before publication: ${runId}`)
      throw new Error(`Site audit run was no longer running before publication: ${runId}`)
    }

    log.info('completed', { runId, projectId, status: terminalStatus, complete: crawlSummary.complete, pages: crawlSummary.pagesObserved })
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const cancelled = isCancelled(error, opts.signal)
    const message = error instanceof Error ? error.message : String(error)
    db.transaction((tx) => {
      tx.update(siteCrawlAttempts).set({
        state: cancelled ? 'cancelled' : 'failed',
        error: message,
        finishedAt,
        updatedAt: finishedAt,
      }).where(eq(siteCrawlAttempts.id, attemptId)).run()
      tx.update(runs).set({
        status: cancelled ? 'cancelled' : 'failed',
        error: message,
        finishedAt,
      }).where(and(eq(runs.id, runId), eq(runs.status, 'running'))).run()
    })
    log.error('failed', { runId, projectId, cancelled, error: message })
    throw error
  }
}
