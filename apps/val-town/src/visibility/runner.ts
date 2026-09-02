import {
  DEFAULT_VISIBILITY_PROBE_LIMITS,
  type RunVisibilityProbeInput,
  VISIBILITY_PROBE_SCHEMA_VERSION,
  type VisibilityProbeCheck,
  type VisibilityProbeFailure,
  type VisibilityProbeQuery,
  type VisibilityProbeReport,
  type VisibilityProbeReportStatus,
  type VisibilityProbeSourceEvidence,
  type VisibilityProbeSummary,
  type VisibilityProbeTarget,
  type VisibilityProviderAdapter,
  type VisibilityProviderResponse,
} from './contracts.ts'
import {
  type CitationEvidence,
  detectCitation,
  detectMention,
  type NormalizedTarget,
  normalizeTarget,
} from './brand.ts'
import {
  cleanText,
  clipText,
  createDeadlineSignal,
  isAbortError,
  MAX_EXTRACTED_SOURCES,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUERY_ID_CHARS,
  nowIso,
  resolveLimits,
  safeProviderErrorMessage,
  throwIfAborted,
  uniqueStable,
} from './runtime.ts'

interface PreparedQuery extends VisibilityProbeQuery {
  id: string
  text: string
}

interface PreparedAdapter {
  adapter: VisibilityProviderAdapter
  name: string
  requestedModel: string | null
}

interface CheckSlot {
  query: PreparedQuery
  adapter: PreparedAdapter
}

/**
 * Execute a bounded query × provider matrix and return only normalized evidence.
 * A failed check is intentionally represented with null metrics, never coerced
 * into `not-mentioned` / `not-cited`.
 */
export async function runVisibilityProbe(input: RunVisibilityProbeInput): Promise<VisibilityProbeReport> {
  const limits = resolveLimits(DEFAULT_VISIBILITY_PROBE_LIMITS, input.limits)
  const target = normalizeTarget(input.target)
  const queries = prepareQueries(input.queries, limits.maxQueries)
  const adapters = prepareAdapters(input.adapters, limits.maxProviders)
  const startedAt = nowIso(input.now)
  const slots = createSlots(queries, adapters)
  const checks = new Array<VisibilityProbeCheck>(slots.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < slots.length) {
      const index = cursor
      cursor += 1
      checks[index] = await executeSlot(slots[index]!, target, limits, input.signal, input.now)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limits.maxConcurrency, slots.length) }, worker))

  const summary = summarize(checks)
  return {
    schemaVersion: VISIBILITY_PROBE_SCHEMA_VERSION,
    target: { canonicalDomain: target.canonicalDomain, brandNames: target.brandNames },
    startedAt,
    completedAt: nowIso(input.now),
    status: reportStatus(summary),
    checks,
    summary,
  }
}

function prepareQueries(input: readonly VisibilityProbeQuery[], maxQueries: number): PreparedQuery[] {
  if (input.length === 0) throw new Error('at least one query is required')
  if (input.length > maxQueries) throw new Error(`at most ${maxQueries} queries are allowed`)
  const ids = new Set<string>()
  return input.map((candidate, index) => {
    const text = cleanText(candidate.text)
    if (!text) throw new Error(`query ${index + 1} must not be empty`)
    if (text.length > MAX_QUERY_CHARS) {
      throw new Error(`query ${index + 1} must be at most ${MAX_QUERY_CHARS} characters`)
    }
    const id = cleanText(candidate.id) || `query-${index + 1}`
    if (id.length > MAX_QUERY_ID_CHARS) {
      throw new Error(`query ${index + 1} ID must be at most ${MAX_QUERY_ID_CHARS} characters`)
    }
    if (ids.has(id)) throw new Error('query IDs must be unique')
    ids.add(id)
    return { id, text }
  })
}

