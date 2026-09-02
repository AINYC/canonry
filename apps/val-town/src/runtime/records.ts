/**
 * Shared record identity and lifetime rules.
 *
 * Both the HTTP app and the MCP endpoint resolve checks and decide whether one
 * is still readable. Two copies of either rule would drift silently: a
 * mismatched fingerprint makes the MCP endpoint miss cached work the UI can
 * see, and a mismatched expiry lets one surface serve a result the other has
 * already retired.
 */
import type { CheckRecord } from './types.ts'

/** Caller-supplied questions, normalized for identity and for the prompt. */
export const MAX_USER_QUERIES = 3
const MIN_QUERY_CHARS = 3
const MAX_QUERY_CHARS = 200

/**
 * Reuse identity for a domain check. It is versioned because it keys the cache
 * and the one-active-check index: changing what a check measures without
 * changing this prefix would let an old result answer a new question.
 *
 * v3 adds the brands each answer names, which is what mention share is built
 * from. A v2 record cannot satisfy a v3 request: it carries `namedBrands: null`
 * on every row, so the visitor would get a result silently missing half the
 * report and no way to tell why. Bumping the prefix retires those records at
 * the moment the signal set changed rather than at their own TTL.
 *
 * The caller's own questions are part of that identity. They change what the
 * check MEASURES, so two requests for one domain with different questions must
 * never share a result: without them in the key, the second caller silently
 * receives answers to the first caller's questions. Order is preserved rather
 * than sorted, so the key is exactly what was asked.
 */
export function checkFingerprint(domain: string, userQueries: readonly string[] = []): string {
  const base = `visibility-v3:${domain}`
  if (userQueries.length === 0) return base
  return `${base}|${userQueries.join('\u0001')}`
}

/**
 * Trim, drop blanks, bound length, and cap the count. Returns the questions in
 * the order given; the generator fills whatever remains.
 */
export function normalizeUserQueries(input: unknown): string[] {
  const raw = typeof input === 'string' ? input.split('\n') : Array.isArray(input) ? input : []
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim().replace(/\s+/g, ' ')
    if (trimmed.length < MIN_QUERY_CHARS) continue
    out.push(trimmed.slice(0, MAX_QUERY_CHARS))
    if (out.length === MAX_USER_QUERIES) break
  }
  return out
}

/** A record with no `expiresAt` never expires; anything at or past it is gone. */
export function isCheckExpired(record: CheckRecord, at: Date): boolean {
  if (!record.expiresAt) return false
  const expiresAt = Date.parse(record.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= at.getTime()
}
