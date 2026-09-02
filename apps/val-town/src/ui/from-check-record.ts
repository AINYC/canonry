import { orderFactors } from '../site-health/factor-order.ts'
import { computeMentionShare, computeShareOfVoice, type ShareOfVoice } from '../visibility/share.ts'
import type {
  CheckRecord,
  CheckResult,
  SiteHealthPageSample,
  SiteHealthSample,
  VisibilityEvidence,
  VisibilityReport,
} from '../runtime/types.ts'
import { PUBLIC_CHECK_UNAVAILABLE, PUBLIC_RATE_LIMITED_ERROR_CODE } from '../runtime/types.ts'
import type {
  CanonryDemoViewModel,
  CheckFormViewModel,
  QueryEvidenceViewModel,
  SiteHealthDefectViewModel,
  SiteHealthFactorViewModel,
  SiteHealthPageViewModel,
  VisibilityViewModel,
} from './types.ts'

export interface CheckRecordViewOptions {
  form?: CheckFormViewModel
  displayName?: string
  locale?: string
  title?: string
}

const LOCAL_READY_FORM: CheckFormViewModel = {
  action: '/check',
  method: 'post',
  verificationFieldName: 'cf-turnstile-response',
  verificationStatus: 'not-required',
  submitLabel: 'Check a domain',
}

/**
 * Converts a sanitized, durable public-check record into the narrow UI model.
 * It deliberately never turns an absent provider report into a 0% score.
 */
export function toCanonryDemoViewModel(
  record: CheckRecord | null,
  options: CheckRecordViewOptions = {},
): CanonryDemoViewModel {
  const domain = record?.domain ?? ''
  const result = record?.result ?? null
  const status = record ? mapStatus(record) : 'empty'
  const resultDomain = result?.domain || domain
  const displayName = options.displayName ?? nameFromDomain(resultDomain || 'Canonry')
  const visibility = result?.visibility ? mapVisibility(result.visibility) : undefined
  const siteHealth = result?.siteHealth ? mapSiteHealth(result.siteHealth, result.generatedAt) : undefined

  return {
    status,
    title: options.title,
    displayName,
    domain: resultDomain,
    locale: options.locale,
    form: { ...LOCAL_READY_FORM, ...options.form },
    visibility,
    siteHealth,
    notice: buildNotice(record, result),
  }
}

/**
 * Did anything in this check actually fail?
 *
 * `record.status` is decided once, when the check runs, and stored. That makes
 * it the wrong thing to warn a reader off: when the rule behind it is corrected
 * the stored value stays wrong for the record's whole 24h life, and a reader
 * opening a shared link sees the old verdict forever. Every check written
 * before the bounded-sample rule was fixed still says `partial` with zero
 * failed probes and a completed crawl.
 *
 * The evidence is right here in the result, so read it instead of the flag: a
 * probe that failed, a crawl that errored, or a recorded phase error. Nothing
 * failed means no caution, whatever the stored status says.
 */
function hasFailedWork(record: CheckRecord): boolean {
  const result = record.result
  if (!result) return false
  if (result.errors && result.errors.length > 0) return true
  if (result.siteHealth && result.siteHealth.status === 'error') return true
  return (result.visibility?.evidence ?? []).some((row) => row.mentioned === null && row.cited === null)
}

function mapStatus(record: CheckRecord): CanonryDemoViewModel['status'] {
  if (record.errorCode === PUBLIC_RATE_LIMITED_ERROR_CODE) return 'rate-limited'
  switch (record.status) {
    case 'queued':
    case 'running':
      return 'loading'
    case 'partial':
      // A stored `partial` is only worth a caution when something in the
      // result actually failed. See `hasFailedWork`.
      return hasFailedWork(record) ? 'partial' : 'ready'
    case 'failed':
      return 'error'
    case 'complete':
      return 'ready'
  }
}

/**
 * Percentages are rounded for display only. The shares they come from sum to
 * exactly 1; rounding each independently can land the printed column on 99 or
 * 101, so the bar is drawn from the unrounded share and only the labels round.
 */
function mapShare(report: VisibilityReport): VisibilityViewModel['share'] {
  return toShareView(computeShareOfVoice(report.evidence, report.domain), report.domain)
}

/**
 * The mention table is keyed by NAME, so the target's row is labelled with the
 * brand the answers actually wrote when they named it, falling back to the
 * domain when no answer named it at all. Labelling that row with the domain
 * would put a domain in a table of names.
 */
