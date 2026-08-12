import { and, asc, eq, sql, max } from 'drizzle-orm'
import { gscDailyTotals, gscQueryDailyTotals, gscSearchData } from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { shiftIsoCalendarDate, type MetricsWindow } from '@ainyc/canonry-contracts'

export interface GscDailyTotal {
  date: string
  clicks: number
  impressions: number
  position: number
}

/** Days a labelled rolling window covers. `all` has no fixed span. */
const WINDOW_DAYS: Record<Exclude<MetricsWindow, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }

/**
 * The inclusive date range a labelled GSC window actually covers, plus the
 * reporting lag that decided it.
 */
export interface GscWindowRange {
  /** Inclusive lower bound, or `null` for `all`. */
  startDate: string | null
  /** Inclusive upper bound: the latest date the property has published. */
  endDate: string | null
  /** `MAX(date)` across the project's GSC data, ignoring any window. */
  latestDataDate: string | null
  /** Calendar days between `latestDataDate` and today. `null` with no data. */
  reportingLagDays: number | null
}

/**
 * Resolve a labelled window against the last day Search Console actually
 * published, NOT against the clock.
 *
 * Google publishes search analytics on a two-to-three day delay, so the most
 * recent days of a now-anchored window are dates that cannot ever hold data.
 * Anchoring `30d` at today therefore returns 27 or 28 days of data under a
 * label that promises 30, and the shortfall grows as the window shrinks: a
 * `7d` window spends three of its seven days on the lag and delivers four.
 *
 * Worse, the shortfall is invisible and it is not monotonic across labels.
 * Canonry's now-anchored `30d` covered 2026-07-13..2026-08-09 while Search
 * Console's own `28 days` covered 2026-07-14..2026-08-10 — neither range
 * contains the other, so the wider Canonry window reported FEWER impressions
 * (1,174) than the narrower Google one (1,360). A total that moves the wrong
 * way when you widen the window reads as missing data, and there is no way for
 * an operator to tell that apart from a real decline.
 *
 * Anchoring on the last published day is what Search Console's own UI does, so
 * `30d` means thirty days of data and the two surfaces become comparable.
 *
 * `today` is injected rather than read from the clock so this stays pure and
 * testable, matching the `gbp-summary` precedent.
 */
