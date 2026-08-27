/**
 * Classification of raw provider failure text into a stable bucket.
 *
 * Provider adapters throw plain `Error`s carrying whatever the upstream API
 * said, so the only signal available is the message. Best-effort regex match:
 * it is a histogram bucket and a telemetry reason code, never load-bearing for
 * control flow.
 *
 * Lives here because two callers need the same answer and must not drift: the
 * job runner, which stamps `errorCode` on `run.completed`, and the query
 * generation route, which has to preserve the provider's failure kind instead
 * of flattening it to `INTERNAL_ERROR` on the way to the dashboard.
 */

export type ProviderErrorCode =
  | 'PROVIDER_AUTH'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'UNKNOWN'

/**
 * Priority when several providers fail differently in one run: report the one
 * an operator can act on first. Auth is a standing misconfiguration, a rate
 * limit is a retry, and `UNKNOWN` is what is left when nothing matched.
 */
const PROVIDER_ERROR_PRIORITY: readonly ProviderErrorCode[] = [
  'PROVIDER_AUTH',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'PARSE_ERROR',
  'UNKNOWN',
]

export function classifyProviderErrorMessage(message: string): ProviderErrorCode {
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|missing[_ -]?api[_ -]?key|authentication/i.test(message)) {
    return 'PROVIDER_AUTH'
  }
  if (/\b429\b|rate[_ -]?limit|too many requests|quota[_ -]?exceeded/i.test(message)) {
    return 'RATE_LIMITED'
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return 'TIMEOUT'
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up/i.test(message)) {
    return 'NETWORK'
  }
  if (/parse|unexpected token|invalid json|malformed|JSON\.parse/i.test(message)) {
    return 'PARSE_ERROR'
  }
  return 'UNKNOWN'
}

/** Collapse a set of per-provider failure messages to one reportable code. */
export function classifyProviderErrorMessages(
  messages: Iterable<string>,
): ProviderErrorCode {
  const codes = new Set<ProviderErrorCode>()
  for (const message of messages) {
    codes.add(classifyProviderErrorMessage(message))
  }
  for (const code of PROVIDER_ERROR_PRIORITY) {
    if (codes.has(code)) return code
  }
  return 'UNKNOWN'
}
