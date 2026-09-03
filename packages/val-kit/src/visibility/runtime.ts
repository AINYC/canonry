import type { VisibilityProbeLimits } from './contracts.js'

const HARD_LIMITS = {
  timeoutMs: { min: 1_000, max: 30_000 },
  maxConcurrency: { min: 1, max: 4 },
  maxQueries: { min: 1, max: 20 },
  maxProviders: { min: 1, max: 8 },
  maxAnswerChars: { min: 256, max: 20_000 },
  maxSources: { min: 1, max: 50 },
  maxSourceUrlChars: { min: 128, max: 4_096 },
  maxSourceTitleChars: { min: 32, max: 1_024 },
  maxSearchQueries: { min: 0, max: 25 },
  maxSearchQueryChars: { min: 32, max: 512 },
} as const

export const MAX_QUERY_CHARS = 512
/** Stable query IDs are returned verbatim, so reject oversize caller input. */
export const MAX_QUERY_ID_CHARS = 160
/** Provider names are public report identities, not arbitrary display text. */
export const MAX_PROVIDER_ID_CHARS = 80
/** Requested/served model identifiers are public report identities. */
export const MAX_MODEL_ID_CHARS = 256
export const MAX_BRAND_NAME_CHARS = 128
export const MAX_BRAND_NAMES = 20
export const MAX_DOMAIN_CHARS = 253
export const MAX_PROVIDER_ERROR_CHARS = 180
export const MAX_EXTRACTED_SOURCES = 100

export function resolveLimits(
  defaults: VisibilityProbeLimits,
  partial: Partial<VisibilityProbeLimits> | undefined,
): VisibilityProbeLimits {
  const candidate = { ...defaults, ...partial }
  return {
    timeoutMs: boundedInteger(candidate.timeoutMs, HARD_LIMITS.timeoutMs),
    maxConcurrency: boundedInteger(candidate.maxConcurrency, HARD_LIMITS.maxConcurrency),
    maxQueries: boundedInteger(candidate.maxQueries, HARD_LIMITS.maxQueries),
    maxProviders: boundedInteger(candidate.maxProviders, HARD_LIMITS.maxProviders),
    maxAnswerChars: boundedInteger(candidate.maxAnswerChars, HARD_LIMITS.maxAnswerChars),
    maxSources: boundedInteger(candidate.maxSources, HARD_LIMITS.maxSources),
    maxSourceUrlChars: boundedInteger(candidate.maxSourceUrlChars, HARD_LIMITS.maxSourceUrlChars),
    maxSourceTitleChars: boundedInteger(candidate.maxSourceTitleChars, HARD_LIMITS.maxSourceTitleChars),
    maxSearchQueries: boundedInteger(candidate.maxSearchQueries, HARD_LIMITS.maxSearchQueries),
    maxSearchQueryChars: boundedInteger(candidate.maxSearchQueryChars, HARD_LIMITS.maxSearchQueryChars),
  }
}

function boundedInteger(value: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return bounds.min
  return Math.max(bounds.min, Math.min(bounds.max, Math.floor(value)))
}

export function clipText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: value.slice(0, maxChars), truncated: true }
}

export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function uniqueStable(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

export interface DeadlineSignal {
  signal: AbortSignal
  didTimeout(): boolean
  dispose(): void
}

/** Web-standard timeout composition that works in Node and Deno without globals. */
export function createDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): DeadlineSignal {
  const controller = new AbortController()
  let timedOut = false
  const timeoutReason = new DOMException('Visibility provider request timed out.', 'TimeoutError')
  const abortFromParent = () => controller.abort(parent?.reason)
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(timeoutReason)
  }, timeoutMs)
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'AbortError' || error.name === 'TimeoutError'
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError' || /\babort(?:ed|ing)?\b/i.test(error.message)
}

/** Do not echo provider response bodies, URLs, or accidental credentials into report storage. */
export function safeProviderErrorMessage(error: unknown): string {
  const generic = 'The provider request failed.'
  if (!(error instanceof Error)) return generic
  const message = error.message.replace(/[\r\n\t]+/g, ' ').trim()
  if (!message) return generic
  // Provider SDK messages commonly embed request IDs and error bodies. Keep a
  // small classified surface instead of a transport dump.
  if (/\b429\b/.test(message)) return 'The provider rate-limited this request.'
  if (/\b(?:500|501|502|503|504)\b/.test(message)) return 'The provider was temporarily unavailable.'
  if (/invalid api key|api[_ -]?key|unauthori[sz]ed|forbidden/i.test(message)) {
    return 'The provider credentials were rejected.'
  }
  if (/timeout|timed out/i.test(message)) return 'The provider request timed out.'
  return clipText(generic, MAX_PROVIDER_ERROR_CHARS).value
}

export function nowIso(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString()
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

export function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const timer = setTimeout(done, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }
    function done(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
