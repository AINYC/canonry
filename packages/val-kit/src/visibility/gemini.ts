import { type GenerateContentParameters, type GenerateContentResponse, GoogleGenAI } from '@google/genai'

import type {
  VisibilityProbeTarget,
  VisibilityProviderAdapter,
  VisibilityProviderRequest,
  VisibilityProviderResponse,
  VisibilityQueryPlan,
  VisibilityQueryPlanner,
  VisibilityQueryPlanningInput,
  VisibilitySource,
} from './contracts.js'
import { detectMention, hostOf, normalizeTarget } from './brand.js'
import {
  cleanText,
  clipText,
  createDeadlineSignal,
  isAbortError,
  MAX_EXTRACTED_SOURCES,
  MAX_MODEL_ID_CHARS,
  nowIso,
  sleep,
  throwIfAborted,
  uniqueStable,
} from './runtime.js'

export const DEFAULT_GEMINI_VISIBILITY_MODEL = 'gemini-2.5-flash'

/**
 * Thinking tokens a probe may spend, out of its `maxOutputTokens`. Bounded so
 * reasoning can never starve the answer: an empty answer is a lost
 * measurement, and it is indistinguishable from an engine that had nothing to
 * say about the brand.
 */
export const PROBE_THINKING_BUDGET_TOKENS = 512
const VERTEX_AI_SEARCH_PROXY_DOMAIN = 'vertexaisearch.cloud.google.com'
const MAX_PLANNER_CONTEXT_CHARS = 12_000
// Room for the plan itself. Thinking is disabled for this call, so the whole
// allowance goes to the JSON; 700 had to cover reasoning too and often did not.
const MAX_PLANNER_OUTPUT_TOKENS = 1_200

export interface GeminiVisibilityAdapterOptions {
  apiKey: string
  model?: string
  /** 0–2 retries for 429/5xx/network failures. Defaults to one retry. */
  maxRetries?: number
  retryBaseDelayMs?: number
  /** Bounded model output. Defaults to 1,200 and is capped at 2,048. */
  maxOutputTokens?: number
  /** Test/advanced-runtime seam; normal hosts should omit this and use the SDK client. */
  client?: GeminiContentClient
}

export interface GeminiContentClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>
  }
}

/**
 * A Gemini adapter that asks Gemini to use native Google Search grounding.
 * It emits only normalized answer/source evidence and never retains a raw SDK
 * response. The caller owns key storage, budgets, and request admission.
 */
export function createGeminiVisibilityAdapter(options: GeminiVisibilityAdapterOptions): VisibilityProviderAdapter {
  const config = normalizeGeminiOptions(options)
  const client = options.client ?? createGeminiClient(config)
  return {
    name: 'gemini',
    requestedModel: config.model,
    async execute(request: VisibilityProviderRequest): Promise<VisibilityProviderResponse> {
      const response = await withBoundedRetry(
        () =>
          client.models.generateContent({
            model: config.model,
            contents: request.query.text,
            config: {
              tools: [{ googleSearch: {} }],
              candidateCount: 1,
              temperature: 0,
              maxOutputTokens: config.maxOutputTokens,
              // Gemini 2.5 thinks by default and bills those tokens against
              // the SAME output allowance, so a probe could spend the whole
              // budget reasoning and return a response with no text at all —
              // which the runner correctly reports as "returned no answer
              // text" and which cost a real check one of its three answers.
              //
              // Capped rather than disabled: this is simulating an answer
              // engine, so some reasoning is wanted, but it must not be able
              // to consume the answer's room. `mention-extract.ts` sets 0 for
              // the same reason, because copying names out needs no thought.
              thinkingConfig: { thinkingBudget: PROBE_THINKING_BUDGET_TOKENS },
              abortSignal: request.signal,
            },
          }),
        request.signal,
        config,
      )
      return normalizeGeminiVisibilityResponse(response, config.model)
    },
  }
}

/**
 * One bounded planning call for public-domain onboarding. It plans aliases and
 * non-brand buyer queries from caller-provided homepage text; it never fetches
 * the domain itself and does not run a visibility probe.
 */
