import { runVisibilityProbe } from '../../src/visibility/runner.ts'
import { publicProbeError, visibilityPhaseError } from '../../src/jobs/public-check.ts'
import type { VisibilityProviderAdapter, VisibilityProviderResponse } from '../../src/visibility/contracts.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const GENERIC = 'This answer-engine check was unavailable.'

function adapter(execute: VisibilityProviderAdapter['execute']): VisibilityProviderAdapter {
  return { name: 'gemini', requestedModel: 'gemini-test', execute }
}

const answer = (over: Partial<VisibilityProviderResponse> = {}): VisibilityProviderResponse => ({
  requestedModel: 'gemini-test',
  servedModel: 'gemini-test',
  answerText: 'An answer.',
  sources: [],
  searchQueries: [],
  retrievalStatus: 'used',
  ...over,
})

/** Run one query through the real runner and return the message it classified. */
async function failureMessage(
  execute: VisibilityProviderAdapter['execute'],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const report = await runVisibilityProbe({
    target: { canonicalDomain: 'example.com', brandNames: ['Example'] },
    queries: [{ id: 'q1', text: 'a question' }],
    adapters: [adapter(execute)],
    signal: options.signal,
    limits: { maxQueries: 1, maxProviders: 1, maxConcurrency: 1, timeoutMs: options.timeoutMs ?? 16_000 },
  })
  const check = report.checks[0]
  assert(check, 'expected one check')
  assert(check.status === 'failed', `expected a failed check, got ${check.status}`)
  assert(check.error, 'a failed check must carry a classified failure')
  // A failed check is unmeasured. It must never be coerced into a negative.
  equal(check.mentioned, null, 'a failure is not a not-mentioned')
  equal(check.cited, null, 'a failure is not a not-cited')
  return check.error.message
}

const throwing = (message: string): VisibilityProviderAdapter['execute'] => () => Promise.reject(new Error(message))

/**
 * Each case runs the REAL classifier, so the left side is a message the runner
 * can actually produce rather than a string copied out of the sanitizer.
 */
const CASES: ReadonlyArray<{
  name: string
  run: () => Promise<string>
  expected: string
}> = [
  {
    name: 'rate limited',
    run: () => failureMessage(throwing('429 Too Many Requests for quota metric generate_requests')),
    expected: 'The answer engine rate-limited this check.',
  },
  {
    name: 'provider down',
    run: () => failureMessage(throwing('503 Service Unavailable')),
    expected: 'The answer engine was temporarily unavailable.',
  },
  {
    name: 'bad credentials',
    run: () => failureMessage(throwing('API key not valid. Please pass a valid API key.')),
    expected: 'This check could not be authorized with the answer engine.',
  },
  {
    name: 'unclassifiable provider error',
    run: () => failureMessage(throwing('socket hang up while reading response body')),
    expected: 'The answer engine did not return an answer.',
  },
  {
    name: 'empty answer',
    run: () => failureMessage(() => Promise.resolve(answer({ answerText: '   ' }))),
    expected: 'The answer engine returned no answer text.',
  },
  {
    name: 'unusable model id',
    run: () => failureMessage(() => Promise.resolve(answer({ requestedModel: '' }))),
    expected: 'The answer engine reported an unusable model.',
  },
  {
    name: 'cancelled',
    run: () => failureMessage(throwing('unused'), { signal: AbortSignal.abort() }),
    expected: 'This check was cancelled before the answer engine replied.',
  },
  {
    name: 'timed out',
    run: () =>
      failureMessage(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted by deadline')))
          }),
        { timeoutMs: 1_000 },
      ),
    expected: 'The answer engine did not respond in time.',
  },
]

for (const testCase of CASES) {
  Deno.test(`a ${testCase.name} failure reaches the visitor as a reason`, async () => {
    const message = await testCase.run()
    equal(publicProbeError(message), testCase.expected, `${testCase.name} lost its reason`)
  })
}

Deno.test('no failure the runner can produce falls back to the generic sentence', async () => {
  // The guard, not a restatement of the cases above: a new failure mode added
  // upstream reaches the visitor as "This answer-engine check was unavailable."
  // and the reason is gone, because nothing is logged either. This fails when
  // that happens instead of leaving a row nobody can explain afterwards.
  for (const testCase of CASES) {
    const message = await testCase.run()
    assert(
      publicProbeError(message) !== GENERIC,
      `the runner emits "${message}" with no public translation, so its reason is destroyed`,
    )
  }
})

