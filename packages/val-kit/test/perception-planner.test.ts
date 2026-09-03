import { test } from 'vitest'
import type { GenerateContentResponse } from '@google/genai'
import { buildPerceptionPlanPrompt, createGeminiPerceptionPlanner } from '../src/perception/planner.js'

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

function planResponse(body: unknown): GenerateContentResponse {
  return {
    modelVersion: 'gemini-2.5-flash',
    candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
  } as unknown as GenerateContentResponse
}

function stubClient(responses: Array<() => Promise<GenerateContentResponse>>) {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    client: {
      models: {
        generateContent(params: Record<string, unknown>) {
          calls.push(params)
          const next = responses[calls.length - 1] ?? responses[responses.length - 1]
          return present(next, 'the stub ran out of responses')()
        },
      },
    },
  }
}

test('a generated question that does not name the brand is dropped', async () => {
  // The whole point of the instrument, and the exact inverse of the visibility
  // planner's `!detectMention(...)` filter. A question that never writes the
  // brand measures whether the engine VOLUNTEERS it, which is visibility; this
  // basket asks about the brand by name, so the two can never be pooled. The
  // prompt asks for branded questions; `detectMention` decides whether it got
  // them.
  const { calls, client } = stubClient([() =>
    Promise.resolve(planResponse({
      brandNames: ['Example Co'],
      queries: [
        'best AEO tools for startups',
        'is Example Co legit?',
        'what are the complaints about Example Co?',
      ],
    }))])
  const planner = createGeminiPerceptionPlanner({ apiKey: 'k', client: client as never, maxRetries: 0 })
  const plan = await planner.plan({ canonicalDomain: 'example.com', maxQueries: 3 })

  equal(calls.length, 1)
  deepEqual(plan.queries.map((query) => query.text), [
    'is Example Co legit?',
    'what are the complaints about Example Co?',
  ], 'only the branded questions survive')
  deepEqual(plan.target, { canonicalDomain: 'example.com', brandNames: ['Example Co'] })
})

test('a question that writes the domain counts as naming the brand', async () => {
  const { client } = stubClient([() =>
    Promise.resolve(planResponse({ brandNames: [], queries: ['is example.com trustworthy?'] }))])
  const planner = createGeminiPerceptionPlanner({ apiKey: 'k', client: client as never, maxRetries: 0 })
  const plan = await planner.plan({ canonicalDomain: 'example.com', maxQueries: 3 })

  deepEqual(plan.queries.map((query) => query.text), ['is example.com trustworthy?'])
})

test('fewer branded questions than requested is a smaller sample, and zero is a failure', async () => {
  // Same rule as the visibility planner, for the same reason: demanding an
  // EXACT count meant two usable questions out of three destroyed the whole
  // phase and the reader got nothing instead of two answers.
  const fewer = stubClient([() =>
    Promise.resolve(planResponse({
      brandNames: ['Example Co'],
      queries: ['Example Co reviews', 'best tools in this category'],
    }))])
  const fewerPlan = await createGeminiPerceptionPlanner({ apiKey: 'k', client: fewer.client as never, maxRetries: 0 })
    .plan({ canonicalDomain: 'example.com', maxQueries: 3 })
  equal(fewerPlan.queries.length, 1, 'one usable question is still a plan')

  const none = stubClient([() =>
    Promise.resolve(planResponse({
      brandNames: ['Example Co'],
      queries: ['best AEO tools', 'how does answer engine optimization work'],
    }))])
  await createGeminiPerceptionPlanner({ apiKey: 'k', client: none.client as never, maxRetries: 0 })
    .plan({ canonicalDomain: 'example.com', maxQueries: 3 })
    .then(
      () => {
        throw new Error('a plan with no branded question must fail: there is nothing to ask')
      },
      (error: unknown) => {
        assert(error instanceof Error, 'expected an Error')
        equal(error.message, 'The perception planner did not return any branded questions.')
      },
    )
})

test('duplicate and oversize questions are removed before the branded filter counts them', async () => {
  const { client } = stubClient([() =>
    Promise.resolve(planResponse({
      brandNames: ['Example Co'],
      queries: [
        'Is Example Co legit?',
        'is   example co   LEGIT?',
        `Example Co ${'x'.repeat(600)}`,
        'Example Co reviews',
      ],
    }))])
  const plan = await createGeminiPerceptionPlanner({ apiKey: 'k', client: client as never, maxRetries: 0 })
    .plan({ canonicalDomain: 'example.com', maxQueries: 3 })

  deepEqual(plan.queries.map((query) => query.text), ['Is Example Co legit?', 'Example Co reviews'])
})

test('the planner grounds its research, constrains nothing, and spends no tokens thinking', async () => {
  const { calls, client } = stubClient([() =>
    Promise.resolve(planResponse({ brandNames: ['Example Co'], queries: ['Example Co reviews'] }))])
  await createGeminiPerceptionPlanner({ apiKey: 'k', client: client as never, maxRetries: 0 })
    .plan({ canonicalDomain: 'example.com', maxQueries: 3 })

  const call = present(calls[0])
  const config = call.config as Record<string, unknown>
  deepEqual(config.tools, [{ googleSearch: {} }], 'grounding is how the planner learns what the company is called')
  // Gemini 2.5 refuses structured output alongside a built-in tool, so this
  // call hand-parses a fence instead.
  equal('responseSchema' in config, false)
  const thinking = config.thinkingConfig as { thinkingBudget?: number } | undefined
  equal(thinking?.thinkingBudget, 0, 'emitting a small JSON object needs no reasoning')
  assert(typeof call.contents === 'string', 'expected a text prompt')
  assert(call.contents.includes('Every question must write the company name.'), 'the prompt asks for branded questions')
})

test('one transient failure does not cost the plan', async () => {
  // Planning is the single point whose failure can cost the whole phase, so it
  // retries once INSIDE the deadline it already holds — an attempt, not extra
  // budget.
  const { calls, client } = stubClient([
    () => Promise.reject(Object.assign(new Error('429 rate limited'), { status: 429 })),
    () => Promise.resolve(planResponse({ brandNames: ['Example Co'], queries: ['Example Co reviews'] })),
  ])
  const plan = await createGeminiPerceptionPlanner({ apiKey: 'k', client: client as never })
    .plan({ canonicalDomain: 'example.com', maxQueries: 3 })

  equal(calls.length, 2, 'one retry, and only one')
  equal(present(plan.queries[0]).text, 'Example Co reviews')
})

test('the prompt names the branded shapes it wants and never asks for a score', () => {
  const prompt = buildPerceptionPlanPrompt({ canonicalDomain: 'example.com', maxQueries: 3 })
  assert(prompt.includes('exactly 3 questions'), 'the count is stated')
  assert(prompt.includes('is <brand> legit?'), 'the shapes are examples, not a schema')
  assert(prompt.includes('Domain: example.com'), 'the domain is stated')
  assert(!/score|sentiment|rating/i.test(prompt), 'nothing here asks a model to rate a brand')
})
