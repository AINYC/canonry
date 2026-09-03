import { test } from 'vitest'
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import type { VisibilityProbeInput } from '../src/runtime/types.js'
import type { GeminiContentClient } from '../src/visibility/gemini.js'
import {
  buildPlannerPrompt,
  createGeminiVisibilityAdapter,
  createGeminiVisibilityQueryPlanner,
  extractGroundedSources,
  normalizeGeminiVisibilityResponse,
  parseGeminiQueryPlan,
  PROBE_THINKING_BUDGET_TOKENS,
} from '../src/visibility/gemini.js'
import { DEFAULT_VISIBILITY_PROBE_LIMITS } from '../src/visibility/contracts.js'
import { createGeminiBrandExtractor } from '../src/visibility/mention-extract.js'
import { createGeminiValVisibilityProbe, VAL_TOWN_GEMINI_VISIBILITY_LIMITS } from '../src/visibility/gemini-probe.js'
import { runVisibilityProbe } from '../src/visibility/runner.js'

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

function present<T>(value: T | undefined, message = 'expected a value'): T {
  if (value === undefined) throw new Error(message)
  return value
}

function responseFixture(): GenerateContentResponse {
  return {
    modelVersion: 'gemini-2.5-flash-served',
    candidates: [{
      content: { parts: [{ text: 'A concise answer.' }] },
      groundingMetadata: {
        webSearchQueries: ['best aeo software'],
        groundingChunks: [
          { web: { uri: 'https://unused.test/a', title: 'Unused' } },
          { web: { uri: 'https://www.example.com/guide', title: 'Example guide' } },
        ],
        groundingSupports: [{ groundingChunkIndices: [1] }],
      },
    }],
  } as unknown as GenerateContentResponse
}

test('normalizes only supported Gemini grounding chunks without retaining a raw response', () => {
  const normalized = normalizeGeminiVisibilityResponse(responseFixture(), 'gemini-2.5-flash')

  deepEqual(normalized, {
    requestedModel: 'gemini-2.5-flash',
    servedModel: 'gemini-2.5-flash-served',
    answerText: 'A concise answer.',
    sources: [{ url: 'https://www.example.com/guide', title: 'Example guide' }],
    searchQueries: ['best aeo software'],
    retrievalStatus: 'unknown',
  })
  equal(extractGroundedSources(responseFixture()).length, 1)
})

test('turns a safety or no-candidate Gemini response into an invalid, null observation', async () => {
  const normalized = normalizeGeminiVisibilityResponse({
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: [],
  } as unknown as GenerateContentResponse, 'gemini-2.5-flash')
  equal(normalized.answerText, '')

  const report = await runVisibilityProbe({
    target: { canonicalDomain: 'example.com', brandNames: ['Example'] },
    queries: [{ text: 'best tools' }],
    adapters: [{ name: 'gemini-fixture', execute: () => Promise.resolve(normalized) }],
  })
  const check = present(report.checks[0])
  deepEqual(
    {
      status: report.status,
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
      check: { status: check.status, mentioned: check.mentioned, cited: check.cited, error: check.error },
    },
    {
      status: 'failed',
      successfulChecks: 0,
      failedChecks: 1,
      mentionRate: null,
      citationRate: null,
      check: {
        status: 'failed',
        mentioned: null,
        cited: null,
        error: { code: 'invalid-response', message: 'The provider response contained no answer text.' },
      },
    },
  )
})

test('keeps opaque Gemini redirects as evidence without attributing the provider host', async () => {
  const opaque = (title: string): GenerateContentResponse => ({
    candidates: [{
      groundingMetadata: {
        groundingChunks: [{
          web: {
            uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token',
            title,
          },
        }],
      },
    }],
  } as unknown as GenerateContentResponse)
  const titledDomain = present(extractGroundedSources(opaque('example.com'))[0])
  const titledProse = present(extractGroundedSources(opaque('Example guide'))[0])
  equal(titledDomain.domain, 'example.com')
  equal(titledProse.domain, null)

  const citedReport = await runVisibilityProbe({
    target: { canonicalDomain: 'example.com', brandNames: ['Example'] },
    queries: [{ text: 'best tools' }],
    adapters: [{
      name: 'gemini-fixture',
      execute: () =>
        Promise.resolve({ requestedModel: 'fixture', answerText: 'A grounded answer.', sources: [titledDomain] }),
    }],
  })
  const notCitedReport = await runVisibilityProbe({
    target: { canonicalDomain: 'example.com', brandNames: ['Example'] },
    queries: [{ text: 'best tools' }],
    adapters: [{
      name: 'gemini-fixture',
      execute: () =>
        Promise.resolve({ requestedModel: 'fixture', answerText: 'A grounded answer.', sources: [titledProse] }),
    }],
  })
  const cited = present(citedReport.checks[0])
  const notCited = present(notCitedReport.checks[0])
  deepEqual({ cited: cited.cited, sources: cited.sources }, {
    cited: true,
    sources: [{
      url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token',
      title: 'example.com',
      domain: 'example.com',
      targetDomainMatch: true,
    }],
  })
  deepEqual({ cited: notCited.cited, sources: notCited.sources }, {
    cited: false,
    sources: [{
      url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token',
      title: 'Example guide',
      domain: null,
      targetDomainMatch: false,
    }],
  })
})

