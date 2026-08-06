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
 * instance, and the `data-refresh` schedule fires all of them in the same
 * minute — three sweeps, each pacing itself at 1 req/sec, collectively putting
 * 3 req/sec on a single key. Bing answered `400 ErrorCode 4 (ThrottleUser)`,
 * and the throttle outlived the runs by more than an hour; a site untouched for
 * six days was still refused with nothing in flight.
 *
 * Honesty about what this fixes: the throttle was NOT proven to be caused by
 * that overlap. Per-site throttle counts were identical whether one sweep ran
 * or three, because the observed figure is the deterministic ceiling of a fully
 * throttled run (5 breaker failures x 4 driver attempts x 5 client attempts),
 * not a measure of load. The retry amplification that produced that ceiling is
 * fixed separately, at the call sites.
 *
 * This gate is here because the property is worth holding regardless of which
 * incident it prevents: pacing that a second caller can ignore is not a rate
 * limit, and every sweep on a shared credential should be able to state the
 * rate it collectively imposes.
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
 * A gate with no shared identity — the pre-existing per-call behaviour, kept
 * for callers that genuinely own their limit and for tests that assert an exact
 * sleep sequence without cross-test interference.
 */
export function localRateGate(): RateGate {
  let chain: Promise<void> = Promise.resolve()
  return {
    take(delayMs: number, sleep: SleepFn): Promise<void> {
      const wait = chain.then(() => sleep(delayMs))
      chain = wait.catch(() => {})
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
