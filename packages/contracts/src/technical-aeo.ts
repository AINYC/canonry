import { z } from 'zod'
import { runStatusSchema } from './run.js'

// Keep this as an explicit union instead of `.nullable()`: OpenAPI 3.0 emits
// the latter as `nullable: true` beside an enum, which some client generators
// (including hey-api) discard. The union produces a correct `| null` client
// type while retaining the same runtime contract.
const nullableRunStatusSchema = z.union([runStatusSchema, z.null()])

/**
 * Technical AEO — site-wide technical audit surfaced from
 * `@canonry/aeo-audit`'s `runSiteCrawl`. A `site-audit` run discovers pages
 * from the root, robots/sitemaps, and internal links; audits each reachable
 * HTML page; and rolls the reports into a site score plus crawl graph.
 *
 * These DTOs are the public contract for the dashboard "Technical AEO" page,
 * the `canonry technical-aeo …` CLI, and the matching MCP tools. The underlying
 * run/schedule kind stays `site-audit` (the existing `RunKinds` value); the
 * product surface is named "Technical AEO".
 */

/** Per-factor / per-page health bucket — mirrors aeo-audit's `scoreToStatus`. */
export const siteAuditFactorStatusSchema = z.enum(['pass', 'partial', 'fail'])
export type SiteAuditFactorStatus = z.infer<typeof siteAuditFactorStatusSchema>
export const SiteAuditFactorStatuses = siteAuditFactorStatusSchema.enum

/**
 * Bucket a 0–100 score into pass / partial / fail. Same thresholds aeo-audit
 * uses (`pass ≥ 70`, `partial 40–69`, `fail < 40`) — kept here as a pure helper
 * so canonry can classify the site-level factor averages it computes itself
 * without taking a dependency on the audit package.
 */
export function factorStatusFromScore(score: number): SiteAuditFactorStatus {
  if (score >= 70) return SiteAuditFactorStatuses.pass
  if (score >= 40) return SiteAuditFactorStatuses.partial
  return SiteAuditFactorStatuses.fail
}

/** Direction of the latest score relative to the previous site-audit run. */
export const siteAuditTrendDirectionSchema = z.enum(['up', 'down', 'flat'])
export type SiteAuditTrendDirection = z.infer<typeof siteAuditTrendDirectionSchema>
export const SiteAuditTrendDirections = siteAuditTrendDirectionSchema.enum

/**
 * Site-level rollup of one ranking factor across every successfully-audited
 * page. `avgScore` is the mean of that factor's per-page scores;
 * `pagesPassing + pagesPartial + pagesFailing` always equals the number of
 * successfully-audited pages.
 */
export const siteAuditFactorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  avgScore: z.number(),
  /** Canonry's own pass/partial/fail banding of `avgScore` (aeo-audit v3 is gradeless). */
  status: siteAuditFactorStatusSchema,
  pagesPassing: z.number().int().nonnegative(),
  pagesPartial: z.number().int().nonnegative(),
  pagesFailing: z.number().int().nonnegative(),
})
export type SiteAuditFactorSummaryDto = z.infer<typeof siteAuditFactorSummarySchema>

/**
 * A factor that scores poorly across many pages — the "fix this once, lift the
 * whole site" list. Produced by aeo-audit (`affectedPages` = pages scoring
 * < 70 for the factor); canonry adds `affectedPct` server-side so the dashboard
 * and CLI render the same share without recomputing it.
 */
export const siteAuditCrossCuttingIssueSchema = z.object({
  factorId: z.string(),
  factorName: z.string(),
  avgScore: z.number(),
  affectedPages: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  /** `round(affectedPages / totalPages * 100)`, `0` when `totalPages` is `0`. Computed by canonry, not aeo-audit. */
  affectedPct: z.number().int().nonnegative(),
  topRecommendations: z.array(z.string()).default([]),
})
export type SiteAuditCrossCuttingIssueDto = z.infer<typeof siteAuditCrossCuttingIssueSchema>

/**
 * The Technical AEO scorecard for a project — the latest completed/partial
 * `site-audit` run, with the delta vs the prior run computed server-side.
 *
 * When the project has never been audited, `hasData` is `false`, `runId` /
 * `auditedAt` are `null`, the numeric fields are `0`, and the arrays are empty
 * — consumers should branch on `hasData` and render an onboarding state rather
 * than treating the zeros as a real score.
 */
