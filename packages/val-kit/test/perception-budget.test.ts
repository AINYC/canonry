import { test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import {
  createGeminiValPerceptionProbe,
  VAL_TOWN_GEMINI_PERCEPTION_LIMITS,
} from '../src/perception/gemini-perception-probe.js'
import { VERDICT_EXTRACT_LIMITS } from '../src/perception/verdict-extract.js'
import type { PerceptionProbeInput } from '../src/perception/types.js'

/** The val's whole per-check work budget. Every deadline below has to fit inside it. */
const PUBLIC_CHECK_WORK_BUDGET_MS = 45_000

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

const ANSWER = 'Example Co is well regarded by small teams. Some customers report slow support.'

function planText(): string {
  return JSON.stringify({
    brandNames: ['Example Co'],
    queries: [
      'is Example Co legit?',
      'Example Co reviews',
      'what are the complaints about Example Co?',
    ],
  })
}

function verdictText(count: number): string {
  return JSON.stringify({
    answers: Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      verdict: 'mixed',
      evidence: ['Example Co is well regarded by small teams.'],
      concerns: ['slow support'],
    })),
  })
}

function textResponse(text: string): GenerateContentResponse {
  return {
    modelVersion: 'gemini-2.5-flash',
    candidates: [{ content: { parts: [{ text }] } }],
  } as unknown as GenerateContentResponse
}

function probeResponse(): GenerateContentResponse {
  return {
    modelVersion: 'gemini-2.5-flash',
    candidates: [{
      content: { parts: [{ text: ANSWER }] },
      groundingMetadata: {
        webSearchQueries: ['Example Co reviews'],
        groundingChunks: [
          { web: { uri: 'https://www.reddit.com/r/saas/comments/1', title: 'Reddit thread' } },
          { web: { uri: 'https://example.com/pricing', title: 'Example Co pricing' } },
        ],
      },
    }],
  } as unknown as GenerateContentResponse
}

type CallKind = 'planner' | 'probe' | 'verdict'

/**
 * Routed by what the call IS, never by its ordinal. Three probes run in ONE
 * wave, so their calls interleave with each other and with a retry; an
 * ordinal script silently hands the planner's answer to a probe and the test
 * passes for the wrong reason.
 */
function classify(params: Record<string, unknown>): CallKind {
  const config = params.config as Record<string, unknown> | undefined
  if (config?.responseSchema !== undefined) return 'verdict'
  const contents = typeof params.contents === 'string' ? params.contents : ''
  return contents.startsWith('You create a small brand-perception probe plan') ? 'planner' : 'probe'
}

function routedClient(handlers: {
  planner?: () => Promise<GenerateContentResponse>
  probe?: (query: string) => Promise<GenerateContentResponse>
  verdict?: (count: number) => Promise<GenerateContentResponse>
  probeCount?: number
}) {
  const calls: Array<Record<string, unknown>> = []
  const kinds: CallKind[] = []
  return {
    calls,
    kinds,
    client: {
      models: {
        generateContent(params: Record<string, unknown>) {
          calls.push(params)
          const kind = classify(params)
          kinds.push(kind)
          if (kind === 'planner') return (handlers.planner ?? (() => Promise.resolve(textResponse(planText()))))()
          if (kind === 'verdict') {
            const count = handlers.probeCount ?? 3
            return (handlers.verdict ?? ((n: number) => Promise.resolve(textResponse(verdictText(n)))))(count)
          }
          const query = typeof params.contents === 'string' ? params.contents : ''
          return (handlers.probe ?? (() => Promise.resolve(probeResponse())))(query)
        },
      },
    },
  }
}

function scriptedClient(probeCount = 3) {
  return routedClient({ probeCount })
}