export function createGeminiVisibilityQueryPlanner(options: GeminiVisibilityAdapterOptions): VisibilityQueryPlanner {
  const config = normalizeGeminiOptions(options)
  const client = options.client ?? createGeminiClient(config)
  return {
    name: 'gemini',
    requestedModel: config.model,
    async plan(input: VisibilityQueryPlanningInput): Promise<VisibilityQueryPlan> {
      const target = normalizeTarget({ canonicalDomain: input.canonicalDomain, brandNames: input.brandNames ?? [] })
      const context = cleanText(input.homepageContext)
      const maxQueries = boundedPlannerQueryCount(input.maxQueries)
      const deadline = createDeadlineSignal(input.signal, 15_000)
      try {
        throwIfAborted(deadline.signal)
        const response = await withBoundedRetry(
          () =>
            client.models.generateContent({
              model: config.model,
              contents: buildPlannerPrompt({
                canonicalDomain: target.canonicalDomain,
                homepageContext: context ? clipText(context, MAX_PLANNER_CONTEXT_CHARS).value : null,
                maxQueries,
              }),
              config: {
                temperature: 0,
                candidateCount: 1,
                maxOutputTokens: MAX_PLANNER_OUTPUT_TOKENS,
                // Gemini 2.5 does not support structured output plus a built-in
                // tool. We rely on the strict JSON/fence parser below instead.
                tools: [{ googleSearch: {} }],
                // The THIRD place this bit. Thinking is on by default on 2.5
                // and is billed from `maxOutputTokens`, so the planner could
                // spend its whole allowance reasoning, return empty text, and
                // fail on `JSON.parse('')` as "returned invalid JSON" — taking
                // the generated questions with it. Emitting a small JSON object
                // needs no reasoning at all.
                thinkingConfig: { thinkingBudget: 0 },
                abortSignal: deadline.signal,
              },
            }),
          deadline.signal,
          // One retry, spent inside the deadline this call already holds, so
          // the budget is unchanged. Planning is the single point whose failure
          // costs the WHOLE visibility phase; refusing to retry a transient 503
          // there traded a cheap second attempt for the entire report.
          { ...config, maxRetries: 1 },
        )
        return parseGeminiQueryPlan({
          responseText: extractAnswerText(response),
          target: { canonicalDomain: target.canonicalDomain, brandNames: target.brandNames },
          maxQueries,
          requestedModel: config.model,
          servedModel: extractServedModel(response),
          generatedAt: nowIso(input.now),
        })
      } finally {
        deadline.dispose()
      }
    },
  }
}

interface NormalizedGeminiOptions {
  apiKey: string
  model: string
  maxRetries: number
  retryBaseDelayMs: number
  maxOutputTokens: number
}

function normalizeGeminiOptions(options: GeminiVisibilityAdapterOptions): NormalizedGeminiOptions {
  const apiKey = cleanText(options.apiKey)
  if (!apiKey) throw new Error('Gemini API key is required')
  const model = cleanText(options.model) || DEFAULT_GEMINI_VISIBILITY_MODEL
  if (model.length > MAX_MODEL_ID_CHARS) {
    throw new Error(`Gemini model must be at most ${MAX_MODEL_ID_CHARS} characters`)
  }
  return {
    apiKey,
    model,
    maxRetries: clampInteger(options.maxRetries ?? 1, 0, 2),
    retryBaseDelayMs: clampInteger(options.retryBaseDelayMs ?? 400, 100, 2_000),
    maxOutputTokens: clampInteger(options.maxOutputTokens ?? 1_200, 128, 2_048),
  }
}

export function createGeminiClient(options: Pick<NormalizedGeminiOptions, 'apiKey'>): GoogleGenAI {
  return new GoogleGenAI({ apiKey: options.apiKey })
}

/** The two knobs `withBoundedRetry` reads. `NormalizedGeminiOptions` satisfies it. */
export interface GeminiRetryConfig {
  maxRetries: number
  retryBaseDelayMs: number
}

