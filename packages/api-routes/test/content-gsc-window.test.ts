import { describe, expect, it } from 'vitest'
import { aggregateGscByQuery } from '../src/content-data.js'

/**
 * gsc_search_data is keyed (date, query, page, country, device), so a query
 * ranking on several pages produces several rows for ONE SERP impression.
 * Summing them over-counts. Measured on a live property before this fix, the
 * query "gjelina hotel" summed to 151,571 impressions where the accurate
 * all-time figure was 26,477 and its 30-day window was 1,519.
 */
const PAGE_ROWS = [
  { query: 'boutique hotel', page: 'https://x.test/rooms', impressions: 100, clicks: 4, ctr: '0.04', position: '3' },
  { query: 'boutique hotel', page: 'https://x.test/', impressions: 100, clicks: 6, ctr: '0.06', position: '5' },
]

describe('aggregateGscByQuery', () => {
  it('takes impressions and clicks from the accurate per-query aggregate, not the page sum', () => {
    const out = aggregateGscByQuery(PAGE_ROWS, [
      { query: 'boutique hotel', impressions: 100, clicks: 10, position: 3.8 },
    ])
    const row = out.get('boutique hotel')!
    // 100, not the 200 the two page rows sum to.
    expect(row.impressions).toBe(100)
    expect(row.clicks).toBe(10)
    expect(row.position).toBeCloseTo(3.8)
    expect(row.ctr).toBeCloseTo(0.1)
  })

  it('still attributes the best page from the page rows, which is what they are for', () => {
    const out = aggregateGscByQuery([
      { query: 'boutique hotel', page: 'https://x.test/rooms', impressions: 10, clicks: 0, ctr: '0', position: '9' },
      { query: 'boutique hotel', page: 'https://x.test/suites', impressions: 90, clicks: 5, ctr: '0.05', position: '2' },
    ], [{ query: 'boutique hotel', impressions: 100, clicks: 5, position: 2.7 }])
    expect(out.get('boutique hotel')!.page).toBe('/suites')
  })

  it('falls back to page-summed figures when a query has no accurate aggregate', () => {
    const out = aggregateGscByQuery(PAGE_ROWS, [])
    // Legacy behaviour preserved for un-backfilled days: still an over-count,
    // which is why the fallback is a fallback.
    expect(out.get('boutique hotel')!.impressions).toBe(200)
    expect(out.get('boutique hotel')!.clicks).toBe(10)
  })

  it('derives CTR from the aggregate rather than from any single row', () => {
    const out = aggregateGscByQuery(PAGE_ROWS, [
      { query: 'boutique hotel', impressions: 250, clicks: 25, position: 4 },
    ])
    expect(out.get('boutique hotel')!.ctr).toBeCloseTo(0.1)
  })
})
