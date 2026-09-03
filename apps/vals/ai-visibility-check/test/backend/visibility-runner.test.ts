import type { VisibilityProviderAdapter } from '../../src/visibility/contracts.ts'
import { runVisibilityProbe } from '../../src/visibility/runner.ts'

const clock = () => new Date('2026-09-01T12:00:00.000Z')
const target = { canonicalDomain: 'example.com', brandNames: ['Example Co'] }

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

async function rejects(operation: () => Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) return
    throw error
  }
  throw new Error(`expected rejection containing: ${expectedMessage}`)
}

function adapter(name: string, execute: VisibilityProviderAdapter['execute']): VisibilityProviderAdapter {
  return { name, requestedModel: `${name}-model`, execute }
}

Deno.test('keeps answer mentions and source citations as independent evidence signals', async () => {
  const report = await runVisibilityProbe({
    target,
    queries: [{ id: 'q1', text: 'best answer engine optimization tools' }],
    adapters: [
      adapter('mention-only', () =>
        Promise.resolve({
          requestedModel: 'mention-only-model',
          answerText: 'Example Co is a useful option, according to a market overview.',
          sources: [{ url: 'https://publisher.test/overview', title: 'Overview' }],
        })),
      adapter('citation-only', () =>
        Promise.resolve({
          requestedModel: 'citation-only-model',
          answerText: 'Several vendors compete in this category.',
          sources: [{ url: 'https://blog.example.com/research', title: 'Research' }],
        })),
    ],
    now: clock,
  })

  const mentionOnly = present(report.checks[0])
  const citationOnly = present(report.checks[1])
  equal(report.status, 'completed')
  deepEqual(
    { mentioned: mentionOnly.mentioned, cited: mentionOnly.cited, matchedTerms: mentionOnly.matchedTerms },
    { mentioned: true, cited: false, matchedTerms: ['Example Co'] },
  )
  deepEqual(
    {
      mentioned: citationOnly.mentioned,
      cited: citationOnly.cited,
      matchedCitationUrls: citationOnly.matchedCitationUrls,
    },
    { mentioned: false, cited: true, matchedCitationUrls: ['https://blog.example.com/research'] },
  )
  deepEqual(
    {
      totalChecks: report.summary.totalChecks,
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
    },
    { totalChecks: 2, successfulChecks: 2, failedChecks: 0, mentionRate: 0.5, citationRate: 0.5 },
  )
})

Deno.test('keeps failed checks null and excludes them from mention and citation denominators', async () => {
  const report = await runVisibilityProbe({
    target,
    queries: [{ id: 'q1', text: 'best answer engine optimization tools' }],
    adapters: [
      adapter(
        'good',
        () => Promise.resolve({ requestedModel: 'good-model', answerText: 'Example Co appears in the answer.' }),
      ),
      adapter('bad', () => Promise.reject(new Error('credential=very-secret-value response body=not for output'))),
    ],
    now: clock,
  })

  const failed = present(report.checks[1])
  equal(report.status, 'partial')
  deepEqual(
    { status: failed.status, mentioned: failed.mentioned, cited: failed.cited, error: failed.error },
    {
      status: 'failed',
      mentioned: null,
      cited: null,
      error: { code: 'provider-error', message: 'The provider request failed.' },
    },
  )
  equal(JSON.stringify(report).includes('very-secret-value'), false)
  deepEqual(
    {
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
    },
    { successfulChecks: 1, failedChecks: 1, mentionRate: 1, citationRate: 0 },
  )
})

Deno.test('treats blank provider answers as invalid observations instead of negative results', async () => {
  const report = await runVisibilityProbe({
    target,
    queries: [{ id: 'q1', text: 'best answer engine optimization tools' }],
    adapters: [adapter('blank', () => Promise.resolve({ requestedModel: 'blank-model', answerText: ' \n\t ' }))],
    now: clock,
  })

  const check = present(report.checks[0])
  deepEqual(
    {
      status: report.status,
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      mentionRate: report.summary.mentionRate,
      citationRate: report.summary.citationRate,
      check: {
        status: check.status,
        answerText: check.answerText,
        mentioned: check.mentioned,
        cited: check.cited,
        error: check.error,
      },
    },
    {
      status: 'failed',
      successfulChecks: 0,
      failedChecks: 1,
      mentionRate: null,
      citationRate: null,
      check: {
        status: 'failed',
        answerText: null,
        mentioned: null,
        cited: null,
        error: { code: 'invalid-response', message: 'The provider response contained no answer text.' },
      },
    },
  )
})

Deno.test('turns pre-aborted provider work into a failed null observation', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('stop', 'AbortError'))
  let calls = 0
  const report = await runVisibilityProbe({
    target,
    queries: [{ id: 'q1', text: 'best answer engine optimization tools' }],
    adapters: [adapter('never-called', () => {
      calls += 1
      return Promise.resolve({ requestedModel: 'never-called-model', answerText: 'This should not run.' })
    })],
    signal: controller.signal,
    now: clock,
  })

  const check = present(report.checks[0])
  equal(calls, 0)
  deepEqual(
    {
      status: report.status,
      successfulChecks: report.summary.successfulChecks,
      failedChecks: report.summary.failedChecks,
      mentioned: check.mentioned,
      cited: check.cited,
      error: check.error,
    },
    {
      status: 'failed',
      successfulChecks: 0,
      failedChecks: 1,
      mentioned: null,
      cited: null,
      error: { code: 'aborted', message: 'The provider request was cancelled.' },
    },
  )
})

