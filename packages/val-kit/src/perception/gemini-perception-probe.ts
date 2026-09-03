/**
 * The host adapter: plan -> probe -> extract -> verify -> type -> summarize.
 *
 * The probing itself is `runVisibilityProbe` with branded queries. There is no
 * second probe implementation and there must not be one: the runner already
 * owns per-check deadlines, the failed-check-is-null rule, output caps, and the
 * safe error classifier, and a fork of it would drift on exactly the parts that
 * only show up in production.
 */
import { runVisibilityProbe } from '../visibility/runner.js'
import {
  createGeminiClient,
  createGeminiVisibilityAdapter,
  DEFAULT_GEMINI_VISIBILITY_MODEL,
  type GeminiContentClient,
} from '../visibility/gemini.js'
import type { VisibilityProbeCheck } from '../visibility/contracts.js'
import { cleanText } from '../visibility/runtime.js'
import { createGeminiPerceptionPlanner, type PerceptionQueryPlan } from './planner.js'
import { classifySourceType } from './source-type.js'
import { summarizePerception } from './summary.js'
import {
  createGeminiVerdictExtractor,
  VERDICT_EXTRACT_LIMITS,
  type VerdictProposal,
  verifyVerdict,
} from './verdict-extract.js'
import type { PerceptionEvidence, PerceptionProbeInput, PerceptionProbePort, PerceptionReport } from './types.js'

/**
 * Five provider calls for a whole check: 1 planner + 3 probes in ONE wave + 1
 * verdict extraction. `probeConcurrency >= maxProbeCalls` is what makes it one
 * wave, and one wave is what the arithmetic depends on:
 * `10 + 20 + 12 = 42s` inside a 45s job budget. Raising `maxProbeCalls` without
 * raising concurrency silently reintroduces a second wave and blows the
 * ceiling, so `perception-budget.test.ts` asserts the relationship, not the
 * numbers.
 */
export const VAL_TOWN_GEMINI_PERCEPTION_LIMITS = {
  maxPlannerCalls: 1,
  maxProbeCalls: 3,
  /** Reads the answers back for the position each takes. See verdict-extract.ts. */
  maxExtractCalls: 1,
  plannerTimeoutMs: 10_000,
  /** Per probe. A grounded `googleSearch` answer regularly runs past 10s. */
  probeTimeoutMs: 20_000,
  /** One wave: every probe in flight at once, never a second round. */
  probeConcurrency: 3,
  /** The verdict call's own deadline, kept equal to `VERDICT_EXTRACT_LIMITS.timeoutMs`. */
  verdictTimeoutMs: VERDICT_EXTRACT_LIMITS.timeoutMs,
} as const

const MAX_ANSWER_CHARS = 4_000
const MAX_SOURCES = 12
const MAX_SEARCH_QUERIES = 12

export interface GeminiValPerceptionProbeOptions {
  apiKey: string
  model?: string
  /** Test seam; production uses the SDK client created by the local adapter. */
  client?: GeminiContentClient
}

