/**
 * Display order for the audit factors: best score first, worst last.
 *
 * The audit engine returns its rollup alphabetically, which reads as a list of
 * names rather than a result. Sorting by score turns the same rows into a
 * ranking, so the strongest signals sit at the top and the work to do collects
 * at the bottom where it is easy to scan.
 *
 * Ordering is a reading decision over stored data, not part of the record, so it
 * is applied at read time. That keeps checks written before this change in the
 * new order too, and it is why both surfaces call the same comparator: the UI
 * and the MCP payload describe the same audit and must not disagree about which
 * factor is doing best.
 */

/** What the order is decided on. `score` is null when nothing was measured. */
export interface FactorRank {
  score: number | null
  label: string
}

/**
 * An unmeasured factor sorts last, never as a zero. "Not applicable to the
 * sampled page types" is the absence of a measurement; ranking it below the
 * worst real score would claim it is worse than the worst thing found.
 */
export function compareFactorRank(a: FactorRank, b: FactorRank): number {
  const aScore = typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : null
  const bScore = typeof b.score === 'number' && Number.isFinite(b.score) ? b.score : null
  if (aScore === null || bScore === null) {
    if (aScore !== bScore) return aScore === null ? 1 : -1
  } else if (aScore !== bScore) {
    return bScore - aScore
  }
  // Ties break by name so the same audit always draws the same list. Several
  // factors scoring 100 is the common case, not an edge case.
  return a.label.localeCompare(b.label)
}

/** Sort a copy, so a stored array is never reordered in place. */
export function orderFactors<T>(items: readonly T[], rank: (item: T) => FactorRank): T[] {
  return [...items].sort((a, b) => compareFactorRank(rank(a), rank(b)))
}
