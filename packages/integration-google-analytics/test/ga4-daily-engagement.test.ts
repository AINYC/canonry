import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fetchDailyTotals } from '../src/ga4-client.js'
import { GA4_METRICS } from '../src/constants.js'

/**
 * Engagement metrics on the property-level daily series.
 *
 * No returning-users figure is derived. GA4 exposes no such metric, and
 * subtracting newUsers from totalUsers does not reconstruct one, because a
 * visitor can be first-seen AND return inside the same range.
 */

type FetchArgs = { url: string; body: { metrics?: Array<{ name: string }> } }

describe('fetchDailyTotals engagement metrics', () => {
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
  })
})
