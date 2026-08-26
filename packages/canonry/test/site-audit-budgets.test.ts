import { describe, expect, it } from 'vitest'

import { crawlBudgetsFor, reportedTermination } from '../src/execute-site-audit.js'

/**
 * A 1,000-page audit used to return 140 pages, because the engine's 100 MB byte
 * default is exhausted after ~140 pages of a site serving ~745 KB each — and
 * the platform never set it. These lock the arithmetic that keeps the page
 * budget the binding one, and the reporting that says so honestly.
 */
describe('crawl budgets', () => {
  it('gives the byte budget enough headroom that pages, not bytes, bind', () => {
    // The measured page weight that produced the 140-page ceiling.
    const HEAVY_PAGE_BYTES = 745_000
    for (const maxPages of [100, 1_000, 8_717]) {
      const { maxBytes } = crawlBudgetsFor(maxPages)
      const pagesAffordable = Math.floor(maxBytes / HEAVY_PAGE_BYTES)
      expect(pagesAffordable, `${maxPages} pages`).toBeGreaterThanOrEqual(maxPages)
    }
  })

  it('would not have saved the old default — the regression is real', () => {
    // Sanity on the diagnosis itself: the engine default really is too small
    // for the page budget the dashboard already asks for.
    const ENGINE_DEFAULT_MAX_BYTES = 100 * 1024 * 1024
    expect(Math.floor(ENGINE_DEFAULT_MAX_BYTES / 745_000)).toBeLessThan(200)
    expect(crawlBudgetsFor(1_000).maxBytes).toBeGreaterThan(ENGINE_DEFAULT_MAX_BYTES)
  })

  it('never drops below the engine floor for a small crawl', () => {
    expect(crawlBudgetsFor(10).maxDurationMs).toBe(120_000)
  })

  it('scales the duration with the page budget', () => {
    // 8,717 pages at ~5/s is ~29 minutes; the budget must not cut that short.
    const { maxDurationMs } = crawlBudgetsFor(8_717)
    expect(maxDurationMs).toBeGreaterThan(29 * 60 * 1_000)
  })

  it('lifts maxQueryVariants off the default that caused the masking', () => {
    // 10 is an ADMISSION limit reached while seeding a large sitemap; latching
    // it first is what hid the real byte stop.
    expect(crawlBudgetsFor(1_000).maxQueryVariants).toBeGreaterThan(10)
  })
})

describe('reported termination', () => {
  const limits = { maxBytes: 1_000, maxDurationMs: 60_000, maxFetches: 500 }

  it('reports a byte stop as a byte stop even when a soft reason latched first', () => {
    // Exactly the live case: the run recorded max-query-variants for a crawl
    // that actually exhausted its byte budget.
    expect(reportedTermination({
      terminationReason: 'max-query-variants',
      bytesRead: 1_000, elapsedMs: 30_000, fetchesStarted: 140, limits,
    })).toBe('max-bytes')
  })

  it('reports a duration stop when the clock ran out', () => {
    expect(reportedTermination({
      terminationReason: 'max-pages', bytesRead: 10, elapsedMs: 60_000, fetchesStarted: 10, limits,
    })).toBe('max-duration')
  })

  it('keeps the engine reason when nothing was exhausted', () => {
    expect(reportedTermination({
      terminationReason: 'max-pages', bytesRead: 10, elapsedMs: 10, fetchesStarted: 10, limits,
    })).toBe('max-pages')
  })

  it('reports complete when the crawl simply finished', () => {
    expect(reportedTermination({ terminationReason: null, limits })).toBe('complete')
  })

  it('falls back safely when the engine reports no counters', () => {
    expect(reportedTermination({ terminationReason: 'max-pages' })).toBe('max-pages')
  })
})
