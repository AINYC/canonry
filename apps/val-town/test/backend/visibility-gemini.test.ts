import type { GenerateContentParameters, GenerateContentResponse } from 'npm:@google/genai@1.46.0'
import type { VisibilityProbeInput } from '../../src/runtime/types.ts'
import type { GeminiContentClient } from '../../src/visibility/gemini.ts'
import {
  buildPlannerPrompt,
  createGeminiVisibilityQueryPlanner,
  extractGroundedSources,
  normalizeGeminiVisibilityResponse,
  parseGeminiQueryPlan,
} from '../../src/visibility/gemini.ts'
import { createGeminiValVisibilityProbe, VAL_TOWN_GEMINI_VISIBILITY_LIMITS } from '../../src/visibility/gemini-probe.ts'
import { runVisibilityProbe } from '../../src/visibility/runner.ts'

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

Deno.test('normalizes only supported Gemini grounding chunks without retaining a raw response', () => {
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

Deno.test('turns a safety or no-candidate Gemini response into an invalid, null observation', async () => {
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

Deno.test('keeps opaque Gemini redirects as evidence without attributing the provider host', async () => {
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

Deno.test('planner accepts only complete non-brand buyer query plans', () => {
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

Deno.test('planner parser rejects an incomplete three-query plan', () => {
  try {
    parseGeminiQueryPlan({
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
  } catch (error) {
    if (error instanceof Error && error.message.includes('did not return 3 non-brand buyer queries')) return
    throw error
  }
  throw new Error('expected an incomplete plan to be rejected')
})

Deno.test('domain-only planning requests grounded unstructured JSON and returns three valid queries', async () => {
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

Deno.test('the Val host fixes one planner, three probes, one extraction, a single probe wave, and zero retries', async () => {
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
  // One planner, three probes, one brand extraction. The first probe is a
  // retryable 429, so a SIXTH call would prove the public billing limits were
  // no longer fixed. This is the number that changes when a feature adds a
  // provider call, and it is meant to be noticed when it does.
  equal(calls.length, 5)
  deepEqual(
    {
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      evidenceCount: report.evidence.length,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
    },
    { successfulChecks: 2, failedChecks: 1, evidenceCount: 3, mentionRate: 1, citationRate: 1 },
  )
})
