import { test } from 'vitest'
import { summarizePerception } from '../src/perception/summary.js'
import type { PerceptionEvidence, PerceptionSourceRef, PerceptionVerdict, SourceType } from '../src/perception/types.js'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function deepEqual(actual: unknown, expected: unknown, message = 'values differ'): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) throw new Error(`${message}: ${actualJson} !== ${expectedJson}`)
}

function present<T>(value: T | null | undefined, message = 'expected a value'): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

function source(type: SourceType, index = 0): PerceptionSourceRef {
  return { url: `https://${type}${index}.test/page`, domain: `${type}${index}.test`, title: null, type }
}

function row(options: {
  verdict: PerceptionVerdict | null
  concerns?: string[]
  sources?: PerceptionSourceRef[]
}): PerceptionEvidence {
  const failed = options.verdict === null
  return {
    query: 'is Example Co legit?',
    provider: 'gemini',
    requestedModel: 'gemini-2.5-flash',
    servedModel: failed ? null : 'gemini-2.5-flash',
    completedAt: '2026-09-01T00:00:00.000Z',
    answerText: failed ? null : 'an answer',
    verdict: options.verdict,
    evidenceSentences: [],
    concerns: options.concerns ?? [],
    sources: options.sources ?? [],
    searchQueries: [],
    retrievalStatus: failed ? 'error' : 'grounded',
    error: failed ? 'The provider request timed out.' : null,
  }
}

test('the verdict counts sum to successfulChecks, and none is a bucket rather than a residual', () => {
  const summary = summarizePerception([
    row({ verdict: 'recommends' }),
    row({ verdict: 'cautions' }),
    row({ verdict: 'mixed' }),
    row({ verdict: 'none' }),
    row({ verdict: 'recommends' }),
  ])
  deepEqual(summary.verdicts, { recommends: 2, cautions: 1, mixed: 1, none: 1 })
  equal(summary.successfulChecks, 5)
  equal(summary.failedChecks, 0)
  const total = summary.verdicts.recommends + summary.verdicts.cautions + summary.verdicts.mixed +
    summary.verdicts.none
  equal(total, summary.successfulChecks, 'the four buckets are the whole denominator')
})

test('a check with no verdict is unmeasured and enters no denominator at all', () => {
  // A failed probe and an answer whose verdict was never extracted are the same
  // thing here: nobody read a position out of it. One definition of successful,
  // used by all three sections, or the same card says "2 answers" above one
  // number and "3 answers" above the next.
  const summary = summarizePerception([
    row({ verdict: 'recommends', concerns: ['slow support'], sources: [source('review')] }),
    row({ verdict: null, concerns: ['slow support'], sources: [source('news')] }),
    row({ verdict: null }),
  ])
  equal(summary.successfulChecks, 1)
  equal(summary.failedChecks, 2)
  deepEqual(summary.verdicts, { recommends: 1, cautions: 0, mixed: 0, none: 0 })
  deepEqual(summary.concerns, [{ phrase: 'slow support', answers: 1 }], 'the unmeasured row raises nothing')
  const shares = present(summary.sourceTypes)
  equal(shares.measuredAnswers, 1)
  equal(shares.totalAppearances, 1, 'and it attributes nothing either')
})

test('a concern counts once per answer, however often that answer repeats it', () => {
  // Counting mentions would let one verbose answer outrank a concern three
  // separate answers raised.
  const summary = summarizePerception([
    row({ verdict: 'cautions', concerns: ['slow support', 'slow support', 'hidden fees'] }),
    row({ verdict: 'mixed', concerns: ['hidden fees'] }),
  ])
  deepEqual(summary.concerns, [
    { phrase: 'hidden fees', answers: 2 },
    { phrase: 'slow support', answers: 1 },
  ])
})

test('concerns dedupe across casing and punctuation, and keep the first spelling written', () => {
  const summary = summarizePerception([
    row({ verdict: 'cautions', concerns: ['Hidden Fees'] }),
    row({ verdict: 'cautions', concerns: ['hidden fees'] }),
    row({ verdict: 'cautions', concerns: ['hidden-fees'] }),
  ])
  deepEqual(summary.concerns, [{ phrase: 'Hidden Fees', answers: 3 }], 'one concern, shown as an answer wrote it')
})

test('concerns sort by answers desc, then phrase asc', () => {
  const summary = summarizePerception([
    row({ verdict: 'cautions', concerns: ['zeta', 'alpha', 'beta'] }),
    row({ verdict: 'cautions', concerns: ['beta'] }),
  ])
  deepEqual(summary.concerns, [
    { phrase: 'beta', answers: 2 },
    { phrase: 'alpha', answers: 1 },
    { phrase: 'zeta', answers: 1 },
  ])
})

test('a source type counts once per answer and the shares sum to exactly 1', () => {
  // Eight Reddit threads in one answer is ONE answer leaning on community
  // sources. Counting links would let a single well-linked answer decide the
  // mix.
  const summary = summarizePerception([
    row({
      verdict: 'recommends',
      sources: [source('community', 1), source('community', 2), source('community', 3), source('official')],
    }),
    row({ verdict: 'cautions', sources: [source('community', 4), source('review')] }),
  ])
  const shares = present(summary.sourceTypes)
  deepEqual(shares.entries.map((entry) => [entry.type, entry.answers]), [
    ['community', 2],
    ['official', 1],
    ['review', 1],
  ])
  equal(shares.totalAppearances, 4)
  equal(shares.measuredAnswers, 2)
  equal(shares.unattributedAnswers, 0)
  equal(shares.entries.reduce((sum, entry) => sum + entry.share, 0), 1, 'the shares are a whole, not a sample')
  deepEqual(shares.entries.map((entry) => entry.share), [0.5, 0.25, 0.25])
})

test('an answer that attributed nothing is stated, never counted as a denominator', () => {
  // An answer with no sources is not an answer where some source type won.
  const summary = summarizePerception([
    row({ verdict: 'recommends', sources: [source('news')] }),
    row({ verdict: 'none' }),
    row({ verdict: 'none' }),
  ])
  const shares = present(summary.sourceTypes)
  equal(shares.measuredAnswers, 1)
  equal(shares.unattributedAnswers, 2)
  equal(shares.totalAppearances, 1)
  equal(summary.successfulChecks, 3, 'they are still measured checks; they just attributed nothing')
})

test('sourceTypes is null when nothing attributed a source, so the section renders nothing', () => {
  const nothing = summarizePerception([row({ verdict: 'none' }), row({ verdict: 'recommends' })])
  equal(nothing.sourceTypes, null)
  const empty = summarizePerception([])
  deepEqual(empty, {
    successfulChecks: 0,
    failedChecks: 0,
    verdicts: { recommends: 0, cautions: 0, mixed: 0, none: 0 },
    concerns: [],
    sourceTypes: null,
  })
})

test('every check failing leaves a summary of zeroes and nulls, never an invented finding', () => {
  const summary = summarizePerception([row({ verdict: null }), row({ verdict: null }), row({ verdict: null })])
  equal(summary.successfulChecks, 0)
  equal(summary.failedChecks, 3)
  deepEqual(summary.verdicts, { recommends: 0, cautions: 0, mixed: 0, none: 0 })
  equal(summary.sourceTypes, null)
})
