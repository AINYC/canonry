/**
 * Runtime-neutral contracts for the public Canonry sample.  The Val host owns
 * request handling and persistence; package adapters own provider and crawler
 * implementation details.
 */

export const CHECK_RESULT_SCHEMA_VERSION = '1.0' as const
/** Controlled presentation code for native public-form quota failures. */
export const PUBLIC_RATE_LIMITED_ERROR_CODE = 'public-rate-limited' as const
/**
 * What a failed check says when its reason could not be classified. Shared
 * because the UI must recognise it as the ABSENCE of a reason: leading a banner
 * with it restates the banner's own title and tells the reader nothing.
 */
export const PUBLIC_CHECK_UNAVAILABLE = 'This answer-engine check was unavailable.' as const

export type CheckStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed'

export interface VisibilitySource {
  url: string
  title: string | null
}

/** A normalized, display-safe answer observation. Never place a raw provider response here. */
export interface VisibilityEvidence {
  query: string
  provider: string
  requestedModel: string | null
  servedModel: string | null
  completedAt: string
  answerText: string | null
  /** Null means the provider check failed; it is never silently converted to false. */
  mentioned: boolean | null
  matchedTerms: string[]
  /** Null means the provider check failed; it is never silently converted to false. */
  cited: boolean | null
  citedDomains: string[]
  citedUrls: string[]
  matchedCitationDomains: string[]
  matchedCitationUrls: string[]
  sources: VisibilitySource[]
  searchQueries: string[]
  /**
   * Brands this answer NAMES in its prose, every one verified to be written
   * there. Null means the extraction did not run or failed, which is not the
   * same as an answer that named nobody, and keeps mention share unmeasured
   * rather than reporting a field of zeroes.
   */
  namedBrands: string[] | null
  retrievalStatus: 'grounded' | 'not-grounded' | 'unknown' | 'error'
  error: string | null
}

export interface VisibilitySummary {
  successfulChecks: number
  failedChecks: number
  mentionRate: number | null
  citationRate: number | null
}

export interface VisibilityReport {
  schemaVersion: string
  domain: string
  startedAt: string
  completedAt: string
  summary: VisibilitySummary
  evidence: VisibilityEvidence[]
}

export interface VisibilityProbeInput {
  domain: string
  /**
   * Caller-supplied questions, used verbatim. The planner generates only
   * `maxProbeCalls - userQueries.length`, and is not called at all when the
   * caller supplied the full set.
   */
  userQueries?: readonly string[]
  /** The package may use this one capped call to derive a profile/query basket. */
  maxPlannerCalls: 1
  /** The package may issue at most this many grounded answer-engine probes. */
  maxProbeCalls: 3
  signal: AbortSignal
}

/**
 * Boundary between public-check orchestration and the Val-local visibility
 * implementation. The public result never includes raw provider responses.
 */
export interface VisibilityProbePort {
  probe(input: VisibilityProbeInput): Promise<VisibilityReport>
}

export interface FactorSample {
  id: string
  name: string
  score: number
  applicable: boolean | null
  findings: Array<{ code: string; message: string }>
  recommendations: string[]
}

export interface SiteHealthPageSample {
  url: string
  status: 'success' | 'error'
  score: number | null
  depth: number | null
  indexability: string | null
  factors: FactorSample[]
  criticalDefects: Array<{
    id: string
    severity: string
    detail: string
    recommendation: string
  }>
  error: string | null
}

/**
 * One page in the crawled link graph. A node is either a page the crawler
 * actually fetched and audited (`crawled`), or a link target it saw but never
 * opened — the distinction matters, because only a crawled node can carry a
 * score, and drawing the two alike would imply measurement that never happened.
 */
export interface SiteMapNode {
  key: string
  url: string
  /** Path for display, or the host for the site root. */
  label: string
  depth: number | null
  crawled: boolean
  score: number | null
  indexable: boolean | null
  inboundLinks: number
  outboundLinks: number
}

/** A followable-or-not internal link between two mapped nodes. */
export interface SiteMapEdge {
  from: string
  to: string
  followable: boolean
}

/**
 * A bounded internal-link graph built from the same crawl as the page audit.
 *
 * `totalPages` / `totalEdges` are the pre-cap totals, so a reader can always
 * tell a displayed sample from the whole site.
 */
export interface SiteMapSample {
  nodes: SiteMapNode[]
  edges: SiteMapEdge[]
  totalPages: number
  totalEdges: number
  truncated: boolean
}