function prepareAdapters(input: readonly VisibilityProviderAdapter[], maxProviders: number): PreparedAdapter[] {
  if (input.length === 0) throw new Error('at least one provider adapter is required')
  if (input.length > maxProviders) throw new Error(`at most ${maxProviders} provider adapters are allowed`)
  const names = new Set<string>()
  return input.map((adapter) => {
    const name = cleanText(adapter.name)
    if (!name || typeof adapter.execute !== 'function') {
      throw new Error('each provider adapter must have a name and execute function')
    }
    if (name.length > MAX_PROVIDER_ID_CHARS) {
      throw new Error(`provider adapter names must be at most ${MAX_PROVIDER_ID_CHARS} characters`)
    }
    if (names.has(name)) throw new Error('provider adapter names must be unique')
    const requestedModel = boundedIdentifier(adapter.requestedModel, MAX_MODEL_ID_CHARS)
    if (adapter.requestedModel !== undefined && !requestedModel) {
      throw new Error(`provider adapter requestedModel must be at most ${MAX_MODEL_ID_CHARS} non-whitespace characters`)
    }
    names.add(name)
    return { adapter, name, requestedModel }
  })
}

function createSlots(queries: readonly PreparedQuery[], adapters: readonly PreparedAdapter[]): CheckSlot[] {
  const slots: CheckSlot[] = []
  for (const query of queries) {
    for (const adapter of adapters) slots.push({ query, adapter })
  }
  return slots
}

async function executeSlot(
  slot: CheckSlot,
  target: NormalizedTarget,
  limits: ReturnType<typeof resolveLimits>,
  parentSignal: AbortSignal | undefined,
  now: (() => Date) | undefined,
): Promise<VisibilityProbeCheck> {
  const deadline = createDeadlineSignal(parentSignal, limits.timeoutMs)
  try {
    throwIfAborted(deadline.signal)
    const response = await slot.adapter.adapter.execute({
      query: slot.query,
      target: { canonicalDomain: target.canonicalDomain, brandNames: target.brandNames },
      signal: deadline.signal,
      limits,
    })
    throwIfAborted(deadline.signal)
    return successfulCheck(slot, response, target, limits, now)
  } catch (error) {
    return failedCheck(slot, classifyFailure(error, deadline.didTimeout()), now)
  } finally {
    deadline.dispose()
  }
}

function successfulCheck(
  slot: CheckSlot,
  response: VisibilityProviderResponse,
  target: NormalizedTarget,
  limits: ReturnType<typeof resolveLimits>,
  now: (() => Date) | undefined,
): VisibilityProbeCheck {
  const answer = cleanText(response.answerText)
  if (!answer) {
    return failedCheck(
      slot,
      { code: 'invalid-response', message: 'The provider response contained no answer text.' },
      now,
    )
  }
  const requestedModel = boundedIdentifier(response.requestedModel, MAX_MODEL_ID_CHARS)
  if (!requestedModel) {
    return failedCheck(slot, {
      code: 'invalid-response',
      message: 'The provider response has an invalid requested model.',
    }, now)
  }
  // Match only the evidence that will be returned. This keeps the verdict
  // auditable and caps work even for a malformed custom adapter.
  const clippedAnswer = clipText(answer, limits.maxAnswerChars)
  const mention = detectMention(clippedAnswer.value, target)
  const citation = detectCitation((response.sources ?? []).slice(0, MAX_EXTRACTED_SOURCES), target)
  const clippedSources = clipSources(citation, limits)
  const normalizedSearchQueries = normalizeSearchQueries(response.searchQueries, limits)
  return {
    queryId: slot.query.id,
    query: slot.query.text,
    provider: slot.adapter.name,
    requestedModel,
    servedModel: boundedIdentifier(response.servedModel, MAX_MODEL_ID_CHARS),
    completedAt: nowIso(now),
    status: 'success',
    answerText: clippedAnswer.value,
    answerTruncated: clippedAnswer.truncated,
    mentioned: mention.mentioned,
    matchedTerms: mention.matchedTerms,
    cited: citation.cited,
    citedDomains: uniqueStable(
      clippedSources.map((source) => source.domain).filter((domain): domain is string => Boolean(domain)),
    ),
    citedUrls: clippedSources.map((source) => source.url),
    // Derive every outward-facing URL/domain array from the clipped source
    // set. `citation` may inspect up to the extraction hard cap to preserve
    // the verdict, but it must never leak an unbounded provider URL.
    matchedCitationDomains: uniqueStable(
      clippedSources.filter((source) => source.targetDomainMatch)
        .map((source) => source.domain)
        .filter((domain): domain is string => Boolean(domain)),
    ),
    matchedCitationUrls: clippedSources.filter((source) => source.targetDomainMatch).map((source) => source.url),
    sources: clippedSources,
    sourceCount: citation.sources.length,
    sourcesTruncated: citation.sources.length > clippedSources.length,
    searchQueries: normalizedSearchQueries.values,
    searchQueriesTruncated: normalizedSearchQueries.truncated,
    retrievalStatus: response.retrievalStatus ?? 'unknown',
    error: null,
  }
}

