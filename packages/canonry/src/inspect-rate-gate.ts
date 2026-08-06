/**
 * Process-wide request spacing, keyed by the limit being protected.
 *
 * `inspectUrlsPaced` used to build its rate gate as a promise chain in a local
 * variable, so the gate lived exactly as long as one call. Every concurrent
 * sweep therefore got its OWN "one request per second" budget. That is fine
 * when the limit being protected is also per-sweep, and wrong whenever several
 * sweeps share one upstream limit.
 *
 * Bing is the case that exposed it: one API key serves every project on the
 * instance and `data-refresh` fires them in the same minute, so three sweeps
 * each honouring 1 req/sec collectively put 3 req/sec on one credential. This
 * is hygiene rather than an incident fix — the 2026-08-06 throttle was NOT
 * shown to be caused by that overlap (see PR #969) — but pacing that a second
 * caller can ignore is not a rate limit.
 *
 * The key names the SHARED resource, not the caller:
 *
 *     bing:<hash of api key>     one Bing account, every project on it
 *     gsc:<propertyId>           Google meters URL Inspection per property
 *
 * so two Bing accounts on one instance still run independently, while every
 * project on one account queues behind the same clock.
 *
 * Only the WAIT is serialised, never the request. A worker takes its start slot
 * and then runs free, so concurrency is unaffected — this bounds how often a
 * request may START, which is the thing the upstream limit actually counts.
 */

import crypto from 'node:crypto'

export type SleepFn = (ms: number) => Promise<void>

export interface RateGate {
  /**
   * Resolve once this caller is allowed to start a request. Each call extends
   * the shared chain by `delayMs`, so N waiters cost N spacings in total rather
   * than N spacings each.
   */
  take(delayMs: number, sleep: SleepFn): Promise<void>
}

/**
 * Live gates, keyed by shared resource. Module-level on purpose: the whole
 * point is that separate `inspectUrlsPaced` calls — separate RUNS — meet here.
 *
 * Unbounded in principle, bounded in practice: one entry per Bing account and
 * one per GSC property, both fixed by how many integrations an instance has
 * connected. A resolved promise chain holds no memory beyond its own reference.
 */
const gates = new Map<string, { chain: Promise<void> }>()

export function sharedRateGate(key: string): RateGate {
  let entry = gates.get(key)
  if (!entry) {
    entry = { chain: Promise.resolve() }
    gates.set(key, entry)
  }
  const held = entry
  return {
    take(delayMs: number, sleep: SleepFn): Promise<void> {
      const wait = held.chain.then(() => sleep(delayMs))
      // Swallow on the STORED chain only: one caller's rejection must not
      // reject every future waiter behind it. The returned promise is
      // deliberately not caught, so the caller still sees its own failure.
      held.chain = wait.catch(() => {})
      return wait
    },
  }
}

/**
 * Stable, non-reversible gate key for a credential.
 *
 * The API key itself is never used as the key: a Map key ends up in heap dumps
 * and is one careless log line away from disclosure. A truncated digest is
 * enough to separate two accounts without carrying the secret.
 */
export function credentialGateKey(prefix: string, secret: string): string {
  const digest = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12)
  return `${prefix}:${digest}`
}

/** Drop every gate. Tests only — production keeps one process-lifetime map. */
export function resetRateGatesForTest(): void {
  gates.clear()
}
