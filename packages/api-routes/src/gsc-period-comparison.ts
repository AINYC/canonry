/**
 * Trailing-period vs prior-equal-period comparison for GSC search performance.
 *
 * Why this exists, and why it is not the fitted trend line.
 *
 * The dashboard used to express each tile's percentage as the least-squares
 * line's start-to-end movement over its own START value. Two things go wrong
 * with that, and both were observed on a real property:
 *
 * 1. The fit is unconstrained, so the value it predicts for day one can be zero
 *    or negative even for a metric that cannot be negative. Impressions on that
 *    property fitted to -13.98 on day one, so there was no baseline to divide
 *    by and the tile printed nothing at all — on a metric that had grown almost
 *    six-fold. The longer the window, the likelier this is: a steep recent ramp
 *    drags the backward extrapolation below zero.
 * 2. Where it did print, it described the LINE rather than the data. Average
 *    position fitted 17.70 -> 25.81 and read as a 45.8% improvement, while the
 *    property's actual position went from 22.6 to 24.2, i.e. slightly WORSE.
 *    A number that points the opposite way to reality is worse than a blank.
 *
 * So the comparison is between two real, equal-length stretches of the window.
 * Nothing is extrapolated and every figure is one the property actually
 * recorded.
 *
 * No DB, no clock, no I/O — same posture as `gbp-summary.ts` and
 * `visibility-compare.ts`, so the whole thing is unit-testable from literals.
 */

/**
 * Which table a figure came from.
 *
 * `gsc_daily_totals` (property-daily) and `SUM(gsc_search_data)` (dimensioned)
 * are NOT interchangeable, and the difference is large: on one real
 * property-month the same period reads 1,142 clicks / 34,916 impressions from
 * the property table and 792 / 45,266 from the dimensioned sum, because Google
 * withholds rare queries (under-counting clicks) and fans one impression out
 * across every query x page x country x device row (over-counting impressions).
 */
export type GscTotalsSource = 'property-daily' | 'dimensioned' | 'mixed'

/** One day as the performance route assembles it. `position` is nullable. */
export interface GscDailyRow {
  date: string
  clicks: number
  impressions: number
  position: number | null
  /**
   * True when this date came from the un-dimensioned property-daily table.
   *
   * The route merges both sources per date, so an install that synced
   * dimensioned data before the property-daily table existed has a window whose
   * older half is one source and newer half the other. Comparing across that
   * boundary divides one measurement system by another.
   */
  fromPropertyTotals: boolean
}

export interface GscPeriodTotals {
  startDate: string
  endDate: string
  clicks: number
  impressions: number
  /** `clicks / impressions` for the WHOLE period, never a mean of daily ratios. */
  ctr: number | null
  /** Impression-weighted mean position, or null when no day carried one. */
  position: number | null
  /** Which table this period's figures came from. */
  source: GscTotalsSource
}

export interface GscPeriodChange {
  clicks: number | null
  impressions: number | null
  ctr: number | null
  position: number | null
}

export interface GscPeriodComparison {
  /** Length of EACH period in calendar days. */
  days: number
  prior: GscPeriodTotals
  trailing: GscPeriodTotals
  /**
   * False when the two periods do not rest on the same measurement, in which
   * case every `change` is null.
   *
   * A ratio of one source to the other is not a change in the property, it is
   * the gap between two counting methods. On the measured pair above, a
   * perfectly FLAT property whose window straddles the boundary would report
   * clicks +44%, impressions -23% and CTR +87%. `totals` tolerates the mix
   * because a uniform bias in a level is still monotone; a ratio of two
   * differently-sourced halves is not. Same posture as `top-pages`, which
   * returns null rather than falling back for a total.
   */
  comparable: boolean
  /**
   * Relative change as a ratio (0.5 = +50%), or null where the prior period
   * gives nothing to divide by. Sign is mathematical: for position, a POSITIVE
   * value means the number went up, which is a worse rank. Desirability is the
   * renderer's business, not this module's.
   */
  change: GscPeriodChange
}

/**
 * Relative change, or null when the baseline cannot support one.
 *
 * A zero baseline is the honest blank: going from no clicks to some clicks is
 * an infinite increase, and "+∞%" or a silently substituted "+100%" would both
 * be inventions. A null baseline means the metric was never measured.
 */
