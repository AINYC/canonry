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
 * These DTOs are the public contract for the dashboard's visible "Site Health"
 * tab, the `canonry technical-aeo …` CLI, and the matching MCP tools. The
 * stable route/API/embed key stays `technical-aeo`; the underlying run and
 * schedule kind stays `site-audit` (the existing `RunKinds` value).
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
  trend: z.union([siteAuditTrendDirectionSchema, z.null()]),
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
  /** Root URL originally requested by the operator; null for legacy snapshots. */
  requestedRootUrl: z.string().nullable(),
  /** Effective root followed by the crawl after any supported host redirect. */
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

/**
 * Why a crawl stopped early. Mirrors `CrawlTerminationReason` from
 * @canonry/aeo-audit, plus two values canonry itself writes: `complete` when
 * the crawl finished on its own, and `unknown`, the NOT NULL column default in
 * `packages/db` that a row keeps when nothing ever set a reason. `unknown` is
 * in the set precisely because it is persisted and reader-visible: leaving it
 * out would render the raw token in client copy. Persisted rows stay
 * string-backed for forward compatibility, so consumers match against this set
 * and keep a raw fallback.
 */
export const siteCrawlTerminationSchema = z.enum([
  'complete',
  'unknown',
  'max-pages',
  'max-edges',
  'max-fetches',
  'max-duration',
  'max-bytes',
  'max-page-bytes',
  'max-depth',
  'max-links-per-page',
  'max-query-variants',
  'max-sitemap-fanout',
  'max-sitemap-urls',
  'root-host-redirect',
])
export type SiteCrawlTermination = z.infer<typeof siteCrawlTerminationSchema>

/** Shared meaning behind Site Health node color across API, agents, and UI. */
export const siteHealthStateSchema = z.enum(['eligible', 'hidden', 'failed', 'unchecked'])
export type SiteHealthState = z.infer<typeof siteHealthStateSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteHealthStates = siteHealthStateSchema.enum

/** Exact state vocabulary emitted by @canonry/aeo-audit's Site Crawl contract. */
export const SiteCrawlFetchStates = {
  discovered: 'discovered',
  robotsBlocked: 'robots-blocked',
  html: 'html',
  redirect: 'redirect',
  nonHtml: 'non-html',
  fetchError: 'fetch-error',
} as const
export type SiteCrawlFetchState = (typeof SiteCrawlFetchStates)[keyof typeof SiteCrawlFetchStates]
/** States reached only after an HTTP fetch was attempted. */
export const SiteCrawlFetchedStates = [
  SiteCrawlFetchStates.html,
  SiteCrawlFetchStates.redirect,
  SiteCrawlFetchStates.nonHtml,
  SiteCrawlFetchStates.fetchError,
] as const satisfies readonly SiteCrawlFetchState[]

/** Exact indexability vocabulary emitted by @canonry/aeo-audit's Site Crawl contract. */
export const SiteCrawlIndexabilityStates = {
  indexable: 'indexable',
  noindex: 'noindex',
  blocked: 'blocked',
  unknown: 'unknown',
} as const
export type SiteCrawlIndexabilityState = (typeof SiteCrawlIndexabilityStates)[keyof typeof SiteCrawlIndexabilityStates]

/** Machine reasons that carry a canonical-identity decision from the crawler. */
export const SiteCrawlIndexabilityReasons = {
  robotsDisallow: 'robots-disallow',
  redirectTerminal: 'redirect-terminal',
  metaRobotsNoindex: 'meta-robots-noindex',
  xRobotsNoindex: 'x-robots-noindex',
  canonicalToOther: 'canonical-to-other',
  notHtmlOrUnavailable: 'not-html-or-unavailable',
} as const
export type SiteCrawlIndexabilityReason = (typeof SiteCrawlIndexabilityReasons)[keyof typeof SiteCrawlIndexabilityReasons]

/**
 * Rows remain string-backed for forward-compatible persisted crawl history, but
 * classification only recognizes the exact crawler values declared above.
 */
export interface SiteHealthStateInput {
  fetchState: string
  indexabilityState: string
  indexabilityReasons?: readonly string[]
  /** Resolved canonical identity. It is null when that target was not a crawl node. */
  canonicalNodeKey?: string | null
  /** Stable identity of this persisted crawl page. */
  nodeKey?: string
}

