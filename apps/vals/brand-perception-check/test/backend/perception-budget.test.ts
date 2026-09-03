import { VAL_TOWN_GEMINI_PERCEPTION_LIMITS, VERDICT_EXTRACT_LIMITS } from 'npm:@canonry/val-kit@0.1.0/perception'
import { PUBLIC_CHECK_WORK_BUDGET_MS } from '../../src/jobs/perception-check.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

const limits = VAL_TOWN_GEMINI_PERCEPTION_LIMITS

/** Probe waves needed to run every probe at the configured concurrency. */
function probeWaves(): number {
  return Math.ceil(limits.maxProbeCalls / limits.probeConcurrency)
}

/** The phase's own worst case, in the order the phase actually runs. */
function worstCaseMs(): number {
  return limits.plannerTimeoutMs +
    probeWaves() * limits.probeTimeoutMs +
    limits.verdictTimeoutMs
}

Deno.test('the perception phase fits inside the budget the job gives it', () => {
  // Four numbers in two packages, and nothing but this test connects them to
  // the job ceiling. This phase is strictly sequential — plan, then one probe
  // wave, then read the answers back — so the worst cases ADD rather than
  // overlap, and there is no second phase to hide a slip behind.
  const worst = worstCaseMs()
  assert(
    worst <= PUBLIC_CHECK_WORK_BUDGET_MS,
    `phase worst case ${worst}ms exceeds the ${PUBLIC_CHECK_WORK_BUDGET_MS}ms job budget ` +
      `(planner ${limits.plannerTimeoutMs} + ${probeWaves()} wave(s) x probe ${limits.probeTimeoutMs} ` +
      `+ verdict ${limits.verdictTimeoutMs})`,
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

Deno.test('the verdict deadline is one number, not two that agree today', () => {
  // The extractor enforces its own timeout; the host's arithmetic reads this
  // constant. Two constants that happen to match are two constants, and the
  // budget silently stops being true the first time only one of them moves.
  equal(limits.verdictTimeoutMs, VERDICT_EXTRACT_LIMITS.timeoutMs, 'the host and the extractor must share a deadline')
})

Deno.test('a probe deadline outlives a grounded Gemini answer', () => {
  // A grounded `googleSearch` answer regularly runs past 10s on its own. A
  // deadline at or below that is not a timeout, it is a coin flip.
  assert(
    limits.probeTimeoutMs >= 15_000,
    `a ${limits.probeTimeoutMs}ms probe deadline is shorter than a slow grounded answer`,
  )
})

Deno.test('the phase keeps real headroom, not a budget spent to the cent', () => {
  // Val Town runs the check inside the HTTP request, so the visitor is waiting
  // through all of this. A phase sized to exactly the ceiling has nowhere to
  // put the response, or an unlucky moment.
  const headroom = PUBLIC_CHECK_WORK_BUDGET_MS - worstCaseMs()
  assert(headroom >= 2_000, `only ${headroom}ms of headroom under the job budget`)
})
