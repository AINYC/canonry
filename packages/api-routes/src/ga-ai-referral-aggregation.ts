import { AiReferralTrafficClasses } from '@ainyc/canonry-contracts'
import type { AiReferralTrafficClass, GA4AiReferralDailyDto } from '@ainyc/canonry-contracts'

/**
 * CONSERVATION INVARIANT for `ga_ai_referrals`. Read this before changing any
 * aggregation in this file or adding a new read of that table.
 *
 *   SUM ACROSS LANDING PAGES WITHIN ONE ATTRIBUTION DIMENSION.
 *   NEVER SUM ACROSS DIMENSIONS.
 *
 * A stored row is one (date, source, medium, sourceDimension, channelGroup,
 * landingPage) cell, so one day of traffic from one source arrives as MANY
 * rows, each worth a handful of sessions and very often worth exactly 1 (one
 * landing page, one visit). The rows inside a single dimension are disjoint:
 * GA4 attributes exactly one landing page per session, so summing them is
 * required to get that dimension's real total.
 *
 * The dimensions are not disjoint. `session`, `first_user` and `manual_utm`
 * are three overlapping lenses on the same visit, fetched as three separate
 * GA4 reports. Only one lens may contribute to a tuple's total; this module
 * keeps the lens reporting the most sessions.
 *
 * Both ways of getting this wrong have shipped in this codebase:
 *
 *   sum every row  ->  roughly 3x inflation (three lenses counted as if they
 *                      were three disjoint groups of traffic)
 *   MAX every row  ->  collapse to a single landing page (a real 35 session
 *                      day reported as 1)
 *
 * This is the same discipline as the demand-conservation rule: the parts must
 * add up to the whole exactly once, so every derived AI session number (window
 * totals, the daily trend series, the per-source rows) is folded from the one
 * winner set produced by `resolveWinningDimensions` below. Two surfaces that
 * derive the same quantity independently will eventually disagree; two
 * surfaces that fold the same winner set cannot.
 *
 * THE COMPANION RULE FOR USERS. Everything above is about SESSIONS, and it
 * does not transfer:
 *
 *   SESSIONS sum across landing pages within a dimension.
 *   USERS DO NOT SUM AT ANY GRAIN.
 *
 * GA reports `totalUsers` as a COUNT DISTINCT evaluated at the grain the
 * report asked for. One visitor who reads three pages is ONE user, but they
 * contribute a `users` value to all three landing-page rows, so adding those
 * rows counts them three times. The same is true across mediums, channel
 * groups, sources and dates. There is no grain at which the stored `users`
 * column may be added up, which is why no surface here publishes one.
 *
 * Sessions escape this because GA4 attributes exactly one landing page to a
 * session and dates are disjoint, so the landing-page rows partition the day.
 *
 * A correct users figure requires GA to do the dedup in an un-dimensioned
 * report. `ga_daily_totals` is that fetch for whole-property traffic, but
 * there is no AI-referral equivalent: `fetchAiReferrals` is always dimensioned
 * by source/medium/landingPage/channelGroup. So an AI-referral user count
 * cannot be computed and cannot be fetched. It is therefore not reported, the
 * same call `aiReferralSectionSchema` made when it withdrew its user counts
 * and the same call `/ga/traffic` made in 4.135.0 when it withdrew its six
 * `*Users*` fields and the `users` on its two referral row types. Do not
 * reintroduce one here with a caveat: a wrong number with a caveat is still a
 * wrong number on a customer-facing surface.
 */

/**
 * One `ga_ai_referrals` row as these aggregations need to see it.
 *
 * `users` is absent on purpose, and there is no sibling row type that carries
 * it: nothing derives a published number from that column any more, so no
 * caller has a reason to select it.
 */
export interface AiReferralAggregationRow {
  date: string
  source: string
  medium: string
  trafficClass: string | null
  sourceDimension: string
  channelGroup: string
  sessions: number | null
}

/**
 * One (date, source, medium) tuple after the winning lens has been chosen.
 *
 * SESSIONS ONLY. There is deliberately no user figure on this type, so no
 * surface folding the winner set can publish one by accident.
 */
export interface AiReferralWinningTuple {
  date: string
  source: string
  medium: string
  paidSessions: number
  organicSessions: number
}

interface DimensionSessionCounts {
  paidSessions: number
  organicSessions: number
}

export function normalizeAiTrafficClass(value: string | null | undefined): AiReferralTrafficClass {
  return value === AiReferralTrafficClasses.paid
    ? AiReferralTrafficClasses.paid
    : AiReferralTrafficClasses.organic
}

function emptyAiCounts() {
  return { sessions: 0 }
}

/**
 * Collapse raw rows to one entry per (date, source, medium), summing landing
 * pages inside each attribution dimension and then keeping only the winning
 * dimension. This is the single primitive every AI session number is folded
 * from.
 *
 * Traffic class deliberately does NOT join the tuple key. A visit counted paid
 * under one lens and organic under another would then survive twice and
 * inflate the combined total. Instead each dimension keeps its own paid vs
 * organic split, and the winner's total is partitioned by class: the rows
 * within one dimension are disjoint by class, so paid + organic always equals
 * that tuple's total.
 */
