import crypto from 'node:crypto'
import { and, asc, count, desc, eq, inArray, lt, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  runs,
  siteAuditPages,
  siteAuditSnapshots,
  siteCrawlEdges,
  siteCrawlFindings,
  siteCrawlPages,
  siteCrawlRunRequests,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  SiteAuditTrendDirections,
  normalizeSiteAuditRunRequest,
  notFound,
  operationInProgress,
  siteAuditRequestIdentity,
  siteAuditRunRequestSchema,
  validationError,
  type RunStatus,
  type SiteAuditPageDto,
  type SiteAuditPagesResponseDto,
  type SiteAuditScoreDto,
  type SiteAuditTrendResponseDto,
  type SiteCrawlDeadLinksResponseDto,
  type SiteCrawlEdgeDto,
  type SiteCrawlInternalLinksResponseDto,
  type SiteCrawlNeighborsResponseDto,
  type SiteCrawlPageDto,
  type SiteCrawlPagesResponseDto,
  type SiteCrawlStructureResponseDto,
  type SiteCrawlSummaryDto,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'

export interface TechnicalAeoRoutesOptions {
  /**
   * Fired after a `site-audit` run row is created. Wire this in the host server
   * to `executeSiteAudit(...).then(() => runCoordinator.onRunCompleted(...))`.
   */
  onSiteAuditRequested?: (runId: string, projectId: string, opts?: {
    sitemapUrl?: string
    /** @deprecated Compatibility alias for maxPages. */
    limit?: number
    maxPages?: number
    maxEdges?: number
    maxDepth?: number
    checkDeadLinks?: boolean
  }) => void
}

/** Run statuses that count as a real, surfaceable site audit. */
const SURFACEABLE_STATUSES = [RunStatuses.completed, RunStatuses.partial]

function emptyScore(projectName: string): SiteAuditScoreDto {
  return {
    project: projectName,
    hasData: false,
    runId: null,
    runStatus: null,
    sitemapUrl: null,
    auditedAt: null,
    aggregateScore: 0,
    pagesDiscovered: 0,
    pagesAudited: 0,
    pagesSkipped: 0,
    pagesErrored: 0,
    deltaScore: null,
    trend: null,
    previousScore: null,
    previousAuditedAt: null,
    factors: [],
    crossCuttingIssues: [],
    prioritizedFixes: [],
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(max, Math.floor(n))
}

function parseBoundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = parsePositiveInt(value, fallback, max)
  return Math.max(1, parsed)
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return null
}

/** Opaque offset cursor. Every list is bounded, and callers cannot select raw offsets. */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url')
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return 0
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown }
    return typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0
      ? Math.min(parsed.offset, 1_000_000)
      : 0
  } catch {
    return 0
  }
}

function normalizeParentPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '/'
  const bare = value.trim().split(/[?#]/, 1)[0] ?? '/'
  const prefixed = bare.startsWith('/') ? bare : `/${bare}`
  const collapsed = prefixed.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

/** A persisted crawl is capped by the run request contract at 50,000 pages. */
const MAX_STRUCTURE_SOURCE_ROWS = 50_000

/** Folder identity deliberately folds trailing slashes without changing URL identity. */
function structureHierarchyPath(path: string): string {
  if (path.length <= 1) return path
  return path.replace(/\/+$/, '') || '/'
}

/**
 * Project one persisted page into the immediate child folder below `parentPath`.
 * This stays in JS so path delimiters are never handed to a dialect-specific
 * SQL function (or to LIKE, where literal `%` and `_` become wildcards).
 */
function structureChildPath(parentPath: string, path: string): string | null {
  const hierarchyPath = structureHierarchyPath(path)
  if (hierarchyPath === parentPath) return null

  const relative = parentPath === '/'
    ? hierarchyPath.startsWith('/') ? hierarchyPath.slice(1) : ''
    : hierarchyPath.startsWith(`${parentPath}/`) ? hierarchyPath.slice(parentPath.length + 1) : ''
  if (relative.length === 0) return null

  const separator = relative.indexOf('/')
  const segment = separator === -1 ? relative : relative.slice(0, separator)
  return parentPath === '/' ? `/${segment}` : `${parentPath}/${segment}`
}

function mapCrawlPage(row: typeof siteCrawlPages.$inferSelect): SiteCrawlPageDto {
  return {
    nodeKey: row.nodeKey,
    url: row.url,
    finalUrl: row.finalUrl,
    path: row.path,
    parentPath: row.parentPath,
    discoverySource: row.discoverySource,
    fetchState: row.fetchState,
    httpStatus: row.httpStatus,
    canonicalUrl: row.canonicalUrl,
    indexabilityState: row.indexabilityState,
    indexabilityReasons: row.indexabilityReasons,
    auditState: row.auditState,
    auditScore: row.auditScore,
    inventoryEligible: row.inventoryEligible,
    depth: row.depth,
    inboundUniqueEdges: row.inboundUniqueEdges,
    outboundUniqueEdges: row.outboundUniqueEdges,
    inboundOccurrences: row.inboundOccurrences,
    outboundOccurrences: row.outboundOccurrences,
    linkScoreRaw: row.linkScoreRaw,
    linkScoreNormalized: row.linkScoreNormalized,
  }
}

function mapCrawlEdge(row: typeof siteCrawlEdges.$inferSelect): SiteCrawlEdgeDto {
  return {
    edgeKey: row.edgeKey,
    sourceNodeKey: row.sourceNodeKey,
    sourceUrl: row.sourceUrl,
    targetNodeKey: row.targetNodeKey,
    targetUrl: row.targetUrl,
    relation: row.relation,
    internal: row.internal,
    followable: row.followable,
    occurrences: row.occurrences,
    followableOccurrences: row.followableOccurrences,
    nofollowOccurrences: row.nofollowOccurrences,
    anchors: row.anchors,
  }
}

export async function technicalAeoRoutes(app: FastifyInstance, opts: TechnicalAeoRoutesOptions) {
  /** Resolve only a real, visible site-audit crawl in this exact project. */
  const resolveCrawl = (projectId: string, runId?: string) => {
    const filters = [
      eq(siteCrawlSnapshots.projectId, projectId),
      eq(runs.projectId, projectId),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ]
    if (runId) {
      // Historical inspection may intentionally select an older partial
      // snapshot. It is never the default current graph.
      filters.push(eq(siteCrawlSnapshots.runId, runId))
    } else {
      // A live/current graph is an immutable successful publication only.
      // In-progress attempt rows are deliberately excluded, and a later
      // partial crawl cannot displace the prior complete graph.
      filters.push(eq(siteCrawlSnapshots.complete, true), eq(runs.status, RunStatuses.completed))
    }
    return app.db
      .select({ snapshot: siteCrawlSnapshots, runStatus: runs.status })
      .from(siteCrawlSnapshots)
      .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
      .where(and(...filters))
      .orderBy(desc(siteCrawlSnapshots.createdAt))
      .limit(1)
      .get()
  }

  /** Legacy rows are a scorecard only: they never stand in for a crawl graph. */
  const hasLegacyAudit = (projectId: string): boolean => Boolean(app.db
    .select({ runId: siteAuditSnapshots.runId })
    .from(siteAuditSnapshots)
    .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
    .where(and(
      eq(siteAuditSnapshots.projectId, projectId),
      eq(runs.projectId, projectId),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ))
    .limit(1)
    .get())

  const emptyCrawlSummary = (projectName: string, legacyAuditAvailable: boolean): SiteCrawlSummaryDto => ({
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable,
    runId: null,
    runStatus: null,
    rootUrl: null,
    effectiveOptions: {},
    complete: false,
    termination: null,
    detailsAvailable: false,
    counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
    deadLinks: { state: 'unavailable' },
  })

  // GET /projects/:name/technical-aeo — latest scorecard, or one historical run, + delta vs prior run.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string }
  }>('/projects/:name/technical-aeo', async (request): Promise<SiteAuditScoreDto> => {
    const project = resolveProject(app.db, request.params.name)
    const baseFilters = [
      eq(siteAuditSnapshots.projectId, project.id),
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ]
    const targetFilters = request.query.runId
      ? [...baseFilters, eq(siteAuditSnapshots.runId, request.query.runId)]
      : baseFilters
    const latest = app.db
      .select({ snap: siteAuditSnapshots, runStatus: runs.status })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(...targetFilters))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()

    if (!latest) {
      if (request.query.runId) throw notFound('Site audit run', request.query.runId)
      return emptyScore(project.name)
    }

    const snap = latest.snap
    const previous = app.db
      .select({ snap: siteAuditSnapshots })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(...baseFilters, lt(siteAuditSnapshots.createdAt, snap.createdAt)))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()?.snap ?? null
    const deltaScore = previous ? snap.aggregateScore - previous.aggregateScore : null
    const trend = deltaScore == null
      ? null
      : deltaScore > 0
        ? SiteAuditTrendDirections.up
        : deltaScore < 0
          ? SiteAuditTrendDirections.down
          : SiteAuditTrendDirections.flat

    return {
      project: project.name,
      hasData: true,
      runId: snap.runId,
      runStatus: latest.runStatus as RunStatus,
      sitemapUrl: snap.sitemapUrl,
      auditedAt: snap.auditedAt,
      aggregateScore: snap.aggregateScore,
      pagesDiscovered: snap.pagesDiscovered,
      pagesAudited: snap.pagesAudited,
      pagesSkipped: snap.pagesSkipped,
      pagesErrored: snap.pagesErrored,
      deltaScore,
      trend,
      previousScore: previous?.aggregateScore ?? null,
      previousAuditedAt: previous?.auditedAt ?? null,
      factors: snap.factorAverages,
      crossCuttingIssues: snap.crossCuttingIssues,
      prioritizedFixes: snap.prioritizedFixes,
    }
  })

  // GET /projects/:name/technical-aeo/pages — per-page breakdown of the latest or selected run.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; status?: string; sort?: string; limit?: string; offset?: string }
  }>('/projects/:name/technical-aeo/pages', async (request): Promise<SiteAuditPagesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)

    // Latest surfaceable site-audit run for this project, or the explicitly selected run.
    const targetFilters = [
      eq(siteAuditSnapshots.projectId, project.id),
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ]
    if (request.query.runId) targetFilters.push(eq(siteAuditSnapshots.runId, request.query.runId))
    const latest = app.db
      .select({ runId: siteAuditSnapshots.runId, auditedAt: siteAuditSnapshots.auditedAt })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(...targetFilters))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()

    if (!latest && request.query.runId) {
      throw notFound('Site audit run', request.query.runId)
    }
    if (!latest) {
      return { project: project.name, runId: null, auditedAt: null, total: 0, pages: [] }
    }

    const statusFilter = request.query.status === 'success' || request.query.status === 'error'
      ? request.query.status
      : null
    const conds = [eq(siteAuditPages.projectId, project.id), eq(siteAuditPages.runId, latest.runId)]
    if (statusFilter) conds.push(eq(siteAuditPages.status, statusFilter))
    const where = and(...conds)

    const totalRow = app.db.select({ value: count() }).from(siteAuditPages).where(where).get()
    const total = totalRow?.value ?? 0

    const limit = parsePositiveInt(request.query.limit, 100, 500)
    const offset = parsePositiveInt(request.query.offset, 0, Number.MAX_SAFE_INTEGER)
    const orderBy = request.query.sort === 'score-desc'
      ? desc(siteAuditPages.overallScore)
      : request.query.sort === 'url'
        ? asc(siteAuditPages.url)
        : asc(siteAuditPages.overallScore)

    const rows = app.db
      .select()
      .from(siteAuditPages)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset)
      .all()

    const pages: SiteAuditPageDto[] = rows.map((row) => ({
      url: row.url,
      overallScore: row.overallScore,
      status: row.status === 'error' ? 'error' : 'success',
      error: row.error,
      factors: row.factors,
    }))

    return { project: project.name, runId: latest.runId, auditedAt: latest.auditedAt, total, pages }
  })

  // GET /projects/:name/technical-aeo/trend — aggregate score over time (oldest-first).
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/technical-aeo/trend', async (request): Promise<SiteAuditTrendResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const limit = parsePositiveInt(request.query.limit, 30, 365)

    const rows = app.db
      .select({
        runId: siteAuditSnapshots.runId,
        auditedAt: siteAuditSnapshots.auditedAt,
        aggregateScore: siteAuditSnapshots.aggregateScore,
        pagesAudited: siteAuditSnapshots.pagesAudited,
      })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(
        eq(siteAuditSnapshots.projectId, project.id),
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, SURFACEABLE_STATUSES),
        notProbeRun(),
      ))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(limit)
      .all()

    return { project: project.name, points: rows.reverse() }
  })

  // GET /projects/:name/technical-aeo/crawl — persisted crawl metadata only;
  // legacy scorecard rows never fabricate a graph-shaped response.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string }
  }>('/projects/:name/technical-aeo/crawl', async (request): Promise<SiteCrawlSummaryDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    const legacyAuditAvailable = hasLegacyAudit(project.id)
    if (!target) {
      if (request.query.runId) throw notFound('Site crawl run', request.query.runId)
      return emptyCrawlSummary(project.name, legacyAuditAvailable)
    }

    const snapshot = target.snapshot
    const deadLinks = !snapshot.checkDeadLinks || snapshot.deadLinkState === 'disabled'
      ? { state: 'disabled' as const }
      : snapshot.deadLinkState === 'complete'
        ? { state: 'complete' as const, checked: snapshot.deadLinksChecked, found: snapshot.deadLinksFound }
        : snapshot.deadLinkState === 'partial'
          ? { state: 'partial' as const, checked: snapshot.deadLinksChecked, found: snapshot.deadLinksFound }
          : { state: 'unavailable' as const }

    return {
      project: project.name,
      hasCrawlData: true,
      legacyAuditAvailable,
      runId: snapshot.runId,
      runStatus: target.runStatus as RunStatus,
      rootUrl: snapshot.rootUrl,
      crawlSchemaVersion: snapshot.crawlSchemaVersion,
      engineVersion: snapshot.engineVersion,
      normalizationVersion: snapshot.normalizationVersion,
      indexabilityVersion: snapshot.indexabilityVersion,
      linkScoreVersion: snapshot.linkScoreVersion,
      effectiveOptions: snapshot.effectiveOptions,
      complete: snapshot.complete,
      termination: snapshot.termination,
      detailsAvailable: snapshot.detailsAvailable,
      counts: {
        pagesDiscovered: snapshot.pagesDiscovered,
        pagesFetched: snapshot.pagesFetched,
        pagesEligible: snapshot.pagesEligible,
        edges: snapshot.edgesDiscovered,
        findings: snapshot.findingsCount,
      },
      deadLinks,
    }
  })

  // GET /projects/:name/technical-aeo/crawl/pages — filterable, cursor-paged
  // crawl nodes. A crawl summary may exist before detail persistence finishes.
  app.get<{
    Params: { name: string }
    Querystring: {
      runId?: string
      cursor?: string
      limit?: string
      inventoryEligible?: string
      fetchState?: string
      indexabilityState?: string
      auditState?: string
      sort?: string
    }
  }>('/projects/:name/technical-aeo/crawl/pages', async (request): Promise<SiteCrawlPagesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      if (request.query.runId) throw notFound('Site crawl run', request.query.runId)
      return { project: project.name, hasCrawlData: false, runId: null, total: 0, nextCursor: null, pages: [] }
    }
    const snapshot = target.snapshot
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return { project: project.name, hasCrawlData: true, runId: snapshot.runId, total: 0, nextCursor: null, pages: [] }
    }

    const filters = [
      eq(siteCrawlPages.projectId, project.id),
      eq(siteCrawlPages.runId, snapshot.runId),
      eq(siteCrawlPages.attemptId, snapshot.attemptId),
    ]
    const inventoryEligible = parseBoolean(request.query.inventoryEligible)
    if (inventoryEligible != null) filters.push(eq(siteCrawlPages.inventoryEligible, inventoryEligible))
    if (request.query.fetchState) filters.push(eq(siteCrawlPages.fetchState, request.query.fetchState))
    if (request.query.indexabilityState) filters.push(eq(siteCrawlPages.indexabilityState, request.query.indexabilityState))
    if (request.query.auditState) filters.push(eq(siteCrawlPages.auditState, request.query.auditState))
    const where = and(...filters)
    const total = app.db.select({ value: count() }).from(siteCrawlPages).where(where).get()?.value ?? 0
    const limit = parseBoundedLimit(request.query.limit, 100, 200)
    const offset = decodeCursor(request.query.cursor)
    const orderBy = request.query.sort === 'score-desc'
      ? [desc(siteCrawlPages.auditScore), asc(siteCrawlPages.nodeKey)] as const
      : request.query.sort === 'score-asc'
        ? [asc(siteCrawlPages.auditScore), asc(siteCrawlPages.nodeKey)] as const
        : request.query.sort === 'path'
          ? [asc(siteCrawlPages.path), asc(siteCrawlPages.nodeKey)] as const
          : [asc(siteCrawlPages.url), asc(siteCrawlPages.nodeKey)] as const
    const rows = app.db.select().from(siteCrawlPages).where(where).orderBy(...orderBy).limit(limit).offset(offset).all()
    const nextOffset = offset + rows.length
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      pages: rows.map(mapCrawlPage),
    }
  })

  // GET /projects/:name/technical-aeo/structure — one path level only. This
  // deliberately cannot materialize an unbounded site tree.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; parentPath?: string; cursor?: string; limit?: string }
  }>('/projects/:name/technical-aeo/structure', async (request): Promise<SiteCrawlStructureResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const parentPath = normalizeParentPath(request.query.parentPath)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      if (request.query.runId) throw notFound('Site crawl run', request.query.runId)
      return { project: project.name, hasCrawlData: false, runId: null, parentPath, nextCursor: null, children: [] }
    }
    const snapshot = target.snapshot
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return { project: project.name, hasCrawlData: true, runId: snapshot.runId, parentPath, nextCursor: null, children: [] }
    }

    // A crawl cannot persist more than MAX_STRUCTURE_SOURCE_ROWS pages. Read
    // only the columns needed for a one-level projection, then aggregate in
    // JS. This keeps delimiter parsing dialect-neutral and treats `%` / `_`
    // literally instead of giving them LIKE semantics.
    const sourceRows = app.db
      .select({
        path: siteCrawlPages.path,
        url: siteCrawlPages.url,
        inventoryEligible: siteCrawlPages.inventoryEligible,
        fetchState: siteCrawlPages.fetchState,
      })
      .from(siteCrawlPages)
      .where(and(
        eq(siteCrawlPages.projectId, project.id),
        eq(siteCrawlPages.runId, snapshot.runId),
        eq(siteCrawlPages.attemptId, snapshot.attemptId),
      ))
      .limit(MAX_STRUCTURE_SOURCE_ROWS + 1)
      .all()
    if (sourceRows.length > MAX_STRUCTURE_SOURCE_ROWS) {
      throw validationError(`Persisted crawl exceeds the ${MAX_STRUCTURE_SOURCE_ROWS}-page structure limit`)
    }

    const children = new Map<string, {
      url: string | null
      hasPage: boolean
      pageCount: number
      inventoryEligibleCount: number
      fetchedCount: number
    }>()
    for (const row of sourceRows) {
      const childPath = structureChildPath(parentPath, row.path)
      if (!childPath) continue
      const child = children.get(childPath) ?? {
        url: null,
        hasPage: false,
        pageCount: 0,
        inventoryEligibleCount: 0,
        fetchedCount: 0,
      }
      child.pageCount++
      if (row.inventoryEligible) child.inventoryEligibleCount++
      if (['html', 'redirect', 'non-html', 'fetch-error', 'fetched'].includes(row.fetchState)) child.fetchedCount++
      if (structureHierarchyPath(row.path) === childPath) {
        child.hasPage = true
        // Preserve the old SQL `max(url)` tie break when both `/docs` and
        // `/docs/` are observed as distinct URL identities.
        if (child.url == null || row.url > child.url) child.url = row.url
      }
      children.set(childPath, child)
    }

    const limit = parseBoundedLimit(request.query.limit, 50, 100)
    const offset = decodeCursor(request.query.cursor)
    const sortedChildren = [...children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
    const page = sortedChildren.slice(offset, offset + limit + 1)
    const hasMore = page.length > limit
    const visible = hasMore ? page.slice(0, limit) : page
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      parentPath,
      nextCursor: hasMore ? encodeCursor(offset + visible.length) : null,
      children: visible.map(([path, child]) => ({
        path,
        url: child.url,
        hasPage: child.hasPage,
        pageCount: child.pageCount,
        inventoryEligibleCount: child.inventoryEligibleCount,
        fetchedCount: child.fetchedCount,
      })),
    }
  })

  // GET /projects/:name/technical-aeo/internal-links — cursor-paged internal
  // edges, never the full graph in one response.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; cursor?: string; limit?: string; sourceUrl?: string; targetUrl?: string; followable?: string }
  }>('/projects/:name/technical-aeo/internal-links', async (request): Promise<SiteCrawlInternalLinksResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      if (request.query.runId) throw notFound('Site crawl run', request.query.runId)
      return { project: project.name, hasCrawlData: false, runId: null, total: 0, nextCursor: null, edges: [] }
    }
    const snapshot = target.snapshot
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return { project: project.name, hasCrawlData: true, runId: snapshot.runId, total: 0, nextCursor: null, edges: [] }
    }

    const filters = [
      eq(siteCrawlEdges.projectId, project.id),
      eq(siteCrawlEdges.runId, snapshot.runId),
      eq(siteCrawlEdges.attemptId, snapshot.attemptId),
      eq(siteCrawlEdges.internal, true),
    ]
    if (request.query.sourceUrl) filters.push(eq(siteCrawlEdges.sourceUrl, request.query.sourceUrl))
    if (request.query.targetUrl) filters.push(eq(siteCrawlEdges.targetUrl, request.query.targetUrl))
    const followable = parseBoolean(request.query.followable)
    if (followable != null) filters.push(eq(siteCrawlEdges.followable, followable))
    const where = and(...filters)
    const total = app.db.select({ value: count() }).from(siteCrawlEdges).where(where).get()?.value ?? 0
    const limit = parseBoundedLimit(request.query.limit, 100, 200)
    const offset = decodeCursor(request.query.cursor)
    const rows = app.db
      .select()
      .from(siteCrawlEdges)
      .where(where)
      .orderBy(asc(siteCrawlEdges.edgeKey))
      .limit(limit)
      .offset(offset)
      .all()
    const nextOffset = offset + rows.length
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      edges: rows.map(mapCrawlEdge),
    }
  })

  // GET /projects/:name/technical-aeo/internal-links/neighbors — a bounded
  // local graph neighborhood for one canonical node/URL.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; nodeKey?: string; url?: string; limit?: string }
  }>('/projects/:name/technical-aeo/internal-links/neighbors', async (request): Promise<SiteCrawlNeighborsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    if (!request.query.nodeKey && !request.query.url) {
      throw validationError('Provide nodeKey or url')
    }
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      if (request.query.runId) throw notFound('Site crawl run', request.query.runId)
      return {
        project: project.name, hasCrawlData: false, runId: null, nodeKey: request.query.nodeKey ?? null, url: request.query.url ?? null,
        inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
      }
    }
    const snapshot = target.snapshot
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return {
        project: project.name, hasCrawlData: true, runId: snapshot.runId, nodeKey: request.query.nodeKey ?? null, url: request.query.url ?? null,
        inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
      }
    }
    const scope = [
      eq(siteCrawlEdges.projectId, project.id),
      eq(siteCrawlEdges.runId, snapshot.runId),
      eq(siteCrawlEdges.attemptId, snapshot.attemptId),
      eq(siteCrawlEdges.internal, true),
    ]
    const inboundMatch = request.query.nodeKey && request.query.url
      ? or(eq(siteCrawlEdges.targetNodeKey, request.query.nodeKey), eq(siteCrawlEdges.targetUrl, request.query.url))
      : request.query.nodeKey
        ? eq(siteCrawlEdges.targetNodeKey, request.query.nodeKey)
        : eq(siteCrawlEdges.targetUrl, request.query.url!)
    const outboundMatch = request.query.nodeKey && request.query.url
      ? or(eq(siteCrawlEdges.sourceNodeKey, request.query.nodeKey), eq(siteCrawlEdges.sourceUrl, request.query.url))
      : request.query.nodeKey
        ? eq(siteCrawlEdges.sourceNodeKey, request.query.nodeKey)
        : eq(siteCrawlEdges.sourceUrl, request.query.url!)
    const limit = parseBoundedLimit(request.query.limit, 50, 100)
    const inboundRows = app.db.select().from(siteCrawlEdges).where(and(...scope, inboundMatch)).orderBy(asc(siteCrawlEdges.edgeKey)).limit(limit + 1).all()
    const outboundRows = app.db.select().from(siteCrawlEdges).where(and(...scope, outboundMatch)).orderBy(asc(siteCrawlEdges.edgeKey)).limit(limit + 1).all()
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      nodeKey: request.query.nodeKey ?? null,
      url: request.query.url ?? null,
      inbound: inboundRows.slice(0, limit).map(mapCrawlEdge),
      outbound: outboundRows.slice(0, limit).map(mapCrawlEdge),
      inboundTruncated: inboundRows.length > limit,
      outboundTruncated: outboundRows.length > limit,
    }
  })

  // GET /projects/:name/technical-aeo/dead-links — no crawl opt-in is a
  // distinct state, never a deceptive empty list.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; cursor?: string; limit?: string }
  }>('/projects/:name/technical-aeo/dead-links', async (request): Promise<SiteCrawlDeadLinksResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    const legacyAuditAvailable = hasLegacyAudit(project.id)
    if (!target) {
      if (request.query.runId) throw notFound('Site crawl run', request.query.runId)
      return { project: project.name, runId: null, state: 'unavailable', legacyAuditAvailable }
    }
    const snapshot = target.snapshot
    if (!snapshot.checkDeadLinks || snapshot.deadLinkState === 'disabled') {
      return { project: project.name, runId: snapshot.runId, state: 'disabled', checkDeadLinks: false }
    }
    if (snapshot.deadLinkState === 'unavailable') {
      return { project: project.name, runId: snapshot.runId, state: 'unavailable', legacyAuditAvailable }
    }
    if (!snapshot.attemptId) {
      return { project: project.name, runId: snapshot.runId, state: 'partial', checkDeadLinks: true, checked: snapshot.deadLinksChecked, found: snapshot.deadLinksFound, total: 0, nextCursor: null, deadLinks: [] }
    }
    const where = and(
      eq(siteCrawlFindings.projectId, project.id),
      eq(siteCrawlFindings.runId, snapshot.runId),
      eq(siteCrawlFindings.attemptId, snapshot.attemptId),
      eq(siteCrawlFindings.findingType, 'dead-link'),
    )
    const total = app.db.select({ value: count() }).from(siteCrawlFindings).where(where).get()?.value ?? 0
    const limit = parseBoundedLimit(request.query.limit, 100, 200)
    const offset = decodeCursor(request.query.cursor)
    const rows = app.db.select().from(siteCrawlFindings).where(where).orderBy(asc(siteCrawlFindings.findingKey)).limit(limit).offset(offset).all()
    const nextOffset = offset + rows.length
    const deadLinks = rows.map((row) => ({
      findingKey: row.findingKey,
      severity: row.severity,
      sourceNodeKey: row.sourceNodeKey,
      sourceUrl: row.sourceUrl,
      targetNodeKey: row.targetNodeKey,
      targetUrl: row.targetUrl,
      evidence: row.evidence,
    }))
    const state = snapshot.deadLinkState === 'complete' ? 'complete' as const : 'partial' as const
    return {
      project: project.name,
      runId: snapshot.runId,
      state,
      checkDeadLinks: true,
      checked: snapshot.deadLinksChecked,
      found: snapshot.deadLinksFound,
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      deadLinks,
    }
  })

  // POST /projects/:name/technical-aeo/runs — exact-identity consolidation.
  app.post<{
    Params: { name: string }
    Body: { sitemapUrl?: string; limit?: number; maxPages?: number; maxEdges?: number; maxDepth?: number; checkDeadLinks?: boolean }
  }>('/projects/:name/technical-aeo/runs', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = siteAuditRunRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid site-audit request')
    }

    const effectiveRequest = normalizeSiteAuditRunRequest(parsed.data)
    const identityKey = siteAuditRequestIdentity(effectiveRequest)
    const result = app.db.transaction((tx) => {
      const existing = tx
        .select({
          id: runs.id,
          status: runs.status,
          identityKey: siteCrawlRunRequests.identityKey,
          effectiveOptions: siteCrawlRunRequests.effectiveOptions,
        })
        .from(runs)
        .leftJoin(siteCrawlRunRequests, and(
          eq(siteCrawlRunRequests.projectId, runs.projectId),
          eq(siteCrawlRunRequests.runId, runs.id),
        ))
        .where(and(
          eq(runs.projectId, project.id),
          eq(runs.kind, RunKinds['site-audit']),
          inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
        ))
        .get()
      if (existing) {
        if (existing.identityKey === identityKey) {
          return { runId: existing.id, status: existing.status as RunStatus, created: false }
        }
        throw operationInProgress(
          `A Technical AEO crawl is already ${existing.status} with different request options.`,
          {
            activeRunId: existing.id,
            activeStatus: existing.status,
            activeOptions: existing.effectiveOptions,
            requestedOptions: effectiveRequest,
          },
        )
      }

      const now = new Date().toISOString()
      const runId = crypto.randomUUID()
      tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['site-audit'],
        status: RunStatuses.queued,
        trigger: RunTriggers.manual,
        createdAt: now,
      }).run()
      tx.insert(siteCrawlRunRequests).values({
        runId,
        projectId: project.id,
        identityKey,
        effectiveOptions: effectiveRequest,
        createdAt: now,
      }).run()
      return { runId, status: RunStatuses.queued, created: true }
    })

    if (result.created) {
      opts.onSiteAuditRequested?.(result.runId, project.id, {
        sitemapUrl: effectiveRequest.sitemapUrl ?? undefined,
        limit: parsed.data.limit,
        maxPages: effectiveRequest.maxPages,
        maxEdges: effectiveRequest.maxEdges,
        maxDepth: effectiveRequest.maxDepth ?? undefined,
        checkDeadLinks: effectiveRequest.checkDeadLinks,
      })
    }

    return { runId: result.runId, status: result.status }
  })
}
