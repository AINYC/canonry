import {
  type CheckStore,
  PUBLIC_CHECK_EXECUTION_LEASE_MS,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
  PUBLIC_CHECK_UNAVAILABLE,
  type PublicCheckDispatchOptions,
  type PublicCheckRunner,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import {
  safeProviderErrorMessage,
  type VisibilityProbePort,
  type VisibilityReport,
} from 'npm:@canonry/val-kit@0.1.0/visibility'
import { CHECK_RESULT_SCHEMA_VERSION, type CheckResult } from '../runtime/check-result.ts'
import type { SiteHealthRunner, SiteHealthSample } from '../site-health/types.ts'

/**
 * Ceiling for one check's provider work. The visibility probe and the site
 * crawl run under it in parallel, so this is the budget the probe phase's own
 * planner + probes + extraction deadlines have to fit inside.
 */
export const PUBLIC_CHECK_WORK_BUDGET_MS = 45_000

const SITE_HEALTH_TIMEOUT_ERROR = 'The Technical AEO sample timed out.'
const SITE_HEALTH_NO_PUBLIC_PAGES_ERROR = 'No public pages could be audited in the Technical AEO sample.'
const SITE_HEALTH_GENERIC_ERROR = 'The Technical AEO sample could not complete.'
const VISIBILITY_GENERIC_ERROR = 'The AI Visibility sample could not complete.'

// `SiteHealthSample.error` crosses from the crawler adapter into the public
// durable record. These are the only strings emitted by the local runner that
// are safe to preserve; every other string is treated as a transport detail.
const SAFE_SITE_HEALTH_ERRORS = new Set([
  SITE_HEALTH_TIMEOUT_ERROR,
  SITE_HEALTH_NO_PUBLIC_PAGES_ERROR,
  SITE_HEALTH_GENERIC_ERROR,
])

/**
 * Why one query in a check could not be measured, in the visitor's words.
 *
 * The runner already classifies a probe failure into one of a small closed set
 * of strings, and none of them carry a provider body, a request id, or a
 * credential. This sanitizer used to replace all of them with a single
 * "This answer-engine check was unavailable.", which meant the reason existed
 * for one function call and was then destroyed: nothing is logged either, so a
 * row reading "Not measured" could not be explained afterwards by anyone,
 * including the operator.
 *
 * Translated rather than passed through, for two reasons. The upstream wording
 * says "provider", which is not a word this page uses. And a sanitizer must not
 * trust its input: an adapter that one day puts a transport dump in `message`
 * falls through to the generic sentence instead of publishing it.
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

export class PublicQuotaError extends Error {
  override name = 'PublicQuotaError'
  constructor(readonly scope: 'client' | 'global') {
    super(scope === 'client' ? 'Daily check limit reached.' : 'The public check is at capacity. Try again tomorrow.')
  }
}

export interface PublicCheckRunnerOptions {
  store: CheckStore<CheckResult>
  visibilityProbe: VisibilityProbePort | null
  siteHealthRunner: SiteHealthRunner
  ttlMs: number
  now?: () => Date
}

export function createPublicCheckRunner(options: PublicCheckRunnerOptions): PublicCheckRunner {
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
          // This is a transient capacity race, not a failed check. Persist it back
          // to the queue so a later request/durable trigger can safely claim it.
          return (await options.store.requeueJob(checkId, owner, now().toISOString())) ? 'busy' : 'ignored'
        }
        shouldReleaseExecutionLease = true

        const signal = AbortSignal.timeout(PUBLIC_CHECK_WORK_BUDGET_MS)
        const [visibilityResult, siteHealthResult] = await Promise.allSettled([
          options.visibilityProbe
            ? options.visibilityProbe.probe({
              domain: record.domain,
              userQueries: record.userQueries,
              maxPlannerCalls: 1,
              maxProbeCalls: 3,
              signal,
            })
            : Promise.reject(new Error('The AI Visibility sample is not configured yet.')),
          options.siteHealthRunner.run(record.domain, signal),
        ])

        const errors: CheckResult['errors'] = []
        const visibility = visibilityResult.status === 'fulfilled'
          ? sanitizeVisibility(visibilityResult.value)
          : (errors.push({
            area: 'visibility',
            code: options.visibilityProbe ? 'unavailable' : 'not-configured',
            message: publicExecutionError('visibility', visibilityResult.reason, options.visibilityProbe === null),
          }),
            null)
        const siteHealth = siteHealthResult.status === 'fulfilled'
          ? sanitizeSiteHealth(siteHealthResult.value)
          : (errors.push({
            area: 'site-health',
            code: 'unavailable',
            message: publicExecutionError('site-health', siteHealthResult.reason),
          }),
            null)

        if (siteHealth?.status === 'error') {
          errors.push({
            area: 'site-health',
            code: 'crawl-failed',
            message: publicExecutionError('site-health', siteHealth.error),
          })
        }

        const completedAt = now()
        const result: CheckResult = {
          schemaVersion: CHECK_RESULT_SCHEMA_VERSION,
          domain: record.domain,
          generatedAt: completedAt.toISOString(),
          visibility,
          siteHealth,
          errors,
        }
        const hasAnyResult = visibility !== null || (siteHealth !== null && siteHealth.status !== 'error')
        const status = !hasAnyResult
          ? 'failed'
          : errors.length > 0 || siteHealth?.status === 'partial'
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

function sanitizeVisibility(report: VisibilityReport): VisibilityReport {
  return {
    schemaVersion: clip(report.schemaVersion, 32),
    domain: clip(report.domain, 253),
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    summary: {
      successfulChecks: finiteCount(report.summary.successfulChecks),
      failedChecks: finiteCount(report.summary.failedChecks),
      mentionRate: finiteRate(report.summary.mentionRate),
      citationRate: finiteRate(report.summary.citationRate),
    },
    evidence: report.evidence.slice(0, 3).map((evidence) => ({
      query: clip(evidence.query, 300),
      provider: clip(evidence.provider, 80),
      requestedModel: nullableClip(evidence.requestedModel, 160),
      servedModel: nullableClip(evidence.servedModel, 160),
      completedAt: evidence.completedAt,
      answerText: nullableClip(evidence.answerText, 4_000),
      mentioned: evidence.mentioned == null ? null : Boolean(evidence.mentioned),
      matchedTerms: evidence.matchedTerms.slice(0, 12).map((term) => clip(term, 160)),
      cited: evidence.cited == null ? null : Boolean(evidence.cited),
      citedDomains: evidence.citedDomains.slice(0, 12).map((domain) => clip(domain, 253)),
      citedUrls: evidence.citedUrls.slice(0, 12).map((url) => clip(url, 2_048)),
      matchedCitationDomains: evidence.matchedCitationDomains.slice(0, 12).map((domain) => clip(domain, 253)),
      matchedCitationUrls: evidence.matchedCitationUrls.slice(0, 12).map((url) => clip(url, 2_048)),
      sources: evidence.sources.slice(0, 12).map((source) => ({
        url: clip(source.url, 2_048),
        title: nullableClip(source.title, 300),
      })),
      searchQueries: evidence.searchQueries.slice(0, 12).map((query) => clip(query, 300)),
      // Already verified to be written in the answer, so these are the answer's
      // own words. Bounded anyway, like every other array on this record.
      namedBrands: evidence.namedBrands === null
        ? null
        : evidence.namedBrands.slice(0, 12).map((name) => clip(name, 64)),
      retrievalStatus: evidence.retrievalStatus,
      // Provider adapters may include transport diagnostics, so only a known
      // classification survives; anything else becomes the generic sentence.
      error: publicProbeError(evidence.error),
    })),
  }
}

function sanitizeSiteHealth(sample: SiteHealthSample): SiteHealthSample {
  return {
    ...sample,
    warnings: sample.warnings.slice(0, 4).map(() => 'Some optional crawl checks were unavailable.'),
    pages: sample.pages.slice(0, 5).map((page) => ({
      ...page,
      error: page.error ? 'This page could not be audited.' : null,
    })),
    error: sample.error === null ? null : publicExecutionError('site-health', sample.error),
  }
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function finiteRate(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null
}

function nullableClip(value: string | null, max: number): string | null {
  return value == null ? null : clip(value, max)
}

/**
 * Why a whole PHASE could not run, as opposed to why one probe failed.
 *
 * The per-row reason was already preserved; this was not, so a visibility phase
 * that threw before producing a single row reported "The AI Visibility sample
 * could not complete." and nothing else. That is the same defect one level up:
 * the reason exists at the throw site and is destroyed on the way out.
 *
 * A phase throw is a planning failure or a provider failure, and both arrive as
 * an Error whose message the classifiers below already know how to reduce to a
 * closed set. Anything they do not recognize still becomes the generic
 * sentence, so an unbounded provider message can never reach the record.
 */
const PUBLIC_VISIBILITY_PHASE_ERRORS = new Map([
  ['The provider rate-limited this request.', 'The answer engine rate-limited this check.'],
  ['The provider was temporarily unavailable.', 'The answer engine was temporarily unavailable.'],
  ['The provider credentials were rejected.', 'This check could not be authorized with the answer engine.'],
  ['The provider request timed out.', 'The answer engine did not respond in time.'],
])

/** Exported for the test that pins every phase failure to a public sentence. */
export function visibilityPhaseError(error: unknown): string {
  if (isTimeout(error)) return 'The AI Visibility sample timed out.'
  if (!(error instanceof Error)) return VISIBILITY_GENERIC_ERROR

  const classified = PUBLIC_VISIBILITY_PHASE_ERRORS.get(safeProviderErrorMessage(error))
  if (classified) return classified

  // Planning failures are the val's own strings, not a provider body, and they
  // are the difference between "the engine is down" and "we could not build a
  // question set for this domain" — which is a fact about the DOMAIN.
  if (/query planner/i.test(error.message)) {
    return 'Questions could not be generated for this domain.'
  }
  return VISIBILITY_GENERIC_ERROR
}

function publicExecutionError(area: 'visibility' | 'site-health', error: unknown, notConfigured = false): string {
  if (area === 'visibility' && notConfigured) return 'The AI Visibility sample is not configured for this demo.'
  if (area === 'site-health' && typeof error === 'string' && SAFE_SITE_HEALTH_ERRORS.has(error)) return error
  if (area === 'visibility') return visibilityPhaseError(error)
  return isTimeout(error) ? SITE_HEALTH_TIMEOUT_ERROR : SITE_HEALTH_GENERIC_ERROR
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}
