/**
 * The aggregation, and the four invariants a reader depends on without being
 * told they exist.
 *
 * 1. A check counts as SUCCESSFUL exactly when it produced a verdict. The
 *    verdict is what this instrument measures, so a row without one measured
 *    nothing — whether the probe failed or the extraction did — and it leaves
 *    EVERY denominator, not just the verdict counts. One definition, used by
 *    all three sections, or the same card says "2 answers" above one number and
 *    "3 answers" above the next.
 * 2. The verdict counts sum to `successfulChecks`. `'none'` is a bucket, not a
 *    residual: an answer that took no position was still measured.
 * 3. A concern counts ONCE PER ANSWER, however many times that answer repeats
 *    it. Counting mentions would let one verbose answer outrank a concern three
 *    separate answers raised.
 * 4. A source TYPE counts once per answer, for the same reason: eight Reddit
 *    threads in one answer is one answer leaning on community sources, and
 *    counting links would let a single well-linked answer decide the mix.
 *    Shares are `answers / totalAppearances`, so they sum to 1 exactly.
 */
import { brandKey } from '../visibility/brand.js'
import type {
  PerceptionConcern,
  PerceptionEvidence,
  PerceptionSourceTypeShare,
  PerceptionSummary,
  PerceptionVerdict,
  PerceptionVerdictCounts,
  SourceType,
} from './types.js'

export function summarizePerception(evidence: readonly PerceptionEvidence[]): PerceptionSummary {
  const measured = evidence.filter(
    (row): row is PerceptionEvidence & { verdict: PerceptionVerdict } => row.verdict !== null,
  )
  return {
    successfulChecks: measured.length,
    failedChecks: evidence.length - measured.length,
    verdicts: countVerdicts(measured),
    concerns: countConcerns(measured),
    sourceTypes: shareSourceTypes(measured),
  }
}

function countVerdicts(measured: ReadonlyArray<PerceptionEvidence & { verdict: PerceptionVerdict }>): (
  PerceptionVerdictCounts
) {
  const counts: PerceptionVerdictCounts = { recommends: 0, cautions: 0, mixed: 0, none: 0 }
  for (const row of measured) counts[row.verdict] += 1
  return counts
}

function countConcerns(measured: readonly PerceptionEvidence[]): PerceptionConcern[] {
  // `brandKey` folds case, accents, spacing, and punctuation to one key, so
  // "Hidden fees", "hidden fees", and "hidden-fees" are one concern. The FIRST
  // spelling seen is what the reader is shown: it is the one an answer actually
  // wrote, where a normalized key is a string nothing wrote.
  const totals = new Map<string, PerceptionConcern>()
  for (const row of measured) {
    const seen = new Set<string>()
    for (const phrase of row.concerns) {
      const key = brandKey(phrase)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const existing = totals.get(key)
      if (existing) existing.answers += 1
      else totals.set(key, { phrase, answers: 1 })
    }
  }
  return [...totals.values()].sort((a, b) => b.answers - a.answers || a.phrase.localeCompare(b.phrase, 'en'))
}

function shareSourceTypes(measured: readonly PerceptionEvidence[]): PerceptionSourceTypeShare | null {
  const answersByType = new Map<SourceType, number>()
  let measuredAnswers = 0
  let unattributedAnswers = 0
  for (const row of measured) {
    const types = new Set(row.sources.map((source) => source.type))
    if (types.size === 0) {
      // Stated, never folded into the denominator: an answer that attributed no
      // source is not an answer where some source type won.
      unattributedAnswers += 1
      continue
    }
    measuredAnswers += 1
    for (const type of types) answersByType.set(type, (answersByType.get(type) ?? 0) + 1)
  }
  if (measuredAnswers === 0) return null

  const totalAppearances = [...answersByType.values()].reduce((sum, count) => sum + count, 0)
  const entries = [...answersByType.entries()]
    .map(([type, answers]) => ({ type, answers, share: answers / totalAppearances }))
    .sort((a, b) => b.answers - a.answers || a.type.localeCompare(b.type, 'en'))
  return { measuredAnswers, unattributedAnswers, totalAppearances, entries }
}