function mapMentionShare(report: VisibilityReport): VisibilityViewModel['mentionShare'] {
  const label = targetBrandLabel(report)
  return toShareView(computeMentionShare(report.evidence, label), label)
}

function targetBrandLabel(report: VisibilityReport): string {
  for (const row of report.evidence) {
    // matchedTerms holds the approved aliases this answer actually wrote. The
    // domain can appear there too, and a domain is not the brand's name.
    const name = row.matchedTerms.find((term) => !term.includes('.'))
    if (name) return name
  }
  return report.domain
}

function toShareView(share: ShareOfVoice | null, targetLabel: string): VisibilityViewModel['share'] {
  if (!share) return undefined
  return {
    basis: share.basis,
    measuredAnswers: share.measuredAnswers,
    totalAppearances: share.totalAppearances,
    unattributedAnswers: share.unattributedAnswers,
    targetDomain: targetLabel,
    targetPercent: Math.round((share.targetShare ?? 0) * 100),
    tail: share.tail ? { domains: share.tail.domains, percent: Math.round(share.tail.share * 100) } : null,
    entries: share.entries.map((entry) => ({
      domain: entry.domain,
      answers: entry.answers,
      percent: Math.round(entry.share * 100),
      isTarget: entry.isTarget,
    })),
  }
}

function mapVisibility(report: VisibilityReport): VisibilityViewModel {
  const providers = uniqueProviders(report.evidence)
  const denominator = report.summary.successfulChecks
  const mentioned = report.evidence.filter((row) => row.mentioned).length
  const cited = report.evidence.filter((row) => row.cited).length
  const failed = report.summary.failedChecks
  return {
    historyKind: 'snapshot',
    share: mapShare(report),
    mentionShare: mapMentionShare(report),
    requestedAt: report.startedAt,
    checkedAt: report.completedAt,
    providers,
    summaries: {
      mentioned: {
        rate: percent(report.summary.mentionRate),
        numerator: mentioned,
        denominator,
      },
      cited: {
        rate: percent(report.summary.citationRate),
        numerator: cited,
        denominator,
      },
    },
    completedChecks: denominator,
    requestedChecks: denominator + failed,
    failedChecks: failed,
    evidence: report.evidence.map(mapEvidence),
    notice: failed > 0
      ? {
        tone: 'caution',
        title: `${failed} ${failed === 1 ? 'check' : 'checks'} unavailable`,
        // The reason leads, because that is what a row reading "Not measured"
        // makes someone ask. It is only stated when the failures agree on one;
        // with several reasons the banner would have to pick one and be wrong
        // about the rest, so it defers to the per-row evidence instead.
        detail: `${failureReason(report.evidence) ?? ''}Mention and citation rates use completed checks only.`,
      }
      : undefined,
  }
}

/** The one reason every failed check shares, or null when they disagree. */
function failureReason(evidence: readonly VisibilityEvidence[]): string | null {
  const reasons = new Set(
    evidence.filter((row) => row.mentioned === null && row.cited === null)
      .map((row) => row.error)
      // The generic sentence is the absence of a reason, and every check stored
      // before the sanitizer kept one carries it. Leading with it produces
      // "1 check unavailable. This answer-engine check was unavailable."
      .filter((error): error is string => Boolean(error) && error !== PUBLIC_CHECK_UNAVAILABLE),
  )
  if (reasons.size !== 1) return null
  const [reason] = [...reasons]
  return reason ? `${reason} ` : null
}

function uniqueProviders(evidence: readonly VisibilityEvidence[]): VisibilityViewModel['providers'] {
  const seen = new Map<string, VisibilityViewModel['providers'][number]>()
  for (const row of evidence) {
    if (seen.has(row.provider)) continue
    seen.set(row.provider, {
      id: row.provider,
      label: providerLabel(row.provider),
      model: row.requestedModel ?? undefined,
    })
  }
  return [...seen.values()]
}

