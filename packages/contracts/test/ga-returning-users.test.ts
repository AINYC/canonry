import { describe, it, expect } from 'vitest'
import { deriveReturningUsers, parseBoundedRate } from '../src/formatting.js'

describe('deriveReturningUsers', () => {
  it('subtracts new users from total users', () => {
    expect(deriveReturningUsers(400, 80)).toBe(320)
  })

  it('clamps at zero when GA4 reports more new users than total users', () => {
    // totalUsers and newUsers are estimated independently, so a sparse day can
    // report more new than total. A bare subtraction would emit a negative.
    expect(deriveReturningUsers(50, 90)).toBe(0)
  })

  it('reports null when newUsers is unavailable, never zero', () => {
    // A 0 here would render as a real "nobody returned" day on a client chart.
    expect(deriveReturningUsers(400, null)).toBeNull()
  })
})

describe('parseBoundedRate', () => {
  it('passes a rate inside 0..1 through', () => {
    expect(parseBoundedRate(0.62)).toBe(0.62)
    expect(parseBoundedRate(0)).toBe(0)
    expect(parseBoundedRate(1)).toBe(1)
  })

  it('reports an out-of-range rate as unavailable rather than passing it on', () => {
    // The contract bounds engagementRate to 0..1. Passing 1.4 through would
    // throw at the Zod boundary instead of degrading to "not measured".
    expect(parseBoundedRate(1.4)).toBeNull()
    expect(parseBoundedRate(-0.2)).toBeNull()
  })

  it('preserves null', () => {
    expect(parseBoundedRate(null)).toBeNull()
  })
})