export const siteAuditScoreSchema = z.object({
  project: z.string(),
  hasData: z.boolean(),
  runId: z.string().nullable(),
  runStatus: nullableRunStatusSchema,
  sitemapUrl: z.string().nullable(),
  auditedAt: z.string().nullable(),
  aggregateScore: z.number(),
  pagesDiscovered: z.number().int().nonnegative(),
  pagesAudited: z.number().int().nonnegative(),
  pagesSkipped: z.number().int().nonnegative(),
  pagesErrored: z.number().int().nonnegative(),
  /** `aggregateScore - previousScore`, or `null` when there is no prior run. */
  deltaScore: z.number().nullable(),
  trend: siteAuditTrendDirectionSchema.nullable(),
  previousScore: z.number().nullable(),
  previousAuditedAt: z.string().nullable(),
  factors: z.array(siteAuditFactorSummarySchema).default([]),
  crossCuttingIssues: z.array(siteAuditCrossCuttingIssueSchema).default([]),
  prioritizedFixes: z.array(z.string()).default([]),
})
export type SiteAuditScoreDto = z.infer<typeof siteAuditScoreSchema>

/** One factor's score on a single audited page (findings/recommendations are rolled up at the site level, not stored per page). */
export const siteAuditPageFactorSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  score: z.number(),
})
export type SiteAuditPageFactorDto = z.infer<typeof siteAuditPageFactorSchema>

/** One audited page in the latest site-audit run. `status='error'` pages carry an `error` message and no factors. */
export const siteAuditPageSchema = z.object({
  url: z.string(),
  overallScore: z.number(),
  status: z.enum(['success', 'error']),
  error: z.string().nullable().optional(),
  factors: z.array(siteAuditPageFactorSchema).default([]),
})
export type SiteAuditPageDto = z.infer<typeof siteAuditPageSchema>

export const siteAuditPagesResponseSchema = z.object({
  project: z.string(),
  runId: z.string().nullable(),
  auditedAt: z.string().nullable(),
  /** Total pages in the latest run matching the filter (before `limit`/`offset`). */
  total: z.number().int().nonnegative(),
  pages: z.array(siteAuditPageSchema).default([]),
})
export type SiteAuditPagesResponseDto = z.infer<typeof siteAuditPagesResponseSchema>

/** One historical data point for the aggregate-score trend chart. */
export const siteAuditTrendPointSchema = z.object({
  runId: z.string(),
  auditedAt: z.string(),
  aggregateScore: z.number(),
  pagesAudited: z.number().int().nonnegative(),
})
export type SiteAuditTrendPointDto = z.infer<typeof siteAuditTrendPointSchema>

export const siteAuditTrendResponseSchema = z.object({
  project: z.string(),
  points: z.array(siteAuditTrendPointSchema).default([]),
})
export type SiteAuditTrendResponseDto = z.infer<typeof siteAuditTrendResponseSchema>

/** Read-only crawl persistence is distinct from the legacy scorecard tables. */
export const siteCrawlDeadLinkStateSchema = z.enum(['disabled', 'complete', 'partial', 'unavailable'])
export type SiteCrawlDeadLinkState = z.infer<typeof siteCrawlDeadLinkStateSchema>
export const SiteCrawlDeadLinkStates = siteCrawlDeadLinkStateSchema.enum

export const siteCrawlCountsSchema = z.object({
  pagesDiscovered: z.number().int().nonnegative(),
  pagesFetched: z.number().int().nonnegative(),
  pagesEligible: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
})
export type SiteCrawlCountsDto = z.infer<typeof siteCrawlCountsSchema>

const siteCrawlDeadLinksSummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }),
  z.object({ state: z.literal('disabled') }),
  z.object({ state: z.literal('complete'), checked: z.number().int().nonnegative(), found: z.number().int().nonnegative() }),
  z.object({ state: z.literal('partial'), checked: z.number().int().nonnegative(), found: z.number().int().nonnegative() }),
])

/**
 * Latest (or selected) persisted crawl. `hasCrawlData=false` is intentionally
 * not backfilled from legacy `site_audit_*` rows: their scorecard data does not
 * imply a page graph. `legacyAuditAvailable` lets consumers retain that view.
 */
