import {
  type CheckRecord,
  PUBLIC_CHECK_UNAVAILABLE,
  PUBLIC_RATE_LIMITED_ERROR_CODE,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import type {
  PerceptionEvidence,
  PerceptionReport,
  PerceptionVerdict,
  SourceType,
} from 'npm:@canonry/val-kit@0.1.0/perception'
import type { PerceptionCheckResult } from '../runtime/check-result.ts'
import type {
  BrandPerceptionViewModel,
  CheckFormViewModel,
  PerceptionAnswerViewModel,
  PerceptionViewModel,
  UiTone,
  VerdictCountViewModel,
} from './types.ts'

export interface CheckRecordViewOptions {
  form?: CheckFormViewModel
  displayName?: string
  title?: string
}

const LOCAL_READY_FORM: CheckFormViewModel = {
  action: '/check',
  method: 'post',
  verificationFieldName: 'cf-turnstile-response',
  verificationStatus: 'not-required',
  submitLabel: 'Check a brand',
}

/**
 * The verdict vocabulary, written once.
 *
 * `none` is a POSITION — the answer described the brand and took none — so it
 * gets a neutral tone and a label that says what happened, never "no data".
 * `null` is the absence of a measurement and is handled separately, because
 * collapsing the two would turn an outage into a finding.
 */
const VERDICT_COPY: Readonly<Record<PerceptionVerdict, { label: string; tone: UiTone }>> = {
  recommends: { label: 'Recommends', tone: 'positive' },
  cautions: { label: 'Cautions', tone: 'negative' },
  mixed: { label: 'Mixed', tone: 'caution' },
  none: { label: 'Took no position', tone: 'neutral' },
}

/** What KIND of place, in the reader's words. Never "where opinions come from". */
const SOURCE_TYPE_LABELS: Readonly<Record<SourceType, string>> = {
  official: 'The brand’s own site',
  community: 'Community',
  review: 'Review site',
  news: 'News',
  other: 'Other',
}

/**
 * Converts a sanitized, durable public-check record into the narrow UI model.
 * It deliberately never turns an unmeasured answer into a neutral verdict.
 */
export function toBrandPerceptionViewModel(
  record: CheckRecord<PerceptionCheckResult> | null,
  options: CheckRecordViewOptions = {},
): BrandPerceptionViewModel {
  const domain = record?.domain ?? ''
  const result = record?.result ?? null
  const status = record ? mapStatus(record) : 'empty'
  const resultDomain = result?.domain || domain

  return {
    status,
    title: options.title,
    displayName: options.displayName ?? nameFromDomain(resultDomain || 'Brand'),
    domain: resultDomain,
    form: { ...LOCAL_READY_FORM, ...options.form },
    perception: result?.perception ? mapPerception(result.perception) : undefined,
    notice: buildNotice(record, result),
  }
}

/**
 * Did anything in this check actually fail?
 *
 * `record.status` is decided once, when the check runs, and stored, which makes
 * it the wrong thing to warn a reader off: correcting the rule behind it never
 * reaches a record already written, so a shared link keeps showing the old
 * verdict for its whole 24h life. The evidence is right here in the result, so
 * read it instead of the flag.
 */
function hasFailedWork(record: CheckRecord<PerceptionCheckResult>): boolean {
  const result = record.result
  if (!result) return false
  if (result.errors.length > 0) return true
  return (result.perception?.evidence ?? []).some((row) => row.verdict === null)
}

function mapStatus(record: CheckRecord<PerceptionCheckResult>): BrandPerceptionViewModel['status'] {
  if (record.errorCode === PUBLIC_RATE_LIMITED_ERROR_CODE) return 'rate-limited'
  switch (record.status) {
    case 'queued':
    case 'running':
      return 'loading'
    case 'partial':
      // A stored `partial` is only worth a caution when something in the result
      // actually failed. See `hasFailedWork`.
      return hasFailedWork(record) ? 'partial' : 'ready'
    case 'failed':
      return 'error'
    case 'complete':
      return 'ready'
  }
}

function mapPerception(report: PerceptionReport): PerceptionViewModel {
  const failed = report.summary.failedChecks
  const sourceTypes = report.summary.sourceTypes
  return {
    requestedAt: report.startedAt,
    checkedAt: report.completedAt,
    measuredAnswers: report.summary.successfulChecks,
    requestedAnswers: report.evidence.length,
    failedAnswers: failed,
    // Fixed order, so the row reads the same on every check and a count that
    // happens to be zero keeps its column rather than shuffling the others.
    verdicts: (['recommends', 'cautions', 'mixed', 'none'] as const).map((key): VerdictCountViewModel => ({
      key,
      label: VERDICT_COPY[key].label,
      tone: VERDICT_COPY[key].tone,
      count: report.summary.verdicts[key],
    })),
    concerns: report.summary.concerns.map((concern) => ({ phrase: concern.phrase, answers: concern.answers })),
    // Percentages round for display only; the shares they come from sum to 1.
    sourceTypes: sourceTypes
      ? {
        measuredAnswers: sourceTypes.measuredAnswers,
        unattributedAnswers: sourceTypes.unattributedAnswers,
        totalAppearances: sourceTypes.totalAppearances,
        entries: sourceTypes.entries.map((entry) => ({
          type: entry.type,
          label: SOURCE_TYPE_LABELS[entry.type],
          answers: entry.answers,
          percent: Math.round(entry.share * 100),
        })),
      }
      : undefined,
    answers: report.evidence.map(mapAnswer),
    notice: failed > 0
      ? {
        tone: 'caution',
        title: `${failed} ${failed === 1 ? 'answer' : 'answers'} unavailable`,
        // The reason leads, because that is what a row reading "Not measured"
        // makes someone ask. It is only stated when the failures agree on one;
        // with several the banner would have to pick one and be wrong about the
        // rest, so it defers to the per-row evidence instead.
        detail: `${failureReason(report.evidence) ?? ''}Every count uses the answers that were measured.`,
      }
      : undefined,
  }
}

/** The one reason every unmeasured answer shares, or null when they disagree. */
function failureReason(evidence: readonly PerceptionEvidence[]): string | null {
  const reasons = new Set(
    evidence.filter((row) => row.verdict === null)
      .map((row) => row.error)
      // The generic sentence is the ABSENCE of a reason. Leading with it
      // produces "1 answer unavailable. This answer-engine check was
      // unavailable." — the banner restating its own title.
      .filter((error): error is string => Boolean(error) && error !== PUBLIC_CHECK_UNAVAILABLE),
  )
  if (reasons.size !== 1) return null
  const [reason] = [...reasons]
  return reason ? `${reason} ` : null
}

function mapAnswer(row: PerceptionEvidence): PerceptionAnswerViewModel {
  const copy = row.verdict === null ? null : VERDICT_COPY[row.verdict]
  return {
    id: `${row.provider}:${row.query}:${row.completedAt}`,
    query: row.query,
    verdict: row.verdict,
    verdictLabel: copy?.label ?? 'Not measured',
    verdictTone: copy?.tone ?? 'neutral',
    // The answer's own first sentence, or nothing. A verdict of 'none' carries
    // no evidence by construction, and inventing a line to fill the cell would
    // put words in an answer that did not write them.
    headline: row.evidenceSentences[0] ?? null,
    evidenceSentences: row.evidenceSentences,
    concerns: row.concerns,
    sources: row.sources.map((source) => ({
      url: source.url,
      title: source.title,
      domain: source.domain,
      typeLabel: SOURCE_TYPE_LABELS[source.type],
    })),
    searchQueries: row.searchQueries,
    answerText: row.answerText,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    completedAt: row.completedAt,
    error: row.error,
  }
}

function buildNotice(
  record: CheckRecord<PerceptionCheckResult> | null,
  result: PerceptionCheckResult | null,
): BrandPerceptionViewModel['notice'] {
  if (!record) return undefined
  if (record.errorCode === PUBLIC_RATE_LIMITED_ERROR_CODE) {
    return {
      tone: 'caution',
      title: 'Check limit reached',
      detail: record.errorMessage ?? 'This public sample has reached its current limit. Try again later.',
    }
  }
  if (record.status === 'failed') {
    return {
      tone: 'negative',
      title: 'This check could not finish',
      detail: result?.errors[0]?.message ?? record.errorMessage ?? 'Try another public domain later.',
    }
  }
  const first = result?.errors[0]
  if (first) return { tone: 'caution', title: 'Brand perception was unavailable', detail: first.message }
  return undefined
}

function nameFromDomain(domain: string): string {
  const host = domain.replace(/^www\./i, '').split('.')[0] ?? domain
  return host
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * The landing view, shown before anything has been checked.
 *
 * It carries no `perception` because nothing has been measured yet. A fixture
 * here would be read as measurement by anyone who scrolled past the badge that
 * qualified it — and a fabricated verdict about a real brand is a worse lie
 * than a fabricated percentage. An empty state is the honest thing to show when
 * the answer is "nothing yet".
 */
export function emptyLandingViewModel(form: CheckFormViewModel): BrandPerceptionViewModel {
  return {
    status: 'empty',
    title: 'Brand Perception Check',
    displayName: 'Check a brand',
    domain: '',
    form,
  }
}
