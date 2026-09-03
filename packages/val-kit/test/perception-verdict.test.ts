import { test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import {
  buildVerdictExtractPrompt,
  createGeminiVerdictExtractor,
  parseVerdictExtractResponse,
  VERDICT_EXTRACT_LIMITS,
  verifyVerdict,
} from '../src/perception/verdict-extract.js'

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function present<T>(value: T | undefined, message = 'expected a value'): T {
  if (value === undefined) throw new Error(message)
  return value
}

const ANSWER = [
  'Example Co is a well-reviewed provider that most small teams are happy with.',
  'Some customers report slow support during peak season, and the pricing is opaque.',
].join(' ')

test('a sentence the answer does not contain is dropped, whatever the model returned', () => {
  // The basis of the whole instrument. Asked for a verdict a model will produce
  // one, with a fluent sentence to back it, whether or not the answer contains
  // either. Exact matching is what makes this a measurement.
  const verified = verifyVerdict(ANSWER, {
    verdict: 'recommends',
    evidence: [
      'Example Co is a well-reviewed provider that most small teams are happy with.',
      'Example Co is the clear market leader.',
    ],
    concerns: [],
  })

  deepEqual(verified.evidenceSentences, [
    'Example Co is a well-reviewed provider that most small teams are happy with.',
  ], 'the invented sentence is gone')
  equal(verified.verdict, 'recommends')
})

test('a re-wrapped or re-cased sentence still counts, because it is the same sentence', () => {
  const verified = verifyVerdict(ANSWER, {
    verdict: 'cautions',
    evidence: ['some customers report SLOW   support\n  during peak season'],
    concerns: [],
  })
  equal(verified.verdict, 'cautions')
  equal(verified.evidenceSentences.length, 1)
})

test('a verdict with no surviving evidence becomes none, never the verdict the model wanted', () => {
  const verified = verifyVerdict(ANSWER, {
    verdict: 'recommends',
    evidence: ['Everyone I know recommends them.'],
    concerns: [],
  })
  deepEqual(verified, { verdict: 'none', evidenceSentences: [], concerns: [] })
})

test('none carries no evidence, because taking no position is the finding', () => {
  const verified = verifyVerdict(ANSWER, {
    verdict: 'none',
    evidence: ['Example Co is a well-reviewed provider that most small teams are happy with.'],
    concerns: ['slow support'],
  })
  deepEqual(verified.evidenceSentences, [])
  equal(verified.verdict, 'none')
  // A concern is verified against the prose on its own, so it survives a
  // verdict that did not.
  deepEqual(verified.concerns, ['slow support'])
})

test('a concern the answer does not write is dropped, expansions and translations included', () => {
  const verified = verifyVerdict(ANSWER, {
    verdict: 'cautions',
    evidence: ['the pricing is opaque'],
    concerns: ['slow support', 'opaque pricing', 'hidden fees', 'slow customer support'],
  })
  deepEqual(verified.concerns, ['slow support'], 'only the phrase written as adjacent complete words survives')
  equal(verified.verdict, 'cautions')
})

test('an unparsable or unrecognised response leaves every row unmeasured, never none', () => {
  // `none` is a finding about the answer; `null` is a fact about the check.
  // Collapsing the second into the first turns an outage into a result.
  deepEqual(parseVerdictExtractResponse('not json at all', 3), [null, null, null])
  deepEqual(
    parseVerdictExtractResponse(JSON.stringify({ answers: [{ index: 1, verdict: 'positive', evidence: [] }] }), 1),
    [null],
    'a verdict outside the closed set is not a verdict',
  )
})

test('the parser reads a fenced response, honours the index, and bounds every field', () => {
  const rows = parseVerdictExtractResponse(
    [
      '```json',
      JSON.stringify({
        answers: [
          {
            index: 2,
            verdict: 'mixed',
            evidence: Array.from({ length: 6 }, (_, index) => `sentence ${index}`),
            concerns: Array.from({ length: 12 }, (_, index) => `concern ${index}`),
          },
        ],
      }),
      '```',
    ].join('\n'),
    2,
  )
  equal(rows[0], null, 'the row nobody reported stays unmeasured')
  const second = present(rows[1])
  equal(second.verdict, 'mixed')
  equal(second.evidence.length, VERDICT_EXTRACT_LIMITS.maxEvidencePerAnswer)
  equal(second.concerns.length, VERDICT_EXTRACT_LIMITS.maxConcernsPerAnswer)
})

test('the extractor spends one call, constrains its output, and thinks not at all', async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    models: {
      generateContent(params: Record<string, unknown>) {
        calls.push(params)
        return Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  answers: [{ index: 1, verdict: 'cautions', evidence: ['the pricing is opaque'], concerns: [] }],
                }),
              }],
            },
          }],
        } as unknown as GenerateContentResponse)
      },
    },
  }
  const proposals = await createGeminiVerdictExtractor({ client: client as never, model: 'gemini-2.5-flash' })
    .extract([{ text: ANSWER, brandNames: ['Example Co'] }])

  equal(calls.length, 1, 'one call for the whole batch')
  const config = present(calls[0]).config as Record<string, unknown>
  equal(config.responseMimeType, 'application/json')
  assert(config.responseSchema !== undefined, 'the shape is enforced by the provider, not hoped for')
  equal((config.thinkingConfig as { thinkingBudget?: number }).thinkingBudget, 0)
  equal(present(proposals[0]).verdict, 'cautions')
})

test('a provider failure leaves every answer unmeasured rather than positionless', async () => {
  const client = { models: { generateContent: () => Promise.reject(new Error('503 unavailable')) } }
  const proposals = await createGeminiVerdictExtractor({ client: client as never, model: 'gemini-2.5-flash' })
    .extract([
      { text: ANSWER, brandNames: ['Example Co'] },
      { text: ANSWER, brandNames: ['Example Co'] },
    ])
  deepEqual(proposals, [null, null])
})

test('the extractor never spends a call on nothing', async () => {
  let called = 0
  const client = {
    models: {
      generateContent: () => {
        called += 1
        return Promise.resolve({} as GenerateContentResponse)
      },
    },
  }
  const proposals = await createGeminiVerdictExtractor({ client: client as never, model: 'gemini-2.5-flash' })
    .extract([{ text: '   ', brandNames: [] }])
  equal(called, 0, 'three failed probes have no prose to read')
  deepEqual(proposals, [null])
})

test('the prompt demands copied sentences and names the subject when it is known', () => {
  const prompt = buildVerdictExtractPrompt([{ text: ANSWER, brandNames: ['Example Co', 'Example'] }])
  assert(prompt.includes('WORD FOR WORD'), 'the model is told the sentences are checked')
  assert(prompt.includes('(the company is: Example Co, Example)'), 'the subject is stated')
  const anonymous = buildVerdictExtractPrompt([{ text: ANSWER, brandNames: [] }])
  assert(anonymous.includes('Text 1:'), 'and an unnamed subject reads as a plain text, not as an empty label')
})
