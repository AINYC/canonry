/** A versioned, persistence-free report contract. */
export const VISIBILITY_PROBE_SCHEMA_VERSION = 1 as const

/**
 * User-approved identity for one site. `brandNames` are exact aliases, not
 * fuzzy search terms. A domain counts as an answer mention only when it is
 * written explicitly; the probe never silently derives a prose alias from it.
 */
export interface VisibilityProbeTarget {
  canonicalDomain: string
  brandNames: readonly string[]
}

export interface VisibilityProbeQuery {
  /** Stable caller identity. A deterministic position-based ID is used when omitted. */
  id?: string
  text: string
}

export type VisibilityRetrievalStatus = 'used' | 'not-used' | 'unknown'

/** A provider-normalized source. Never pass raw provider response objects here. */
export interface VisibilitySource {
  url: string
  title?: string | null
  /**
   * Optional provider-normalized source domain. `null` explicitly says an
   * opaque provider redirect could not be attributed to a website, so callers
   * must not fall back to the redirect host.
   */
  domain?: string | null
}

/**
 * What a provider adapter returns after it has interpreted its own response.
 * The runner applies the target-specific mention/citation detection and output
 * caps, so adapters have no Canonry persistence or UI knowledge.
 */
export interface VisibilityProviderResponse {
  requestedModel: string
  /** Only use a provider-disclosed identity; never fall back to requestedModel. */
  servedModel?: string | null
  answerText: string
  sources?: readonly VisibilitySource[]
  searchQueries?: readonly string[]
  retrievalStatus?: VisibilityRetrievalStatus
  /**
   * Why an adapter produced no answer text. Read only when `answerText` is
   * empty, so an unwritten answer says whether it was truncated, declined, or
   * simply absent.
   */
  emptyAnswerReason?: string
}

export interface VisibilityProviderRequest {
  query: VisibilityProbeQuery
  target: VisibilityProbeTarget
  signal: AbortSignal
  limits: VisibilityProbeLimits
}

/** Provider-neutral execution seam. Adapters own credentials passed at construction. */
export interface VisibilityProviderAdapter {
  /** Stable machine identifier, for example `gemini`. */
  readonly name: string
  /** Configuration identity, useful when a request fails before the provider responds. */
  readonly requestedModel?: string
  execute(request: VisibilityProviderRequest): Promise<VisibilityProviderResponse>
}

/**
 * All values are bounded by hard local limits. The public Val Town sample sets
 * tighter product limits (three Gemini queries).
 */
export interface VisibilityProbeLimits {
  /** Per query-provider request deadline. */
  timeoutMs: number
  maxConcurrency: number
  maxQueries: number
  maxProviders: number
  maxAnswerChars: number
  maxSources: number
  maxSourceUrlChars: number
  maxSourceTitleChars: number
  maxSearchQueries: number
  maxSearchQueryChars: number
}

export const DEFAULT_VISIBILITY_PROBE_LIMITS: VisibilityProbeLimits = {
  timeoutMs: 16_000,
  maxConcurrency: 1,
  maxQueries: 10,
  maxProviders: 4,
  maxAnswerChars: 12_000,
  maxSources: 20,
  maxSourceUrlChars: 2_048,
  maxSourceTitleChars: 512,
  maxSearchQueries: 10,
  maxSearchQueryChars: 300,
}

export interface RunVisibilityProbeInput {
  target: VisibilityProbeTarget
  queries: readonly VisibilityProbeQuery[]
  adapters: readonly VisibilityProviderAdapter[]
  limits?: Partial<VisibilityProbeLimits>
  /** Cancels outstanding work. A cancellation becomes a failed check, never a false negative. */
  signal?: AbortSignal
  /** Deterministic test seam; no wall-clock state is retained. */
  now?: () => Date
}

export type VisibilityProbeCheckStatus = 'success' | 'failed'
export type VisibilityProbeReportStatus = 'completed' | 'partial' | 'failed'

export type VisibilityProbeFailureCode = 'aborted' | 'timeout' | 'provider-error' | 'invalid-response'

/** Safe, clipped error information. Provider bodies and credentials never leave an adapter. */
export interface VisibilityProbeFailure {
  code: VisibilityProbeFailureCode
  message: string
}

/** A source selected for display after output caps are applied. */
export interface VisibilityProbeSourceEvidence {
  url: string
  title: string | null
  domain: string | null
  /** This source points to the target domain or one of its subdomains. */
  targetDomainMatch: boolean
}

/** One query × provider observation. `null` means the check failed, not false. */
export interface VisibilityProbeCheck {
  queryId: string
  query: string
  provider: string
  requestedModel: string | null
  servedModel: string | null
  completedAt: string
  status: VisibilityProbeCheckStatus
  answerText: string | null
  answerTruncated: boolean
  mentioned: boolean | null
  matchedTerms: string[]
  cited: boolean | null
  /** All domain identities emitted by the provider's source list, subject to output caps. */
  citedDomains: string[]
  /** All source URLs emitted by the provider's source list, subject to output caps. */
  citedUrls: string[]
  matchedCitationDomains: string[]
  matchedCitationUrls: string[]
  sources: VisibilityProbeSourceEvidence[]
  sourceCount: number
  sourcesTruncated: boolean
  searchQueries: string[]
  searchQueriesTruncated: boolean
  retrievalStatus: VisibilityRetrievalStatus
  error: VisibilityProbeFailure | null
}

/** Rates use successful query-provider checks only. They are null when none succeeded. */
export interface VisibilityProbeSummary {
  totalChecks: number
  successfulChecks: number
  failedChecks: number
  mentionedChecks: number
  citedChecks: number
  mentionRate: number | null
  citationRate: number | null
}

export interface VisibilityProbeReport {
  schemaVersion: typeof VISIBILITY_PROBE_SCHEMA_VERSION
  target: VisibilityProbeTarget
  startedAt: string
  completedAt: string
  status: VisibilityProbeReportStatus
  checks: VisibilityProbeCheck[]
  summary: VisibilityProbeSummary
}

/**
 * Separate optional planning seam. The host supplies any homepage text it has
 * already fetched; the planner never fetches a website to plan a probe.
 */
export interface VisibilityQueryPlanningInput {
  canonicalDomain: string
  /** Optional host-fetched homepage extract. An empty value uses grounded domain research only. */
  homepageContext?: string
  brandNames?: readonly string[]
  maxQueries?: number
  signal?: AbortSignal
  /** Deterministic test seam; no wall-clock state is retained. */
  now?: () => Date
}

export interface VisibilityQueryPlan {
  target: VisibilityProbeTarget
  queries: VisibilityProbeQuery[]
  planner: string
  requestedModel: string
  servedModel: string | null
  generatedAt: string
}

export interface VisibilityQueryPlanner {
  readonly name: string
  readonly requestedModel: string
  plan(input: VisibilityQueryPlanningInput): Promise<VisibilityQueryPlan>
}
