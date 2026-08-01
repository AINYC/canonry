import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fetchDailyTotals } from '../src/ga4-client.js'
import { GA4_METRICS } from '../src/constants.js'

/**
 * `engagementRate` and returning users on the property-level daily series.
 *
 * The daily-totals report carries `date` as its ONLY dimension, so GA4
 * deduplicates every user metric inside the day. That is what makes
 * `totalUsers - newUsers` an exact returning-user count for that day rather
 * than an approximation: within one day a user is either new or returning,
 * and there is no second dimension for the counts to fan out across.
 *
 * `returningUsers` is NOT a GA4 metric. The alternative — adding the
 * `newVsReturning` dimension — would multiply the row count and break the
 * date-only grain this table exists to hold, so it is deliberately not used.
 */

type FetchArgs = { url: string; body: { metrics?: Array<{ name: string }> } }

describe('fetchDailyTotals engagement + returning users', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let calls: FetchArgs[]

  beforeEach(() => {
    calls = []
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mockReport(rows: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>) {
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as FetchArgs['body'] })
      return new Response(JSON.stringify({ rows, rowCount: rows.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  }

  it('requests engagementRate and newUsers alongside the existing metrics', async () => {
    mockReport([])

    await fetchDailyTotals('fake-token', '123456', 7)

    expect(calls).toHaveLength(1)
    const requested = (calls[0]!.body.metrics ?? []).map(metric => metric.name)
    // The literal names are the GA4 Data API contract, asserted here on purpose:
    // a typo in the constant would otherwise pass a constant-only comparison.
    expect(requested).toEqual(['sessions', 'totalUsers', 'engagementRate', 'newUsers'])
    expect(GA4_METRICS.engagementRate).toBe('engagementRate')
    expect(GA4_METRICS.newUsers).toBe('newUsers')
  })

  it('derives returningUsers as totalUsers minus newUsers', async () => {
    mockReport([
      {
        dimensionValues: [{ value: '20260731' }],
        metricValues: [{ value: '1420' }, { value: '500' }, { value: '0.6234' }, { value: '180' }],
      },
    ])

    const rows = await fetchDailyTotals('fake-token', '123456', 7)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      date: '2026-07-31',
      sessions: 1420,
      users: 500,
      engagementRate: 0.6234,
      newUsers: 180,
      returningUsers: 320,
    })
  })

  it('clamps returningUsers at zero when GA4 reports more new users than total users', async () => {
    // GA4 can report newUsers > totalUsers on a low-volume day because the two
    // metrics are estimated independently. A negative returning-user count is
    // never a real reading, so it floors at 0 rather than propagating.
    mockReport([
      {
        dimensionValues: [{ value: '20260731' }],
        metricValues: [{ value: '4' }, { value: '3' }, { value: '0.5' }, { value: '5' }],
      },
    ])

    const rows = await fetchDailyTotals('fake-token', '123456', 7)
    expect(rows[0]!.returningUsers).toBe(0)
  })

  it('parses newUsers as a whole number and rejects an empty metric value', async () => {
    // Two contract details the DTO depends on. `newUsers` feeds an INTEGER
    // column and an `int()` DTO field, so a decimal string must not survive as
    // a float. And `Number('')` is 0, not NaN, so an empty value would
    // otherwise land as a real zero reading instead of an absent one.
    mockReport([
      {
        dimensionValues: [{ value: '20260731' }],
        metricValues: [{ value: '90' }, { value: '40' }, { value: '' }, { value: '12.0' }],
      },
    ])

    const rows = await fetchDailyTotals('fake-token', '123456', 7)

    expect(rows[0]!.engagementRate).toBeNull()
    expect(rows[0]!.newUsers).toBe(12)
    expect(Number.isInteger(rows[0]!.newUsers)).toBe(true)
    expect(rows[0]!.returningUsers).toBe(28)
  })

  it('reports the new metrics as null, not zero, when GA4 omits them', async () => {
    // A property whose response predates the widened metric list must not read
    // as "0% engaged, 0 returning users" — that is a real value, and this is
    // the absence of one.
    mockReport([
      {
        dimensionValues: [{ value: '20260730' }],
        metricValues: [{ value: '90' }, { value: '40' }],
      },
    ])

    const rows = await fetchDailyTotals('fake-token', '123456', 7)

    expect(rows[0]!.sessions).toBe(90)
    expect(rows[0]!.users).toBe(40)
    expect(rows[0]!.engagementRate).toBeNull()
    expect(rows[0]!.newUsers).toBeNull()
    expect(rows[0]!.returningUsers).toBeNull()
  })
})
