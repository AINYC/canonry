import {
  type CheckStore,
  PUBLIC_CHECK_EXECUTION_LEASE_MS,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
  PUBLIC_CHECK_UNAVAILABLE,
  type PublicCheckDispatchOptions,
  type PublicCheckRunner,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import type {
  PerceptionEvidence,
  PerceptionProbePort,
  PerceptionReport,
  PerceptionSummary,
} from 'npm:@canonry/val-kit@0.1.0/perception'
import { safeProviderErrorMessage } from 'npm:@canonry/val-kit@0.1.0/visibility'
import { CHECK_RESULT_SCHEMA_VERSION, type PerceptionCheckResult } from '../runtime/check-result.ts'

/**
 * Ceiling for one check's provider work.
 *
 * There is ONE phase here, and it runs three deadlines in sequence: the branded
 * planner, one wave of probes, and the verdict extraction. `perception-budget.test.ts`
 * is the only thing that connects those numbers to this one.
 */
export const PUBLIC_CHECK_WORK_BUDGET_MS = 45_000

const PERCEPTION_GENERIC_ERROR = 'The brand perception check could not complete.'
const PERCEPTION_TIMEOUT_ERROR = 'The brand perception check timed out.'
const PERCEPTION_NOT_CONFIGURED_ERROR = 'The brand perception check is not configured for this demo.'

/**
 * Why one branded question could not be measured, in the visitor's words.
 *
 * The probe runner already classifies a failure into a small closed set of
 * strings, and none of them carry a provider body, a request id, or a
 * credential. They are translated rather than passed through for two reasons.
 * The upstream wording says "provider", which is not a word this page uses. And
 * a sanitizer must not trust its input: an adapter that one day puts a transport
 * dump in `message` falls through to the generic sentence instead of publishing
 * it.
 */
const PUBLIC_PROBE_ERRORS = new Map([
  ['The provider request timed out.', 'The answer engine did not respond in time.'],
  ['The provider request was cancelled.', 'This check was cancelled before the answer engine replied.'],
  ['The provider rate-limited this request.', 'The answer engine rate-limited this check.'],
  ['The provider was temporarily unavailable.', 'The answer engine was temporarily unavailable.'],
  ['The provider credentials were rejected.', 'This check could not be authorized with the answer engine.'],
  ['The provider response contained no answer text.', 'The answer engine returned no answer text.'],
  ['The provider answer was cut off at the length limit.', 'The answer engine ran out of room mid-answer.'],
  ['The provider declined to answer this query.', 'The answer engine declined to answer this question.'],
  [
    'The provider stopped the answer to avoid reciting a source.',
    'The answer engine stopped short to avoid quoting a source.',
  ],
  ['The provider does not support the language of this query.', 'The answer engine does not support this language.'],
  ['The provider ended the answer on an internal tool error.', 'The answer engine hit an internal error mid-answer.'],
  [
    'The provider ended the answer without writing anything.',
    'The answer engine finished without saying anything for this question.',
  ],
  ['The provider stopped the answer for an unstated reason.', 'The answer engine stopped without giving a reason.'],
  ['The provider response has an invalid requested model.', 'The answer engine reported an unusable model.'],
  ['The provider request failed.', 'The answer engine did not return an answer.'],
])

/** Exported for the test that pins every runner failure to a public sentence. */
export function publicProbeError(message: string | null): string | null {
  if (message === null) return null
  return PUBLIC_PROBE_ERRORS.get(message) ?? PUBLIC_CHECK_UNAVAILABLE
}

/**
 * Why the whole PHASE could not run, as opposed to why one question failed.
 *
 * A phase throw is a planning failure or a provider failure thrown before a
 * single probe ran, and both arrive as an Error whose message the classifier
 * below already reduces to a closed set. Anything it does not recognize becomes
 * the generic sentence, so an unbounded provider message can never reach the
 * durable public record.
 */
const PUBLIC_PERCEPTION_PHASE_ERRORS = new Map([
  ['The provider rate-limited this request.', 'The answer engine rate-limited this check.'],
  ['The provider was temporarily unavailable.', 'The answer engine was temporarily unavailable.'],
  ['The provider credentials were rejected.', 'This check could not be authorized with the answer engine.'],
  ['The provider request timed out.', 'The answer engine did not respond in time.'],
])

/** Exported for the test that pins every phase failure to a public sentence. */
export function perceptionPhaseError(error: unknown): string {
  if (isTimeout(error)) return PERCEPTION_TIMEOUT_ERROR
  if (!(error instanceof Error)) return PERCEPTION_GENERIC_ERROR

  const classified = PUBLIC_PERCEPTION_PHASE_ERRORS.get(safeProviderErrorMessage(error))
  if (classified) return classified

  // A planning failure is the val's own string, not a provider body, and it is
  // a fact about the BRAND rather than about the engine: nothing could be asked
  // because nothing could be asked ABOUT. That is the difference between "try
  // again" and "this will not work".
  if (/perception planner/i.test(error.message)) {
    return 'Branded questions could not be generated for this brand.'
  }
  return PERCEPTION_GENERIC_ERROR
}

export class PublicQuotaError extends Error {
  override name = 'PublicQuotaError'
  constructor(readonly scope: 'client' | 'global') {
    super(scope === 'client' ? 'Daily check limit reached.' : 'The public check is at capacity. Try again tomorrow.')
  }
}

export interface PerceptionCheckRunnerOptions {
  store: CheckStore<PerceptionCheckResult>
  perceptionProbe: PerceptionProbePort | null
  ttlMs: number
  now?: () => Date
}

export function createPerceptionCheckRunner(options: PerceptionCheckRunnerOptions): PublicCheckRunner {
  const now = options.now ?? (() => new Date())
  return {
    async run(checkId, dispatchOptions: PublicCheckDispatchOptions = {}) {
      const owner = dispatchOptions.executionLeaseOwner ?? crypto.randomUUID()
      const started = now()
      const jobLeaseUntil = new Date(started.getTime() + PUBLIC_CHECK_EXECUTION_LEASE_MS).toISOString()
      // A supplied reservation must be released even when the durable job
      // vanished before this request-bound runner could claim it.
      let shouldReleaseExecutionLease = dispatchOptions.executionLeaseOwner !== undefined

      try {
        const record = await options.store.claimJob(checkId, owner, started.toISOString(), jobLeaseUntil)
        if (!record) return 'ignored'

        // Renew an admission reservation (or claim a direct-run lease) after
        // the durable job claim. A slow admission must never reach provider
        // work on a reservation that has expired in the meantime.
        const renewalAt = now()
        const executionLeaseUntil = new Date(renewalAt.getTime() + PUBLIC_CHECK_EXECUTION_LEASE_MS).toISOString()
        const hasExecutionLease = await options.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          owner,
          renewalAt.toISOString(),
          executionLeaseUntil,
        )
        if (!hasExecutionLease) {
          // A transient capacity race, not a failed check. Persist it back to
          // the queue so a later request can safely claim it.
          return (await options.store.requeueJob(checkId, owner, now().toISOString())) ? 'busy' : 'ignored'
        }
        shouldReleaseExecutionLease = true

        const signal = AbortSignal.timeout(PUBLIC_CHECK_WORK_BUDGET_MS)
        const errors: PerceptionCheckResult['errors'] = []
        let perception: PerceptionReport | null = null
        try {
          if (!options.perceptionProbe) throw new PerceptionNotConfiguredError()
          perception = sanitizePerception(
            await options.perceptionProbe.probe({
              domain: record.domain,
              userQueries: record.userQueries,
              maxProbeCalls: 3,
              signal,
            }),
          )
        } catch (error) {
          errors.push({
            area: 'perception',
            message: error instanceof PerceptionNotConfiguredError
              ? PERCEPTION_NOT_CONFIGURED_ERROR
              : perceptionPhaseError(error),
          })
        }

        const completedAt = now()
        const result: PerceptionCheckResult = {
          schemaVersion: CHECK_RESULT_SCHEMA_VERSION,
          domain: record.domain,
          generatedAt: completedAt.toISOString(),
          perception,
          errors,
        }
        // A report where nothing was measured produced no finding at all: every
        // denominator below it would be zero, so the record is a failure rather
        // than a result with empty sections. Reaching a configured ceiling is
        // never a failure here — there is no ceiling to reach, only questions
        // that were answered or were not.
        const status = perception === null || perception.summary.successfulChecks === 0
          ? 'failed'
          : perception.summary.failedChecks > 0 || errors.length > 0
          ? 'partial'
          : 'complete'
        await options.store.finalizeJob(checkId, owner, {
          status,
          updatedAt: completedAt.toISOString(),
          // Failed checks are never reused, but they still need a TTL so their
          // public capability URL and durable row do not live forever.
          expiresAt: new Date(completedAt.getTime() + options.ttlMs).toISOString(),
          result,
          errorCode: status === 'failed' ? 'check-failed' : null,
          errorMessage: status === 'failed' ? 'The public check could not complete.' : null,
        })
        return 'completed'
      } finally {
        if (shouldReleaseExecutionLease) {
          await options.store.releaseGlobalLease(PUBLIC_CHECK_EXECUTION_LEASE_NAME, owner)
        }
      }
    },
  }
}

