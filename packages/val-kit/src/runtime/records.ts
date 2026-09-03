/**
 * Shared record identity and lifetime rules.
 *
 * Both the HTTP app and the MCP endpoint resolve checks and decide whether one
 * is still readable. Two copies of either rule would drift silently: a
 * mismatched fingerprint makes the MCP endpoint miss cached work the UI can
 * see, and a mismatched expiry lets one surface serve a result the other has
 * already retired.
 */
import type { CheckRecord } from './types.js'

/** Caller-supplied questions, normalized for identity and for the prompt. */
export const MAX_USER_QUERIES = 3
const MIN_QUERY_CHARS = 3
const MAX_QUERY_CHARS = 200

/**
 * Reuse identity for a domain check.
 *
 * The key is both the cache key and the one-active-check index, so everything
 * that changes what a check PRODUCES has to be in it.
 *
 * `namespace` is that "what". It names the product and the version of the
 * result schema the product stores, and the kit requires it because the kit
 * cannot know either. Two products sharing one store must never collide — a
 * perception check and a visibility check for the same domain measure
 * different things and share nothing — and a product that adds a measured
 * signal retires its own stale records by bumping its OWN namespace, at the
 * moment the signal set changed rather than at each record's own TTL. A
 * namespace is never bumped on another product's behalf.
 *
 * The caller's own questions are part of that identity too. They change what
 * the check MEASURES, so two requests for one domain with different questions
 * must never share a result: without them in the key, the second caller
 * silently receives answers to the first caller's questions. Order is preserved
 * rather than sorted, so the key is exactly what was asked.
 */
export function checkFingerprint(namespace: string, domain: string, userQueries: readonly string[] = []): string {
  if (namespace.trim() === '') {
    throw new Error('checkFingerprint requires a product namespace; an empty one would collide across products.')
  }
  const base = `${namespace}:${domain}`
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
