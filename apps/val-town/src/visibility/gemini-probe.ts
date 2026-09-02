import {
  createGeminiClient,
  createGeminiVisibilityAdapter,
  createGeminiVisibilityQueryPlanner,
  DEFAULT_GEMINI_VISIBILITY_MODEL,
  type GeminiContentClient,
} from './gemini.ts'
import { createGeminiBrandExtractor } from './mention-extract.ts'
import type { VisibilityProbeCheck, VisibilityProbeReport } from './contracts.ts'
import { runVisibilityProbe } from './runner.ts'
import type {
  VisibilityEvidence,
  VisibilityProbeInput,
  VisibilityProbePort,
  VisibilityReport,
} from '../runtime/types.ts'

export interface GeminiValVisibilityProbeOptions {
  apiKey: string
  model?: string
  /** Test seam; production uses the SDK client created by the local adapter. */
  client?: GeminiContentClient
}

export const VAL_TOWN_GEMINI_VISIBILITY_LIMITS = {
  maxPlannerCalls: 1,
  maxProbeCalls: 3,
  /** Reads the answers back to list the brands each one names. See mention-extract.ts. */
  maxExtractCalls: 1,
  plannerTimeoutMs: 10_000,
  /**
   * Per probe, not for the phase. Gemini answers with `googleSearch` grounding,
   * which regularly runs past 10s: a real check timed out on ALL THREE probes
   * and reported "The answer engine did not respond in time."
   *
   * The old 10s was not a judgement about Gemini, it was all the budget there
   * was. Three probes at concurrency 2 run in TWO waves, so the phase cost
   * `planner + 2 x probe + extraction` = 42s against a 45s ceiling. Running all
   * three in one wave buys back a whole wave and pays for a realistic deadline.
   * `probe-budget.test.ts` holds the arithmetic.
   */
  probeTimeoutMs: 20_000,
  /** One wave: `maxProbeCalls` in flight at once, never a second round. */
  probeConcurrency: 3,
} as const

/**
 * Val-specific composition of the local planner, provider adapter, and
 * evidence runner. The public host can make exactly one planning call and at
 * most three probe calls per check.
 */
export function createGeminiValVisibilityProbe(options: GeminiValVisibilityProbeOptions): VisibilityProbePort {
  const planner = createGeminiVisibilityQueryPlanner({
    apiKey: options.apiKey,
    model: options.model,
    maxRetries: 0,
    maxOutputTokens: 700,
    client: options.client,
  })
  const adapter = createGeminiVisibilityAdapter({
    apiKey: options.apiKey,
    model: options.model,
    maxRetries: 0,
    maxOutputTokens: 1_000,
    client: options.client,
  })
  const extractor = createGeminiBrandExtractor({
    client: options.client ?? createGeminiClient({ apiKey: options.apiKey }),
    model: options.model ?? DEFAULT_GEMINI_VISIBILITY_MODEL,
  })

  return {
    async probe(input: VisibilityProbeInput): Promise<VisibilityReport> {
      const supplied = (input.userQueries ?? [])
        .slice(0, VAL_TOWN_GEMINI_VISIBILITY_LIMITS.maxProbeCalls)
        .map((text, index) => ({ id: `user-${index + 1}`, text }))
      const generateCount = VAL_TOWN_GEMINI_VISIBILITY_LIMITS.maxProbeCalls - supplied.length

      // A caller who supplied the full set gets no planning call at all: it
      // would cost a Gemini request to produce questions nothing then asks.
      const plan = generateCount > 0
        ? await planner.plan({
          canonicalDomain: input.domain,
          brandNames: [],
          maxQueries: generateCount,
          signal: AbortSignal.any([
            input.signal,
            AbortSignal.timeout(VAL_TOWN_GEMINI_VISIBILITY_LIMITS.plannerTimeoutMs),
          ]),
        })
        : null

      // The caller's questions come first, so a partial list is never displaced
      // by generated ones when the probe budget is spent.
      const queries = [...supplied, ...(plan?.queries ?? [])]
        .slice(0, VAL_TOWN_GEMINI_VISIBILITY_LIMITS.maxProbeCalls)

      const report = await runVisibilityProbe({
        target: plan?.target ?? { canonicalDomain: input.domain, brandNames: [] },
        queries,
        adapters: [adapter],
        signal: input.signal,
        limits: {
          maxQueries: VAL_TOWN_GEMINI_VISIBILITY_LIMITS.maxProbeCalls,
          maxProviders: 1,
          maxConcurrency: VAL_TOWN_GEMINI_VISIBILITY_LIMITS.probeConcurrency,
          timeoutMs: VAL_TOWN_GEMINI_VISIBILITY_LIMITS.probeTimeoutMs,
          maxAnswerChars: 4_000,
          maxSources: 12,
          maxSearchQueries: 12,
        },
      })
      // Mention share needs names, and nothing before this point knows the
      // rivals'. One bounded call reads the answers back; every name it returns
      // is then re-verified against the prose. A failure leaves the field null,
      // so mentions read as unmeasured rather than as nobody named.
      const answers = report.checks.map((check) => check.answerText ?? '')
      const namedBrands = await extractor.extract(answers, input.signal)
      return toHostReport(input.domain, report, namedBrands)
    },
  }
}

function toHostReport(
  domain: string,
  report: VisibilityProbeReport,
  namedBrands: ReadonlyArray<string[] | null>,
): VisibilityReport {
  return {
    schemaVersion: String(report.schemaVersion),
    domain,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    summary: {
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
    },
    evidence: report.checks.map((check, index) => toEvidence(check, namedBrands[index] ?? null)),
  }
}

function toEvidence(check: VisibilityProbeCheck, namedBrands: string[] | null): VisibilityEvidence {
  return {
    query: check.query,
    provider: check.provider,
    requestedModel: check.requestedModel,
    servedModel: check.servedModel,
    completedAt: check.completedAt,
    answerText: check.answerText,
    mentioned: check.mentioned,
    matchedTerms: check.matchedTerms,
    cited: check.cited,
    citedDomains: check.citedDomains,
    citedUrls: check.citedUrls,
    matchedCitationDomains: check.matchedCitationDomains,
    matchedCitationUrls: check.matchedCitationUrls,
    sources: check.sources.map((source) => ({ url: source.url, title: source.title })),
    searchQueries: check.searchQueries,
    // A failed check has no prose, so it can carry no names either.
    namedBrands: check.status === 'failed' ? null : namedBrands,
    retrievalStatus: check.status === 'failed'
      ? 'error'
      : check.retrievalStatus === 'used'
      ? 'grounded'
      : check.retrievalStatus === 'not-used'
      ? 'not-grounded'
      : 'unknown',
    error: check.error?.message ?? null,
  }
}
