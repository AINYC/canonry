/**
 * Per-provider in-process concurrency and rolling-minute dispatch guard.
 * Daily quota is persisted separately because it must survive restarts.
 */
function rejectionError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

export class ProviderExecutionGate {
  private readonly window: number[] = []
  private readonly concurrencyWaiters: Array<() => void> = []
  private readonly rateLimitWakeups = new Set<() => void>()
  private rateLimitChain = Promise.resolve()
  private inFlight = 0

  constructor(private maxConcurrency: number, private maxPerMinute: number) {}

  /** Apply a settings change without discarding active work or recent dispatches. */
  updateLimits(maxConcurrency: number, maxPerMinute: number): void {
    const concurrencyChanged = this.maxConcurrency !== maxConcurrency
    const rateChanged = this.maxPerMinute !== maxPerMinute
    this.maxConcurrency = maxConcurrency
    this.maxPerMinute = maxPerMinute
    if (concurrencyChanged) this.drainConcurrencyWaiters()
    if (rateChanged) {
      for (const wake of [...this.rateLimitWakeups]) wake()
    }
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      await this.waitForRateLimit(signal)
      signal?.throwIfAborted()
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.concurrencyWaiters.length === 0 && this.inFlight < Math.max(1, this.maxConcurrency)) {
      this.inFlight++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        const index = this.concurrencyWaiters.indexOf(wake)
        if (index !== -1) this.concurrencyWaiters.splice(index, 1)
        reject(rejectionError(signal?.reason))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.concurrencyWaiters.push(wake)
      this.drainConcurrencyWaiters()
    })
  }
  private drainConcurrencyWaiters(): void {
    const cap = Math.max(1, this.maxConcurrency)
    while (this.inFlight < cap && this.concurrencyWaiters.length > 0) {
      const resolve = this.concurrencyWaiters.shift()!
      // Reserve the slot before waking the continuation. Otherwise a new
      // caller can observe the same free slot and overbook the updated cap.
      this.inFlight++
      resolve()
    }
  }
  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.drainConcurrencyWaiters()
  }
  private waitForRateLimitWindow(delayMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timeout)
        this.rateLimitWakeups.delete(wake)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        clearTimeout(timeout)
        this.rateLimitWakeups.delete(wake)
        signal?.removeEventListener('abort', abort)
        reject(rejectionError(signal?.reason))
      }
      this.rateLimitWakeups.add(wake)
      const timeout = setTimeout(wake, Math.max(0, delayMs))
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  private waitForRateLimit(signal?: AbortSignal): Promise<void> {
    let releaseChain: (() => void) | undefined
    const previousChain = this.rateLimitChain
    this.rateLimitChain = new Promise<void>(resolve => { releaseChain = resolve })
    const wait = async () => {
      // Keep the chain ordered even when its caller cancels while queued.
      await previousChain
      try {
        for (;;) {
          signal?.throwIfAborted()
          const now = Date.now(); const windowStart = now - 60_000
          while (this.window.length > 0 && this.window[0]! < windowStart) this.window.shift()
          if (this.window.length < Math.max(1, this.maxPerMinute)) break
          // A settings update wakes this wait so a raised limit takes effect
          // immediately; a lowered limit rechecks the retained window instead
          // of laundering old requests through a fresh bucket.
          await this.waitForRateLimitWindow(this.window[0]! + 60_000 - now + 50, signal)
        }
        this.window.push(Date.now())
      } finally { releaseChain?.() }
    }
    const pending = wait()
    if (!signal) return pending
    // Release the caller's concurrency slot promptly, without letting later
    // rate waiters bypass predecessors or recording a canceled dispatch.
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort)
        reject(rejectionError(signal.reason))
      }
      pending.then(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, error => {
        signal.removeEventListener('abort', abort)
        reject(rejectionError(error))
      })
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
}

/**
 * Every gate handed out by `getSharedProviderExecutionGate`, keyed by
 * normalized provider name — one process-wide budget per upstream provider,
 * shared across every concurrent run regardless of which project queued it.
 *
 * A provider's quota policy (concurrency cap, requests/minute) is registered
 * process-wide alongside its API key (see `ProviderRegistry.register`). The
 * policy may be reconfigured in place, but the guarded credential budget and
 * its active/history state remain one process-wide bucket.
 */
const sharedGates = new Map<string, ProviderExecutionGate>()

function gateKey(providerName: string): string {
  const key = providerName.trim()
  // Connection IDs are case-sensitive config keys, unlike native providers.
  return key.startsWith('connection:') ? key : key.toLocaleLowerCase('en')
}

/**
 * The one gate for this provider, process-wide. Settings writers must use
 * `configureSharedProviderExecutionGate` to change its policy authoritatively;
 * ordinary callers only retrieve the current bucket and cannot revive stale
 * limits captured by an older adapter.
 */
export function getSharedProviderExecutionGate(
  providerName: string,
  maxConcurrency: number,
  maxPerMinute: number,
): ProviderExecutionGate {
  const key = gateKey(providerName)
  const existing = sharedGates.get(key)
  if (existing) return existing
  const gate = new ProviderExecutionGate(maxConcurrency, maxPerMinute)
  sharedGates.set(key, gate)
  return gate
}

/**
 * Create or update the authoritative process-wide policy for one credential.
 * Updating preserves in-flight slots and the rolling-minute dispatch window.
 */
export function configureSharedProviderExecutionGate(
  providerName: string,
  maxConcurrency: number,
  maxPerMinute: number,
): ProviderExecutionGate {
  const key = gateKey(providerName)
  const existing = sharedGates.get(key)
  if (existing) {
    existing.updateLimits(maxConcurrency, maxPerMinute)
    return existing
  }
  const gate = new ProviderExecutionGate(maxConcurrency, maxPerMinute)
  sharedGates.set(key, gate)
  return gate
}

/**
 * Test-only escape hatch. The shared gates are process-wide singletons on
 * purpose (that is the fix for NEW-3: one real budget per provider, not one
 * per run), but that means their in-flight/rate-limit state persists across
 * `test()` blocks that reuse a provider name with a different quota policy
 * within the same file. Call this between tests that need a clean budget.
 */
export function resetSharedProviderExecutionGates(): void {
  sharedGates.clear()
}