export function resolveWinningDimensions(
  rows: readonly AiReferralAggregationRow[],
): AiReferralWinningTuple[] {
  interface TupleGroup {
    date: string
    source: string
    medium: string
    byDimension: Map<string, DimensionSessionCounts>
  }

  const groups = new Map<string, TupleGroup>()

  for (const row of rows) {
    const key = `${row.date}\0${row.source}\0${row.medium}`
    let group = groups.get(key)
    if (!group) {
      group = { date: row.date, source: row.source, medium: row.medium, byDimension: new Map() }
      groups.set(key, group)
    }
    let dim = group.byDimension.get(row.sourceDimension)
    if (!dim) {
      dim = { paidSessions: 0, organicSessions: 0 }
      group.byDimension.set(row.sourceDimension, dim)
    }
    // Sum across landing pages (and channel groups) inside this one dimension.
    const sessions = row.sessions ?? 0
    if (normalizeAiTrafficClass(row.trafficClass) === AiReferralTrafficClasses.paid) {
      dim.paidSessions += sessions
    } else {
      dim.organicSessions += sessions
    }
  }

  const winners: AiReferralWinningTuple[] = []
  for (const group of groups.values()) {
    const dims = [...group.byDimension.values()]
    const bestSessions = dims.reduce((best, d) =>
      d.paidSessions + d.organicSessions > best.paidSessions + best.organicSessions ? d : best)
    winners.push({
      date: group.date,
      source: group.source,
      medium: group.medium,
      paidSessions: bestSessions.paidSessions,
      organicSessions: bestSessions.organicSessions,
    })
  }
  return winners
}

/**
 * Window totals for the AI traffic cards.
 *
 * `deduped` folds the winner set from `resolveWinningDimensions`. `bySession`
 * is the narrower session-lens-only view the disjoint channel breakdown needs,
 * which is a plain sum over the `session` rows because a single lens is
 * already disjoint by landing page.
 *
 * SESSIONS ONLY. Every bucket used to carry a `.users` landing-page sum backing
 * the six `/ga/traffic` user fields; 4.135.0 withdrew those fields and deleted
 * the math behind them. See the users rule at the top of this file for why no
 * correct replacement can be computed or fetched.
 */
export function summarizeAiReferralCounts(rows: readonly AiReferralAggregationRow[]) {
  const paidDeduped = emptyAiCounts()
  const organicDeduped = emptyAiCounts()
  const paidBySession = emptyAiCounts()
  const organicBySession = emptyAiCounts()
  const bySessionChannelGroup = new Map<string, number>()

  for (const winner of resolveWinningDimensions(rows)) {
    paidDeduped.sessions += winner.paidSessions
    organicDeduped.sessions += winner.organicSessions
  }

  for (const row of rows) {
    if (row.sourceDimension !== 'session') continue
    const sessions = row.sessions ?? 0
    bySessionChannelGroup.set(
      row.channelGroup,
      (bySessionChannelGroup.get(row.channelGroup) ?? 0) + sessions,
    )
    const bucket = normalizeAiTrafficClass(row.trafficClass) === AiReferralTrafficClasses.paid
      ? paidBySession
      : organicBySession
    bucket.sessions += sessions
  }

  return {
    paidDeduped,
    organicDeduped,
    paidBySession,
    organicBySession,
    bySessionChannelGroup,
    deduped: { sessions: paidDeduped.sessions + organicDeduped.sessions },
    bySession: { sessions: paidBySession.sessions + organicBySession.sessions },
  }
}

/**
 * Per-date, per-source AI session series for the trend chart.
 *
 * Folds the SAME winner set the window totals fold, just grouped by date and
 * source instead of summed flat, so `totalSessions` here is identical to
 * `summarizeAiReferralCounts(rows).deduped.sessions` for the same rows by
 * construction rather than by two call sites happening to match.
 *
 * SESSIONS ONLY. There is no user count here and there must never be one: the
 * winner set's user figures are landing-page sums, and rolling them up further
 * across sources and mediums would compound the over-count. See the users rule
 * at the top of this file for why no correct alternative exists.
 */
export function buildAiReferralDailySeries(
  rows: readonly AiReferralAggregationRow[],
): GA4AiReferralDailyDto {
  interface SourceBucket {
    source: string
    sessions: number
    paidSessions: number
    organicSessions: number
  }

  const byDate = new Map<string, Map<string, SourceBucket>>()
  const sourceTotals = new Map<string, number>()
  let totalSessions = 0
  let totalPaidSessions = 0
  let totalOrganicSessions = 0

  for (const winner of resolveWinningDimensions(rows)) {
    const sessions = winner.paidSessions + winner.organicSessions
    let bySource = byDate.get(winner.date)
    if (!bySource) {
      bySource = new Map()
      byDate.set(winner.date, bySource)
    }
    let bucket = bySource.get(winner.source)
    if (!bucket) {
      bucket = { source: winner.source, sessions: 0, paidSessions: 0, organicSessions: 0 }
      bySource.set(winner.source, bucket)
    }
    // Mediums are disjoint within a tuple, so a source's day is the sum of its
    // winning tuples. This is the only place the per-source day is defined.
    bucket.sessions += sessions
    bucket.paidSessions += winner.paidSessions
    bucket.organicSessions += winner.organicSessions

    sourceTotals.set(winner.source, (sourceTotals.get(winner.source) ?? 0) + sessions)
    totalSessions += sessions
    totalPaidSessions += winner.paidSessions
    totalOrganicSessions += winner.organicSessions
  }

  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bySource]) => {
      const sources = [...bySource.values()]
        .sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source))
      return {
        date,
        sessions: sources.reduce((sum, s) => sum + s.sessions, 0),
        paidSessions: sources.reduce((sum, s) => sum + s.paidSessions, 0),
        organicSessions: sources.reduce((sum, s) => sum + s.organicSessions, 0),
        bySource: sources,
      }
    })

  const sources = [...sourceTotals.entries()]
    .sort(([aSource, aSessions], [bSource, bSessions]) =>
      bSessions - aSessions || aSource.localeCompare(bSource))
    .map(([source]) => source)

  return { days, sources, totalSessions, totalPaidSessions, totalOrganicSessions }
}
