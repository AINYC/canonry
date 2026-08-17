import { describe, expect, it } from 'vitest'
import {
  calendarMonthBounds,
  visibilityCompareMetricPeriodSchema,
  visibilityStatsShareOfVoiceSchema,
} from '../src/visibility-stats.js'

describe('visibility comparison availability', () => {
  it('preserves observations while marking a missing competitive frame unavailable', () => {
    expect(visibilityCompareMetricPeriodSchema.parse({
      availability: 'no-competitive-frame',
      point: null,
      ciLow: null,
      ciHigh: null,
      numerator: 3,
      denominator: 0,
    })).toMatchObject({ availability: 'no-competitive-frame', numerator: 3, denominator: 0 })
  })

  it('carries the configured competitor count beside a null 0/0 share', () => {
    expect(visibilityStatsShareOfVoiceSchema.parse({
      queryClass: 'non-brand',
      percent: null,
      competitorCount: 1,
      projectMentions: 0,
      competitorMentions: 0,
      snapshotsWithAnswerText: 2,
      perCompetitor: [],
    }).competitorCount).toBe(1)
  })
})

describe('calendarMonthBounds', () => {
  it('expands a month to inclusive UTC bounds', () => {
    expect(calendarMonthBounds('2026-06')).toEqual({
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-06-30T23:59:59.999Z',
    })
  })

  it('handles February in a leap year (29 days)', () => {
    expect(calendarMonthBounds('2024-02')).toEqual({
      since: '2024-02-01T00:00:00.000Z',
      until: '2024-02-29T23:59:59.999Z',
    })
  })

  it('handles February in a non-leap year (28 days)', () => {
    expect(calendarMonthBounds('2026-02').until).toBe('2026-02-28T23:59:59.999Z')
  })

  it('handles December (the exclusive end rolls into the next year)', () => {
    expect(calendarMonthBounds('2026-12')).toEqual({
      since: '2026-12-01T00:00:00.000Z',
      until: '2026-12-31T23:59:59.999Z',
    })
  })

  it('throws RangeError on a malformed or out-of-range month', () => {
    expect(() => calendarMonthBounds('2026-6')).toThrow(/YYYY-MM/)
    expect(() => calendarMonthBounds('June')).toThrow(/YYYY-MM/)
    expect(() => calendarMonthBounds('2026-13')).toThrow(/between 01 and 12/)
    expect(() => calendarMonthBounds('2026-00')).toThrow(/between 01 and 12/)
    expect(() => calendarMonthBounds('2026-6')).toThrow(RangeError)
  })
})