export const siteCrawlSummarySchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  legacyAuditAvailable: z.boolean(),
  runId: z.string().nullable(),
  runStatus: nullableRunStatusSchema,
  rootUrl: z.string().nullable(),
  crawlSchemaVersion: z.string().nullable().optional(),
  engineVersion: z.string().nullable().optional(),
  normalizationVersion: z.string().nullable().optional(),
  indexabilityVersion: z.string().nullable().optional(),
  linkScoreVersion: z.string().nullable().optional(),
  effectiveOptions: z.record(z.string(), z.unknown()).default({}),
  complete: z.boolean(),
  termination: z.string().nullable(),
  detailsAvailable: z.boolean(),
  counts: siteCrawlCountsSchema,
  deadLinks: siteCrawlDeadLinksSummarySchema,
})
export type SiteCrawlSummaryDto = z.infer<typeof siteCrawlSummarySchema>

export const siteCrawlPageSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  finalUrl: z.string().nullable(),
  path: z.string(),
  parentPath: z.string(),
  discoverySource: z.string(),
  fetchState: z.string(),
  httpStatus: z.number().int().nullable(),
  canonicalUrl: z.string().nullable(),
  indexabilityState: z.string(),
  indexabilityReasons: z.array(z.string()).default([]),
  auditState: z.string(),
  auditScore: z.number().nullable(),
  inventoryEligible: z.boolean(),
  depth: z.number().int().nullable(),
  inboundUniqueEdges: z.number().int().nonnegative(),
  outboundUniqueEdges: z.number().int().nonnegative(),
  inboundOccurrences: z.number().int().nonnegative(),
  outboundOccurrences: z.number().int().nonnegative(),
  linkScoreRaw: z.number().nullable(),
  linkScoreNormalized: z.number().nullable(),
})
export type SiteCrawlPageDto = z.infer<typeof siteCrawlPageSchema>

export const siteCrawlPagesResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  pages: z.array(siteCrawlPageSchema).default([]),
})
export type SiteCrawlPagesResponseDto = z.infer<typeof siteCrawlPagesResponseSchema>

export const siteCrawlStructureChildSchema = z.object({
  path: z.string(),
  /** URL of the exact folder landing page, null for a synthetic hierarchy node. */
  url: z.string().nullable(),
  hasPage: z.boolean(),
  pageCount: z.number().int().positive(),
  inventoryEligibleCount: z.number().int().nonnegative(),
  fetchedCount: z.number().int().nonnegative(),
})
export type SiteCrawlStructureChildDto = z.infer<typeof siteCrawlStructureChildSchema>

export const siteCrawlStructureResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  parentPath: z.string(),
  nextCursor: z.string().nullable(),
  children: z.array(siteCrawlStructureChildSchema).default([]),
})
export type SiteCrawlStructureResponseDto = z.infer<typeof siteCrawlStructureResponseSchema>

export const siteCrawlEdgeSchema = z.object({
  edgeKey: z.string(),
  sourceNodeKey: z.string(),
  sourceUrl: z.string(),
  targetNodeKey: z.string().nullable(),
  targetUrl: z.string(),
  relation: z.string(),
  internal: z.boolean(),
  followable: z.boolean(),
  occurrences: z.number().int().positive(),
  followableOccurrences: z.number().int().nonnegative(),
  nofollowOccurrences: z.number().int().nonnegative(),
  anchors: z.array(z.string()).default([]),
})
export type SiteCrawlEdgeDto = z.infer<typeof siteCrawlEdgeSchema>

export const siteCrawlInternalLinksResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  edges: z.array(siteCrawlEdgeSchema).default([]),
})
export type SiteCrawlInternalLinksResponseDto = z.infer<typeof siteCrawlInternalLinksResponseSchema>

export const siteCrawlNeighborsResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  nodeKey: z.string().nullable(),
  url: z.string().nullable(),
  inbound: z.array(siteCrawlEdgeSchema).default([]),
  outbound: z.array(siteCrawlEdgeSchema).default([]),
  inboundTruncated: z.boolean(),
  outboundTruncated: z.boolean(),
})
export type SiteCrawlNeighborsResponseDto = z.infer<typeof siteCrawlNeighborsResponseSchema>

export const siteCrawlDeadLinkSchema = z.object({
  findingKey: z.string(),
  severity: z.string(),
  sourceNodeKey: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  targetNodeKey: z.string().nullable(),
  targetUrl: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()).default({}),
})
export type SiteCrawlDeadLinkDto = z.infer<typeof siteCrawlDeadLinkSchema>