export function resolveGscWindowRange(
  window: MetricsWindow,
  latestDataDate: string | null,
  today: string,
): GscWindowRange {
  const reportingLagDays = latestDataDate === null
    ? null
    : Math.max(0, Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latestDataDate}T00:00:00Z`)) / 86_400_000,
    ))

  // `all` has no lower bound to place, and with no data at all there is no
  // anchor: fall back to the now-anchored cutoff so an empty project still
  // filters rather than returning everything.
  if (window === 'all') {
    return { startDate: null, endDate: latestDataDate, latestDataDate, reportingLagDays }
  }
  const days = WINDOW_DAYS[window]
  if (latestDataDate === null) {
    return {
      startDate: shiftIsoCalendarDate(today, -days),
      endDate: null,
      latestDataDate: null,
      reportingLagDays: null,
    }
  }
  // `days - 1`, because the range is INCLUSIVE at both ends: a 7-day window
  // ending on the 10th starts on the 4th, not the 3rd.
  return {
    startDate: shiftIsoCalendarDate(latestDataDate, -(days - 1)),
    endDate: latestDataDate,
    latestDataDate,
    reportingLagDays,
  }
}

/**
 * The latest GSC reporting date stored for a project, across BOTH sources.
 *
 * The property-level table is preferred everywhere else, but it can lag the
 * dimensioned one (a project synced before `gsc_daily_totals` existed has only
 * dimensioned rows). Taking the max of the two means the anchor never sits
 * behind data the endpoint is about to return.
 */
export function readLatestGscDataDate(db: DatabaseClient, projectId: string): string | null {
  const property = db.select({ latest: max(gscDailyTotals.date) })
    .from(gscDailyTotals).where(eq(gscDailyTotals.projectId, projectId)).get()?.latest ?? null
  const dimensioned = db.select({ latest: max(gscSearchData.date) })
    .from(gscSearchData).where(eq(gscSearchData.projectId, projectId)).get()?.latest ?? null
  if (property === null) return dimensioned
  if (dimensioned === null) return property
  return property >= dimensioned ? property : dimensioned
}

/**
 * Read the property-level daily GSC totals for a project over an inclusive
 * `[startDate, endDate]` window, ordered by date ascending.
 *
 * These rows come from the un-dimensioned (`dimensions: ['date']`) GSC sync and
 * are the CORRECT source for the headline clicks / impressions / CTR / position
 * and the daily trend on dates where they exist — summing the dimensioned
 * `gsc_search_data` rows does not equal Google's property total.
 */
export function readGscDailyTotals(
  db: DatabaseClient,
  projectId: string,
  startDate: string,
  endDate: string,
): GscDailyTotal[] {
  const rows = db
    .select({
      date: gscDailyTotals.date,
      clicks: gscDailyTotals.clicks,
      impressions: gscDailyTotals.impressions,
      position: gscDailyTotals.position,
    })
    .from(gscDailyTotals)
    .where(
      and(
        eq(gscDailyTotals.projectId, projectId),
        sql`${gscDailyTotals.date} >= ${startDate}`,
        sql`${gscDailyTotals.date} <= ${endDate}`,
      ),
    )
    .orderBy(asc(gscDailyTotals.date))
    .all()

  return rows.map((r) => {
    const position = Number(r.position)
    return {
      date: r.date,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Number.isFinite(position) ? position : 0,
    }
  })
}

export function mergeGscDailyTotalsWithFallback(
  propertyTotals: readonly GscDailyTotal[],
  dimensionedFallback: readonly GscDailyTotal[],
): GscDailyTotal[] {
  const byDate = new Map<string, GscDailyTotal>()
  for (const row of dimensionedFallback) byDate.set(row.date, row)
  for (const row of propertyTotals) byDate.set(row.date, row)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** One (date, query) observation. The grain BOTH sources share. */
export interface GscQueryDayRow {
  date: string
  query: string
  clicks: number
  impressions: number
  position: number
}

export interface GscQueryTotal {
  query: string
  clicks: number
  impressions: number
  /** Impression-weighted across the days in the window. */
  position: number
}

export interface GscQueryAggregate extends GscQueryTotal {
  /**
   * How this query's window was sourced.
   *
   * `google` — every day came from the un-dimensioned `['date','query']` fetch
   * (accurate). `page-summed` — every day came from the legacy
   * `gsc_search_data` sum, whose impressions are inflated by the `page`
   * fan-out. `mixed` — the window spans both, which is the normal state while
   * a backfill is partial: recent days accurate, older days not.
   *
   * A `mixed` total is deliberately NOT suppressed. Dropping the legacy days
   * would silently shorten the window and undercount; blending them without
   * saying so would overstate. The caller is told instead.
   */
  source: 'google' | 'page-summed' | 'mixed'
}

/**
 * Read per-(date, query) rows from the accurate un-dimensioned fetch over an
 * inclusive `[startDate, endDate]` window.
 *
 * Deliberately NOT pre-aggregated. The merge below has to happen at day grain,
 * because a partially-backfilled query has accurate rows for only part of the
 * window and must keep its legacy rows for the rest.
 */
export function readGscQueryDailyRows(
  db: DatabaseClient,
  projectId: string,
  startDate: string,
  endDate: string,
): GscQueryDayRow[] {
  const rows = db
    .select({
      date: gscQueryDailyTotals.date,
      query: gscQueryDailyTotals.query,
      clicks: gscQueryDailyTotals.clicks,
      impressions: gscQueryDailyTotals.impressions,
      position: gscQueryDailyTotals.position,
    })
    .from(gscQueryDailyTotals)
    .where(
      and(
        eq(gscQueryDailyTotals.projectId, projectId),
        sql`${gscQueryDailyTotals.date} >= ${startDate}`,
        sql`${gscQueryDailyTotals.date} <= ${endDate}`,
      ),
    )
    .all()

  return rows.map((r) => {
    const position = Number(r.position)
    return {
      date: r.date,
      query: r.query,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Number.isFinite(position) ? position : 0,
    }
  })
}

interface QueryAccumulator {
  clicks: number
  impressions: number
  weightedPositionSum: number
  positionSum: number
  positionDays: number
  sawAccurate: boolean
  sawLegacy: boolean
}

/**
 * Merge the accurate and legacy sources at (date, query) grain, THEN aggregate
 * to one row per query.
 *
 * Order matters. Aggregating first and preferring the accurate total would
 * replace a query's whole-window legacy figure with an accurate figure covering
 * only the backfilled days — silently truncating a 90-day report to whatever
 * the backfill has reached, and undercounting. Merging per day keeps every day
 * in the window and uses the best source available for each one.
 *
 * `position` is impression-weighted across the merged days, which is the
 * correct way to combine Google's own per-day per-query averages: a
 * 1-impression day must not weigh as much as a 500-impression one.
 */
export function mergeGscQueryTotalsWithFallback(
  accurateDays: readonly GscQueryDayRow[],
  fallbackDays: readonly GscQueryDayRow[],
): GscQueryAggregate[] {
  const dayKey = (r: GscQueryDayRow): string => `${r.date}\u0000${r.query}`

  // Per (date, query): accurate wins, legacy fills the gap.
  const byDay = new Map<string, { row: GscQueryDayRow; accurate: boolean }>()
  for (const row of fallbackDays) byDay.set(dayKey(row), { row, accurate: false })
  for (const row of accurateDays) byDay.set(dayKey(row), { row, accurate: true })

  const byQuery = new Map<string, QueryAccumulator>()
  for (const { row, accurate } of byDay.values()) {
    const acc = byQuery.get(row.query) ?? {
      clicks: 0,
      impressions: 0,
      weightedPositionSum: 0,
      positionSum: 0,
      positionDays: 0,
      sawAccurate: false,
      sawLegacy: false,
    }
    acc.clicks += row.clicks
    acc.impressions += row.impressions
    acc.weightedPositionSum += row.position * row.impressions
    // Unweighted fallback so a window whose every day has zero impressions
    // still reports the position Google gave, rather than collapsing to 0.
    acc.positionSum += row.position
    acc.positionDays += 1
    if (accurate) acc.sawAccurate = true
    else acc.sawLegacy = true
    byQuery.set(row.query, acc)
  }

  return [...byQuery.entries()].map(([query, acc]) => ({
    query,
    clicks: acc.clicks,
    impressions: acc.impressions,
    position:
      acc.impressions > 0
        ? acc.weightedPositionSum / acc.impressions
        : acc.positionDays > 0
          ? acc.positionSum / acc.positionDays
          : 0,
    source: acc.sawAccurate && acc.sawLegacy ? 'mixed' : acc.sawAccurate ? 'google' : 'page-summed',
  }))
}
