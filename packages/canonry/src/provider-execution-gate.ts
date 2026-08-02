/**
 * Per-provider in-process concurrency and rolling-minute dispatch guard.
 * Daily quota is persisted separately because it must survive restarts.
 */
export class ProviderExecutionGate {
  private readonly window: number[] = []
  private readonly waiters: Array<() => void> = []
  private rateLimitChain = Promise.resolve()
  private inFlight = 0

  constructor(private readonly maxConcurrency: number, private readonly maxPerMinute: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      await this.waitForRateLimit()
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < Math.max(1, this.maxConcurrency)) { this.inFlight++; return }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.inFlight++
  }
  private release(): void { this.inFlight = Math.max(0, this.inFlight - 1); this.waiters.shift()?.() }
  private async waitForRateLimit(): Promise<void> {
    let releaseChain: (() => void) | undefined
    const previousChain = this.rateLimitChain
    this.rateLimitChain = new Promise<void>(resolve => { releaseChain = resolve })
    await previousChain
    try {
      const now = Date.now(); const windowStart = now - 60_000
      while (this.window.length > 0 && this.window[0]! < windowStart) this.window.shift()
      if (this.window.length >= this.maxPerMinute) {
        await new Promise(resolve => setTimeout(resolve, this.window[0]! + 60_000 - now + 50))
        const nextWindowStart = Date.now() - 60_000
        while (this.window.length > 0 && this.window[0]! < nextWindowStart) this.window.shift()
      }
      this.window.push(Date.now())
    } finally { releaseChain?.() }
  }
}

/**
 * Every gate handed out by `getSharedProviderExecutionGate`, keyed by
 * normalized provider name — one process-wide budget per upstream provider,
 * shared across every concurrent run regardless of which project queued it.
 *
 * A provider's quota policy (concurrency cap, requests/minute) is registered
 * once, process-wide, alongside its API key (see `ProviderRegistry.register`);
 * it is not a per-run or per-project setting. That is what makes sharing one
 * gate per provider name correct rather than merely convenient — the budget
 * being guarded is the same upstream API key no matter which run is asking.
 */
const sharedGates = new Map<string, ProviderExecutionGate>()

/**
 * The one gate for this provider, process-wide. The first caller for a given
 * provider name wins the concurrency/rate-limit values it passes in — every
 * later caller for the same provider is expected to pass the same registered
 * quota policy, since it comes from the same process-wide provider
 * registration, not from anything that varies per run or per project.
 */
export function getSharedProviderExecutionGate(
  providerName: string,
  maxConcurrency: number,
  maxPerMinute: number,
): ProviderExecutionGate {
  const key = providerName.trim().toLocaleLowerCase('en')
  const existing = sharedGates.get(key)
  if (existing) return existing
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