function pointsToOtherCanonical(input: SiteHealthStateInput): boolean {
  return input.indexabilityReasons?.some((reason) => reason === SiteCrawlIndexabilityReasons.canonicalToOther) === true
    || (input.nodeKey !== undefined
      && input.canonicalNodeKey !== null
      && input.canonicalNodeKey !== undefined
      && input.canonicalNodeKey !== input.nodeKey)
}

export function deriveSiteHealthState(input: SiteHealthStateInput): SiteHealthState {
  // Fetch state is decisive: a failed request cannot be visually eligible.
  switch (input.fetchState) {
    case SiteCrawlFetchStates.fetchError:
      return 'failed'
    case SiteCrawlFetchStates.discovered:
      return 'unchecked'
    case SiteCrawlFetchStates.redirect:
    case SiteCrawlFetchStates.robotsBlocked:
    case SiteCrawlFetchStates.nonHtml:
      return 'hidden'
    case SiteCrawlFetchStates.html:
      break
    default:
      // Unrecognized persisted values are not crawler states and cannot prove a page's health.
      return 'unchecked'
  }

  // Never infer canonical identity from textual URL presentation (e.g. trailing slashes).
  if (pointsToOtherCanonical(input)) return 'hidden'

  switch (input.indexabilityState) {
    case SiteCrawlIndexabilityStates.indexable:
      return 'eligible'
    case SiteCrawlIndexabilityStates.noindex:
    case SiteCrawlIndexabilityStates.blocked:
      return 'hidden'
    case SiteCrawlIndexabilityStates.unknown:
    default:
      return 'unchecked'
  }
}

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
  healthState: siteHealthStateSchema,
})
export type SiteCrawlPageDto = z.infer<typeof siteCrawlPageSchema>

/** One stable, page-scoped finding emitted by the audit engine. */
export const siteCrawlAuditFindingSchema = z.object({
  type: z.enum(['found', 'missing', 'info', 'timeout', 'unreachable']),
  /** Stable machine code; UI and agents must not key behavior off `message`. */
  code: z.string().min(1),
  message: z.string().min(1),
})
export type SiteCrawlAuditFindingDto = z.infer<typeof siteCrawlAuditFindingSchema>

/**
 * One factor that contributes to a page's aggregate audit score, with the
 * exact evidence and remediation emitted for that page in the selected run.
 */
export const siteCrawlAuditFactorSchema = siteAuditPageFactorSchema.extend({
  status: siteAuditFactorStatusSchema,
  /** `null` means the engine did not explicitly classify applicability. */
  applicable: z.boolean().nullable(),
  findings: z.array(siteCrawlAuditFindingSchema).default([]),
  recommendations: z.array(z.string()).default([]),
})
export type SiteCrawlAuditFactorDto = z.infer<typeof siteCrawlAuditFactorSchema>

/** High-impact page defect detected independently of the weighted score. */
export const siteCrawlCriticalDefectSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['critical', 'warning']),
  detail: z.string().min(1),
  recommendation: z.string().min(1),
})
export type SiteCrawlCriticalDefectDto = z.infer<typeof siteCrawlCriticalDefectSchema>

/**
 * One-page audit evidence read. This stays separate from the 20k-node graph
 * projection so selecting a node can load evidence without inflating every
 * graph node with finding prose.
 */
const siteCrawlPageAuditProvenanceSchema = z.object({
  project: z.string(),
  runId: z.string(),
  complete: z.boolean(),
  termination: z.string().nullable(),
})
const siteCrawlPageAuditIdentitySchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  auditState: z.string(),
})

export const siteCrawlPageAuditSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no-crawl'),
    project: z.string(),
    runId: z.null(),
  }),
  siteCrawlPageAuditProvenanceSchema.extend({ state: z.literal('details-unavailable') }),
  siteCrawlPageAuditProvenanceSchema.extend({ state: z.literal('not-found') }),
  siteCrawlPageAuditProvenanceSchema.merge(siteCrawlPageAuditIdentitySchema).extend({
    state: z.literal('not-audited'),
    auditScore: z.null(),
    factors: z.array(siteCrawlAuditFactorSchema).length(0).default([]),
    criticalDefects: z.array(siteCrawlCriticalDefectSchema).length(0).default([]),
  }),
  siteCrawlPageAuditProvenanceSchema.merge(siteCrawlPageAuditIdentitySchema).extend({
    state: z.literal('ready'),
    auditScore: z.number(),
    /** Old crawl rows retain factor scores but did not persist evidence prose. */
    evidenceState: z.enum(['complete', 'scores-only']),
    factors: z.array(siteCrawlAuditFactorSchema).default([]),
    criticalDefects: z.array(siteCrawlCriticalDefectSchema).default([]),
  }),
])
export type SiteCrawlPageAuditDto = z.infer<typeof siteCrawlPageAuditSchema>

