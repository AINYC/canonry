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

export interface ClaudeRawResult {
  provider: 'claude'
  rawResponse: Record<string, unknown>
  model: string
  /** Verbatim `model` from the response; undefined when Claude disclosed none. */
  servedModel?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /**
   * Whether Claude actually invoked web_search. Distinguishes an answer written
   * without retrieval from one that searched and cited nothing: both carry zero
   * cited domains, and only this separates them. Under `search-required.v1` a
   * false here means the contract did not hold and the row should not be pooled
   * with retrieved answers.
   */
  retrieved: boolean
  /** The measurement contract that produced this result. */
  retrievalContract: string
}

export interface ClaudeNormalizedResult {
  provider: 'claude'
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link ClaudeRawResult.retrieved}. */
  retrieved: boolean
}
