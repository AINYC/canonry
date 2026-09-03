/**
 * Runtime-neutral contracts for a public check.  The Val host owns request
 * handling and persistence; package adapters own provider and crawler
 * implementation details.
 *
 * The kit is OPAQUE to what a check produces. `CheckRecord<TResult>` carries a
 * product's result without naming it, and the stores only stringify and parse
 * it, so a second product stores a different shape through the same admission,
 * lease, and quota machinery. The result schema — and the fingerprint namespace
 * that retires records of that schema — belong to the val that measures it.
 */

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

/**
 * One durable check.
 *
 * `TResult` is the product's own result schema. The kit never reads inside it:
 * it is written as JSON on finalize and handed back as-is on read, which is
 * what lets two vals with different measurements share one store. A val names
 * the parameter once — `CheckStore<CheckResult>` — and every record it takes
 * out is typed from there.
 */
export interface CheckRecord<TResult = unknown> {
  id: string
  fingerprint: string
  domain: string
  /** Questions the visitor supplied. The generator fills the remainder. */
  userQueries: string[]
  status: CheckStatus
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  result: TResult | null
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
export type CheckAdmission<TResult = unknown> =
  | { kind: 'created'; record: CheckRecord<TResult> }
  | { kind: 'reused'; record: CheckRecord<TResult> }
  | { kind: 'reclaimed'; record: CheckRecord<TResult> }
  | { kind: 'quota-exhausted'; scope: 'client' | 'global' }
  | { kind: 'busy' }

export interface CheckAdmissionInput<TResult = unknown> {
  candidate: CheckRecord<TResult>
  now: string
  clientQuota: CheckQuotaClaim
  globalQuota: CheckQuotaClaim
}

/** The patch a terminal transition may write. Everything else is store-owned. */
export type CheckRecordPatch<TResult = unknown> = Partial<
  Pick<CheckRecord<TResult>, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>
>

export interface CheckStore<TResult = unknown> {
  initialize(): Promise<void>
  /**
   * Atomically reuse an active/fresh check, reclaim a crashed lease, or spend
   * quota and create one new record. Production executes this as one durable
   * SQLite admission batch; callers must not compose these steps.
   */
  admit(input: CheckAdmissionInput<TResult>): Promise<CheckAdmission<TResult>>
  /** Legacy/read seam used by tests and status helpers; it never returns an expired running lease. */
  findReusable(fingerprint: string, now: string): Promise<CheckRecord<TResult> | null>
  create(record: CheckRecord<TResult>): Promise<void>
  get(id: string): Promise<CheckRecord<TResult> | null>
  update(id: string, patch: CheckRecordPatch<TResult>): Promise<CheckRecord<TResult> | null>
  /** Atomically transition a queued/stale check to running and attach a per-check lease. */
  claimJob(id: string, owner: string, now: string, leaseUntil: string): Promise<CheckRecord<TResult> | null>
  /** Publish a terminal result only if this isolate still owns the per-check lease. */
  finalizeJob(id: string, owner: string, patch: CheckRecordPatch<TResult>): Promise<CheckRecord<TResult> | null>
  /** Return an unstarted claimed job to the durable queue when global capacity is occupied. */
  requeueJob(id: string, owner: string, now: string): Promise<CheckRecord<TResult> | null>
  /** One active paid/public check at a time, with expiry so a crashed isolate recovers. */
  claimGlobalLease(name: string, holder: string, now: string, leaseUntil: string): Promise<boolean>
  releaseGlobalLease(name: string, holder: string): Promise<void>
  /** Atomically spend one unit only while the current UTC-day total is below max. */
  claimQuota(scope: string, subject: string, day: string, max: number): Promise<boolean>
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
