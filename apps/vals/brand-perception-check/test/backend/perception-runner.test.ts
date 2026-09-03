/**
 * The runner's three jobs: decide a status, bound what reaches the durable
 * record, and preserve WHY something was not measured.
 *
 * The failure copy is driven through the REAL probe runner rather than through
 * strings copied out of the sanitizer, so the left-hand side of each case is a
 * message the engine can actually produce. That is the guard: a new failure mode
 * added upstream fails this suite instead of silently erasing its own reason.
 */
import {
  type CheckStore,
  createRequestBoundDispatcher,
  newCheckRecord,
} from 'npm:@canonry/val-kit@0.2.0/jobs'
import {
  type PerceptionEvidence,
  type PerceptionProbeInput,
  type PerceptionProbePort,
  type PerceptionReport,
  summarizePerception,
} from 'npm:@canonry/val-kit@0.2.0/perception'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.2.0/storage'
import {
  emptyAnswerReason,
  runVisibilityProbe,
  type VisibilityProviderAdapter,
  type VisibilityProviderResponse,
} from 'npm:@canonry/val-kit@0.2.0/visibility'
import {
  createPerceptionCheckRunner,
  perceptionPhaseError,
  publicProbeError,
} from '../../src/jobs/perception-check.ts'
import type { PerceptionCheckResult } from '../../src/runtime/check-result.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Indexed access under `noUncheckedIndexedAccess`: assert presence, then use it. */
function at<T>(items: readonly T[], index: number, message = 'missing element'): T {
  const value = items[index]
  if (value === undefined) throw new Error(`${message} at index ${index}`)
  return value
}

const GENERIC = 'This answer-engine check was unavailable.'
const NOW = new Date('2026-09-01T12:00:00.000Z')

function evidence(over: Partial<PerceptionEvidence> & Pick<PerceptionEvidence, 'query'>): PerceptionEvidence {
  return {
    provider: 'gemini',
    requestedModel: 'gemini-test',
    servedModel: 'gemini-test',
    completedAt: '2026-09-01T12:00:10.000Z',
    answerText: 'An answer about the brand.',
    verdict: 'none',
    evidenceSentences: [],
    concerns: [],
    sources: [],
    searchQueries: [],
    retrievalStatus: 'grounded',
    error: null,
    ...over,
  }
}

function report(rows: PerceptionEvidence[], domain = 'example.com'): PerceptionReport {
  return {
    schemaVersion: '1',
    domain,
    brandNames: ['Example'],
    startedAt: '2026-09-01T12:00:00.000Z',
    completedAt: '2026-09-01T12:00:30.000Z',
    // The REAL aggregation, so a fixture can never hand the runner a headline
    // its own rows do not support.
    summary: summarizePerception(rows),
    evidence: rows,
  }
}

function probePort(produce: (input: PerceptionProbeInput) => Promise<PerceptionReport>): PerceptionProbePort {
  return { probe: produce }
}

/** Run one check to completion and hand back the stored record. */
async function runCheck(
  perceptionProbe: PerceptionProbePort | null,
  domain = 'example.com',
): Promise<{ status: string; result: PerceptionCheckResult | null }> {
  const store: CheckStore<PerceptionCheckResult> = new MemoryCheckStore<PerceptionCheckResult>()
  await store.initialize()
  const record = newCheckRecord<PerceptionCheckResult>({
    id: crypto.randomUUID(),
    fingerprint: `perception-v1:${domain}`,
    domain,
    now: NOW,
  })
  await store.create(record)
  const runner = createPerceptionCheckRunner({ store, perceptionProbe, ttlMs: 86_400_000, now: () => NOW })
  await createRequestBoundDispatcher(runner).dispatch(record.id)
  const stored = await store.get(record.id)
  assert(stored, 'the check must still be stored')
  return { status: stored.status, result: stored.result }
}

Deno.test('a check where every answer was measured is complete', async () => {
  const rows = [evidence({ query: 'is Example legit?' }), evidence({ query: 'Example reviews' })]
  const { status, result } = await runCheck(probePort(() => Promise.resolve(report(rows))))
  equal(status, 'complete')
  equal(result?.perception?.summary.successfulChecks, 2)
  equal(result?.errors.length, 0)
})

Deno.test('a check with one unmeasured answer is partial, and keeps the measured ones', async () => {
  const rows = [
    evidence({ query: 'is Example legit?', verdict: 'recommends', evidenceSentences: ['Example is well regarded.'] }),
    evidence({ query: 'Example complaints', verdict: null, answerText: null, error: 'The provider request failed.' }),
  ]
  const { status, result } = await runCheck(probePort(() => Promise.resolve(report(rows))))
  equal(status, 'partial')
  equal(result?.perception?.summary.successfulChecks, 1)
  equal(result?.perception?.summary.failedChecks, 1)
  // The unmeasured row keeps a null verdict. Coercing it to 'none' would turn
  // an outage into a finding about the answer.
  equal(at(result!.perception!.evidence, 1).verdict, null)
})

