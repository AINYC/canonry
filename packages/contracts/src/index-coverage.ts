/**
 * Index coverage without spending quota.
 *
 * Coverage used to come only from the URL Inspection API — ~7.1s and one unit
 * of a 2000/property/day quota per page. That caps a site at ~2000 pages a day
 * and, in practice, at whatever the caller was willing to wait for: the old
 * inline pass inspected the top 50 pages by clicks, so a 290-page site reported
 * coverage from 50 of them and said nothing about the other 240.
 *
 * Search analytics already answers most of the question for free. **A page with
 * at least one impression in the window is, by definition, in Google's index** —
 * Google cannot have shown it otherwise. That figure arrives in the rows the
 * sync already fetches, in under a second, for every page, at any site size.
 *
 * The inverse does NOT hold, and this is the trap the whole module exists to
 * avoid: **no impressions is not evidence of exclusion.** A page can be indexed
 * and simply never rank in the window. Treating silence as "not indexed" would
 * manufacture bad news at exactly the moment coverage stopped being truncated,
 * so a page nobody has measured is `unknown` — a third state, not a zero.
 *
 * Inspection stays authoritative where it exists: it is a direct answer from
 * Google about that URL, so it beats derivation. What changes is that it is now
 * needed only for the pages derivation cannot resolve, which is where the
 * interesting cases live anyway.
 */

/** What we know about one page's presence in Google's index. */
export type IndexCoverageState = 'indexed' | 'not-indexed' | 'unknown'

export interface IndexCoverageInput {
  /** Every page seen in the window, with its impression count. */
  pages: ReadonlyArray<{ page: string; impressions: number }>
  /**
   * Latest inspection verdict per page, where one exists. `indexingState` is
   * GSC's own value; `'INDEXING_ALLOWED'` is the pass condition.
   */
  inspections?: ReadonlyArray<{ url: string; indexingState: string | null; coverageState?: string | null }>
}

export interface IndexCoverageSummary {
  /** Per-page resolution, keyed by page URL. */
  states: Map<string, IndexCoverageState>
  indexed: number
  notIndexed: number
  unknown: number
  /** Pages resolved by a real inspection verdict rather than derived. */
  verifiedByInspection: number
  /** Pages proven indexed by impressions alone, costing no quota. */
  derivedFromImpressions: number
  /** `coverageState` histogram for the not-indexed pages, for the UI breakdown. */
  reasonBreakdown: Record<string, number>
}

/**
 * Resolve index coverage for every page, preferring inspection and falling back
 * to impressions.
 *
 * Precedence per page:
 *
 *   1. **impressions > 0** → `indexed`. Certain, and free. Checked first because
 *      it is the strongest signal available: Google served the page. It also
 *      overrides a stale `not-indexed` inspection, which is the common case
 *      after a page gets fixed and starts ranking again.
 *   2. **an inspection verdict** → `indexed` / `not-indexed` per `indexingState`.
 *   3. **neither** → `unknown`. Never `not-indexed`.
 *
 * Pages that were inspected but never appeared in the window are included too —
 * dropping them would silently shrink the denominator.
 */
export function deriveIndexCoverage(input: IndexCoverageInput): IndexCoverageSummary {
  const impressionsByPage = new Map<string, number>()
  for (const row of input.pages) {
    if (!row.page) continue
    impressionsByPage.set(row.page, (impressionsByPage.get(row.page) ?? 0) + (row.impressions || 0))
  }

  const inspectionByUrl = new Map<string, { indexingState: string | null; coverageState?: string | null }>()
  for (const row of input.inspections ?? []) {
    if (row.url) inspectionByUrl.set(row.url, row)
  }

  const states = new Map<string, IndexCoverageState>()
  const reasonBreakdown: Record<string, number> = {}
  let indexed = 0
  let notIndexed = 0
  let unknown = 0
  let verifiedByInspection = 0
  let derivedFromImpressions = 0

  // Union of both sources: a page may rank without ever being inspected, or be
  // inspected without ranking in this window.
  for (const page of new Set([...impressionsByPage.keys(), ...inspectionByUrl.keys()])) {
    const impressions = impressionsByPage.get(page) ?? 0
    const inspection = inspectionByUrl.get(page)

    if (impressions > 0) {
      states.set(page, 'indexed')
      indexed++
      derivedFromImpressions++
      // Counted as verified too when an inspection agrees — the page is both
      // proven by traffic and confirmed by Google.
      if (inspection) verifiedByInspection++
      continue
    }

    if (!inspection) {
      states.set(page, 'unknown')
      unknown++
      continue
    }

    verifiedByInspection++
    if (inspection.indexingState === 'INDEXING_ALLOWED') {
      states.set(page, 'indexed')
      indexed++
    } else {
      states.set(page, 'not-indexed')
      notIndexed++
      const reason = inspection.coverageState ?? 'Unknown'
      reasonBreakdown[reason] = (reasonBreakdown[reason] ?? 0) + 1
    }
  }

  return { states, indexed, notIndexed, unknown, verifiedByInspection, derivedFromImpressions, reasonBreakdown }
}
