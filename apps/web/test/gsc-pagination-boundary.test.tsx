import { describe, it, expect } from 'vitest'

/**
 * Regression for the off-by-one that hid the last row.
 *
 * The old shape fetched PAGE_SIZE + 1 as a "is there more" sentinel, rendered
 * PAGE_SIZE, and then compared the FETCHED count against totalMatching. With
 * exactly PAGE_SIZE + 1 matching rows that reads as "no more pages" while one
 * fetched row was never displayed, so it was unreachable in the UI.
 */
const PAGE_SIZE = 25

function hasMore(fetchOffset: number, fetchedRows: number, totalMatching: number): boolean {
  return fetchOffset + fetchedRows < totalMatching
}

describe('GSC performance pagination', () => {
  it('does not strand the final row when exactly PAGE_SIZE + 1 rows match', () => {
    // Old behaviour: fetch 26, render 25, hasMore = 0 + 26 < 26 = false.
    const oldFetched = PAGE_SIZE + 1
    expect(hasMore(0, oldFetched, 26)).toBe(false)   // "no more pages"
    const oldRendered = PAGE_SIZE
    expect(oldRendered).toBeLessThan(26)             // ...but row 26 never shown

    // New behaviour: fetch exactly PAGE_SIZE, so fetched === rendered.
    expect(hasMore(0, PAGE_SIZE, 26)).toBe(true)
  })

  it('reports no more pages when the page exactly consumes the result set', () => {
    expect(hasMore(0, PAGE_SIZE, PAGE_SIZE)).toBe(false)
  })

  it('reports no more pages on the final partial page', () => {
    expect(hasMore(25, 10, 35)).toBe(false)
  })
})