/** Distinguishes "no credential on this deployment" from "the engine failed". */
class PerceptionNotConfiguredError extends Error {
  override name = 'PerceptionNotConfiguredError'
}

/**
 * Bound every string and array before the report becomes a durable public
 * record. The instrument already clips inside its own limits; this is the
 * boundary that does not trust it, and it is where the visitor's wording
 * replaces the provider's.
 */
function sanitizePerception(report: PerceptionReport): PerceptionReport {
  return {
    schemaVersion: report.schemaVersion,
    domain: clip(report.domain, 253),
    brandNames: report.brandNames.slice(0, 20).map((name) => clip(name, 128)),
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    summary: sanitizeSummary(report.summary),
    evidence: report.evidence.slice(0, 3).map(sanitizeEvidence),
  }
}

/**
 * Clipped and coerced, never RECOMPUTED. The summary is what the instrument
 * measured; deriving it a second time here would let a headline disagree with
 * the rows the reader is shown.
 */
function sanitizeSummary(summary: PerceptionSummary): PerceptionSummary {
  return {
    successfulChecks: finiteCount(summary.successfulChecks),
    failedChecks: finiteCount(summary.failedChecks),
    verdicts: {
      recommends: finiteCount(summary.verdicts.recommends),
      cautions: finiteCount(summary.verdicts.cautions),
      mixed: finiteCount(summary.verdicts.mixed),
      none: finiteCount(summary.verdicts.none),
    },
    concerns: summary.concerns.slice(0, 24).map((concern) => ({
      phrase: clip(concern.phrase, 64),
      answers: finiteCount(concern.answers),
    })),
    sourceTypes: summary.sourceTypes === null ? null : {
      measuredAnswers: finiteCount(summary.sourceTypes.measuredAnswers),
      unattributedAnswers: finiteCount(summary.sourceTypes.unattributedAnswers),
      totalAppearances: finiteCount(summary.sourceTypes.totalAppearances),
      entries: summary.sourceTypes.entries.slice(0, 5).map((entry) => ({
        type: entry.type,
        answers: finiteCount(entry.answers),
        share: finiteRate(entry.share),
      })),
    },
  }
}

