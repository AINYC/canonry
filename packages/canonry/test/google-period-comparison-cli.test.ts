import { beforeEach, describe, expect, it, vi } from 'vitest'

const gscPerformanceDaily = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gscPerformanceDaily }),
}))

const { googlePerformanceDaily } = await import('../src/commands/google.js')

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => lines.join('\n'))
}

const DAILY = [
  { date: '2026-07-01', clicks: 5, impressions: 1000, ctr: 0.005, position: 12 },
  { date: '2026-07-02', clicks: 10, impressions: 800, ctr: 0.0125, position: 11 },
  { date: '2026-07-03', clicks: 15, impressions: 600, ctr: 0.025, position: 10 },
  { date: '2026-07-04', clicks: 20, impressions: 400, ctr: 0.05, position: 9 },
]

function response(overrides: Record<string, unknown> = {}) {
  return {
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: 10.5, positionDays: 4, days: 4 },
    daily: DAILY,
    periodComparison: {
      days: 2,
      comparable: true,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 15, impressions: 1800, ctr: 15 / 1800, position: 11.5556, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 35, impressions: 1000, ctr: 35 / 1000, position: 9.6, source: 'property-daily' as const,
      },
      change: { clicks: 35 / 15 - 1, impressions: -0.4444, ctr: 3.2, position: -0.1692 },
    },
    ...overrides,
  }
}

/**
 * The dashboard tile and this block must print the SAME percentage. They read
 * one server-computed field precisely so they cannot drift, and this asserts
 * the CLI half actually renders it.
 */
describe('canonry google performance-daily — period comparison', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gscPerformanceDaily.mockResolvedValue(response())
  })

  it('names both periods and their dates', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('Last 2 days (2026-07-03 to 2026-07-04) vs prior 2 (2026-07-01 to 2026-07-02)')
  })

  it('prints a signed percentage per metric', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+\+133\.3%\s+better/)
    expect(out).toMatch(/Impressions:\s+-44\.4%\s+worse/)
    expect(out).toMatch(/CTR:\s+\+320\.0%\s+better/)
  })

  /**
   * Position is the one metric where the sign and the verdict disagree: the
   * rank number FELL, which is an improvement. A naive `ratio > 0 = better`
   * gets this backwards, which is exactly the bug the old fitted-line label
   * shipped with.
   */
  it('calls a falling average position better, not worse', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Position:\s+-16\.9%\s+better/)
  })

  it('calls a rising average position worse', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: { ...response().periodComparison, change: { clicks: 0, impressions: 0, ctr: 0, position: 0.25 } },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Position:\s+\+25\.0%\s+worse/)
  })

  it('states the absence when the prior period gives nothing to divide by', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        prior: {
          ...response().periodComparison.prior,
          clicks: 0, impressions: 0, ctr: null, position: null,
        },
        change: { clicks: null, impressions: null, ctr: null, position: null },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+new in last 2 days/)
    expect(out).toContain('no prior period to compare')
    expect(out).not.toMatch(/Infinity|NaN/)
  })

  it('distinguishes an empty trailing metric from a missing prior baseline', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        trailing: {
          ...response().periodComparison.trailing,
          clicks: 0, impressions: 0, ctr: null, position: null, source: 'empty' as const,
        },
        change: { clicks: -1, impressions: -1, ctr: null, position: null },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/CTR:\s+no value in last 2 days/)
    expect(out).toMatch(/Position:\s+no value in last 2 days/)
    expect(out).not.toMatch(/CTR:\s+no prior period/)
  })

  it('reports an exact zero as no change rather than a signed zero', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        change: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+no change/)
    expect(out).not.toMatch(/[+-]0\.0%/)
  })

  /**
   * A server older than the field omits it entirely. The CLI must drop the
   * block rather than crash or imply the metrics did not move — the same skew
   * guard `window` and `trends` already carry.
   */
  it('omits the block against a server that predates the field', async () => {
    gscPerformanceDaily.mockResolvedValue(response({ periodComparison: undefined }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).not.toContain('vs prior')
    expect(out).toContain('Clicks:')
  })

  it('carries the field verbatim in json mode', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'json' }))
    const parsed = JSON.parse(out) as { periodComparison?: { days: number } }
    expect(parsed.periodComparison?.days).toBe(2)
  })
})

/**
 * The CLI half of the same refusal. Both surfaces read one server-computed
 * `comparable` flag so they cannot disagree about when a comparison is valid.
 */
describe('mixed data sources', () => {
  it('refuses to print percentages and says why', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        comparable: false,
        prior: { ...response().periodComparison.prior, source: 'dimensioned' as const },
        change: { clicks: null, impressions: null, ctr: null, position: null },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('needs property-level daily data')
    expect(out).not.toContain('vs prior 2')
    // A flat property would otherwise read +44% clicks / -23% impressions.
    expect(out).not.toMatch(/Clicks:\s+[+-]\d/)
  })
})