Deno.test('bounds public query, provider, and model identities', async () => {
  await rejects(
    () =>
      runVisibilityProbe({
        target,
        queries: [{ text: 'q'.repeat(513) }],
        adapters: [
          adapter('safe', () => Promise.resolve({ requestedModel: 'safe-model', answerText: 'A useful answer.' })),
        ],
      }),
    'query 1 must be at most 512 characters',
  )
  await rejects(
    () =>
      runVisibilityProbe({
        target,
        queries: [{ id: 'q'.repeat(161), text: 'best answer engine optimization tools' }],
        adapters: [
          adapter('safe', () => Promise.resolve({ requestedModel: 'safe-model', answerText: 'A useful answer.' })),
        ],
      }),
    'query 1 ID must be at most 160 characters',
  )
  await rejects(
    () =>
      runVisibilityProbe({
        target,
        queries: [{ text: 'best answer engine optimization tools' }],
        adapters: [adapter('p'.repeat(81), () =>
          Promise.resolve({ requestedModel: 'safe-model', answerText: 'A useful answer.' }))],
      }),
    'provider adapter names must be at most 80 characters',
  )

  const invalidRequestedModel = await runVisibilityProbe({
    target,
    queries: [{ text: 'best answer engine optimization tools' }],
    adapters: [adapter('configured', () =>
      Promise.resolve({
        requestedModel: 'm'.repeat(257),
        answerText: 'A useful answer.',
      }))],
    now: clock,
  })
  const invalidCheck = present(invalidRequestedModel.checks[0])
  deepEqual(
    {
      status: invalidCheck.status,
      requestedModel: invalidCheck.requestedModel,
      mentioned: invalidCheck.mentioned,
      error: invalidCheck.error,
    },
    {
      status: 'failed',
      requestedModel: 'configured-model',
      mentioned: null,
      error: { code: 'invalid-response', message: 'The provider response has an invalid requested model.' },
    },
  )
  equal(JSON.stringify(invalidRequestedModel).includes('m'.repeat(200)), false)

  const oversizedServedModel = await runVisibilityProbe({
    target,
    queries: [{ text: 'best answer engine optimization tools' }],
    adapters: [adapter('served-model', () =>
      Promise.resolve({
        requestedModel: 'compact-model',
        servedModel: 's'.repeat(257),
        answerText: 'A useful answer.',
      }))],
    now: clock,
  })
  deepEqual(
    {
      status: present(oversizedServedModel.checks[0]).status,
      servedModel: present(oversizedServedModel.checks[0]).servedModel,
    },
    { status: 'success', servedModel: null },
  )
  equal(JSON.stringify(oversizedServedModel).includes('s'.repeat(200)), false)
})

Deno.test('clips every public citation URL and retains a target match before source caps', async () => {
  const longTargetUrl = `https://docs.example.com/${'x'.repeat(5_000)}`
  const report = await runVisibilityProbe({
    target,
    queries: [{ id: 'q1', text: 'best answer engine optimization tools' }],
    adapters: [adapter('bounded', () =>
      Promise.resolve({
        requestedModel: 'bounded-model',
        answerText: 'No explicit brand prose.',
        sources: [
          { url: 'https://publisher.test/first', title: 'Other source' },
          { url: longTargetUrl, title: 'Very long target URL' },
        ],
      }))],
    limits: { maxSources: 1, maxSourceUrlChars: 128 },
    now: clock,
  })

  const check = present(report.checks[0])
  equal(check.cited, true)
  equal(check.sources.length, 1)
  equal(present(check.sources[0]).targetDomainMatch, true)
  equal(present(check.sources[0]).url.length, 128)
  equal(present(check.citedUrls[0]).length, 128)
  equal(present(check.matchedCitationUrls[0]).length, 128)
  equal(JSON.stringify(check).includes('x'.repeat(300)), false)
})

Deno.test('does not match a domain label as prose or an alias as a substring', async () => {
  const report = await runVisibilityProbe({
    target: { canonicalDomain: 'best.example', brandNames: ['Acme'] },
    queries: [{ text: 'best tools' }],
    adapters: [adapter('exact', () =>
      Promise.resolve({
        requestedModel: 'exact-model',
        answerText: 'Acmeology recommends the best tools for a small team.',
      }))],
    now: clock,
  })

  const check = present(report.checks[0])
  deepEqual({ mentioned: check.mentioned, cited: check.cited, matchedTerms: check.matchedTerms }, {
    mentioned: false,
    cited: false,
    matchedTerms: [],
  })
})

Deno.test('counts an explicit written canonical domain as an answer mention', async () => {
  const report = await runVisibilityProbe({
    target: { canonicalDomain: 'best.example', brandNames: [] },
    queries: [{ text: 'best tools' }],
    adapters: [adapter('written-domain', () =>
      Promise.resolve({
        requestedModel: 'written-domain-model',
        answerText: 'best.example is one option for a small team.',
      }))],
    now: clock,
  })

  const check = present(report.checks[0])
  deepEqual(
    { mentioned: check.mentioned, cited: check.cited, matchedTerms: check.matchedTerms },
    { mentioned: true, cited: false, matchedTerms: ['best.example'] },
  )
})