function clipSources(
  citation: CitationEvidence,
  limits: ReturnType<typeof resolveLimits>,
): VisibilityProbeSourceEvidence[] {
  // If output clipping occurs, keep target matches first so `cited: true`
  // always has visible source evidence. Relative provider order is preserved
  // within the matching and non-matching groups.
  const ordered = [
    ...citation.sources.filter((source) => source.targetDomainMatch),
    ...citation.sources.filter((source) => !source.targetDomainMatch),
  ]
  return ordered.slice(0, limits.maxSources).map((source) => ({
    url: clipText(source.url, limits.maxSourceUrlChars).value,
    title: source.title ? clipText(source.title, limits.maxSourceTitleChars).value : null,
    domain: source.domain,
    targetDomainMatch: source.targetDomainMatch,
  }))
}

function normalizeSearchQueries(
  values: readonly string[] | undefined,
  limits: ReturnType<typeof resolveLimits>,
): { values: string[]; truncated: boolean } {
  const source = (values ?? []).slice(0, MAX_EXTRACTED_SOURCES)
  const cleaned = uniqueStable(source.map(cleanText).filter(Boolean))
  return {
    values: cleaned.slice(0, limits.maxSearchQueries).map((value) => clipText(value, limits.maxSearchQueryChars).value),
    truncated: values !== undefined && (values.length > source.length || cleaned.length > limits.maxSearchQueries),
  }
}

function failedCheck(
  slot: CheckSlot,
  error: VisibilityProbeFailure,
  now: (() => Date) | undefined,
): VisibilityProbeCheck {
  return {
    queryId: slot.query.id,
    query: slot.query.text,
    provider: slot.adapter.name,
    requestedModel: slot.adapter.requestedModel,
    servedModel: null,
    completedAt: nowIso(now),
    status: 'failed',
    answerText: null,
    answerTruncated: false,
    mentioned: null,
    matchedTerms: [],
    cited: null,
    citedDomains: [],
    citedUrls: [],
    matchedCitationDomains: [],
    matchedCitationUrls: [],
    sources: [],
    sourceCount: 0,
    sourcesTruncated: false,
    searchQueries: [],
    searchQueriesTruncated: false,
    retrievalStatus: 'unknown',
    error,
  }
}

function boundedIdentifier(value: unknown, maxChars: number): string | null {
  const normalized = cleanText(value)
  return normalized && normalized.length <= maxChars ? normalized : null
}

function classifyFailure(error: unknown, timedOut: boolean): VisibilityProbeFailure {
  if (timedOut) return { code: 'timeout', message: 'The provider request timed out.' }
  if (isAbortError(error)) return { code: 'aborted', message: 'The provider request was cancelled.' }
  return { code: 'provider-error', message: safeProviderErrorMessage(error) }
}

function summarize(checks: readonly VisibilityProbeCheck[]): VisibilityProbeSummary {
  const successfulChecks = checks.filter((check) => check.status === 'success')
  const mentionedChecks = successfulChecks.filter((check) => check.mentioned === true).length
  const citedChecks = successfulChecks.filter((check) => check.cited === true).length
  const denominator = successfulChecks.length
  return {
    totalChecks: checks.length,
    successfulChecks: denominator,
    failedChecks: checks.length - denominator,
    mentionedChecks,
    citedChecks,
    mentionRate: denominator > 0 ? mentionedChecks / denominator : null,
    citationRate: denominator > 0 ? citedChecks / denominator : null,
  }
}

function reportStatus(summary: VisibilityProbeSummary): VisibilityProbeReportStatus {
  if (summary.successfulChecks === 0) return 'failed'
  return summary.failedChecks > 0 ? 'partial' : 'completed'
}

/** Public helper for callers that want to validate normalized target input before a run. */
export function normalizeVisibilityProbeTarget(target: VisibilityProbeTarget): VisibilityProbeTarget {
  const normalized = normalizeTarget(target)
  return { canonicalDomain: normalized.canonicalDomain, brandNames: normalized.brandNames }
}