Deno.test('an unknown message is replaced, never published', () => {
  // The sanitizer does not trust its input: an adapter that one day puts a
  // transport dump in the message must not reach the durable public record.
  equal(
    publicProbeError('x-request-id 8f21 key=AIzaSyD… POST https://internal/v1beta/models'),
    GENERIC,
  )
  equal(publicProbeError(null), null, 'a check that did not fail carries no error')
})

Deno.test('the banner states the reason when the failures agree on one', async () => {
  const { toCanonryDemoViewModel } = await import('../../src/ui/from-check-record.ts')
  const row = (error: string | null) => ({
    query: 'q',
    provider: 'gemini',
    requestedModel: 'm',
    servedModel: error ? null : 'm',
    completedAt: '2026-09-01T00:00:00.000Z',
    answerText: error ? null : 'text',
    mentioned: error ? null : false,
    matchedTerms: [],
    cited: error ? null : false,
    citedDomains: [],
    citedUrls: [],
    matchedCitationDomains: [],
    matchedCitationUrls: [],
    sources: [],
    searchQueries: [],
    namedBrands: null,
    retrievalStatus: error ? 'error' : 'grounded',
    error,
  })
  const build = (errors: Array<string | null>) =>
    toCanonryDemoViewModel(
      {
        id: '11111111-2222-4333-8444-555555555555',
        fingerprint: 'f',
        userQueries: [],
        domain: 'example.com',
        status: 'complete',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: null,
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseUntil: null,
        result: {
          schemaVersion: '1.0',
          domain: 'example.com',
          generatedAt: '2026-09-01T00:00:00.000Z',
          errors: [],
          siteHealth: null,
          visibility: {
            schemaVersion: '1',
            domain: 'example.com',
            startedAt: '2026-09-01T00:00:00.000Z',
            completedAt: '2026-09-01T00:00:10.000Z',
            summary: {
              successfulChecks: 1,
              failedChecks: errors.filter(Boolean).length,
              mentionRate: 0,
              citationRate: 0,
            },
            evidence: [row(null), ...errors.map(row)],
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any,
    ).visibility?.notice?.detail ?? ''

  const single = build(['The answer engine did not respond in time.'])
  assert(single.startsWith('The answer engine did not respond in time. '), `reason must lead: ${single}`)
  assert(single.includes('completed checks only'), 'the denominator note stays')

  // Two different reasons: the banner cannot name one without being wrong about
  // the other, so it says nothing and the per-row evidence carries each.
  const mixed = build([
    'The answer engine did not respond in time.',
    'The answer engine rate-limited this check.',
  ])
  equal(mixed, 'Mention and citation rates use completed checks only.')

  // Every check stored before the sanitizer kept a reason carries the generic
  // sentence, which is the absence of one. Leading with it read as
  // "1 check unavailable. This answer-engine check was unavailable."
  equal(build([GENERIC]), 'Mention and citation rates use completed checks only.')
})

Deno.test('a phase that never produced a row still says why', () => {
  // The per-ROW reason was preserved but the per-PHASE one was not, so a
  // visibility phase that threw before a single probe ran reported only "The
  // AI Visibility sample could not complete." — with no evidence rows to carry
  // a reason either, that check was unexplainable from any surface.
  const generic = 'The AI Visibility sample could not complete.'

  // Provider failures arrive as thrown Errors and go through the same
  // classifier the row path uses, so the two cannot describe one outage
  // differently.
  equal(
    visibilityPhaseError(new Error('429 Too Many Requests for quota metric generate_requests')),
    'The answer engine rate-limited this check.',
  )
  equal(
    visibilityPhaseError(new Error('503 Service Unavailable')),
    'The answer engine was temporarily unavailable.',
  )
  equal(
    visibilityPhaseError(new Error('API key not valid. Please pass a valid API key.')),
    'This check could not be authorized with the answer engine.',
  )

  // A planning failure is a fact about the DOMAIN, not about the engine, and
  // the two are the difference between "try again" and "this will not work".
  equal(
    visibilityPhaseError(new Error('The query planner returned invalid JSON.')),
    'Questions could not be generated for this domain.',
  )
  equal(
    visibilityPhaseError(new Error('The query planner did not return 2 non-brand buyer queries.')),
    'Questions could not be generated for this domain.',
  )

  // A deadline is its own state, distinct from a provider refusing.
  equal(
    visibilityPhaseError(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })),
    'The AI Visibility sample timed out.',
  )

  // And the sanitizer still refuses to publish anything it does not recognize.
  equal(visibilityPhaseError(new Error('x-request-id 8f21 POST https://internal/v1beta/models')), generic)
  equal(visibilityPhaseError('a bare string, not an Error'), generic)
})