test('planner accepts only complete non-brand buyer query plans', () => {
  const plan = parseGeminiQueryPlan({
    responseText: JSON.stringify({
      brandNames: ['Example Co', 'Example'],
      queries: [
        'What are the best answer engine optimization tools?',
        'How can a marketing team improve AI search citations?',
        'What are the best answer engine optimization tools?',
        'What does Example Co cost?',
        'How should a content team measure AI answer mentions?',
      ],
    }),
    target: { canonicalDomain: 'example.com', brandNames: ['Example Co'] },
    maxQueries: 3,
    requestedModel: 'gemini-2.5-flash',
    servedModel: 'gemini-2.5-flash-served',
    generatedAt: '2026-09-01T12:00:00.000Z',
  })

  deepEqual(plan.queries.map((query) => query.text), [
    'What are the best answer engine optimization tools?',
    'How can a marketing team improve AI search citations?',
    'How should a content team measure AI answer mentions?',
  ])
  deepEqual(plan.target.brandNames, ['Example Co', 'Example'])
  equal(plan.servedModel, 'gemini-2.5-flash-served')
  const prompt = buildPlannerPrompt({
    canonicalDomain: 'example.com',
    homepageContext: 'Example Co helps content teams.',
    maxQueries: 3,
  })
  equal(prompt.includes('Return JSON only'), true)
  equal(prompt.includes('exactly 3 non-brand buyer-intent queries'), true)
})

test('an incomplete plan is a smaller sample, not a failed check', () => {
  // Requiring an EXACT count meant a planner that produced two usable queries
  // out of three destroyed the whole visibility half of the report, and the
  // reader got nothing instead of two answers.
  const plan = parseGeminiQueryPlan({
    responseText: JSON.stringify({
      brandNames: ['Example Co'],
      queries: [
        'What are the best answer engine optimization tools?',
        'How can a marketing team improve AI search citations?',
      ],
    }),
    target: { canonicalDomain: 'example.com', brandNames: ['Example Co'] },
    maxQueries: 3,
    requestedModel: 'gemini-2.5-flash',
    servedModel: null,
    generatedAt: '2026-09-01T12:00:00.000Z',
  })
  equal(plan.queries.length, 2, 'two usable queries are two probes, not zero')
})

test('a plan with nothing to probe is still a failure', () => {
  // Zero is different in kind: there is no question to ask. The only query
  // here is branded, and a branded query hands the model the answer, so it is
  // dropped and nothing usable is left.
  try {
    parseGeminiQueryPlan({
      responseText: JSON.stringify({ brandNames: ['Example Co'], queries: ['what does Example Co do?'] }),
      target: { canonicalDomain: 'example.com', brandNames: ['Example Co'] },
      maxQueries: 3,
      requestedModel: 'gemini-2.5-flash',
      servedModel: null,
      generatedAt: '2026-09-01T12:00:00.000Z',
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('did not return any non-brand buyer queries')) return
    throw error
  }
  throw new Error('expected a plan with no usable query to be rejected')
})

test('domain-only planning requests grounded unstructured JSON and returns three valid queries', async () => {
  const calls: GenerateContentParameters[] = []
  const client: GeminiContentClient = {
    models: {
      generateContent(params) {
        calls.push(params)
        return Promise.resolve({
          modelVersion: 'gemini-planner-served',
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  brandNames: ['Example Co'],
                  queries: ['first buyer question', 'second buyer question', 'third buyer question'],
                }),
              }],
            },
          }],
        } as unknown as GenerateContentResponse)
      },
    },
  }
  const planner = createGeminiVisibilityQueryPlanner({ apiKey: 'test-key', client, maxRetries: 0 })
  const plan = await planner.plan({
    canonicalDomain: 'example.com',
    homepageContext: '',
    maxQueries: 3,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
  })

  const call = present(calls[0])
  const config = call.config as Record<string, unknown>
  equal(calls.length, 1)
  if (typeof call.contents !== 'string') throw new Error('expected the planner prompt to be text')
  equal(call.contents.includes('No homepage extract was provided'), true)
  deepEqual(config.tools, [{ googleSearch: {} }])
  equal(config.candidateCount, 1)
  equal(config.temperature, 0)
  equal('responseMimeType' in config, false)
  equal('responseSchema' in config, false)
  deepEqual(plan.queries.map((query) => query.text), [
    'first buyer question',
    'second buyer question',
    'third buyer question',
  ])
})