Deno.test('a check where nothing was measured is failed, not a report full of zeroes', async () => {
  // Every denominator on the page would be zero. That is not a result with
  // empty sections; it is a check that produced no finding at all.
  const rows = [
    evidence({ query: 'is Example legit?', verdict: null, answerText: null, error: 'The provider request timed out.' }),
    evidence({ query: 'Example reviews', verdict: null, answerText: null, error: 'The provider request timed out.' }),
  ]
  const { status, result } = await runCheck(probePort(() => Promise.resolve(report(rows))))
  equal(status, 'failed')
  // The rows survive, so the page can still say why each one was not measured.
  equal(result?.perception?.evidence.length, 2)
  equal(at(result!.perception!.evidence, 0).error, 'The answer engine did not respond in time.')
})

Deno.test('a phase that threw produces a failed record carrying the reason', async () => {
  const { status, result } = await runCheck(
    probePort(() => Promise.reject(new Error('The perception planner did not return any branded questions.'))),
  )
  equal(status, 'failed')
  equal(result?.perception, null)
  equal(at(result!.errors, 0).area, 'perception')
  equal(at(result!.errors, 0).message, 'Branded questions could not be generated for this brand.')
})

Deno.test('a deployment with no answer engine says so, rather than blaming the engine', async () => {
  const { status, result } = await runCheck(null)
  equal(status, 'failed')
  equal(at(result!.errors, 0).message, 'The brand perception check is not configured for this demo.')
})

Deno.test('the sanitizer clips every unbounded field before it becomes a durable record', async () => {
  const rows = [evidence({
    query: 'is Example legit?',
    verdict: 'cautions',
    answerText: 'a'.repeat(5_000),
    evidenceSentences: ['b'.repeat(400), 'c'.repeat(10), 'd'.repeat(10), 'e'.repeat(10)],
    concerns: Array.from({ length: 12 }, (_, index) => `${'f'.repeat(100)}${index}`),
    sources: Array.from({ length: 20 }, (_, index) => ({
      url: `https://source-${index}.example/${'g'.repeat(3_000)}`,
      domain: `source-${index}.example`,
      title: 'h'.repeat(400),
      type: 'other' as const,
    })),
    searchQueries: Array.from({ length: 20 }, (_, index) => `${'i'.repeat(400)}${index}`),
  })]
  const stored = report(rows)
  stored.brandNames = Array.from({ length: 30 }, (_, index) => `${'j'.repeat(200)}${index}`)
  const { result } = await runCheck(probePort(() => Promise.resolve(stored)))

  const row = at(result!.perception!.evidence, 0)
  equal(row.answerText?.length, 4_000, 'answer text is clipped to 4,000')
  equal(row.evidenceSentences.length, 3, 'at most 3 evidence sentences')
  equal(at(row.evidenceSentences, 0).length, 240, 'an evidence sentence is clipped to 240')
  equal(row.concerns.length, 8, 'at most 8 concerns')
  equal(at(row.concerns, 0).length, 64, 'a concern is clipped to 64')
  equal(row.sources.length, 12, 'at most 12 sources')
  equal(at(row.sources, 0).url.length, 2_048, 'a source URL is clipped to 2,048')
  equal(at(row.sources, 0).title?.length, 300, 'a source title is clipped to 300')
  equal(row.searchQueries.length, 12, 'at most 12 search queries')
  equal(at(row.searchQueries, 0).length, 300, 'a search query is clipped to 300')
  equal(result!.perception!.brandNames.length, 20, 'at most 20 brand names')
  equal(at(result!.perception!.brandNames, 0).length, 128, 'a brand name is clipped to 128')
})

Deno.test('the stored summary is the instrument\'s, never recomputed on the way out', async () => {
  // Clipping strings must not silently re-derive the counts. If the runner ever
  // recomputes, a headline can disagree with the rows a reader is shown.
  const rows = [
    evidence({
      query: 'q1',
      verdict: 'recommends',
      evidenceSentences: ['Example is good.'],
      concerns: ['slow support'],
    }),
    evidence({
      query: 'q2',
      verdict: 'cautions',
      evidenceSentences: ['Example has issues.'],
      concerns: ['Slow support'],
    }),
    evidence({ query: 'q3', verdict: null, answerText: null, error: null }),
  ]
  const source = report(rows)
  const { result } = await runCheck(probePort(() => Promise.resolve(source)))
  const summary = result!.perception!.summary

  equal(summary.successfulChecks, 2)
  equal(summary.failedChecks, 1)
  equal(summary.verdicts.recommends + summary.verdicts.cautions + summary.verdicts.mixed + summary.verdicts.none, 2)
  // Counted once per answer and deduped case-insensitively by the instrument.
  equal(summary.concerns.length, 1)
  equal(at(summary.concerns, 0).phrase, 'slow support', 'the first-seen casing is what a reader is shown')
  equal(at(summary.concerns, 0).answers, 2)
})

