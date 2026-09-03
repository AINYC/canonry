/**
 * The BRANDED query planner — the mirror image of the visibility one.
 *
 * The visibility planner drops any generated query that names the brand
 * (`!detectMention(query, target).mentioned`), because a question that hands
 * the model the answer measures recall rather than placement. Perception wants
 * exactly the queries that planner throws away: the finding is what an engine
 * says when it is asked about the brand by name, so a query that never names it
 * is measuring a different thing and cannot go in the same basket.
 *
 * So the filter is inverted, and it is a filter rather than a prompt
 * instruction: the prompt asks for branded questions, `detectMention` decides
 * whether it got them. Fewer than requested is a smaller sample; zero is a
 * failure, because there is nothing to ask.
 */
import { detectMention, normalizeTarget } from '../visibility/brand.js'
import {
  createGeminiClient,
  DEFAULT_GEMINI_VISIBILITY_MODEL,
  extractAnswerText,
  type GeminiContentClient,
  stripCodeFence,
  withBoundedRetry,
} from '../visibility/gemini.js'
import {
  cleanText,
  createDeadlineSignal,
  MAX_BRAND_NAME_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_QUERY_CHARS,
  throwIfAborted,
  uniqueStable,
} from '../visibility/runtime.js'

/** Room for the plan itself. Thinking is disabled for this call, so all of it goes to the JSON. */
const MAX_PLANNER_OUTPUT_TOKENS = 1_200
/**
 * A backstop, not the product deadline. The host wraps this call in its own
 * `plannerTimeoutMs`, which is the number the budget arithmetic uses.
 */
const PLANNER_BACKSTOP_TIMEOUT_MS = 15_000
const MAX_PLANNER_QUERIES = 3
const MAX_PLANNER_BRAND_NAMES = 20

export interface PerceptionQueryPlan {
  target: { canonicalDomain: string; brandNames: string[] }
  queries: Array<{ id: string; text: string }>
}

export interface PerceptionPlanningInput {
  canonicalDomain: string
  maxQueries: number
  signal?: AbortSignal
}

export interface PerceptionPlanner {
  plan(input: PerceptionPlanningInput): Promise<PerceptionQueryPlan>
}

export interface GeminiPerceptionPlannerOptions {
  apiKey: string
  model?: string
  /** Test/advanced-runtime seam; normal hosts omit this and use the SDK client. */
  client?: GeminiContentClient
  /** 0-2 retries for 429/5xx/network failures, spent inside the deadline. Defaults to one. */
  maxRetries?: number
}

export function buildPerceptionPlanPrompt(input: { canonicalDomain: string; maxQueries: number }): string {
  return [
    'You create a small brand-perception probe plan for a company website.',
    'Return JSON only, with this exact shape: {"brandNames":["..."],"queries":["..."]}.',
    `Return 1-5 exact company/brand aliases and exactly ${input.maxQueries} questions ABOUT that company.`,
    'Every question must write the company name. A question that does not name it will be discarded.',
    'Use the shapes a person checking out a company actually types, for example:',
    '"is <brand> legit?", "is <brand> trustworthy?", "<brand> reviews", "what are the complaints about <brand>?",',
    '"<brand> vs alternatives", "is <brand> worth it?".',
    'Do not include URLs, explanations, markdown, or extra keys.',
    `Domain: ${input.canonicalDomain}`,
    'Use Google Search grounding to verify what the company is called before writing the questions.',
  ].join('\n')
}

/**
 * One bounded planning call. It researches the domain through grounding and
 * returns the brand's aliases plus branded questions; it never fetches the
 * domain itself and never runs a probe.
 */