/**
 * Whether a requested `healthState` filter actually ran.
 *
 * Site Health state is persisted at publish time and backfilled for existing
 * scans, so `applied` is the normal answer. `unavailable-legacy-scan` remains
 * for the one case a backfill cannot reach: a page written AFTER the migration
 * by an older engine image that does not know the column. Tenants keep their
 * provision-time image, so that is a real state, and saying so beats letting an
 * empty list read as "no hidden pages".
 */
export const siteCrawlPagesFilterStateSchema = z.enum(['applied', 'unavailable-legacy-scan'])
export type SiteCrawlPagesFilterState = z.infer<typeof siteCrawlPagesFilterStateSchema>

export const siteCrawlPagesResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  /** Null when no `healthState` filter was requested. */
  healthStateFilter: z.union([siteCrawlPagesFilterStateSchema, z.null()]).default(null),
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

export const siteCrawlGraphNodeSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  path: z.string(),
  depth: z.number().int().nonnegative().nullable(),
  indexabilityState: z.string(),
  fetchState: z.string(),
  auditState: z.string(),
  auditScore: z.number().nullable(),
  inventoryEligible: z.boolean(),
  inboundUniqueEdges: z.number().int().nonnegative(),
  outboundUniqueEdges: z.number().int().nonnegative(),
  linkScoreNormalized: z.number().nullable(),
  healthState: siteHealthStateSchema,
  /** Publish-time ForceAtlas2 coordinate. Reads never run layout physics. */
  x: z.number(),
  /** Publish-time ForceAtlas2 coordinate. Reads never run layout physics. */
  y: z.number(),
})
export type SiteCrawlGraphNodeDto = z.infer<typeof siteCrawlGraphNodeSchema>

export const siteCrawlGraphEdgeSchema = z.object({
  edgeKey: z.string(),
  sourceNodeKey: z.string(),
  targetNodeKey: z.string(),
  followable: z.boolean(),
  occurrences: z.number().int().positive(),
})
export type SiteCrawlGraphEdgeDto = z.infer<typeof siteCrawlGraphEdgeSchema>

/**
 * Why a scan has no usable map. Consumers key copy off these exact values, so
 * the set is closed and named rather than inlined at the one use site.
 */
export const siteCrawlGraphLayoutUnavailableReasonSchema = z.enum([
  'no-crawl',
  'legacy-snapshot',
  'details-unavailable',
  'layout-failed',
  'empty-crawl',
])
export type SiteCrawlGraphLayoutUnavailableReason = z.infer<typeof siteCrawlGraphLayoutUnavailableReasonSchema>

export const siteCrawlGraphLayoutSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    version: z.string().min(1),
    computedAt: z.string().min(1),
  }),
  z.object({
    state: z.literal('unavailable'),
    version: z.null(),
    reason: siteCrawlGraphLayoutUnavailableReasonSchema,
  }),
])
export type SiteCrawlGraphLayoutDto = z.infer<typeof siteCrawlGraphLayoutSchema>

/**
 * A persisted, deterministic graph projection for an interactive Site Health
 * map. `total*` reflects graph-compatible persisted crawl rows; `omitted*`
 * explains what the publish/read caps intentionally leave out. Layout state is
 * explicit because snapshots written before layout support remain valid.
 */
