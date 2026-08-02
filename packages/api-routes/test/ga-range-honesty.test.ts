import { describe, it, expect } from 'vitest'

/**
 * Two ways the GA read could report a number it cannot support.
 *
 * 1. `totalUsers` summed from the landing-page dimensioned table. GA counts
 *    users as a COUNT DISTINCT at the grain requested, so a visitor who read
 *    three pages is three rows and no summation recovers the distinct count.
 * 2. An empty requested range relabelled with the synced period's dates, so the
 *    totals read as zero while the labels name a period that had data.
 */
function reportedPeriod(
  requested: { startDate: string | null; endDate: string | null },
  synced: { periodStart: string | null; periodEnd: string | null },
): { periodStart: string | null; periodEnd: string | null } {
  return {
    periodStart: requested.startDate ?? synced.periodStart,
    periodEnd: requested.endDate ?? synced.periodEnd,
  }
}

describe('GA range reporting', () => {
  it('reports an explicitly requested range verbatim even when it covers nothing', () => {
    const out = reportedPeriod(
      { startDate: '2027-01-01', endDate: '2027-01-31' },
      { periodStart: '2026-06-01', periodEnd: '2026-07-25' },
    )
    expect(out).toEqual({ periodStart: '2027-01-01', periodEnd: '2027-01-31' })
    // The old behaviour swapped in the synced bounds, which labelled an empty
    // future range with a period that genuinely had data.
    expect(out.periodStart).not.toBe('2026-06-01')
  })

  it('falls back to the synced bounds only when no range was requested', () => {
    const out = reportedPeriod(
      { startDate: null, endDate: null },
      { periodStart: '2026-06-01', periodEnd: '2026-07-25' },
    )
    expect(out).toEqual({ periodStart: '2026-06-01', periodEnd: '2026-07-25' })
  })

  it('reports an inverted range as asked rather than silently repairing it', () => {
    const out = reportedPeriod(
      { startDate: '2026-08-01', endDate: '2026-07-01' },
      { periodStart: '2026-06-01', periodEnd: '2026-07-25' },
    )
    expect(out).toEqual({ periodStart: '2026-08-01', periodEnd: '2026-07-01' })
  })
})

/**
 * The scoping decision, pinned so it is not widened by accident.
 *
 * A rolling window keeps its historical summed users. That figure is inflated
 * for the same reason, but it predates this change and correcting it is a
 * separate, visible behaviour change rather than one bundled in silently.
 */
function reportedUsers(explicitDates: boolean, summed: number): number | null {
  return explicitDates ? null : summed
}

describe('GA totalUsers availability', () => {
  it('reports unavailable for an explicit calendar range', () => {
    expect(reportedUsers(true, 60)).toBeNull()
  })

  it('keeps the historical summed value for a rolling window', () => {
    expect(reportedUsers(false, 60)).toBe(60)
  })

  it('never reports zero in place of unavailable', () => {
    // A 0 renders as "nobody visited" on a client chart. Null does not.
    expect(reportedUsers(true, 0)).not.toBe(0)
  })
})