export function createGeminiPerceptionPlanner(options: GeminiPerceptionPlannerOptions): PerceptionPlanner {
  const apiKey = cleanText(options.apiKey)
  if (!apiKey) throw new Error('Gemini API key is required')
  const model = cleanText(options.model) || DEFAULT_GEMINI_VISIBILITY_MODEL
  if (model.length > MAX_MODEL_ID_CHARS) {
    throw new Error(`Gemini model must be at most ${MAX_MODEL_ID_CHARS} characters`)
  }
  const client = options.client ?? createGeminiClient({ apiKey })
  const maxRetries = clampInteger(options.maxRetries ?? 1, 0, 2)

  return {
    async plan(input: PerceptionPlanningInput): Promise<PerceptionQueryPlan> {
      const target = normalizeTarget({ canonicalDomain: input.canonicalDomain, brandNames: [] })
      const maxQueries = clampInteger(input.maxQueries, 1, MAX_PLANNER_QUERIES)
      const deadline = createDeadlineSignal(input.signal, PLANNER_BACKSTOP_TIMEOUT_MS)
      try {
        throwIfAborted(deadline.signal)
        const response = await withBoundedRetry(
          () =>
            client.models.generateContent({
              model,
              contents: buildPerceptionPlanPrompt({ canonicalDomain: target.canonicalDomain, maxQueries }),
              config: {
                temperature: 0,
                candidateCount: 1,
                maxOutputTokens: MAX_PLANNER_OUTPUT_TOKENS,
                // Grounding is what lets the planner learn what the company is
                // CALLED, which every branded question then has to write.
                // Gemini 2.5 refuses structured output alongside a built-in
                // tool, so the response is fence-parsed below.
                tools: [{ googleSearch: {} }],
                // Thinking is on by default on 2.5 and is billed from
                // `maxOutputTokens`, so an unset budget lets the model spend
                // its whole allowance reasoning and return empty text — which
                // fails as "returned invalid JSON" and takes the plan with it.
                // Emitting a small JSON object needs no reasoning.
                thinkingConfig: { thinkingBudget: 0 },
                abortSignal: deadline.signal,
              },
            }),
          deadline.signal,
          // Planning is the single point whose failure can cost the whole
          // phase. The retry is spent INSIDE the deadline this call already
          // holds, so it buys an attempt without changing the budget.
          { maxRetries, retryBaseDelayMs: 400 },
        )
        return parsePerceptionQueryPlan({
          responseText: extractAnswerText(response),
          canonicalDomain: target.canonicalDomain,
          maxQueries,
        })
      } finally {
        deadline.dispose()
      }
    },
  }
}

function parsePerceptionQueryPlan(
  input: { responseText: string; canonicalDomain: string; maxQueries: number },
): PerceptionQueryPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(input.responseText))
  } catch {
    throw new Error('The perception planner returned invalid JSON.')
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  const rawNames = Array.isArray(record?.brandNames) ? record.brandNames.slice(0, MAX_PLANNER_BRAND_NAMES) : []
  const rawQueries = Array.isArray(record?.queries) ? record.queries.slice(0, MAX_PLANNER_BRAND_NAMES) : []
  const plannerNames = rawNames.flatMap((value) => typeof value === 'string' ? [cleanText(value)] : [])
    .filter((name) => name.length > 0 && name.length <= MAX_BRAND_NAME_CHARS)
  const target = normalizeTarget({
    canonicalDomain: input.canonicalDomain,
    brandNames: uniqueStable(plannerNames),
  })

  const seen = new Set<string>()
  const queries = rawQueries.flatMap((value) => typeof value === 'string' ? [cleanText(value)] : [])
    .filter((query) => query.length > 0 && query.length <= MAX_QUERY_CHARS)
    .filter((query) => {
      const key = query.toLocaleLowerCase('en').replace(/\s+/g, ' ')
      if (seen.has(key)) return false
      seen.add(key)
      // The inverted filter. A generated question that does not write the brand
      // is measuring visibility, not perception, and belongs to the other
      // instrument's basket. `detectMention` is the same exact-alias arbiter
      // the metrics use, so the prompt proposes and matching disposes.
      return detectMention(query, target).mentioned
    })
    .slice(0, input.maxQueries)
    .map((text, index) => ({ id: `planned-query-${index + 1}`, text }))

  if (queries.length === 0) {
    throw new Error('The perception planner did not return any branded questions.')
  }
  return { target: { canonicalDomain: target.canonicalDomain, brandNames: target.brandNames }, queries }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}