Deno.test('the runner never publishes a raw provider message', async () => {
  const rows = [evidence({
    query: 'q1',
    verdict: null,
    answerText: null,
    error: 'x-request-id 8f21 key=AIzaSyD… POST https://internal/v1beta/models',
  })]
  const { result } = await runCheck(probePort(() => Promise.resolve(report(rows))))
  equal(at(result!.perception!.evidence, 0).error, GENERIC)
})

// ---------------------------------------------------------------------------
// Failure copy, driven through the real probe runner.
// ---------------------------------------------------------------------------

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

/** Run one branded question through the real runner and return the classified message. */
async function failureMessage(
  execute: VisibilityProviderAdapter['execute'],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const probed = await runVisibilityProbe({
    target: { canonicalDomain: 'example.com', brandNames: ['Example'] },
    queries: [{ id: 'q1', text: 'is Example legit?' }],
    adapters: [adapter(execute)],
    signal: options.signal,
    limits: { maxQueries: 1, maxProviders: 1, maxConcurrency: 1, timeoutMs: options.timeoutMs ?? 16_000 },
  })
  const check = probed.checks[0]
  assert(check, 'expected one check')
  assert(check.status === 'failed', `expected a failed check, got ${check.status}`)
  assert(check.error, 'a failed check must carry a classified failure')
  return check.error.message
}

const throwing = (message: string): VisibilityProviderAdapter['execute'] => () => Promise.reject(new Error(message))

const CASES: ReadonlyArray<{ name: string; run: () => Promise<string>; expected: string }> = [
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
    equal(publicProbeError(await testCase.run()), testCase.expected, `${testCase.name} lost its reason`)
  })
}

Deno.test('no failure the runner can produce falls back to the generic sentence', async () => {
  // The guard, not a restatement of the cases above: a new failure mode added
  // upstream would reach the visitor as "This answer-engine check was
  // unavailable." and the reason would be gone, because nothing is logged
  // either. This fails instead of leaving a row nobody can explain afterwards.
  for (const testCase of CASES) {
    const message = await testCase.run()
    assert(
      publicProbeError(message) !== GENERIC,
      `the runner emits "${message}" with no public translation, so its reason is destroyed`,
    )
  }
})

Deno.test('every finish reason the provider can send has a public sentence', () => {
  const finishReasons = [
    'FINISH_REASON_UNSPECIFIED',
    'STOP',
    'MAX_TOKENS',
    'SAFETY',
    'RECITATION',
    'LANGUAGE',
    'OTHER',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'MALFORMED_FUNCTION_CALL',
  ]
  for (const finishReason of finishReasons) {
    const internal = emptyAnswerReason({ candidates: [{ finishReason, content: { parts: [] } }] } as never)
    assert(
      internal !== 'The provider response contained no answer text.',
      `${finishReason} must map to its own reason, not the catch-all`,
    )
    equal(
      publicProbeError(internal) === GENERIC,
      false,
      `${finishReason} -> "${internal}" must survive the public sanitizer`,
    )
  }
})

Deno.test('a phase that never produced a row still says why', () => {
  const generic = 'The brand perception check could not complete.'

  // Provider failures go through the same classifier the row path uses, so the
  // two cannot describe one outage differently.
  equal(
    perceptionPhaseError(new Error('429 Too Many Requests for quota metric generate_requests')),
    'The answer engine rate-limited this check.',
  )
  equal(perceptionPhaseError(new Error('503 Service Unavailable')), 'The answer engine was temporarily unavailable.')
  equal(
    perceptionPhaseError(new Error('API key not valid. Please pass a valid API key.')),
    'This check could not be authorized with the answer engine.',
  )

  // A planning failure is a fact about the BRAND, not about the engine: it is
  // the difference between "try again" and "this will not work".
  equal(
    perceptionPhaseError(new Error('The perception planner returned invalid JSON.')),
    'Branded questions could not be generated for this brand.',
  )
  equal(
    perceptionPhaseError(new Error('The perception planner did not return any branded questions.')),
    'Branded questions could not be generated for this brand.',
  )

  // A deadline is its own state, distinct from a provider refusing.
  equal(
    perceptionPhaseError(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })),
    'The brand perception check timed out.',
  )

  // And the sanitizer still refuses to publish anything it does not recognize.
  equal(perceptionPhaseError(new Error('x-request-id 8f21 POST https://internal/v1beta/models')), generic)
  equal(perceptionPhaseError('a bare string, not an Error'), generic)
})

Deno.test('an unknown per-row message is replaced, never published', () => {
  equal(publicProbeError('x-request-id 8f21 key=AIzaSyD… POST https://internal/v1beta/models'), GENERIC)
  equal(publicProbeError(null), null, 'a check that did not fail carries no error')
})