function relativeChange(trailing: number | null, prior: number | null): number | null {
  if (trailing === null || prior === null) return null
  if (!Number.isFinite(trailing) || !Number.isFinite(prior)) return null
  if (prior <= 0) return null
  return (trailing - prior) / prior
}

/**
 * Every calendar date from `start` to `end` inclusive, as `YYYY-MM-DD`.
 *
 * Stepped in UTC so a DST transition in the host's zone cannot drop or repeat a
 * date. These are calendar labels, not instants.
 */
export function gscCalendarDates(start: string, end: string): string[] {
  const dates: string[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return dates
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function aggregate(dates: string[], byDate: Map<string, GscDailyRow>): GscPeriodTotals {
  let clicks = 0
  let impressions = 0
  let positionWeight = 0
  let positionWeighted = 0
  let propertyDays = 0
  let dimensionedDays = 0

  for (const date of dates) {
    const row = byDate.get(date)
    if (row) {
      if (row.fromPropertyTotals) propertyDays += 1
      else dimensionedDays += 1
    }
    // A calendar day with no row is a real zero for counts. Search Analytics
    // omits zero-data days rather than reporting them, so treating the gap as
    // missing data would silently shorten the period.
    if (!row) continue
    clicks += row.clicks
    impressions += row.impressions
    // Position is non-additive and weighted by impressions, matching how the
    // route computes the window total. A day with one impression must not pull
    // the mean as hard as a day with a thousand, and a day with no impressions
    // has no weight to contribute at all.
    if (row.position !== null && row.impressions > 0) {
      positionWeight += row.impressions
      positionWeighted += row.position * row.impressions
    }
  }

  return {
    startDate: dates[0] ?? '',
    endDate: dates[dates.length - 1] ?? '',
    clicks,
    impressions,
    // CTR is a ratio of the period's own totals. Averaging the daily ratios
    // instead would weight a 1-impression day equally with a 1000-impression
    // one and would not reconcile with the clicks and impressions beside it.
    ctr: impressions > 0 ? clicks / impressions : null,
    position: positionWeight > 0 ? positionWeighted / positionWeight : null,
    // A period with no rows at all reports `dimensioned`: it carries no
    // property-daily evidence, so it must not be treated as commensurable with
    // one that does.
    source: propertyDays > 0 && dimensionedDays > 0
      ? 'mixed'
      : propertyDays > 0 ? 'property-daily' : 'dimensioned',
  }
}

/**
 * Split the window into two equal, adjacent calendar periods and compare them.
 *
 * The split is over the CALENDAR, not over the row array. `daily` carries only
 * dates that produced data, so splitting it down the middle puts a different
 * number of real days on each side whenever the property had a quiet stretch —
 * the same defect that made the trend fit compress quiet periods before it was
 * densified.
 *
 * When the span is an odd number of days the OLDEST day is dropped, because two
 * periods of equal length is the whole point of the comparison; an off-by-one
 * on the older side would quietly flatter or punish the trailing period.
 *
 * Returns null when the span cannot make two periods of at least one day each.
 */
export function computeGscPeriodComparison(daily: readonly GscDailyRow[]): GscPeriodComparison | null {
  if (daily.length === 0) return null

  const first = daily[0]!.date
  const last = daily[daily.length - 1]!.date
  const calendar = gscCalendarDates(first, last)
  const periodDays = Math.floor(calendar.length / 2)
  if (periodDays < 1) return null

  const byDate = new Map(daily.map((row) => [row.date, row]))
  const trailingDates = calendar.slice(calendar.length - periodDays)
  const priorDates = calendar.slice(calendar.length - periodDays * 2, calendar.length - periodDays)

  const prior = aggregate(priorDates, byDate)
  const trailing = aggregate(trailingDates, byDate)

  // Both periods must rest on the same measurement. `mixed` fails on its own:
  // a period that is itself half one source and half the other has no single
  // meaning to compare against anything.
  const comparable = prior.source === trailing.source && prior.source !== 'mixed'

  return {
    days: periodDays,
    prior,
    trailing,
    comparable,
    change: {
      clicks: comparable ? relativeChange(trailing.clicks, prior.clicks) : null,
      impressions: comparable ? relativeChange(trailing.impressions, prior.impressions) : null,
      ctr: comparable ? relativeChange(trailing.ctr, prior.ctr) : null,
      position: comparable ? relativeChange(trailing.position, prior.position) : null,
    },
  }
}