test('the Val host fixes one planner, three probes, one extraction, a single probe wave, and one retry', async () => {
  const calls: unknown[] = []
  const client: GeminiContentClient = {
    models: {
      generateContent(params) {
        calls.push(params)
        if (calls.length === 1) {
          return Promise.resolve({
            modelVersion: 'gemini-planner-served',
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    brandNames: ['Example Co'],
                    queries: ['first buyer query', 'second buyer query', 'third buyer query'],
                  }),
                }],
              },
            }],
          } as unknown as GenerateContentResponse)
        }
        if (calls.length === 2) {
          const error = Object.assign(new Error('429 rate limited'), { status: 429 })
          return Promise.reject(error)
        }
        return Promise.resolve({
          modelVersion: 'gemini-probe-served',
          candidates: [{
            content: { parts: [{ text: 'Example Co is an option.' }] },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: 'https://example.com/', title: 'Example Co' } }],
            },
          }],
        } as unknown as GenerateContentResponse)
      },
    },
  }
  const probe = createGeminiValVisibilityProbe({ apiKey: 'test-key', client })
  const report = await probe.probe({
    domain: 'example.com',
    // Runtime callers cannot enlarge the public cap.
    maxPlannerCalls: 99,
    maxProbeCalls: 99,
    signal: AbortSignal.timeout(1_000),
  } as unknown as VisibilityProbeInput)

  deepEqual(VAL_TOWN_GEMINI_VISIBILITY_LIMITS, {
    maxPlannerCalls: 1,
    maxProbeCalls: 3,
    // One extra call reads the answers back for the brands they name, which is
    // the only way the mention basis can exist. See mention-extract.ts.
    maxExtractCalls: 1,
    plannerTimeoutMs: 10_000,
    // 20s per probe, and concurrency 3 so all three run in ONE wave. At
    // concurrency 2 the phase needed two waves and could spend 42s of the 45s
    // job budget, which is why the deadline was pinned at 10s and a slow
    // grounded answer failed every probe. See probe-budget.test.ts.
    probeTimeoutMs: 20_000,
    probeConcurrency: 3,
  })
  // One planner, three probes, one brand extraction, plus ONE retry: the first
  // probe answers a retryable 429 and is attempted again, which is the point of
  // the retry and is what turns a transient blip into an answer instead of a
  // lost row. A SEVENTH call would mean the retry budget grew past one.
  equal(calls.length, 6)
  deepEqual(
    {
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      evidenceCount: report.evidence.length,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
    },
    // The retryable 429 now succeeds on its second attempt, so the answer that
    // used to be lost is measured. This IS the fix: a transient blip cost a
    // third of the report before, and costs nothing now.
    { successfulChecks: 3, failedChecks: 0, evidenceCount: 3, mentionRate: 1, citationRate: 1 },
  )
})

test('a planning failure never discards questions the visitor typed', () => {
  // A real check produced ZERO evidence rows: the planner threw, and the whole
  // phase rejected with it. If the visitor supplied their own questions, those
  // are perfectly good probes — losing them because OUR generator hiccuped
  // hands back an empty report for work the visitor already specified.
  const calls: unknown[] = []
  const client = {
    models: {
      generateContent(params: unknown) {
        calls.push(params)
        // The planner is always the first call, and it fails outright.
        if (calls.length === 1) return Promise.reject(new Error('The query planner returned invalid JSON.'))
        return Promise.resolve({
          modelVersion: 'gemini-2.5-flash',
          candidates: [{ content: { parts: [{ text: 'Example Co is a good option.' }] } }],
        })
      },
    },
  }
  const probe = createGeminiValVisibilityProbe({ apiKey: 'test-key', client: client as never })
  return probe.probe({
    domain: 'example.com',
    userQueries: ['which tool tracks AI answer visibility'],
    signal: AbortSignal.timeout(5_000),
  } as unknown as VisibilityProbeInput).then((report) => {
    equal(report.evidence.length, 1, "the visitor's own question is still probed")
    equal(report.evidence[0]?.query, 'which tool tracks AI answer visibility')
    equal(report.summary.failedChecks, 0, 'and it is a real measured answer, not a failure row')
  })
})

test('a planning failure with nothing else to ask still fails', () => {
  // With no supplied question there is no probe to run, so the phase must
  // reject rather than report an empty success.
  const client = {
    models: {
      generateContent: () => Promise.reject(new Error('The query planner returned invalid JSON.')),
    },
  }
  const probe = createGeminiValVisibilityProbe({ apiKey: 'test-key', client: client as never })
  return probe.probe({ domain: 'example.com', signal: AbortSignal.timeout(5_000) } as unknown as VisibilityProbeInput)
    .then(
      () => {
        throw new Error('expected the phase to fail when there is nothing to probe')
      },
      (error: unknown) => {
        if (!(error instanceof Error)) throw new Error('expected an Error')
      },
    )
})

