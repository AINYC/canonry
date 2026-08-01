import { describe, it, expect } from 'vitest'
import { parseBoundedRate } from '../src/formatting.js'

describe('parseBoundedRate', () => {
  it('passes a rate inside 0..1 through', () => {
    expect(parseBoundedRate(0.62)).toBe(0.62)
    expect(parseBoundedRate(0)).toBe(0)
    expect(parseBoundedRate(1)).toBe(1)
  })

  it('reports an out-of-range rate as unavailable rather than passing it on', () => {
    // engagementRate is contract-bounded to 0..1. Passing 1.4 through would
    // throw at the schema boundary instead of degrading to "not measured".
    expect(parseBoundedRate(1.4)).toBeNull()
    expect(parseBoundedRate(-0.2)).toBeNull()
  })

  it('preserves null', () => {
    expect(parseBoundedRate(null)).toBeNull()
  })
})