function mapEvidence(row: VisibilityEvidence): QueryEvidenceViewModel {
  // The portable probe distinguishes all provider sources from the sources
  // whose URL actually matches the target. Accept the old runtime shape while
  // it rolls forward, but never mark every cited source as a target citation.
  const matchedCitationUrls = new Set(readMatchedCitationUrls(row))
  return {
    id: `${row.provider}:${row.query}:${row.completedAt}`,
    query: row.query,
    provider: row.provider,
    providerLabel: providerLabel(row.provider),
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    completedAt: row.completedAt,
    mentioned: row.mentioned,
    cited: row.cited,
    matchedTerms: row.matchedTerms,
    answerText: row.answerText,
    sources: row.sources.map((source) => ({
      url: source.url,
      title: source.title,
      isTargetDomain: matchedCitationUrls.has(source.url),
    })),
    searchQueries: row.searchQueries,
    retrievalStatus: mapRetrievalStatus(row.retrievalStatus),
    error: row.error,
  }
}

function readMatchedCitationUrls(row: VisibilityEvidence): readonly string[] {
  return (row as VisibilityEvidence & { matchedCitationUrls?: readonly string[] }).matchedCitationUrls ?? []
}

function percent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value * 100))
}

function mapRetrievalStatus(status: VisibilityEvidence['retrievalStatus']): QueryEvidenceViewModel['retrievalStatus'] {
  if (status === 'error') return 'failed'
  if (status === 'grounded') return 'success'
  if (status === 'not-grounded') return 'not-measured'
  return 'pending'
}

function mapSiteHealth(sample: SiteHealthSample, checkedAt: string): NonNullable<CanonryDemoViewModel['siteHealth']> {
  const complete = sample.pages.filter((page) => page.status === 'success').length
  const failed = sample.pages.filter((page) => page.status === 'error').length
  const attempted = Math.min(5, Math.max(sample.pages.length, sample.pagesObserved))
  return {
    sampleLabel: sample.label,
    score: sample.score,
    discoveredPages: sample.pagesDiscovered,
    attemptedPages: attempted,
    completedPages: complete,
    failedPages: failed,
    checkedAt,
    // Best score first. Alphabetical order reads as a list of names; ranked
    // order reads as a result, with the work to do gathered at the bottom.
    factors: orderFactors(
      sample.factors.map((factor) => {
        const state = factorState(sample, factor.id, factor.count)
        const evidence = factorEvidence(sample, factor.id)
        return {
          id: factor.id,
          label: factor.name,
          state,
          score: state === 'measured' ? factor.averageScore : null,
          findings: evidence.findings,
          recommendations: evidence.recommendations,
          detail: state === 'measured'
            ? `Measured across ${factor.count} sampled ${factor.count === 1 ? 'page' : 'pages'}.`
            : state === 'not-applicable'
            ? 'Not applicable to the sampled page types.'
            : 'Not measured in this sample.',
        }
      }),
      (factor) => ({ score: factor.score, label: factor.label }),
    ),
    criticalDefects: criticalDefects(sample),
    worstPages: sample.pages.map(mapSiteHealthPage),
    // Passed through as measured. A crawl with no usable graph stays absent
    // rather than becoming an empty diagram that implies a site with no links.
    siteMap: sample.siteMap && sample.siteMap.nodes.length > 0
      ? {
        nodes: sample.siteMap.nodes,
        edges: sample.siteMap.edges,
        totalPages: sample.siteMap.totalPages,
        totalEdges: sample.siteMap.totalEdges,
        truncated: sample.siteMap.truncated,
      }
      : undefined,
    terminationReason: sample.terminationReason,
    provenance: {
      schemaVersion: sample.schemaVersion,
      rootUrl: sample.rootUrl,
      finalRootUrl: sample.finalRootUrl,
      attemptedHosts: sample.attemptedHosts,
      engineVersion: readOptionalString(sample, 'engineVersion') ?? readOptionalString(sample, 'crawlEngineVersion'),
    },
    notice: sample.status === 'error' || sample.error
      ? {
        tone: 'caution',
        title: 'Site sample unavailable',
        detail: sample.error ?? 'The Technical AEO sample could not complete.',
      }
      // Same rule as the top-level caution: warn about pages that FAILED, not
      // about a stored status. A crawl that stopped at its own page cap is the
      // sample working, and `sample.status` is frozen at check time so a
      // corrected rule never reaches a record already written.
      : failed > 0
      ? {
        tone: 'caution',
        title: 'Partial site sample',
        detail: `${failed} of ${attempted} sampled ${attempted === 1 ? 'page' : 'pages'} could not be audited. ` +
          'Only completed pages contribute to the shown evidence.',
      }
      : sample.warnings.length
      ? { tone: 'caution', title: 'Sample warning', detail: sample.warnings[0]! }
      : undefined,
  }
}