test('a whole perception check costs exactly five provider calls', async () => {
  // 1 planner + 3 probes in one wave + 1 verdict extraction. That number is
  // meant to be NOTICED when a feature adds a call: it is the check on what an
  // anonymous visitor can make this instrument spend.
  const { calls, client } = scriptedClient()
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: client as never }).probe({
    domain: 'example.com',
    // A runtime caller cannot enlarge the public cap.
    maxProbeCalls: 99,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  equal(calls.length, 5, 'one planner, three probes, one verdict extraction')
  equal(report.evidence.length, 3)
  equal(report.summary.successfulChecks, 3)
  equal(report.summary.failedChecks, 0)
  deepEqual(report.summary.verdicts, { recommends: 0, cautions: 0, mixed: 3, none: 0 })
  deepEqual(report.brandNames, ['Example Co'])
  equal(report.schemaVersion, '1')
})

test('every provider call sets an explicit thinking budget', async () => {
  // Gemini 2.5 thinks by DEFAULT and bills those tokens against
  // `maxOutputTokens`, so a call that does not set `thinkingConfig` can spend
  // its whole allowance reasoning and return NO TEXT. It presents as lost data,
  // never as an error. A new call site cannot inherit the default quietly.
  const { calls, client } = scriptedClient()
  await createGeminiValPerceptionProbe({ apiKey: 'k', client: client as never }).probe({
    domain: 'example.com',
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  equal(calls.length, 5)
  for (const [index, call] of calls.entries()) {
    const config = call.config as Record<string, unknown>
    const thinking = config.thinkingConfig as { thinkingBudget?: number } | undefined
    assert(typeof thinking?.thinkingBudget === 'number', `call ${index + 1} must set thinkingConfig.thinkingBudget`)
    const maxOutput = config.maxOutputTokens as number | undefined
    assert(
      typeof maxOutput !== 'number' || thinking.thinkingBudget < maxOutput,
      `call ${index + 1} lets thinking consume its entire ${maxOutput}-token allowance`,
    )
  }
})

test('the deadlines fit the job budget, and one probe wave is what makes them fit', () => {
  const limits = VAL_TOWN_GEMINI_PERCEPTION_LIMITS
  // Raising `maxProbeCalls` without raising concurrency silently reintroduces a
  // second wave and blows the ceiling, so assert the RELATIONSHIP rather than
  // the numbers.
  assert(limits.probeConcurrency >= limits.maxProbeCalls, 'every probe must run in one wave')
  const worstCase = limits.plannerTimeoutMs + limits.probeTimeoutMs + limits.verdictTimeoutMs
  assert(
    worstCase <= PUBLIC_CHECK_WORK_BUDGET_MS,
    `the phase can spend ${worstCase}ms of a ${PUBLIC_CHECK_WORK_BUDGET_MS}ms budget`,
  )
  // Two constants naming one deadline drift. This is the only thing stopping it.
  equal(limits.verdictTimeoutMs, VERDICT_EXTRACT_LIMITS.timeoutMs)
})

test('supplied questions are asked verbatim and are never required to name the brand', async () => {
  // The visitor chose them. Only a GENERATED question has to be branded.
  const { calls, client } = scriptedClient(3)
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: client as never }).probe({
    domain: 'example.com',
    userQueries: ['what do people think of this tool', 'is it any good', '   '],
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  const asked = report.evidence.map((row) => row.query)
  assert(asked.includes('what do people think of this tool'), 'the visitor question is asked as written')
  assert(asked.includes('is it any good'), 'and so is the second')
  equal(asked.length, 3)
  equal(calls.length, 5, 'the planner fills only the remaining slot')
})

test('a caller who supplied every question pays for no planning call', async () => {
  // It would spend a Gemini request producing questions nothing then asks.
  const { calls, kinds, client } = routedClient({})
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: client as never }).probe({
    domain: 'example.com',
    userQueries: ['question one', 'question two', 'question three', 'question four'],
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  equal(calls.length, 4, 'three probes and one verdict extraction, and no planner')
  equal(kinds.includes('planner'), false, 'no planning call was made at all')
  deepEqual(report.evidence.map((row) => row.query), ['question one', 'question two', 'question three'])
  deepEqual(report.brandNames, [], 'nothing approved an alias, so the report claims none')
})

test('a planning failure is fatal only when it leaves nothing to ask', async () => {
  const withSupplied = routedClient({
    planner: () => Promise.reject(new Error('The perception planner returned invalid JSON.')),
    probeCount: 1,
  }).client
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: withSupplied as never }).probe({
    domain: 'example.com',
    userQueries: ['what do people say about this company'],
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)
  equal(report.evidence.length, 1, "the visitor's own question is still probed")
  equal(report.summary.failedChecks, 0, 'and it is a real measured answer, not a failure row')

  const nothingToAsk = routedClient({
    planner: () => Promise.reject(new Error('The perception planner returned invalid JSON.')),
  }).client
  await createGeminiValPerceptionProbe({ apiKey: 'k', client: nothingToAsk as never }).probe({
    domain: 'example.com',
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput).then(
    () => {
      throw new Error('expected the phase to fail when there is nothing to probe')
    },
    (error: unknown) => {
      assert(error instanceof Error, 'expected an Error')
    },
  )
})

test('a failed probe is unmeasured, and its safe message is the runner classifier copy', async () => {
  // One question is rate-limited on BOTH its attempt and its retry, so exactly
  // one check fails whichever order the wave runs in.
  const routed = routedClient({
    probe: (query) =>
      query === 'is Example Co legit?'
        ? Promise.reject(Object.assign(new Error('429 rate limited'), { status: 429 }))
        : Promise.resolve(probeResponse()),
  })
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: routed.client as never }).probe({
    domain: 'example.com',
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  const failed = present(report.evidence.find((row) => row.error !== null))
  equal(failed.verdict, null, 'a failed check has no verdict; it is not "took no position"')
  equal(failed.answerText, null)
  equal(failed.retrievalStatus, 'error')
  deepEqual(failed.evidenceSentences, [])
  equal(failed.error, 'The provider rate-limited this request.', 'classified copy, never a provider body')
  equal(report.summary.successfulChecks, 2)
  equal(report.summary.failedChecks, 1)
  // 1 planner + 2 attempts at the failing question + 2 answered questions + 1
  // verdict. The retry is spent inside the probe's own deadline, so a transient
  // blip costs an attempt rather than an answer.
  equal(routed.calls.length, 6)
})

test('an extraction failure leaves every verdict unmeasured, and the answers still stand', async () => {
  const client = routedClient({ verdict: () => Promise.reject(new Error('503 unavailable')) }).client
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: client as never }).probe({
    domain: 'example.com',
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  deepEqual(report.evidence.map((row) => row.verdict), [null, null, null], 'unmeasured, never "none"')
  equal(report.summary.successfulChecks, 0)
  equal(report.summary.failedChecks, 3)
  // The answers themselves were measured and are still shown; only the position
  // is missing.
  assert(report.evidence.every((row) => row.answerText === ANSWER), 'the prose survives an extraction outage')
})

test('sources arrive typed, and grounding is derived from what the response carried', async () => {
  const { client } = scriptedClient()
  const report = await createGeminiValPerceptionProbe({ apiKey: 'k', client: client as never }).probe({
    domain: 'example.com',
    maxProbeCalls: 3,
    signal: AbortSignal.timeout(5_000),
  } as PerceptionProbeInput)

  const first = present(report.evidence[0])
  deepEqual(
    first.sources.map((source) => [source.domain, source.type]),
    [['example.com', 'official'], ['reddit.com', 'community']],
    'the brand own page and a forum thread, typed and one per URL',
  )
  equal(first.retrievalStatus, 'grounded')
  deepEqual(first.searchQueries, ['Example Co reviews'])
  deepEqual(first.evidenceSentences, ['Example Co is well regarded by small teams.'], 'copied out of the answer')
  deepEqual(first.concerns, ['slow support'])
  const shares = report.summary.sourceTypes
  assert(shares !== null, 'three answers attributed sources')
  equal(shares.measuredAnswers, 3)
  equal(shares.entries.reduce((sum, entry) => sum + entry.share, 0), 1)
})