export const siteCrawlGraphResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  /**
   * Server-owned identity of the crawl root, resolved from the snapshot root
   * URL (or the depth-0 page). Consumers must not infer the home page from a
   * path or a link score. It is null when the crawl persisted no page detail,
   * and it can name a page that graph sampling left out of `nodes`.
   */
  rootNodeKey: z.string().nullable(),
  layout: siteCrawlGraphLayoutSchema,
  /** Total canonical pages in the persisted crawl before graph sampling. */
  totalNodes: z.number().int().nonnegative(),
  /** Total graph-compatible internal anchor edges before graph sampling. */
  totalEdges: z.number().int().nonnegative(),
  nodes: z.array(siteCrawlGraphNodeSchema).default([]),
  edges: z.array(siteCrawlGraphEdgeSchema).default([]),
  omittedNodes: z.number().int().nonnegative(),
  omittedEdges: z.number().int().nonnegative(),
  /** True when publish/read caps or a layout failure omit graph rows. */
  sampled: z.boolean(),
})
export type SiteCrawlGraphResponseDto = z.infer<typeof siteCrawlGraphResponseSchema>

/** Site Health publish/read caps. They deliberately do not change crawl budgets. */
export const SITE_CRAWL_GRAPH_DEFAULT_MAX_NODES = 20_000
export const SITE_CRAWL_GRAPH_MAX_NODES = 20_000
export const SITE_CRAWL_GRAPH_DEFAULT_MAX_EDGES = 50_000
export const SITE_CRAWL_GRAPH_MAX_EDGES = 50_000

export const siteHealthSubgraphRelationSchema = z.enum([
  'focus',
  'inbound',
  'outbound',
  'both',
  'transitive',
])
export type SiteHealthSubgraphRelation = z.infer<typeof siteHealthSubgraphRelationSchema>

export const siteHealthSubgraphNodeSchema = siteCrawlPageSchema.extend({
  distance: z.number().int().nonnegative(),
  relationToFocus: siteHealthSubgraphRelationSchema,
})
export type SiteHealthSubgraphNodeDto = z.infer<typeof siteHealthSubgraphNodeSchema>

/** Compact canonical graph neighborhood for agents; never includes layout coordinates. */
export const siteHealthSubgraphResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  /** Selected snapshot provenance. Historical partial crawls stay explicit. */
  complete: z.boolean(),
  termination: z.string().nullable(),
  state: z.enum(['no-crawl', 'details-unavailable', 'ready']),
  focusNodeKey: z.string().nullable(),
  focusUrl: z.string().nullable(),
  hops: z.number().int().min(0).max(3),
  totalNodes: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
  nodes: z.array(siteHealthSubgraphNodeSchema).default([]),
  edges: z.array(siteCrawlEdgeSchema).default([]),
  omittedNodes: z.number().int().nonnegative(),
  omittedEdges: z.number().int().nonnegative(),
  /** `lower-bound` means totals and omissions are minimums because traversal hit a cap. */
  countAccuracy: z.enum(['exact', 'lower-bound']),
  truncated: z.boolean(),
})
export type SiteHealthSubgraphResponseDto = z.infer<typeof siteHealthSubgraphResponseSchema>

export const SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_NODES = 25
export const SITE_HEALTH_SUBGRAPH_MAX_NODES = 200
export const SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_EDGES = 50
export const SITE_HEALTH_SUBGRAPH_MAX_EDGES = 500

export const siteHealthNodeReferenceSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  path: z.string(),
})
export type SiteHealthNodeReferenceDto = z.infer<typeof siteHealthNodeReferenceSchema>

/** Directed, followable shortest path over canonical internal-link observations. */
export const siteHealthPathResponseSchema = z.object({
  project: z.string(),
  runId: z.string().nullable(),
  /** Selected snapshot provenance. `unreachable` on a partial crawl is not a site-wide claim. */
  complete: z.boolean(),
  termination: z.string().nullable(),
  state: z.enum(['no-crawl', 'details-unavailable', 'found', 'unreachable', 'truncated']),
  from: siteHealthNodeReferenceSchema.nullable(),
  to: siteHealthNodeReferenceSchema.nullable(),
  maxDepth: z.number().int().positive(),
  visitedNodes: z.number().int().nonnegative(),
  nodes: z.array(siteCrawlPageSchema).default([]),
  edges: z.array(siteCrawlEdgeSchema).default([]),
})
export type SiteHealthPathResponseDto = z.infer<typeof siteHealthPathResponseSchema>

export const SITE_HEALTH_PATH_DEFAULT_MAX_DEPTH = 12
export const SITE_HEALTH_PATH_MAX_DEPTH = 24
export const SITE_HEALTH_PATH_MAX_VISITED_NODES = 5_000