/** Dead-link checks are opt-in; disabled and unavailable never masquerade as an empty list. */
export const siteCrawlDeadLinksResponseSchema = z.discriminatedUnion('state', [
  z.object({ project: z.string(), runId: z.string().nullable(), state: z.literal('unavailable'), legacyAuditAvailable: z.boolean() }),
  z.object({ project: z.string(), runId: z.string(), state: z.literal('disabled'), checkDeadLinks: z.literal(false) }),
  z.object({
    project: z.string(), runId: z.string(), state: z.literal('complete'), checkDeadLinks: z.literal(true),
    checked: z.number().int().nonnegative(), found: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(), deadLinks: z.array(siteCrawlDeadLinkSchema).default([]),
  }),
  z.object({
    project: z.string(), runId: z.string(), state: z.literal('partial'), checkDeadLinks: z.literal(true),
    checked: z.number().int().nonnegative(), found: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(), deadLinks: z.array(siteCrawlDeadLinkSchema).default([]),
  }),
])
export type SiteCrawlDeadLinksResponseDto = z.infer<typeof siteCrawlDeadLinksResponseSchema>

/** Canonry-local crawl defaults. These are part of request identity. */
export const SITE_AUDIT_DEFAULT_PAGE_LIMIT = 1_000
export const SITE_AUDIT_MAX_PAGE_LIMIT = 50_000
export const SITE_AUDIT_DEFAULT_EDGE_LIMIT = 100_000
export const SITE_AUDIT_MAX_EDGE_LIMIT = 1_000_000

/** Body for `POST /projects/:name/technical-aeo/runs`. */
export const siteAuditRunRequestSchema = z.object({
  /** @deprecated Prefer the configured project sitemap; retained for compatibility. */
  sitemapUrl: z.string().url().optional(),
  /** @deprecated Prefer `maxPages`; retained for compatibility. */
  limit: z.number().int().positive().max(2000).optional(),
  /** Crawl page budget. When omitted, Canonry crawls up to 1,000 pages. */
  maxPages: z.number().int().positive().max(50_000).optional(),
  /** Internal-link observation budget. When omitted, Canonry retains up to 100,000 edges. */
  maxEdges: z.number().int().positive().max(1_000_000).optional(),
  /** Maximum crawl depth from the root. */
  maxDepth: z.number().int().min(0).max(100).optional(),
  /** Off by default; derives findings only from observed internal targets. External links are never probed. */
  checkDeadLinks: z.boolean().default(false),
})
export type SiteAuditRunRequest = z.infer<typeof siteAuditRunRequestSchema>

/**
 * Canonical production semantics for one requested crawl. The route persists
 * this before work starts so only requests with the same output identity can
 * consolidate onto an in-flight run. `limit` and `maxPages` intentionally
 * collapse to one field because `limit` is only a compatibility alias.
 */
export interface SiteAuditEffectiveRequest {
  schemaVersion: 1
  sitemapUrl: string | null
  maxPages: number
  maxEdges: number
  maxDepth: number | null
  checkDeadLinks: boolean
}

export function normalizeSiteAuditRunRequest(request: Partial<SiteAuditRunRequest>): SiteAuditEffectiveRequest {
  return {
    schemaVersion: 1,
    sitemapUrl: request.sitemapUrl ? new URL(request.sitemapUrl).toString() : null,
    maxPages: request.maxPages ?? request.limit ?? SITE_AUDIT_DEFAULT_PAGE_LIMIT,
    maxEdges: request.maxEdges ?? SITE_AUDIT_DEFAULT_EDGE_LIMIT,
    maxDepth: request.maxDepth ?? null,
    checkDeadLinks: request.checkDeadLinks === true,
  }
}

/** Stable, versioned identity key for exact in-flight request comparison. */
export function siteAuditRequestIdentity(request: SiteAuditEffectiveRequest): string {
  return JSON.stringify([
    request.schemaVersion,
    request.sitemapUrl,
    request.maxPages,
    request.maxEdges,
    request.maxDepth,
    request.checkDeadLinks,
  ])
}

export const siteAuditRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
})
export type SiteAuditRunResponseDto = z.infer<typeof siteAuditRunResponseSchema>
