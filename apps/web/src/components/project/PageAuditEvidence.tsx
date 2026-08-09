import type {
  SiteAuditFactorStatus,
  SiteCrawlPageAuditDto,
} from '@ainyc/canonry-contracts'
import { ChevronRight } from 'lucide-react'

import type { MetricTone } from '../../view-models.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'

function scoreTone(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

function scoreStatus(score: number): SiteAuditFactorStatus {
  if (score >= 70) return 'pass'
  if (score >= 40) return 'partial'
  return 'fail'
}

function factorTone(status: SiteAuditFactorStatus): MetricTone {
  if (status === 'pass') return 'positive'
  if (status === 'partial') return 'caution'
  return 'negative'
}

function stateLabel(status: SiteAuditFactorStatus): string {
  if (status === 'pass') return 'Pass'
  if (status === 'partial') return 'Partial'
  return 'Fail'
}

export function PageAuditEvidence({
  audit,
  isLoading,
  error,
  onRetry,
}: {
  audit: SiteCrawlPageAuditDto | undefined
  isLoading: boolean
  error: Error | null
  onRetry: () => void
}) {
  return (
    <section className="border-t border-default pt-5" aria-labelledby="site-health-page-audit-heading">
      <div>
        <h3 id="site-health-page-audit-heading" className="text-base font-semibold text-heading">
          Why this technical score
        </h3>
        <p className="mt-1 text-sm text-secondary">Findings and fixes from this page in the selected scan.</p>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-secondary" role="status">Loading technical findings...</p>
      ) : error ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-negative bg-negative-soft px-4 py-3" role="alert">
          <p className="text-sm text-negative">Technical findings could not be loaded.</p>
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Retry technical findings</Button>
        </div>
      ) : !audit ? (
        <p className="mt-4 text-sm text-secondary">Technical findings are unavailable for this page.</p>
      ) : audit.state === 'no-crawl' ? (
        <p className="mt-4 text-sm text-secondary">No Site Health scan is available.</p>
      ) : audit.state === 'details-unavailable' ? (
        <p className="mt-4 text-sm text-secondary">This scan preserved its summary, but not page-level audit evidence.</p>
      ) : audit.state === 'not-found' ? (
        <p className="mt-4 text-sm text-secondary">This page is not present in the selected scan.</p>
      ) : audit.state === 'not-audited' ? (
        <p className="mt-4 text-sm text-secondary">This page was discovered, but it was not technically audited.</p>
      ) : (
        <ReadyPageAudit audit={audit} />
      )}
    </section>
  )
}

function ReadyPageAudit({ audit }: {
  audit: Extract<SiteCrawlPageAuditDto, { state: 'ready' }>
}) {
  const actionableFactors = audit.factors.filter((factor) => (
    factor.applicable !== false
    && (factor.status !== 'pass' || factor.findings.some((finding) => (
      finding.type === 'missing' || finding.type === 'timeout' || finding.type === 'unreachable'
    )))
  ))

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          aria-label={`Technical score ${Math.round(audit.auditScore)} out of 100`}
          className="font-mono text-2xl font-semibold tabular-nums text-heading"
        >
          {Math.round(audit.auditScore)}<span className="text-sm text-muted">/100</span>
        </span>
        <ToneBadge tone={scoreTone(audit.auditScore)}>{stateLabel(scoreStatus(audit.auditScore))}</ToneBadge>
      </div>

      {audit.evidenceState === 'scores-only' && (
        <p className="mt-3 border border-caution bg-caution-soft px-3 py-2 text-sm text-caution">
          This older scan preserved factor scores, but not the original finding text or fixes.
        </p>
      )}

      {audit.criticalDefects.length > 0 && (
        <section className="mt-5" aria-labelledby="site-health-critical-defects-heading">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="site-health-critical-defects-heading" className="text-sm font-semibold text-heading">Score-independent defects</h4>
            <ToneBadge tone={audit.criticalDefects.some((defect) => defect.severity === 'critical') ? 'negative' : 'caution'}>
              {audit.criticalDefects.length}
            </ToneBadge>
            <span className="text-xs text-muted">Not included in the weighted score</span>
          </div>
          <ul className="mt-2 divide-y divide-default border-y border-default">
            {audit.criticalDefects.map((defect) => (
              <li key={defect.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-heading">{defect.detail}</p>
                  <ToneBadge tone={defect.severity === 'critical' ? 'negative' : 'caution'}>
                    {defect.severity === 'critical' ? 'Critical' : 'Warning'}
                  </ToneBadge>
                </div>
                <p className="mt-1 text-sm text-secondary"><span className="font-medium text-heading">Fix:</span> {defect.recommendation}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {actionableFactors.length > 0 ? (
        <div className="mt-5 divide-y divide-default border-y border-default">
          {actionableFactors.map((factor, index) => (
            <details key={factor.id} open={index === 0} className="group py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-sm px-1 py-2 outline-none marker:hidden focus-visible:ring-2 focus-visible:ring-mono-400 [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-heading">
                  <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
                  {factor.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm tabular-nums text-heading">{Math.round(factor.score)}/100</span>
                  <ToneBadge tone={factorTone(factor.status)}>{stateLabel(factor.status)}</ToneBadge>
                </span>
              </summary>
              <div className="grid gap-4 px-1 pb-4 pt-1 md:grid-cols-2">
                <div>
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Evidence</h5>
                  {factor.findings.length > 0 ? (
                    <ul className="mt-2 space-y-1.5 text-sm text-secondary">
                      {factor.findings.map((finding, findingIndex) => (
                        <li key={`${finding.code}:${findingIndex}`}>{finding.message}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-secondary">
                      {audit.evidenceState === 'scores-only'
                        ? 'Finding text was not preserved for this factor.'
                        : 'No finding text was emitted for this factor.'}
                    </p>
                  )}
                </div>
                <div>
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Recommended fix</h5>
                  {factor.recommendations.length > 0 ? (
                    <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-secondary marker:text-muted">
                      {factor.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-secondary">
                      {audit.evidenceState === 'scores-only'
                        ? 'No page-specific fix was preserved.'
                        : 'No page-specific fix was emitted.'}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-muted">Weight: {factor.weight}% of the page score</p>
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : audit.criticalDefects.length === 0 && audit.evidenceState === 'complete' ? (
        <p className="mt-4 border-y border-positive bg-positive-soft px-4 py-3 text-sm text-positive">
          No technical findings need attention on this page.
        </p>
      ) : audit.criticalDefects.length === 0 ? (
        <p className="mt-4 border-y border-default px-4 py-3 text-sm text-secondary">
          No below-pass factor scores were preserved. Detailed finding evidence is unavailable.
        </p>
      ) : null}
    </div>
  )
}