function factorState(sample: SiteHealthSample, factorId: string, count: number): SiteHealthFactorViewModel['state'] {
  if (count > 0) return 'measured'
  const sampled = sample.pages.flatMap((page) => page.factors.filter((factor) => factor.id === factorId))
  if (sampled.length > 0 && sampled.every((factor) => factor.applicable === false)) return 'not-applicable'
  return 'unavailable'
}

function readOptionalString(value: object, key: string): string | null {
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

function mapSiteHealthPage(page: SiteHealthPageSample): SiteHealthPageViewModel {
  const findings = [
    ...page.criticalDefects.map((defect) => defect.detail),
    ...page.factors.flatMap((factor) => factor.findings.map((finding) => finding.message)),
    ...(page.error ? [page.error] : []),
  ].filter(Boolean).slice(0, 6)
  return {
    url: page.url,
    score: page.score,
    status: page.status === 'error' ? 'unavailable' : (page.score ?? 0) >= 80 ? 'good' : 'needs-attention',
    findings,
    indexable: indexability(page.indexability),
  }
}

/**
 * Findings and fixes belong to the factor they came from.
 *
 * They used to be flattened into one "Top fixes" column beside a "Factors"
 * column, which separated a problem from its cause and printed the factor name
 * as the fix's own subtitle: the two columns restated each other. Aggregating
 * per factor, the way the dashboard's page audit does, means one row carries
 * the name, the score, the evidence, and what to do about it.
 *
 * Deduped across sampled pages because five pages of one template produce five
 * copies of the same sentence, and a list of five identical fixes reads as five
 * problems.
 */
function factorEvidence(sample: SiteHealthSample, factorId: string): {
  findings: string[]
  recommendations: string[]
} {
  const findings = new Set<string>()
  const recommendations = new Set<string>()
  for (const page of sample.pages) {
    for (const factor of page.factors) {
      if (factor.id !== factorId) continue
      for (const finding of factor.findings) if (finding.message) findings.add(finding.message)
      for (const recommendation of factor.recommendations) if (recommendation) recommendations.add(recommendation)
    }
  }
  return { findings: [...findings], recommendations: [...recommendations] }
}

/**
 * Defects sit outside the score, so they stay visible rather than collapsing
 * behind a disclosure with everything else.
 */
function criticalDefects(sample: SiteHealthSample): SiteHealthDefectViewModel[] {
  const byKey = new Map<string, SiteHealthDefectViewModel>()
  for (const page of sample.pages) {
    for (const defect of page.criticalDefects) {
      const key = `${defect.id}:${defect.detail}`
      const existing = byKey.get(key)
      if (existing) existing.pages += 1
      else {
        byKey.set(key, {
          id: defect.id,
          severity: defect.severity,
          detail: defect.detail,
          recommendation: defect.recommendation,
          pages: 1,
        })
      }
    }
  }
  return [...byKey.values()]
}

function indexability(value: string | null): boolean | null {
  if (!value) return null
  if (value === 'eligible' || value === 'indexable') return true
  if (value === 'hidden' || value === 'failed' || value === 'not-indexable') return false
  return null
}

function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    claude: 'Claude',
    perplexity: 'Perplexity',
  }
  return known[provider] ?? (provider ? `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}` : 'Unknown engine')
}

function buildNotice(record: CheckRecord | null, result: CheckResult | null): CanonryDemoViewModel['notice'] {
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
      detail: record.errorMessage ?? 'Try another public domain later.',
    }
  }
  if (result?.errors.length) {
    const first = result.errors[0]!
    return {
      tone: 'caution',
      title: first.area === 'visibility' ? 'Visibility was unavailable' : 'Site sample was unavailable',
      detail: first.message,
    }
  }
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
 * It carries no `visibility` and no `siteHealth` because nothing has been
 * measured yet. Earlier this page rendered a fixture — four answer engines,
 * a four-week trend, invented model identifiers — labelled only by a badge in
 * the header, well above the numbers it qualified. Anyone scrolling read
 * fabricated data as measurement, and it advertised three engines this tool
 * does not run. An empty state is the honest thing to show when the answer is
 * "nothing yet".
 */
export function emptyLandingViewModel(form: CheckFormViewModel): CanonryDemoViewModel {
  return {
    status: 'empty',
    title: 'AI Visibility Check',
    displayName: 'Check a domain',
    domain: '',
    form,
  }
}
