import { type GenerateContentParameters, type GenerateContentResponse, GoogleGenAI } from 'npm:@google/genai@1.46.0'

import type {
  VisibilityProbeTarget,
  VisibilityProviderAdapter,
  VisibilityProviderRequest,
  VisibilityProviderResponse,
  VisibilityQueryPlan,
  VisibilityQueryPlanner,
  VisibilityQueryPlanningInput,
  VisibilitySource,
} from './contracts.ts'
import { detectMention, hostOf, normalizeTarget } from './brand.ts'
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
} from './runtime.ts'

export const DEFAULT_GEMINI_VISIBILITY_MODEL = 'gemini-2.5-flash'
const VERTEX_AI_SEARCH_PROXY_DOMAIN = 'vertexaisearch.cloud.google.com'
const MAX_PLANNER_CONTEXT_CHARS = 12_000
const MAX_PLANNER_OUTPUT_TOKENS = 700

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
                abortSignal: deadline.signal,
              },
            }),
          deadline.signal,
          // Planning is one logical and one provider call in the public
          // funnel. Hosts may re-admit a new plan explicitly if desired.
          { ...config, maxRetries: 0 },
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

async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  config: Pick<NormalizedGeminiOptions, 'maxRetries' | 'retryBaseDelayMs'>,
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
  return {
    requestedModel: model,
    servedModel: extractServedModel(response),
    answerText: extractAnswerText(response),
    sources: extractGroundedSources(response),
    searchQueries: extractSearchQueries(response),
    // Google Search grounding is requested, but the API does not reliably
    // attest whether a search actually ran for each answer.
    retrievalStatus: 'unknown',
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
  if (queries.length !== input.maxQueries) {
    throw new Error(`The query planner did not return ${input.maxQueries} non-brand buyer queries.`)
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

function stripCodeFence(value: string): string {
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
