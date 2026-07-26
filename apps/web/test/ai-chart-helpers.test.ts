import { describe, it, expect } from 'vitest'
import {
  AI_ORGANIC_SESSIONS_KEY,
  AI_TOTAL_SESSIONS_KEY,
  buildAiChartData,
} from '../src/lib/ai-chart-helpers.js'
import type { GA4AiReferralDailyDto, GA4SessionHistoryEntry } from '../src/api.js'

const EMPTY: GA4AiReferralDailyDto = {
  days: [],
  sources: [],
  totalSessions: 0,
  totalUsers: 0,
  totalPaidSessions: 0,
  totalOrganicSessions: 0,
}

function sessionDay(date: string, sessions: number, organicSessions: number): GA4SessionHistoryEntry {
  return { date, sessions, organicSessions, users: sessions, usersSource: 'deduplicated' }
}

describe('buildAiChartData', () => {
  it('plots the API session count for the day verbatim', () => {
    // The shape the API returns for a day whose 35 sessions were stored as 35
    // single-session landing-page rows triplicated across attribution lenses.
    const daily: GA4AiReferralDailyDto = {
      days: [{
        date: '2026-07-26',
        sessions: 35,
        users: 35,
        paidSessions: 0,
        organicSessions: 35,
        bySource: [{ source: 'chatgpt', sessions: 35, users: 35, paidSessions: 0, organicSessions: 35 }],
      }],
      sources: ['chatgpt'],
      totalSessions: 35,
      totalUsers: 35,
      totalPaidSessions: 0,
      totalOrganicSessions: 35,
    }

    const agg = buildAiChartData(daily, [sessionDay('2026-07-26', 420, 180)])

    expect(agg.data).toHaveLength(1)
    // The chart point is the real day, not one landing page and not three lenses.
    expect(agg.data[0]!.chatgpt).toBe(35)
    expect(agg.data[0]!.chatgpt).not.toBe(1)
    expect(agg.data[0]!.chatgpt).not.toBe(105)
    expect(agg.data[0]![AI_TOTAL_SESSIONS_KEY]).toBe(420)
    expect(agg.data[0]![AI_ORGANIC_SESSIONS_KEY]).toBe(180)
    expect(agg.sources).toEqual(['chatgpt'])
  })

  it('agrees with the summary total the cards render', () => {
    const daily: GA4AiReferralDailyDto = {
      days: [
        { date: '2026-07-25', sessions: 18, users: 18, paidSessions: 0, organicSessions: 18, bySource: [{ source: 'chatgpt', sessions: 18, users: 18, paidSessions: 0, organicSessions: 18 }] },
        { date: '2026-07-26', sessions: 35, users: 35, paidSessions: 5, organicSessions: 30, bySource: [
          { source: 'chatgpt', sessions: 30, users: 30, paidSessions: 5, organicSessions: 25 },
          { source: 'claude.ai', sessions: 5, users: 5, paidSessions: 0, organicSessions: 5 },
        ] },
      ],
      sources: ['chatgpt', 'claude.ai'],
      totalSessions: 53,
      totalUsers: 53,
      totalPaidSessions: 5,
      totalOrganicSessions: 48,
    }

    const agg = buildAiChartData(daily, [sessionDay('2026-07-25', 300, 120), sessionDay('2026-07-26', 420, 180)])

    const plotted = agg.data.reduce(
      (sum, row) => sum + agg.sources.reduce((s, source) => s + ((row[source] as number) ?? 0), 0),
      0,
    )
    expect(plotted).toBe(daily.totalSessions)
  })

  it('keeps AI dates that have no session-history row', () => {
    const daily: GA4AiReferralDailyDto = {
      ...EMPTY,
      days: [{ date: '2026-07-24', sessions: 2, users: 2, paidSessions: 0, organicSessions: 2, bySource: [{ source: 'claude.ai', sessions: 2, users: 2, paidSessions: 0, organicSessions: 2 }] }],
      sources: ['claude.ai'],
      totalSessions: 2,
      totalUsers: 2,
      totalOrganicSessions: 2,
    }

    const agg = buildAiChartData(daily, [sessionDay('2026-07-26', 420, 180)])

    expect(agg.data.map((r) => r.date)).toEqual(['2026-07-24', '2026-07-26'])
    expect(agg.data[0]!['claude.ai']).toBe(2)
    expect(agg.data[0]![AI_TOTAL_SESSIONS_KEY]).toBe(0)
    expect(agg.dateRange).toEqual({ start: '2026-07-24', end: '2026-07-26' })
  })

  it('returns an empty aggregation with no data', () => {
    expect(buildAiChartData(EMPTY, [])).toEqual({ data: [], sources: [], dateRange: null })
  })
})
