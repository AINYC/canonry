import type { GA4AiReferralDailyDto, GA4SessionHistoryEntry } from '../api.js'

export const AI_TOTAL_SESSIONS_KEY = '_totalSessions'
export const AI_ORGANIC_SESSIONS_KEY = '_organicSessions'

export interface AiChartAggregation {
  data: Array<Record<string, string | number>>
  sources: string[]
  dateRange: { start: string; end: string } | null
}

/**
 * Shape the "AI vs total sessions" chart rows.
 *
 * This function does NOT derive any AI session count. `daily` arrives already
 * deduplicated across attribution dimensions and summed across landing pages by
 * GET /ga/ai-referral-daily, which is the same derivation the AI summary cards
 * are folded from. Re-aggregating referral rows here is what made the chart
 * disagree with its own summary card; the only job left is to merge the AI
 * series onto the total/organic session series and sort by date.
 */
export function buildAiChartData(
  daily: GA4AiReferralDailyDto,
  sessionHistory: readonly GA4SessionHistoryEntry[],
): AiChartAggregation {
  const byDate = new Map<string, Record<string, string | number>>()

  for (const row of sessionHistory) {
    byDate.set(row.date, {
      [AI_TOTAL_SESSIONS_KEY]: row.sessions,
      [AI_ORGANIC_SESSIONS_KEY]: row.organicSessions,
    })
  }

  for (const day of daily.days) {
    let entry = byDate.get(day.date)
    if (!entry) {
      entry = { [AI_TOTAL_SESSIONS_KEY]: 0, [AI_ORGANIC_SESSIONS_KEY]: 0 }
      byDate.set(day.date, entry)
    }
    for (const source of day.bySource) {
      entry[source.source] = ((entry[source.source] as number) ?? 0) + source.sessions
    }
  }

  const data = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, ...vals }))

  const dates = data.map((d) => d.date)
  const dateRange = dates.length > 0
    ? { start: dates[0]!, end: dates[dates.length - 1]! }
    : null

  return { data, sources: daily.sources, dateRange }
}