test('a probe caps its thinking so reasoning cannot starve the answer', () => {
  // A real check lost one of three answers to "returned no answer text".
  // Gemini 2.5 thinks by default and bills those tokens against the SAME
  // output allowance, so the model spent the budget reasoning and wrote
  // nothing. An empty answer is a lost measurement, and it looks exactly like
  // an engine that had nothing to say about the brand.
  const captured: Array<Record<string, unknown>> = []
  const client = {
    models: {
      generateContent(params: { config?: Record<string, unknown> }) {
        captured.push(params.config ?? {})
        return Promise.resolve({
          modelVersion: 'gemini-2.5-flash',
          candidates: [{ content: { parts: [{ text: 'An answer.' }] } }],
        })
      },
    },
  }
  const adapter = createGeminiVisibilityAdapter({ apiKey: 'test-key', client: client as never })
  return adapter.execute({
    query: { id: 'q1', text: 'a question' },
    target: { canonicalDomain: 'example.com', brandNames: [] },
    signal: AbortSignal.timeout(2_000),
    limits: DEFAULT_VISIBILITY_PROBE_LIMITS,
  }).then(() => {
    const config = captured[0]
    if (!config) throw new Error('the adapter must have issued a call')
    const thinking = config.thinkingConfig as { thinkingBudget?: number } | undefined
    equal(thinking?.thinkingBudget, PROBE_THINKING_BUDGET_TOKENS, 'thinking must be explicitly bounded')
    // Bounded, not disabled: this simulates an answer engine, and those reason.
    // `mention-extract.ts` sets 0 because copying names out needs no thought.
    if (PROBE_THINKING_BUDGET_TOKENS <= 0) throw new Error('a probe still gets to think')
    // And the cap has to leave the answer real room in the same allowance.
    if (PROBE_THINKING_BUDGET_TOKENS * 3 >= 2_400) {
      throw new Error(`thinking budget ${PROBE_THINKING_BUDGET_TOKENS} is too large a share of the output allowance`)
    }
  })
})

test('every Gemini call sets an explicit thinking budget', () => {
  // The same bug landed three times: the extractor, the probe adapter, and the
  // planner each spent their output allowance on thinking and returned empty
  // text. Gemini 2.5 thinks by DEFAULT and bills it from `maxOutputTokens`, so
  // "I forgot to set it" is the failure mode, and it presents as a lost answer
  // rather than as an error. A new call site cannot quietly inherit it.
  const seen: Array<{ label: string; config: Record<string, unknown> }> = []
  const clientFor = (label: string) => ({
    models: {
      generateContent(params: { config?: Record<string, unknown> }) {
        seen.push({ label, config: params.config ?? {} })
        return Promise.resolve({
          modelVersion: 'gemini-2.5-flash',
          candidates: [{
            content: {
              parts: [{
                text: label === 'planner'
                  ? JSON.stringify({ brandNames: ['Example'], queries: ['a buyer question'] })
                  : '{"answers":[]}',
              }],
            },
          }],
        })
      },
    },
  })

  const adapter = createGeminiVisibilityAdapter({ apiKey: 'k', client: clientFor('probe') as never })
  const planner = createGeminiVisibilityQueryPlanner({ apiKey: 'k', client: clientFor('planner') as never })
  const extractor = createGeminiBrandExtractor({ client: clientFor('extract') as never, model: 'gemini-2.5-flash' })

  return Promise.all([
    adapter.execute({
      query: { id: 'q1', text: 'a question' },
      target: { canonicalDomain: 'example.com', brandNames: [] },
      signal: AbortSignal.timeout(2_000),
      limits: DEFAULT_VISIBILITY_PROBE_LIMITS,
    }),
    planner.plan({ canonicalDomain: 'example.com', brandNames: [], maxQueries: 1 }),
    extractor.extract(['some answer text'], AbortSignal.timeout(2_000)),
  ]).then(() => {
    equal(seen.length, 3, 'all three call sites must have been exercised')
    for (const { label, config } of seen) {
      const thinking = config.thinkingConfig as { thinkingBudget?: number } | undefined
      if (typeof thinking?.thinkingBudget !== 'number') {
        throw new Error(`the ${label} call must set an explicit thinkingConfig.thinkingBudget`)
      }
      // And it has to leave room for the output it was asked to produce.
      const maxOutput = config.maxOutputTokens as number | undefined
      if (typeof maxOutput === 'number' && thinking.thinkingBudget >= maxOutput) {
        throw new Error(`the ${label} call lets thinking consume its entire ${maxOutput}-token allowance`)
      }
    }
  })
})
