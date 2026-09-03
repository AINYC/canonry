import { MENTION_EXTRACT_LIMITS, VAL_TOWN_GEMINI_VISIBILITY_LIMITS } from 'npm:@canonry/val-kit@0.1.0/visibility'
import { PUBLIC_CHECK_WORK_BUDGET_MS } from '../../src/jobs/public-check.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

const limits = VAL_TOWN_GEMINI_VISIBILITY_LIMITS

/** Probe waves needed to run every probe at the configured concurrency. */
function probeWaves(): number {
  return Math.ceil(limits.maxProbeCalls / limits.probeConcurrency)
}

/** The phase's own worst case, in the order the phase actually runs. */
function worstCaseMs(): number {
  return limits.plannerTimeoutMs +
    probeWaves() * limits.probeTimeoutMs +
    MENTION_EXTRACT_LIMITS.timeoutMs
}

Deno.test('the probe phase fits inside the budget the job gives it', () => {
  // These live in three files and nothing but this test connects them. When
  // they last disagreed the phase could spend 42s of a 45s ceiling, which left
  // no room to give a probe a realistic deadline: every probe was capped at 10s
  // and a slow Gemini failed all three.
  const worst = worstCaseMs()
  assert(
    worst <= PUBLIC_CHECK_WORK_BUDGET_MS,
    `phase worst case ${worst}ms exceeds the ${PUBLIC_CHECK_WORK_BUDGET_MS}ms job budget ` +
      `(planner ${limits.plannerTimeoutMs} + ${probeWaves()} wave(s) x probe ${limits.probeTimeoutMs} ` +
      `+ extraction ${MENTION_EXTRACT_LIMITS.timeoutMs})`,
  )
})

Deno.test('every probe runs in one wave, which is what pays for the deadline', () => {
  // Concurrency below the call count silently doubles the phase's worst case,
  // and the cost shows up as a shorter per-probe deadline rather than as an
  // error. Raising maxProbeCalls without raising concurrency fails here.
  equal(probeWaves(), 1, 'probes must not need a second round')
  assert(
    limits.probeConcurrency >= limits.maxProbeCalls,
    `concurrency ${limits.probeConcurrency} cannot run ${limits.maxProbeCalls} probes at once`,
  )
})

Deno.test('a probe deadline outlives a grounded Gemini answer', () => {
  // Measured: successful checks complete the whole visibility phase in ~15s,
  // and a grounded `googleSearch` answer regularly runs past 10s on its own.
  // A deadline at or below that is not a timeout, it is a coin flip.
  assert(
    limits.probeTimeoutMs >= 15_000,
    `a ${limits.probeTimeoutMs}ms probe deadline is shorter than a slow grounded answer`,
  )
})

Deno.test('the phase keeps real headroom, not a budget spent to the cent', () => {
  // Val Town runs the check inside the HTTP request, so the client is waiting
  // through all of this. A phase sized to exactly the ceiling has nowhere to
  // put the crawl, the response, or an unlucky moment.
  const headroom = PUBLIC_CHECK_WORK_BUDGET_MS - worstCaseMs()
  assert(headroom >= 2_000, `only ${headroom}ms of headroom under the job budget`)
})