/**
 * Retry a provider call inside the deadline the caller already holds, so a
 * transient 429/5xx costs an attempt rather than a measurement and the budget
 * arithmetic is unchanged.
 *
 * Exported so a second instrument reuses this policy instead of copying it: a
 * fork would drift on which statuses are retryable, and the divergence only
 * shows up as one instrument losing answers the other keeps.
 */
export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  config: GeminiRetryConfig,
): Promise<T> {
  let attempt = 0
  for (;;) {
    throwIfAborted(signal)
    try {
      return await operation()
    } catch (error) {
      if (attempt >= config.maxRetries || !isRetryable(error) || isAbortError(error) || signal.aborted) throw error
      const delay = Math.min(config.retryBaseDelayMs * (2 ** attempt), 4_000)
      attempt += 1
      await sleep(delay, signal)
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const candidate = record.status ?? record.statusCode ?? record.code
  const status = typeof candidate === 'number' ? candidate : Number(candidate)
  if (Number.isInteger(status)) return status === 429 || status >= 500
  const message = error instanceof Error ? error.message : ''
  return /\b(?:429|500|501|502|503|504)\b|fetch failed|network/i.test(message)
}

/** Exported for provider fixture tests; it is deliberately raw-payload free. */
export function normalizeGeminiVisibilityResponse(
  response: GenerateContentResponse,
  requestedModel: string,
): VisibilityProviderResponse {
  const model = boundedModelId(requestedModel)
  if (!model) throw new Error(`Gemini model must be at most ${MAX_MODEL_ID_CHARS} non-whitespace characters`)
  const answerText = extractAnswerText(response)
  return {
    requestedModel: model,
    servedModel: extractServedModel(response),
    answerText,
    sources: extractGroundedSources(response),
    searchQueries: extractSearchQueries(response),
    // Google Search grounding is requested, but the API does not reliably
    // attest whether a search actually ran for each answer.
    retrievalStatus: 'unknown',
    // Present only when there is no answer to explain. A normalized response
    // that carries a reason for text it DID produce reads as a contradiction.
    ...(answerText ? {} : { emptyAnswerReason: emptyAnswerReason(response) }),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const record = asRecord(item)
      return record ? [record] : []
    })
    : []
}

export function extractAnswerText(response: GenerateContentResponse): string {
  const record = asRecord(response)
  const candidate = asRecords(record?.candidates).at(0)
  const content = asRecord(candidate?.content)
  const parts = asRecords(content?.parts)
  return parts.flatMap((part) => typeof part.text === 'string' ? [part.text] : []).join('')
}

function extractServedModel(response: GenerateContentResponse): string | null {
  return boundedModelId(asRecord(response)?.modelVersion)
}

/**
 * The provider's whole `FinishReason` enum, mapped to a closed set of safe
 * sentences.
 *
 * Mapping only the reasons that seemed likely left everything else falling
 * through to "contained no answer text", which is where the diagnosis had been
 * destroyed in the first place: a real probe kept failing and the generic
 * sentence could not say whether the answer was truncated, refused, or never
 * attempted. Enumerate the source enum rather than guess at a useful subset.
 *
 * `STOP` with no text is its own finding: the model ended cleanly and wrote
 * nothing, which usually means the grounded search returned it nothing to say.
 */
const EMPTY_ANSWER_REASONS = new Map<string, string>([
  ['MAX_TOKENS', 'The provider answer was cut off at the length limit.'],
  ['SAFETY', 'The provider declined to answer this query.'],
  ['PROHIBITED_CONTENT', 'The provider declined to answer this query.'],
  ['BLOCKLIST', 'The provider declined to answer this query.'],
  ['SPII', 'The provider declined to answer this query.'],
  ['RECITATION', 'The provider stopped the answer to avoid reciting a source.'],
  ['LANGUAGE', 'The provider does not support the language of this query.'],
  ['MALFORMED_FUNCTION_CALL', 'The provider ended the answer on an internal tool error.'],
  ['STOP', 'The provider ended the answer without writing anything.'],
  ['OTHER', 'The provider stopped the answer for an unstated reason.'],
  ['FINISH_REASON_UNSPECIFIED', 'The provider stopped the answer for an unstated reason.'],
])

/**
 * Why the model stopped, when it stopped without writing anything.
 *
 * A response with no text was reported only as "returned no answer text",
 * which is a dead end: it cannot distinguish an answer truncated at the token
 * ceiling (our configuration, fixable) from one the model declined to give
 * (the content, not fixable). Both were losing measurements and looked
 * identical, so the same symptom got diagnosed twice from scratch.
 *
 * Mapped to a closed set. `finishReason` is a provider enum, and this string
 * reaches a public record.
 */
export function emptyAnswerReason(response: GenerateContentResponse): string {
  const candidate = asRecords(asRecord(response)?.candidates).at(0)
  const reason = typeof candidate?.finishReason === 'string' ? candidate.finishReason.toUpperCase() : ''
  return EMPTY_ANSWER_REASONS.get(reason) ?? 'The provider response contained no answer text.'
}

export function extractGroundedSources(response: GenerateContentResponse): VisibilitySource[] {
  const record = asRecord(response)
  const candidate = asRecords(record?.candidates).at(0)
  const metadata = asRecord(candidate?.groundingMetadata)
  const chunks = asRecords(metadata?.groundingChunks)
  const indices = new Set<number>()
  for (const support of asRecords(metadata?.groundingSupports)) {
    const values = support.groundingChunkIndices
    if (!Array.isArray(values)) continue
    for (const value of values) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < chunks.length) {
        indices.add(value)
      }
    }
  }
  const selected = indices.size > 0 ? [...indices].map((index) => chunks[index]!).filter(Boolean) : chunks
  const sources: VisibilitySource[] = []
  const seen = new Set<string>()
  for (const chunk of selected) {
    if (sources.length >= MAX_EXTRACTED_SOURCES) break
    const web = asRecord(chunk.web)
    const source = typeof web?.uri === 'string'
      ? normalizeGeminiSource(web.uri, typeof web.title === 'string' ? web.title : null)
      : null
    if (!source || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  return sources
}

function normalizeGeminiSource(uri: string, title: string | null): VisibilitySource | null {
  try {
    const parsed = new URL(uri)
    if (hostOf(parsed.hostname) !== VERTEX_AI_SEARCH_PROXY_DOMAIN) {
      return { url: parsed.toString(), title }
    }
    const prefix = '/grounding-api-redirect/'
    if (parsed.pathname.startsWith(prefix)) {
      try {
        const redirect = decodeURIComponent(parsed.pathname.slice(prefix.length))
        const redirected = new URL(redirect)
        if (redirected.protocol === 'https:' || redirected.protocol === 'http:') {
          return { url: redirected.toString(), title }
        }
      } catch {
        // Opaque redirect; retain its URL below without treating its host as a citation.
      }
    }
    // Vertex can return an opaque redirect. Preserve the evidence URL but
    // never attribute the proxy hostname as a source. A title is only usable
    // when it is itself exactly a hostname/domain, never ordinary prose.
    return { url: parsed.toString(), title, domain: titleDomain(title) }
  } catch {
    return null
  }
}

function titleDomain(title: string | null): string | null {
  const candidate = cleanText(title)
  if (!candidate || !/^[a-z0-9.-]+$/i.test(candidate)) return null
  const domain = hostOf(candidate)
  return domain && domain.includes('.') ? domain : null
}

export function extractSearchQueries(response: GenerateContentResponse): string[] {
  const record = asRecord(response)
  const candidate = asRecords(record?.candidates).at(0)
  const metadata = asRecord(candidate?.groundingMetadata)
  const values = metadata?.webSearchQueries
  return Array.isArray(values) ? uniqueStable(values.flatMap((value) => typeof value === 'string' ? [value] : [])) : []
}

function boundedPlannerQueryCount(value: number | undefined): number {
  return clampInteger(value ?? 3, 1, 3)
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

export interface GeminiQueryPlanParseInput {
  responseText: string
  target: VisibilityProbeTarget
  maxQueries: number
  requestedModel: string
  servedModel: string | null
  generatedAt: string
}

/**
 * Deterministic parser/validator for the planner's one-call JSON response.
 * It accepts only exact JSON and removes branded, duplicate, empty, and
 * overlong queries before returning a plan.
 */
export function parseGeminiQueryPlan(input: GeminiQueryPlanParseInput): VisibilityQueryPlan {
  const requestedModel = boundedModelId(input.requestedModel)
  if (!requestedModel) throw new Error(`Gemini model must be at most ${MAX_MODEL_ID_CHARS} non-whitespace characters`)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(input.responseText))
  } catch {
    throw new Error('The query planner returned invalid JSON.')
  }
  const record = asRecord(parsed)
  const rawNames = Array.isArray(record?.brandNames) ? record.brandNames.slice(0, 20) : []
  const rawQueries = Array.isArray(record?.queries) ? record.queries.slice(0, 20) : []
  const plannerNames = rawNames.flatMap((value) => typeof value === 'string' ? [cleanText(value)] : [])
    .filter((name) => name.length > 0 && name.length <= 128)
  const target = normalizeTarget({
    canonicalDomain: input.target.canonicalDomain,
    brandNames: uniqueStable([...input.target.brandNames, ...plannerNames]),
  })
  const seenQueries = new Set<string>()
  const queries = rawQueries.flatMap((value) => typeof value === 'string' ? [cleanText(value)] : [])
    .filter((query) => query.length > 0 && query.length <= 512)
    .filter((query) => {
      const key = query.toLocaleLowerCase('en').replace(/\s+/g, ' ')
      if (seenQueries.has(key)) return false
      seenQueries.add(key)
      return !detectMention(query, target).mentioned
    })
    .slice(0, input.maxQueries)
    .map((text, index) => ({ id: `planned-query-${index + 1}`, text }))
  // Fewer than asked for is a smaller sample, not a failed check. Requiring an
  // EXACT count meant a planner that returned two usable queries out of three
  // destroyed the entire visibility half of the report, and the reader got
  // nothing rather than two answers. Zero is still a failure: there is nothing
  // to probe.
  if (queries.length === 0) {
    throw new Error('The query planner did not return any non-brand buyer queries.')
  }
  return {
    target: { canonicalDomain: target.canonicalDomain, brandNames: target.brandNames },
    queries,
    planner: 'gemini',
    requestedModel,
    servedModel: boundedModelId(input.servedModel),
    generatedAt: input.generatedAt,
  }
}