export function createGeminiValPerceptionProbe(options: GeminiValPerceptionProbeOptions): PerceptionProbePort {
  const model = cleanText(options.model) || DEFAULT_GEMINI_VISIBILITY_MODEL
  const planner = createGeminiPerceptionPlanner({
    apiKey: options.apiKey,
    model: options.model,
    // The retry runs inside the per-call deadline, so it costs no extra budget.
    maxRetries: 1,
    client: options.client,
  })
  const adapter = createGeminiVisibilityAdapter({
    apiKey: options.apiKey,
    model: options.model,
    // A transient 503 on one probe would otherwise lose that answer outright.
    // Bounded by the same 20s probe deadline.
    maxRetries: 1,
    // Thinking is billed from this same allowance, so the answer needs room the
    // reasoning cannot take. Clipped to 4,000 chars downstream regardless.
    maxOutputTokens: 2_400,
    client: options.client,
  })
  const extractor = createGeminiVerdictExtractor({
    client: options.client ?? createGeminiClient({ apiKey: options.apiKey }),
    model,
  })

  return {
    async probe(input: PerceptionProbeInput): Promise<PerceptionReport> {
      const budget = boundedProbeCalls(input.maxProbeCalls)
      // The visitor's own questions are used verbatim and need not name the
      // brand — they chose them. Only a GENERATED question has to.
      const supplied = (input.userQueries ?? [])
        .map((text) => cleanText(text))
        .filter((text) => text.length > 0)
        .slice(0, budget)
        .map((text, index) => ({ id: `user-${index + 1}`, text }))
      const generateCount = budget - supplied.length

      // A caller who supplied the full set gets no planning call at all: it
      // would spend a Gemini request producing questions nothing then asks.
      //
      // A planning failure is fatal only when it leaves NOTHING to ask. The
      // visitor's own questions are perfectly good probes, and losing them
      // because OUR generator hiccuped hands back an empty report for work they
      // already specified.
      let plan: PerceptionQueryPlan | null = null
      if (generateCount > 0) {
        try {
          plan = await planner.plan({
            canonicalDomain: input.domain,
            maxQueries: generateCount,
            signal: AbortSignal.any([
              input.signal,
              AbortSignal.timeout(VAL_TOWN_GEMINI_PERCEPTION_LIMITS.plannerTimeoutMs),
            ]),
          })
        } catch (error) {
          if (supplied.length === 0) throw error
        }
      }

      const brandNames = plan?.target.brandNames ?? []
      // Supplied questions first, so a partial list is never displaced by
      // generated ones when the probe budget is spent.
      const queries = [...supplied, ...(plan?.queries ?? [])].slice(0, budget)

      const report = await runVisibilityProbe({
        target: { canonicalDomain: input.domain, brandNames },
        queries,
        adapters: [adapter],
        signal: input.signal,
        limits: {
          maxQueries: budget,
          maxProviders: 1,
          maxConcurrency: VAL_TOWN_GEMINI_PERCEPTION_LIMITS.probeConcurrency,
          timeoutMs: VAL_TOWN_GEMINI_PERCEPTION_LIMITS.probeTimeoutMs,
          maxAnswerChars: MAX_ANSWER_CHARS,
          maxSources: MAX_SOURCES,
          maxSearchQueries: MAX_SEARCH_QUERIES,
        },
      })

      // One bounded call reads every answer back for the position it takes.
      // Each proposal is then re-verified against the prose, so a failure
      // leaves the verdict null (unmeasured) rather than "took no position".
      const proposals = await extractor.extract(
        report.checks.map((check) => ({ text: check.answerText ?? '', brandNames })),
        input.signal,
      )

      // Built once and summarized from the same array the report returns, so a
      // headline can never be computed from rows the reader is not shown.
      const evidence = report.checks.map((check, index) =>
        toEvidence(check, proposals[index] ?? null, input.domain, model)
      )
      return {
        schemaVersion: '1',
        domain: input.domain,
        brandNames,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        summary: summarizePerception(evidence),
        evidence,
      }
    },
  }
}

function boundedProbeCalls(value: number): number {
  const ceiling = VAL_TOWN_GEMINI_PERCEPTION_LIMITS.maxProbeCalls
  // A runtime caller may ask for fewer, never for more: the ceiling is what a
  // public visitor can make this instrument spend.
  if (!Number.isFinite(value)) return ceiling
  return Math.max(1, Math.min(ceiling, Math.floor(value)))
}

function toEvidence(
  check: VisibilityProbeCheck,
  proposal: VerdictProposal | null,
  targetDomain: string,
  requestedModelFallback: string,
): PerceptionEvidence {
  const failed = check.status === 'failed'
  const answerText = check.answerText
  const verified = failed || proposal === null || answerText === null ? null : verifyVerdict(answerText, proposal)
  return {
    query: check.query,
    provider: check.provider,
    requestedModel: check.requestedModel ?? requestedModelFallback,
    servedModel: check.servedModel,
    answerText,
    completedAt: check.completedAt,
    // Null on a failed probe AND on a failed extraction: both mean nobody read
    // a position out of this answer, which is not the same as an answer that
    // took none.
    verdict: verified?.verdict ?? null,
    evidenceSentences: verified?.evidenceSentences ?? [],
    concerns: verified?.concerns ?? [],
    sources: check.sources.map((source) => ({
      url: source.url,
      domain: source.domain,
      title: source.title,
      type: classifySourceType(source.domain, targetDomain),
    })),
    searchQueries: check.searchQueries,
    // Gemini does not attest retrieval per answer, so this is derived from what
    // the response carried: an attributed source or a disclosed search is
    // grounding that demonstrably happened. Nothing at all means nothing in the
    // response indicates retrieval.
    retrievalStatus: failed ? 'error' : (check.sources.length > 0 || check.searchQueries.length > 0)
      ? 'grounded'
      : 'ungrounded',
    error: check.error?.message ?? null,
  }
}
