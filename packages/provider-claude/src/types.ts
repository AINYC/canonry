import type { ProviderQuotaPolicy, GroundingSource, LocationContext } from '@ainyc/canonry-contracts'

export type { GroundingSource }

export interface ClaudeConfig {
  apiKey: string
  quotaPolicy: ProviderQuotaPolicy
  model?: string
}

export interface ClaudeHealthcheckResult {
  ok: boolean
  provider: 'claude'
  message: string
  model?: string
}

export interface ClaudeTrackedQueryInput {
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  config: ClaudeConfig
  location?: LocationContext
}

/**
 * Whether retrieval ran for an answer, kept separate from whether the answer
 * cited anything. Both a searched-but-uncited answer and an answer written
 * without retrieval store zero cited domains, and only this separates them.
 *
 * Deliberately NOT derived from, and not a restatement of, #879's
 * `captureStatus`. That signal reports whether citation extraction completed;
 * an extraction that ran and found zero sources is legitimately `complete` and
 * says nothing about whether a search happened. The two are orthogonal.
 *
 * - `used`           a search call is present in the response
 * - `not-used`       the response is intact and carries no search call
 * - `unknown`        the response is unavailable or empty, so retrieval is not
 *                    determinable; never collapse this into `not-used`, which
 *                    would assert an absence we did not observe
 * - `not-applicable` the surface has no retrieval step to report
 *
 * These values are provider-independent by design: retrieval semantics differ
 * per provider, so the vocabulary has to survive the move to the shared
 * contracts and the snapshot.
 */
export type RetrievalStatus = 'used' | 'not-used' | 'unknown' | 'not-applicable'

/**
 * The search policy a result was produced under, recorded so that a change in
 * policy can never yield an unmarked snapshot and so trends cannot silently mix
 * methods.
 *
 * - `native-auto-v1`     unmodified query, `tool_choice` left at `auto`;
 *                        measures whatever the model chooses to do
 * - `search-required-v1` unmodified query, no system prompt, `tool_choice`
 *                        pinned to `web_search`; measures a search-grounded
 *                        answer, and is NOT a reproduction of Claude.ai
 */
export type RetrievalContract = 'native-auto-v1' | 'search-required-v1'

export interface ClaudeRawResult {
  provider: 'claude'
  rawResponse: Record<string, unknown>
  model: string
  /** Verbatim `model` from the response; undefined when Claude disclosed none. */
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link RetrievalStatus}. */
  retrievalStatus: RetrievalStatus
  /** See {@link RetrievalContract}. */
  retrievalContract: RetrievalContract
}

export interface ClaudeNormalizedResult {
  provider: 'claude'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link RetrievalStatus}. */
  retrievalStatus: RetrievalStatus
}
