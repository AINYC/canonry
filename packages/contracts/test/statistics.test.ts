import { describe, expect, it } from 'vitest'
import { linearTrend, wilsonInterval } from '../src/statistics.js'

describe('wilsonInterval', () => {
  // Fixtures verified against the closed-form Wilson score interval (z=1.96).
  // These are the real May/June DemandIQ proportions the metric will report.
  it('matches the exact 95% interval for the mention-rate proportions', () => {
    expect(wilsonInterval(14, 504)).toEqual({ low: 0.0166, high: 0.0461 })
    expect(wilsonInterval(1, 164)).toEqual({ low: 0.0011, high: 0.0337 })
  })

  it('returns a real upper bound at zero successes (not the degenerate [0,0] Wald gives)', () => {
    // June cited = 0 of 164. A Wald interval would collapse to [0,0] and imply
    // certainty; Wilson keeps the honest "could be as high as 2.3%".
    expect(wilsonInterval(0, 164)).toEqual({ low: 0, high: 0.0229 })
  })

  it('returns null over an empty sample (a rate over no data is undefined)', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    expect(wilsonInterval(5, 0)).toBeNull()
    expect(wilsonInterval(3, -1)).toBeNull()
  })

  it('never leaves [0,1] and never emits negative zero', () => {
    const lo = wilsonInterval(0, 3)!
    expect(lo.low).toBe(0)
    expect(Object.is(lo.low, -0)).toBe(false)
    const hi = wilsonInterval(3, 3)!
    expect(hi.high).toBe(1)
    expect(hi.low).toBeGreaterThan(0)
  })

  it('clamps successes into [0, n] rather than producing a bogus interval', () => {
    // Defensive: a corrupt count above n must not push p above 1.
    expect(wilsonInterval(10, 5)).toEqual(wilsonInterval(5, 5))
  })

  it('brackets the point estimate', () => {
    for (const [s, n] of [[14, 504], [1, 164], [7, 504], [50, 100]] as const) {
      const ci = wilsonInterval(s, n)!
      const p = s / n
      expect(ci.low).toBeLessThanOrEqual(p)
      expect(ci.high).toBeGreaterThanOrEqual(p)
    }
  })
})

describe('linearTrend', () => {
  it('recovers an exact line and reports its endpoints', () => {
    // y = 2x + 1 over indices 0..4.
    const trend = linearTrend([1, 3, 5, 7, 9])
    expect(trend).toEqual({ slope: 2, intercept: 1, r2: 1, start: 1, end: 9, n: 5 })
  })

  it('fits a falling series with a negative slope', () => {
    // y = -3x + 20 over indices 0..3.
    const trend = linearTrend([20, 17, 14, 11])
    expect(trend).toEqual({ slope: -3, intercept: 20, r2: 1, start: 20, end: 11, n: 4 })
  })

  it('reports slope per STEP, so the window change is slope * (n - 1)', () => {
    const trend = linearTrend([1, 3, 5, 7, 9])!
    expect(trend.slope).toBe(2)
    expect(trend.end - trend.start).toBeCloseTo(trend.slope * 4, 10)
  })

  it('calls a constant series a perfect flat fit rather than dividing by zero', () => {
    // ssTot is 0 here; r2 must be 1, not NaN.
    expect(linearTrend([5, 5, 5])).toEqual({ slope: 0, intercept: 5, r2: 1, start: 5, end: 5, n: 3 })
  })

  it('computes the exact least-squares fit for a noisy series', () => {
    // [1, 2, 4]: slope 3/2, intercept 5/6, ssRes 1/6, ssTot 14/3.
    const trend = linearTrend([1, 2, 4])
    expect(trend).toEqual({ slope: 1.5, intercept: 0.8333, r2: 0.9643, start: 0.8333, end: 3.8333, n: 3 })
  })

  it('keeps the true index of a point across a gap instead of compressing the axis', () => {
    // Observations at x=0 and x=2, so the slope is 2 — NOT the 4 you would get
    // by dropping the hole and treating the points as adjacent.
    const trend = linearTrend([0, null, 4])
    expect(trend).toEqual({ slope: 2, intercept: 0, r2: 1, start: 0, end: 4, n: 2 })
    expect(linearTrend([0, 4])!.slope).toBe(4)
  })

  it('counts only the observations it used, not the series length', () => {
    expect(linearTrend([1, null, 3, undefined, 5])!.n).toBe(3)
  })

  it('returns null when a line is undefined', () => {
    expect(linearTrend([])).toBeNull()
    expect(linearTrend([7])).toBeNull()
    expect(linearTrend([null, 7, null])).toBeNull()
    expect(linearTrend([null, undefined])).toBeNull()
  })

  it('skips non-finite observations rather than poisoning the fit with NaN', () => {
    expect(linearTrend([1, Number.NaN, 5, Number.POSITIVE_INFINITY, 9])).toEqual({
      slope: 2, intercept: 1, r2: 1, start: 1, end: 9, n: 3,
    })
  })

  it('reports zero explanatory power on a symmetric series with no linear signal', () => {
    // A V: the fit is the flat mean, so every point is a full residual.
    const trend = linearTrend([10, 0, 0, 10])!
    expect(trend.slope).toBe(0)
    expect(trend.intercept).toBe(5)
    expect(trend.r2).toBe(0)
  })

  it('still trends up when an alternating series ends higher than it started', () => {
    // Guards the tempting-but-wrong reading that "zig-zag" means "flat":
    // this one runs 0 -> 10, and the fit says so.
    expect(linearTrend([0, 10, 0, 10, 0, 10])!.slope).toBeGreaterThan(0)
  })
})