function sanitizeEvidence(evidence: PerceptionEvidence): PerceptionEvidence {
  return {
    query: clip(evidence.query, 300),
    provider: clip(evidence.provider, 80),
    requestedModel: clip(evidence.requestedModel, 160),
    servedModel: nullableClip(evidence.servedModel, 160),
    completedAt: evidence.completedAt,
    answerText: nullableClip(evidence.answerText, 4_000),
    verdict: evidence.verdict,
    // Already verified to be written in the answer, so these are the answer's
    // own words. Bounded anyway, like every other array on this record.
    evidenceSentences: evidence.evidenceSentences.slice(0, 3).map((sentence) => clip(sentence, 240)),
    concerns: evidence.concerns.slice(0, 8).map((concern) => clip(concern, 64)),
    sources: evidence.sources.slice(0, 12).map((source) => ({
      url: clip(source.url, 2_048),
      domain: source.domain === null ? null : clip(source.domain, 253),
      title: nullableClip(source.title, 300),
      type: source.type,
    })),
    searchQueries: evidence.searchQueries.slice(0, 12).map((query) => clip(query, 300)),
    retrievalStatus: evidence.retrievalStatus,
    // Provider adapters may include transport diagnostics, so only a known
    // classification survives; anything else becomes the generic sentence.
    error: publicProbeError(evidence.error),
  }
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function finiteRate(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function nullableClip(value: string | null, max: number): string | null {
  return value == null ? null : clip(value, max)
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}