export interface SiteHealthSample {
  schemaVersion: string
  label: '5-page Technical AEO sample'
  domain: string
  rootUrl: string
  finalRootUrl: string | null
  status: 'complete' | 'partial' | 'error'
  score: number | null
  pagesDiscovered: number
  pagesFetched: number
  pagesObserved: number
  elapsedMs: number
  terminationReason: string | null
  warnings: string[]
  factors: Array<{ id: string; name: string; averageScore: number; count: number }>
  pages: SiteHealthPageSample[]
  /** Null when the crawl produced no usable graph, never an empty stand-in. */
  siteMap: SiteMapSample | null
  attemptedHosts: string[]
  error: string | null
}

export interface CheckResult {
  schemaVersion: typeof CHECK_RESULT_SCHEMA_VERSION
  domain: string
  generatedAt: string
  visibility: VisibilityReport | null
  siteHealth: SiteHealthSample | null
  errors: Array<{ area: 'visibility' | 'site-health'; code: string; message: string }>
}

export interface CheckRecord {
  id: string
  fingerprint: string
  domain: string
  /** Questions the visitor supplied. The generator fills the remainder. */
  userQueries: string[]
  status: CheckStatus
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  result: CheckResult | null
  errorCode: string | null
  errorMessage: string | null
  /** A durable execution claim. It prevents two Val isolates from running one check. */
  leaseOwner: string | null
  leaseUntil: string | null
}

export interface CheckQuotaClaim {
  scope: 'client' | 'global'
  subject: string
  day: string
  max: number
}

/**
 * A durable admission result. The store owns this whole decision so concurrent
 * Val isolates cannot independently spend quota and start the same domain.
 */
export type CheckAdmission =
  | { kind: 'created'; record: CheckRecord }
  | { kind: 'reused'; record: CheckRecord }
  | { kind: 'reclaimed'; record: CheckRecord }
  | { kind: 'quota-exhausted'; scope: 'client' | 'global' }
  | { kind: 'busy' }

export interface CheckAdmissionInput {
  candidate: CheckRecord
  now: string
  clientQuota: CheckQuotaClaim
  globalQuota: CheckQuotaClaim
}

export interface CheckStore {
  initialize(): Promise<void>
  /**
   * Atomically reuse an active/fresh check, reclaim a crashed lease, or spend
   * quota and create one new record. Production executes this as one durable
   * SQLite admission batch; callers must not compose these steps.
   */
  admit(input: CheckAdmissionInput): Promise<CheckAdmission>
  /** Legacy/read seam used by tests and status helpers; it never returns an expired running lease. */
  findReusable(fingerprint: string, now: string): Promise<CheckRecord | null>
  create(record: CheckRecord): Promise<void>
  get(id: string): Promise<CheckRecord | null>
  update(
    id: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>>,
  ): Promise<CheckRecord | null>
  /** Atomically transition a queued/stale check to running and attach a per-check lease. */
  claimJob(id: string, owner: string, now: string, leaseUntil: string): Promise<CheckRecord | null>
  /** Publish a terminal result only if this isolate still owns the per-check lease. */
  finalizeJob(
    id: string,
    owner: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>>,
  ): Promise<CheckRecord | null>
  /** Return an unstarted claimed job to the durable queue when global capacity is occupied. */
  requeueJob(id: string, owner: string, now: string): Promise<CheckRecord | null>
  /** One active paid/public check at a time, with expiry so a crashed isolate recovers. */
  claimGlobalLease(name: string, holder: string, now: string, leaseUntil: string): Promise<boolean>
  releaseGlobalLease(name: string, holder: string): Promise<void>
  /** Atomically spend one unit only while the current UTC-day total is below max. */
  claimQuota(scope: string, subject: string, day: string, max: number): Promise<boolean>
}

export interface SiteHealthRunner {
  run(domain: string, signal: AbortSignal): Promise<SiteHealthSample>
}

/**
 * Internal-only handoff for a request that already reserved the one global
 * execution slot before durable admission. It is never derived from client
 * input or exposed by the public API.
 */
export interface PublicCheckDispatchOptions {
  executionLeaseOwner?: string
}

export interface PublicCheckRunner {
  run(checkId: string, options?: PublicCheckDispatchOptions): Promise<'completed' | 'busy' | 'ignored'>
}

export interface JobDispatcher {
  dispatch(checkId: string, options?: PublicCheckDispatchOptions): Promise<'completed' | 'busy' | 'ignored'>
}