export const siteHealthChangeKindSchema = z.enum(['added', 'removed', 'changed'])
export type SiteHealthChangeKind = z.infer<typeof siteHealthChangeKindSchema>

export const siteHealthPageChangeSchema = z.object({
  entity: z.literal('page'),
  change: siteHealthChangeKindSchema,
  key: z.string(),
  changedFields: z.array(z.string()).default([]),
  before: siteCrawlPageSchema.nullable(),
  after: siteCrawlPageSchema.nullable(),
})
export type SiteHealthPageChangeDto = z.infer<typeof siteHealthPageChangeSchema>

export const siteHealthLinkChangeSchema = z.object({
  entity: z.literal('link'),
  change: siteHealthChangeKindSchema,
  key: z.string(),
  changedFields: z.array(z.string()).default([]),
  before: siteCrawlEdgeSchema.nullable(),
  after: siteCrawlEdgeSchema.nullable(),
})
export type SiteHealthLinkChangeDto = z.infer<typeof siteHealthLinkChangeSchema>

export const siteHealthChangeRecordSchema = z.discriminatedUnion('entity', [
  siteHealthPageChangeSchema,
  siteHealthLinkChangeSchema,
])
export type SiteHealthChangeRecordDto = z.infer<typeof siteHealthChangeRecordSchema>

const siteHealthChangeCountsSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
})

export const siteHealthChangesFiltersSchema = z.object({
  scope: z.enum(['all', 'pages', 'links']),
  change: z.enum(['all', 'added', 'removed', 'changed']),
})
export type SiteHealthChangesFilters = z.infer<typeof siteHealthChangesFiltersSchema>

export const siteHealthChangesResponseSchema = z.discriminatedUnion('state', [
  z.object({
    project: z.string(),
    state: z.literal('unavailable'),
    reason: z.enum(['no-crawl', 'insufficient-history', 'details-unavailable', 'partial-not-comparable']),
    fromRunId: z.string().nullable(),
    toRunId: z.string().nullable(),
  }),
  z.object({
    project: z.string(),
    state: z.literal('incompatible'),
    reason: z.literal('incompatible-versions'),
    fromRunId: z.string(),
    toRunId: z.string(),
    mismatchedVersions: z.array(z.string()).min(1),
  }),
  z.object({
    project: z.string(),
    state: z.literal('ready'),
    fromRunId: z.string(),
    toRunId: z.string(),
    versions: z.object({
      crawlSchema: z.string(),
      normalization: z.string(),
      indexability: z.string(),
      linkScore: z.string(),
    }),
    /** The filters whose post-filter counts and records this page represents. */
    filters: siteHealthChangesFiltersSchema,
    /** Continuations omit summary work; reuse the exact summary from the first page. */
    summaryState: z.enum(['exact', 'omitted-on-continuation']),
    summary: z.object({
      pages: siteHealthChangeCountsSchema,
      links: siteHealthChangeCountsSchema,
    }).nullable(),
    total: z.number().int().nonnegative().nullable(),
    nextCursor: z.string().nullable(),
    changes: z.array(siteHealthChangeRecordSchema).default([]),
  }),
])
export type SiteHealthChangesResponseDto = z.infer<typeof siteHealthChangesResponseSchema>

export const SITE_HEALTH_CHANGES_DEFAULT_LIMIT = 25
export const SITE_HEALTH_CHANGES_MAX_LIMIT = 100

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

/**
 * One entry in the Site Health scan history. `hasCrawlData` separates a scan
 * that published a page and internal-link graph from a legacy score-only scan
 * that predates crawl persistence: both are real, selectable history, but only
 * the first can open the map, inventory, or structure views.
 */
export const siteHealthScanSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  hasCrawlData: z.boolean(),
})
export type SiteHealthScanDto = z.infer<typeof siteHealthScanSchema>

/** Non-probe site-audit runs for one project, newest first. */
export const siteHealthScansResponseSchema = z.object({
  project: z.string(),
  scans: z.array(siteHealthScanSchema).default([]),
})
export type SiteHealthScansResponseDto = z.infer<typeof siteHealthScansResponseSchema>

export const SITE_HEALTH_SCANS_DEFAULT_LIMIT = 20
export const SITE_HEALTH_SCANS_MAX_LIMIT = 100