function boundedModelId(value: unknown): string | null {
  const model = cleanText(value)
  return model && model.length <= MAX_MODEL_ID_CHARS ? model : null
}

/**
 * Unwrap a fenced JSON block.
 *
 * Exported because every call that uses a built-in tool has to hand-parse its
 * output: Gemini 2.5 refuses `responseSchema` alongside `googleSearch`, so a
 * grounded planner gets prose-fenced JSON and nothing else. One implementation,
 * or two parsers disagree about what counts as valid and the symptom is
 * "returned invalid JSON" on one surface only.
 */
export function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return trimmed
  const language = trimmed.slice(3, firstNewline).trim().toLowerCase()
  if (language && language !== 'json') return trimmed
  return trimmed.slice(firstNewline + 1, -3).trim()
}

export function buildPlannerPrompt(input: {
  canonicalDomain: string
  homepageContext: string | null
  maxQueries: number
}): string {
  return [
    'You create a small AI-visibility probe plan from a company website.',
    'Return JSON only, with this exact shape: {"brandNames":["..."],"queries":["..."]}.',
    `Return 1-5 exact company/brand aliases and exactly ${input.maxQueries} non-brand buyer-intent queries.`,
    'Queries must be natural questions or searches a prospective buyer could use before knowing the company.',
    'Do not include the company name, domain, URLs, competitors, explanations, markdown, or extra keys.',
    `Domain: ${input.canonicalDomain}`,
    input.homepageContext
      ? 'Homepage extract:'
      : 'No homepage extract was provided. Use Google Search grounding to verify the domain context.',
    ...(input.homepageContext ? [input.homepageContext] : []),
  ].join('\n')
}
