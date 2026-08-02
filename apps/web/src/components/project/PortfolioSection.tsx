import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LocationContext,
  MeasurementDiscoveryRequest,
  MeasurementDiscoveryResponse,
  MeasurementPlanCompilePreviewResponse,
  MeasurementPlanDiffPreviewResponse,
  MeasurementPlanInput,
  MeasurementPlanResponse,
  MeasurementReportResponse,
} from '@ainyc/canonry-api-client'

import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import {
  applyQuerySet,
  clearTargetAssignments,
  confirmTarget,
  createDraftFromDiscovery,
  expandQueryTemplate,
  mapExpandedTemplateQueries,
  parsePortfolioDraft,
  reconcileDraftWithDiscovery,
  removeTargetUrl,
  rejectTarget,
  resolveCoverageReviews,
  reviewAllExceptions,
  reviewExceptions,
  serializePortfolioDraft,
  stateFromActivePlan,
  toMeasurementPlanInput,
  upsertQuerySet,
  upsertQueryTemplate,
  upsertReportingGroup,
  validatePortfolioDraft,
  type DraftExecutionContext,
  type PortfolioSetupDraft,
} from './portfolio-setup-model.js'

type ProjectQuery = { id: string; query: string }
type ActivePlan = MeasurementPlanResponse['active']
type Stage = 0 | 1 | 2 | 3 | 4

export type PortfolioSectionProps = {
  projectName: string
  locations: readonly LocationContext[]
  queries: readonly ProjectQuery[]
  isQueryLoading: boolean
  isQueryError: boolean
  onRetryQueries?: () => void
  activePlan: ActivePlan | null
  isPlanLoading: boolean
  isPlanError: boolean
  onRetryPlan?: () => void
  report: MeasurementReportResponse | null
  isReportLoading: boolean
  isReportError: boolean
  onRetryReport?: () => void
  onDiscover: (request: MeasurementDiscoveryRequest) => Promise<MeasurementDiscoveryResponse>
  onCreateQueries: (texts: readonly string[]) => Promise<readonly ProjectQuery[]>
  onCompilePlan: (input: MeasurementPlanInput) => Promise<MeasurementPlanCompilePreviewResponse>
  onDiffPlan: (input: MeasurementPlanInput) => Promise<MeasurementPlanDiffPreviewResponse>
  onPublishPlan: (input: MeasurementPlanInput, expectedActiveRevision: number | null) => Promise<MeasurementPlanResponse>
}

const stages = ['Import', 'Targets', 'Queries', 'Review & publish', 'Report'] as const
const memoryStorage = new Map<string, string>()
const TARGET_PAGE_SIZE = 50
const PROJECT_DEFAULT_CONTEXT = '__project_default__'
const NO_LOCATION_CONTEXT = '__no_location__'

function storageKey(projectName: string): string {
  return `canonry:portfolio-draft:${projectName}`
}

function readStoredDraft(projectName: string): PortfolioSetupDraft | null {
  const key = storageKey(projectName)
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(key) ?? memoryStorage.get(key)
    return stored ? parsePortfolioDraft(stored) : null
  } catch {
    const fallback = memoryStorage.get(key)
    if (!fallback) return null
    try {
      return parsePortfolioDraft(fallback)
    } catch {
      return null
    }
  }
}

function saveDraft(projectName: string, draft: PortfolioSetupDraft): void {
  const value = serializePortfolioDraft(draft)
  memoryStorage.set(storageKey(projectName), value)
  try {
    window.localStorage.setItem(storageKey(projectName), value)
  } catch {
    // The in-memory copy keeps setup usable when local storage is restricted.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function contextFromChoice(choice: string, locations: readonly LocationContext[]): DraftExecutionContext {
  if (choice === PROJECT_DEFAULT_CONTEXT) return undefined
  if (choice === NO_LOCATION_CONTEXT) return null
  return locations.find(location => location.label === choice)
}

function contextLabel(context: DraftExecutionContext): string {
  if (context === undefined) return 'Project default'
  if (context === null) return 'No location'
  return context.label
}

function contextsMatch(left: DraftExecutionContext, right: DraftExecutionContext): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left === null || right === null) return left === right
  return left.label === right.label
}

function friendlyCheckName(id: MeasurementPlanCompilePreviewResponse['checks'][number]['id']): string {
  const labels: Record<typeof id, string> = {
    'invalid-authoring': 'Plan details need attention',
    'duplicate-identity': 'Duplicate name or URL',
    'unknown-target': 'Target not found',
    'unknown-query': 'Tracked query not found',
    'invalid-project-context': 'Location is not available',
    'unowned-target-url': 'URL is outside this project',
    'owned-competitor': 'Competitor domain belongs to this project',
    'target-query-context-conflict': 'Query location conflict',
    'target-url-ownership-tie': 'Target URL conflict',
    'target-alias-cross-target-collision': 'Target name conflict',
    'target-alias-project-brand-collision': 'Project name conflict',
    'target-alias-prefix-overlap': 'Similar Target names',
  }
  return labels[id]
}

function matcherLabel(url: PortfolioSetupDraft['targets'][number]['urls'][number]): string {
  if (url.kind === 'exact') return url.url
  if (url.kind === 'prefix') return `https://${url.host}${url.pathPrefix}`
  return `https://${url.host}`
}

function rateLabel(
  rate: MeasurementReportResponse['targets'][number]['citationCoverage'],
  completeness: MeasurementReportResponse['targets'][number]['completeness'],
  hasStoredResult = true,
): string {
  if (!hasStoredResult) return 'No stored result'
  if (!completeness.complete) {
    return `Incomplete: ${completeness.executed}/${completeness.expected}`
  }
  if (rate.rate !== null) return `${Math.round(rate.rate * 100)}%`
  if (rate.reason === 'incomplete' || rate.reason === 'evidence-incomplete') {
    return `Incomplete: ${completeness.executed}/${completeness.expected}`
  }
  if (rate.reason === 'no-population') return 'No tracked queries'
  return 'N/A'
}

function completenessLabel(
  completeness: MeasurementReportResponse['targets'][number]['completeness'],
  hasStoredResult = true,
): string {
  if (!hasStoredResult) return 'Not measured'
  return completeness.complete
    ? `${completeness.executed}/${completeness.expected}`
    : `Incomplete: ${completeness.executed}/${completeness.expected}`
}

function evidenceTone(classification: MeasurementReportResponse['evidence'][number]['classification']) {
  return classification === 'assigned'
    ? 'positive'
    : classification === 'external'
      ? 'neutral'
      : classification === 'invalid'
        ? 'negative'
        : 'caution'
}

function evidenceLabel(classification: MeasurementReportResponse['evidence'][number]['classification']): string {
  const labels: Record<typeof classification, string> = {
    assigned: 'Assigned',
    sibling: 'Sibling',
    ownedUnmapped: 'Owned, not mapped',
    external: 'External',
    ambiguous: 'Ambiguous',
    invalid: 'Invalid URL',
  }
  return labels[classification]
}

function PortfolioReport({
  activePlan,
  report,
  isLoading,
  isError,
  onRetry,
}: {
  activePlan: ActivePlan | null
  report: MeasurementReportResponse | null
  isLoading: boolean
  isError: boolean
  onRetry?: () => void
}) {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)

  if (isError && !activePlan) {
    return (
      <div className="rounded-md border border-negative-800/40 bg-negative-950/20 p-4 text-sm text-negative">
        <p>Could not load measurement setup.</p>
        {onRetry ? <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>Try again</Button> : null}
      </div>
    )
  }
  if (!activePlan) {
    return <p className="text-sm text-secondary">Publish a measurement plan before opening the report.</p>
  }
  if (isLoading && !report) {
    return <div className="h-28 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading report" />
  }
  if (isError && !report) {
    return (
      <div className="rounded-md border border-negative-800/40 bg-negative-950/20 p-4 text-sm text-negative">
        <p>Could not load the report for revision {activePlan.revision}.</p>
        {onRetry ? <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>Try again</Button> : null}
      </div>
    )
  }
  if (!report) {
    return <p className="text-sm text-secondary">No stored measurement result is available for revision {activePlan.revision}.</p>
  }
  if (report.revision !== activePlan.revision) {
    return (
      <div className="rounded-md border border-caution-800/40 bg-caution-950/20 p-4 text-sm text-caution">
        <p>The saved report does not match active revision {activePlan.revision}.</p>
        {onRetry ? <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>Refresh report</Button> : null}
      </div>
    )
  }

  // Every answer carries a baseline usage edge as well as the Target's own, and
  // from the baseline edge no Target is the assigned one — so a Target's own URL
  // classifies as `sibling` there and `assigned` here. Both are right, but
  // showing both put the same URL on screen twice under contradictory labels.
  // A Target's evidence is the evidence gathered for that Target.
  const selectedEvidence = selectedTargetId
    ? report.evidence.filter(item => item.usageEdgeType === 'target' && item.matchedTargetIds.includes(selectedTargetId))
    : []
  const reviewEvidence = report.evidence.filter(item => item.usageEdgeType === 'target' && (item.classification === 'sibling' || item.classification === 'ambiguous'))
  const hasStoredResult = report.run !== null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone="neutral">Revision {report.revision}</ToneBadge>
        {report.run ? (
          <ToneBadge tone={report.run.status === 'completed' ? 'positive' : 'caution'}>
            {report.run.status === 'completed' ? 'Complete' : 'Partial result'}
          </ToneBadge>
        ) : <ToneBadge tone="neutral">No stored result</ToneBadge>}
        {isError ? <span className="text-sm text-caution">Refresh failed. Showing saved data.</span> : null}
      </div>

      {report.groups.length > 0 ? (
        <section aria-labelledby="group-report-title">
          <div className="section-head"><h3 id="group-report-title">Reporting groups</h3></div>
          <div className="overflow-x-auto rounded-md border border-default">
            <table className="evidence-table min-w-[780px]">
              <thead><tr><th>Group</th><th>Targets</th><th>Completeness</th><th>Answer coverage</th><th>Target coverage</th><th>Competitor share of voice</th></tr></thead>
              <tbody>{report.groups.map(group => {
                const competitors = group.sov.domains.filter(domain => !domain.own)
                return <tr key={group.id}><td className="font-medium text-heading">{group.label}</td><td className="tabular-nums text-secondary">{group.targetIds.length}</td><td className="tabular-nums text-secondary">{completenessLabel(group.completeness, hasStoredResult)}</td><td className="text-secondary">{rateLabel(group.answerCoverage, group.completeness, hasStoredResult)}</td><td className="text-secondary">{rateLabel(group.targetCoverage, group.completeness, hasStoredResult)}</td><td className="text-secondary">{competitors.length === 0 ? 'No competitors' : competitors.map(domain => `${domain.domain} ${domain.presentIn === null ? 'N/A' : `${Math.round((domain.presentIn / domain.of) * 100)}%`}`).join(', ')}</td></tr>
              })}</tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-default">
        <table className="evidence-table min-w-[760px]">
          <caption className="sr-only">Measurement results by Target</caption>
          <thead><tr><th>Target</th><th>Completeness</th><th>Citation coverage</th><th>Mention coverage</th><th><span className="sr-only">Evidence</span></th></tr></thead>
          <tbody>
            {report.targets.map(target => (
              <tr key={target.id}>
                <td className="font-medium text-heading">{target.label}</td>
                <td className="tabular-nums text-secondary">
                  {completenessLabel(target.completeness, hasStoredResult)}
                </td>
                <td className="tabular-nums text-secondary">{rateLabel(target.citationCoverage, target.completeness, hasStoredResult)}</td>
                <td className="tabular-nums text-secondary">{rateLabel(target.mentionCoverage, target.completeness, hasStoredResult)}</td>
                <td className="text-right"><Button size="sm" variant="outline" onClick={() => setSelectedTargetId(target.id)}>Show URLs matched to {target.label}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reviewEvidence.length > 0 ? (
        <section aria-labelledby="evidence-review-title">
          <div className="section-head">
            <div>
              <h3 id="evidence-review-title">Evidence requiring review</h3>
              <p className="mt-1 max-w-2xl text-sm text-secondary">Ambiguous evidence is not credited to a Target. Sibling evidence remains visible for context.</p>
            </div>
          </div>
          <EvidenceTable evidence={reviewEvidence} />
        </section>
      ) : null}

      {selectedTargetId ? (
        <section aria-live="polite" aria-labelledby="target-evidence-title">
          <div className="section-head"><h3 id="target-evidence-title">Matched URL evidence</h3></div>
          {selectedEvidence.length > 0 ? <EvidenceTable evidence={selectedEvidence} /> : <p className="text-sm text-secondary">No cited URL matched this Target.</p>}
        </section>
      ) : null}
    </div>
  )
}

function EvidenceTable({ evidence }: { evidence: readonly MeasurementReportResponse['evidence'][number][] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-default">
      <table className="evidence-table min-w-[880px]">
        <caption className="sr-only">Stored citation evidence</caption>
        <thead><tr><th>Status</th><th>Engine</th><th>Tracked query</th><th>Location</th><th>Source URL</th></tr></thead>
        <tbody>
          {evidence.map(item => (
            <tr key={`${item.observationId}:${item.usageEdgeId}:${item.sourceUrl}`}>
              <td><ToneBadge tone={evidenceTone(item.classification)}>{evidenceLabel(item.classification)}</ToneBadge></td>
              <td className="text-secondary">{item.provider}</td>
              <td className="text-secondary">{item.queryText}</td>
              <td className="text-secondary">{item.location ?? 'No location'}</td>
              <td className="max-w-md break-all text-secondary">{item.sourceUrl}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PortfolioSection(props: PortfolioSectionProps) {
  const {
    projectName,
    locations,
    queries,
    isQueryLoading,
    isQueryError,
    onRetryQueries,
    activePlan,
    isPlanLoading,
    isPlanError,
    onRetryPlan,
    report,
    isReportLoading,
    isReportError,
    onRetryReport,
    onDiscover,
    onCreateQueries,
    onCompilePlan,
    onDiffPlan,
    onPublishPlan,
  } = props
  const [initialState] = useState(() => {
    const stored = readStoredDraft(projectName)
    const active = !isPlanLoading && activePlan ? stateFromActivePlan(activePlan.plan) : null
    return {
      draft: stored ?? active,
      source: stored ? 'local' as const : active ? 'active' as const : 'empty' as const,
      activeKey: activePlan && !isPlanLoading ? `${activePlan.revision}:${activePlan.checksum}` : null,
    }
  })
  const [draft, setDraftState] = useState<PortfolioSetupDraft | null>(initialState.draft)
  const [draftSource, setDraftSource] = useState<'empty' | 'active' | 'local'>(initialState.source)
  // Published plan already in hand at mount goes straight to the report; an
  // unsaved local draft resumes where it was left; a project with neither is a
  // genuine first run and starts at Import.
  const [stage, setStage] = useState<Stage>(() => (
    initialState.source === 'active' ? 4 : initialState.draft ? 1 : 0
  ))
  const [sitemapUrl, setSitemapUrl] = useState('')
  const [primaryHost, setPrimaryHost] = useState('')
  // The example spelling belongs in the field's placeholder, never in its value.
  // Prefilling it reads as "this is your rule" on a project whose published plan
  // came from somewhere else entirely.
  const [primaryPath, setPrimaryPath] = useState('')
  const [aliasHost, setAliasHost] = useState('')
  const [aliasPath, setAliasPath] = useState('/{slug}')
  const [excludedSlugs, setExcludedSlugs] = useState('')
  const [discovery, setDiscovery] = useState<MeasurementDiscoveryResponse | null>(null)
  const [importDiff, setImportDiff] = useState<{ newTargets: number; changedTargets: number; reviewItems: number } | null>(null)
  const [busy, setBusy] = useState<'discover' | 'create' | 'check' | 'publish' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [targetSearch, setTargetSearch] = useState('')
  const [selectedTargetKeys, setSelectedTargetKeys] = useState<string[]>([])
  const [expandedTargetKeys, setExpandedTargetKeys] = useState<string[]>([])
  const [selectedQueryIds, setSelectedQueryIds] = useState<string[]>([])
  const [querySetName, setQuerySetName] = useState('')
  const [querySetLocation, setQuerySetLocation] = useState(PROJECT_DEFAULT_CONTEXT)
  const [templateText, setTemplateText] = useState('')
  const [templateLocation, setTemplateLocation] = useState(PROJECT_DEFAULT_CONTEXT)
  const [templateDrafts, setTemplateDrafts] = useState<Array<{ targetKey: string; text: string; context: DraftExecutionContext }>>([])
  const [groupName, setGroupName] = useState('')
  const [groupCompetitor, setGroupCompetitor] = useState('')
  const [createdQueries, setCreatedQueries] = useState<ProjectQuery[]>([])
  const [compilePreview, setCompilePreview] = useState<MeasurementPlanCompilePreviewResponse | null>(null)
  const [diffPreview, setDiffPreview] = useState<MeasurementPlanDiffPreviewResponse | null>(null)
  const [checkedBinding, setCheckedBinding] = useState<{ fingerprint: string; activeKey: string } | null>(null)
  const [publishedPlan, setPublishedPlan] = useState<ActivePlan | null>(activePlan)
  const seededActiveKeyRef = useRef<string | null>(initialState.activeKey)
  const currentFingerprintRef = useRef<string | null>(null)
  const currentActiveKeyRef = useRef<string>('none')

  const allQueries = useMemo(() => {
    const byId = new Map([...queries, ...createdQueries].map(query => [query.id, query]))
    return [...byId.values()]
  }, [queries, createdQueries])
  const queryById = useMemo(() => new Map(allQueries.map(query => [query.id, query.query])), [allQueries])
  const confirmedTargets = draft?.targets.filter(target => target.status === 'confirmed') ?? []
  const confirmedTargetSet = new Set(confirmedTargets.map(target => target.stableKey))
  const selectedConfirmedTargetKeys = selectedTargetKeys.filter(targetKey => confirmedTargetSet.has(targetKey))
  const selectedConfirmedTargetSet = new Set(selectedConfirmedTargetKeys)
  const selectedTargetsHaveAssignments = draft?.assignments.some(assignment => selectedConfirmedTargetSet.has(assignment.targetKey)) ?? false
  const proposedTargetKeys = draft?.targets.filter(target => target.status === 'proposed').map(target => target.stableKey) ?? []
  const unreviewedExceptions = draft?.exceptions.filter(item => item.status === 'unreviewed') ?? []
  const shownReviewExceptions = unreviewedExceptions.slice(0, 20)
  const pendingCoverageReviews = draft?.coverageReviews.filter(review => review.resolution === 'pending') ?? []
  const pendingCoverageTargetSet = new Set(pendingCoverageReviews.map(review => review.targetKey))
  const selectedCoverageTargetKeys = selectedTargetKeys.filter(targetKey => pendingCoverageTargetSet.has(targetKey))
  const filteredTargets = useMemo(() => {
    if (!draft) return []
    const search = targetSearch.trim().toLocaleLowerCase()
    return draft.targets.filter(target => !search || `${target.label} ${target.stableKey}`.toLocaleLowerCase().includes(search))
  }, [draft, targetSearch])
  const shownTargets = filteredTargets.slice(0, TARGET_PAGE_SIZE)
  const selectedTargetSet = new Set(selectedTargetKeys)
  const selectedQuerySet = new Set(selectedQueryIds)
  const compileFails = compilePreview?.checks.filter(check => check.severity === 'fail') ?? []
  const planDiff = diffPreview?.ok ? diffPreview.diff : null
  const draftValidation = draft ? validatePortfolioDraft(draft) : []
  const planInput = draft && draftValidation.length === 0 ? toMeasurementPlanInput(draft) : null
  const planFingerprint = planInput ? JSON.stringify(planInput) : null
  const activeKey = activePlan ? `${activePlan.revision}:${activePlan.checksum}` : 'none'
  currentFingerprintRef.current = planFingerprint
  currentActiveKeyRef.current = activeKey

  function updateDraft(next: PortfolioSetupDraft): void {
    setDraftSource('local')
    setDraftState(next)
  }

  useEffect(() => {
    if (draft && draftSource === 'local' && !isPlanLoading && !isPlanError) saveDraft(projectName, draft)
  }, [draft, draftSource, isPlanError, isPlanLoading, projectName])

  useEffect(() => {
    if (isPlanLoading || isPlanError || draftSource === 'local') return
    const nextActiveKey = activePlan ? `${activePlan.revision}:${activePlan.checksum}` : null
    if (!activePlan || seededActiveKeyRef.current === nextActiveKey) return
    setDraftState(stateFromActivePlan(activePlan.plan))
    setDraftSource('active')
    seededActiveKeyRef.current = nextActiveKey
    // A project whose plan is already published is not being set up, it is being
    // read. Land on the report; the setup steps stay one click away for anyone
    // who came here to change something. Landing on a setup step made a
    // configured project look unconfigured.
    setStage(4)
  }, [activePlan, draftSource, isPlanError, isPlanLoading])

  useEffect(() => {
    setPublishedPlan(activePlan)
  }, [activePlan])

  useEffect(() => {
    setCompilePreview(null)
    setDiffPreview(null)
    setCheckedBinding(null)
  }, [activeKey, draft])

  function toggleTarget(key: string, selected: boolean): void {
    setSelectedTargetKeys(current => selected ? [...new Set([...current, key])] : current.filter(item => item !== key))
  }

  function selectTargetKeys(keys: readonly string[]): void {
    setSelectedTargetKeys(current => [...new Set([...current, ...keys])])
  }

  async function importSitemap(): Promise<void> {
    if (!sitemapUrl.trim() || !primaryHost.trim() || !primaryPath.trim()) return
    setBusy('discover')
    setActionError(null)
    try {
      const response = await onDiscover({
        sitemapUrl: sitemapUrl.trim(),
        rule: {
          primary: { host: primaryHost.trim(), pathTemplate: primaryPath.trim() },
          ...(aliasHost.trim() && aliasPath.trim() ? { aliases: [{ host: aliasHost.trim(), pathTemplate: aliasPath.trim() }] } : {}),
          ...(excludedSlugs.trim() ? {
            excludedSlugPatterns: [...new Set(excludedSlugs.split(/[,\n]+/).map(value => value.trim()).filter(Boolean))]
              .map(value => ({ kind: 'exact' as const, value })),
          } : {}),
        },
      })
      const nextDraft = draft ? reconcileDraftWithDiscovery(draft, response) : createDraftFromDiscovery(response)
      const before = new Map((draft?.targets ?? []).map(target => [target.stableKey, target]))
      const incoming = new Map(createDraftFromDiscovery(response).targets.map(target => [target.stableKey, target]))
      const newTargets = [...incoming.keys()].filter(key => !before.has(key)).length
      const changedTargets = draft ? [...before.entries()].filter(([key, target]) => {
        const updated = incoming.get(key)
        if (!updated) return true
        const oldUrls = target.urls.map(matcherLabel).sort().join('\u0000')
        const newUrls = updated.urls.map(matcherLabel).sort().join('\u0000')
        return oldUrls !== newUrls
      }).length : 0
      setDiscovery(response)
      setImportDiff({ newTargets, changedTargets, reviewItems: nextDraft.exceptions.filter(item => item.status === 'unreviewed').length })
      updateDraft(nextDraft)
      setSelectedTargetKeys([])
      setTargetSearch('')
    } catch (error) {
      setActionError(errorMessage(error, 'Could not import this sitemap.'))
    } finally {
      setBusy(null)
    }
  }

  function setSelectedTargetStatus(status: 'confirmed' | 'rejected'): void {
    if (!draft) return
    updateDraft(selectedTargetKeys.reduce(
      (current, key) => status === 'confirmed' ? confirmTarget(current, key) : rejectTarget(current, key),
      draft,
    ))
    setSelectedTargetKeys([])
  }

  function resolveSelectedCoverage(resolution: 'keep-existing' | 'replace-with-imported'): void {
    if (!draft || selectedCoverageTargetKeys.length === 0) return
    setActionError(null)
    try {
      updateDraft(resolveCoverageReviews(draft, selectedCoverageTargetKeys, resolution))
      setSelectedTargetKeys([])
    } catch (error) {
      setActionError(errorMessage(error, 'Could not resolve these URL coverage changes.'))
    }
  }

  function saveQuerySet(): void {
    if (!draft || !querySetName.trim() || selectedQueryIds.length === 0) return
    const key = querySetName.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `set-${draft.querySets.length + 1}`
    const context = contextFromChoice(querySetLocation, locations)
    updateDraft(upsertQuerySet(draft, { key, label: querySetName.trim(), queryIds: [...new Set(selectedQueryIds)], context }))
    setQuerySetName('')
    setSelectedQueryIds([])
  }

  function applySet(setKey: string): void {
    if (!draft || selectedConfirmedTargetKeys.length === 0) return
    setActionError(null)
    try {
      updateDraft(applyQuerySet(draft, setKey, selectedConfirmedTargetKeys))
    } catch (error) {
      setActionError(errorMessage(error, 'Could not apply this query set.'))
    }
  }

  function previewTemplate(): void {
    if (!draft || !templateText.trim() || !templateText.includes('{target.label}')) return
    const context = contextFromChoice(templateLocation, locations)
    if (selectedConfirmedTargetKeys.length === 0) return
    setActionError(null)
    try {
      const withTemplate = upsertQueryTemplate(draft, {
        key: 'current-template',
        label: 'Current template',
        template: templateText.trim(),
        context,
      })
      updateDraft(withTemplate)
      setTemplateDrafts(expandQueryTemplate(withTemplate, 'current-template', selectedConfirmedTargetKeys).map(item => ({
        targetKey: item.targetKey,
        text: item.queryText,
        context: item.context,
      })))
    } catch (error) {
      setActionError(errorMessage(error, 'Could not preview these query drafts.'))
    }
  }

  async function createTemplateQueries(): Promise<void> {
    if (!draft || templateDrafts.length === 0) return
    setBusy('create')
    setActionError(null)
    try {
      const created = await onCreateQueries(templateDrafts.map(item => item.text))
      setCreatedQueries(current => [...current, ...created])
      const withTemplate = upsertQueryTemplate(draft, {
        key: 'current-template',
        label: 'Current template',
        template: templateText.trim(),
        context: contextFromChoice(templateLocation, locations),
      })
      updateDraft(mapExpandedTemplateQueries(
        withTemplate,
        templateDrafts.map(item => ({ targetKey: item.targetKey, queryText: item.text, context: item.context })),
        created,
      ))
      setTemplateDrafts([])
      setTemplateText('')
    } catch (error) {
      setActionError(errorMessage(error, 'Could not create the reviewed queries.'))
    } finally {
      setBusy(null)
    }
  }

  function saveReportingGroup(): void {
    if (!draft || !groupName.trim() || selectedConfirmedTargetKeys.length === 0) return
    const stableKey = `group-${groupName.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    updateDraft(upsertReportingGroup(draft, {
      stableKey,
      label: groupName.trim(),
      targetKeys: [...selectedConfirmedTargetKeys],
      ...(groupCompetitor.trim() ? { competitors: [...new Set(groupCompetitor.split(/[\s,]+/).map(value => value.trim()).filter(Boolean))] } : {}),
    }))
    setGroupName('')
    setGroupCompetitor('')
  }

  async function checkPlan(): Promise<void> {
    if (!planInput || !planFingerprint) return
    const checkedFingerprint = planFingerprint
    const checkedActiveKey = activeKey
    setBusy('check')
    setActionError(null)
    try {
      const [compile, diff] = await Promise.all([onCompilePlan(planInput), onDiffPlan(planInput)])
      if (currentFingerprintRef.current !== checkedFingerprint || currentActiveKeyRef.current !== checkedActiveKey) return
      setCompilePreview(compile)
      setDiffPreview(diff)
      setCheckedBinding({ fingerprint: checkedFingerprint, activeKey: checkedActiveKey })
    } catch (error) {
      setActionError(errorMessage(error, 'Could not check this plan.'))
    } finally {
      setBusy(current => current === 'check' ? null : current)
    }
  }

  async function publishPlan(): Promise<void> {
    if (!planInput || !planFingerprint || !compilePreview?.ok || compileFails.length > 0) return
    if (!checkedBinding || checkedBinding.fingerprint !== planFingerprint || checkedBinding.activeKey !== activeKey) {
      setActionError('Check the current draft again before publishing.')
      return
    }
    setBusy('publish')
    setActionError(null)
    try {
      const response = await onPublishPlan(planInput, activePlan?.revision ?? null)
      setPublishedPlan(response.active)
    } catch (error) {
      setActionError(errorMessage(error, 'Could not publish this plan.'))
    } finally {
      setBusy(null)
    }
  }

  if (isPlanLoading) {
    return (
      <div className="space-y-4">
        <div className="section-head"><div><h2>Portfolio setup</h2><p className="mt-1 text-sm text-secondary">Loading the active measurement setup.</p></div></div>
        <div className="h-32 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading measurement setup" />
      </div>
    )
  }

  if (isPlanError) {
    return (
      <div className="space-y-4">
        <div className="section-head"><h2>Portfolio setup</h2></div>
        <div className="rounded-md border border-negative-800/40 bg-negative-950/20 p-4 text-sm text-negative">
          <p>Could not load measurement setup. Setup and publishing are unavailable until this is resolved.</p>
          {onRetryPlan ? <Button className="mt-3" size="sm" variant="outline" onClick={onRetryPlan}>Try again</Button> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="section-head section-head-inline">
        <div>
          <h2>Portfolio setup</h2>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Define Targets, URL coverage, and the tracked queries each Target measures.</p>
        </div>
        {publishedPlan ? <ToneBadge tone="positive">Active revision {publishedPlan.revision}</ToneBadge> : <ToneBadge tone="caution">Draft</ToneBadge>}
      </div>

      <nav aria-label="Portfolio setup steps" className="overflow-x-auto border-b border-default">
        <ol className="flex min-w-max gap-6">
          {stages.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                disabled={busy === 'check' || busy === 'publish'}
                className={`min-h-11 border-b-2 px-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${stage === index ? 'border-strong text-heading' : 'border-transparent text-secondary hover:text-primary'}`}
                onClick={() => setStage(index as Stage)}
              >
                {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {actionError ? <p role="alert" className="rounded-md border border-negative-800/40 bg-negative-950/20 p-3 text-sm text-negative">{actionError}</p> : null}

      {stage === 0 ? (
        <section aria-labelledby="portfolio-import-title" className="space-y-5">
          <div className="section-head"><div><h3 id="portfolio-import-title">Import sitemap</h3><p className="mt-1 max-w-2xl text-sm text-secondary">Canonry applies your URL rule and returns reviewable Target candidates. Nothing is published automatically.</p></div></div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Sitemap URL" value={sitemapUrl} onChange={setSitemapUrl} placeholder="https://locations.example/sitemap.xml" />
            <Field label="Primary host" value={primaryHost} onChange={setPrimaryHost} placeholder="locations.example" />
            <Field label="Target path pattern" value={primaryPath} onChange={setPrimaryPath} placeholder="/locations/{slug}" />
            <Field label="Alias host (optional)" value={aliasHost} onChange={setAliasHost} placeholder="directory.example" />
            {aliasHost ? <Field label="Alias path pattern" value={aliasPath} onChange={setAliasPath} placeholder="/{slug}" /> : null}
            <label className="block"><span className="text-sm font-medium text-secondary">Excluded slugs (optional)</span><textarea aria-label="Excluded slugs (optional)" className="mt-1 min-h-20 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none" value={excludedSlugs} onChange={event => setExcludedSlugs(event.target.value)} placeholder={'region-page, archive-page\none value per line or comma-separated'} /></label>
          </div>
          <Button disabled={busy === 'discover' || !sitemapUrl.trim() || !primaryHost.trim() || !primaryPath.trim()} onClick={() => void importSitemap()}>
            {busy === 'discover' ? 'Importing…' : 'Import sitemap'}
          </Button>
          {discovery ? (
            <div className="border-t border-default pt-4" aria-live="polite">
              {importDiff ? <p className="mb-3 rounded-md border border-info-500/25 bg-info-950/20 p-3 text-sm text-secondary">Import changes: {importDiff.newTargets} new {importDiff.newTargets === 1 ? 'Target' : 'Targets'}, {importDiff.changedTargets} with URL changes, and {importDiff.reviewItems} review {importDiff.reviewItems === 1 ? 'item' : 'items'}.</p> : null}
              <div className="flex flex-wrap gap-2">
                <ToneBadge tone="caution">{discovery.proposed.length} proposed {discovery.proposed.length === 1 ? 'Target' : 'Targets'}</ToneBadge>
                {discovery.shared.length > 0 ? <ToneBadge tone="caution">{discovery.shared.length} shared {discovery.shared.length === 1 ? 'URL needs' : 'URLs need'} review</ToneBadge> : null}
                {discovery.unmatched.length > 0 ? <ToneBadge tone="neutral">{discovery.unmatched.length} unmatched</ToneBadge> : null}
                {discovery.excluded.length > 0 ? <ToneBadge tone="neutral">{discovery.excluded.length} excluded</ToneBadge> : null}
                {discovery.diagnostics.length > 0 ? <ToneBadge tone="caution">{discovery.diagnostics.length} import {discovery.diagnostics.length === 1 ? 'issue' : 'issues'}</ToneBadge> : null}
              </div>
              <Button className="mt-4" variant="secondary" onClick={() => setStage(1)}>Continue to Targets</Button>
            </div>
          ) : draft ? (
            <div className="border-t border-default pt-4"><p className="text-sm text-secondary">A saved draft is ready to review.</p><Button className="mt-3" variant="secondary" onClick={() => setStage(1)}>Continue to Targets</Button></div>
          ) : null}
        </section>
      ) : null}

      {stage === 1 ? (
        <section aria-labelledby="portfolio-targets-title" className="space-y-4">
          <div className="section-head section-head-inline">
            <div><h3 id="portfolio-targets-title">Targets</h3><p className="mt-1 max-w-2xl text-sm text-secondary">Confirm the units you want to measure. URL coverage stays attached to each Target.</p></div>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => selectTargetKeys(filteredTargets.map(target => target.stableKey))}>Select all matching Targets</Button><Button size="sm" variant="ghost" disabled={selectedTargetKeys.length === 0} onClick={() => setSelectedTargetKeys([])}>Clear selection</Button><Button size="sm" variant="outline" disabled={selectedTargetKeys.length === 0} onClick={() => setSelectedTargetStatus('confirmed')}>Confirm selected Targets</Button><Button size="sm" variant="ghost" disabled={selectedTargetKeys.length === 0} onClick={() => setSelectedTargetStatus('rejected')}>Reject selected</Button><Button size="sm" variant="ghost" disabled={proposedTargetKeys.length === 0} onClick={() => { updateDraft(proposedTargetKeys.reduce((current, key) => rejectTarget(current, key), draft!)); setSelectedTargetKeys([]) }}>Reject remaining proposed Targets ({proposedTargetKeys.length})</Button></div>
          </div>
          {!draft ? <p className="text-sm text-secondary">Import a sitemap to review Targets.</p> : (
            <>
              <label className="block max-w-md"><span className="text-sm font-medium text-secondary">Search Targets</span><input aria-label="Search Targets" className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none" value={targetSearch} onChange={event => setTargetSearch(event.target.value)} placeholder="Target name" /></label>
              <p className="text-sm text-secondary">Showing {shownTargets.length} of {filteredTargets.length} matching {filteredTargets.length === 1 ? 'Target' : 'Targets'} ({draft.targets.length} total)</p>
              {pendingCoverageReviews.length > 0 ? (
                <div className="space-y-3 rounded-md border border-caution-800/40 bg-caution-950/20 p-4">
                  <div><p className="text-sm font-medium text-caution">{pendingCoverageReviews.length} {pendingCoverageReviews.length === 1 ? 'Target has' : 'Targets have'} URL coverage changes.</p><p className="mt-1 text-sm text-secondary">Select changed Targets, then keep their saved coverage or replace it with this import.</p></div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setSelectedTargetKeys(pendingCoverageReviews.map(review => review.targetKey))}>Select all URL changes</Button>
                    <Button size="sm" variant="outline" disabled={selectedCoverageTargetKeys.length === 0} onClick={() => resolveSelectedCoverage('keep-existing')}>Keep existing coverage for selected</Button>
                    <Button size="sm" variant="outline" disabled={selectedCoverageTargetKeys.length === 0} onClick={() => resolveSelectedCoverage('replace-with-imported')}>Replace selected with imported coverage</Button>
                  </div>
                </div>
              ) : null}
              <div className="overflow-x-auto rounded-md border border-default">
                <table className="evidence-table min-w-[760px]"><thead><tr><th><span className="sr-only">Select</span></th><th>Target</th><th>Status</th><th>URL coverage</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>
                  {shownTargets.map(target => {
                    const expanded = expandedTargetKeys.includes(target.stableKey)
                    return [
                      <tr key={target.stableKey}>
                        <td><input aria-label={`Select ${target.label}`} type="checkbox" checked={selectedTargetSet.has(target.stableKey)} onChange={event => toggleTarget(target.stableKey, event.target.checked)} /></td>
                        <td className="font-medium text-heading">{target.label}</td>
                        <td><ToneBadge tone={target.status === 'confirmed' ? 'positive' : target.status === 'rejected' ? 'negative' : 'caution'}>{target.status === 'confirmed' ? 'Confirmed' : target.status === 'rejected' ? 'Rejected' : 'Proposed'}</ToneBadge></td>
                        <td className="tabular-nums text-secondary">{target.urls.length} {target.urls.length === 1 ? 'URL' : 'URLs'}</td>
                        <td className="text-right"><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpandedTargetKeys(current => expanded ? current.filter(key => key !== target.stableKey) : [...current, target.stableKey])}>{expanded ? 'Hide' : 'Show'} URLs for {target.label}</Button></td>
                      </tr>,
                      expanded ? <tr key={`${target.stableKey}:urls`}><td colSpan={5}><ul className="space-y-2 py-2 text-sm text-secondary">{target.urls.map((url, index) => <li key={`${target.stableKey}:${index}`} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-mono text-xs">{matcherLabel(url)}</span><Button size="sm" variant="ghost" aria-label={`Remove ${matcherLabel(url)} from ${target.label}`} onClick={() => updateDraft(removeTargetUrl(draft, target.stableKey, url))}>Remove</Button></li>)}</ul></td></tr> : null,
                    ]
                  })}
                </tbody></table>
              </div>
              {draft.exceptions.length > 0 ? <details className="rounded-md border border-default p-3"><summary className="cursor-pointer text-sm font-medium text-heading">{unreviewedExceptions.length} {unreviewedExceptions.length === 1 ? 'URL needs' : 'URLs need'} review</summary><p className="mt-3 text-sm text-secondary">Showing {shownReviewExceptions.length} of {unreviewedExceptions.length} unreviewed items</p><ul className="mt-2 space-y-2 text-sm text-secondary">{shownReviewExceptions.map(item => <li key={item.key} className="break-all">{item.url} ({item.reason})</li>)}</ul>{unreviewedExceptions.length > 0 ? <div className="mt-3 flex flex-wrap gap-2">{unreviewedExceptions.length > shownReviewExceptions.length ? <Button size="sm" variant="outline" onClick={() => updateDraft(reviewExceptions(draft, shownReviewExceptions.map(item => item.key)))}>Mark {shownReviewExceptions.length} shown items complete</Button> : null}<Button size="sm" variant="outline" onClick={() => updateDraft(reviewAllExceptions(draft))}>Mark all {unreviewedExceptions.length} URL review items complete</Button></div> : null}</details> : null}
              <Button disabled={confirmedTargets.length === 0} onClick={() => setStage(2)}>Continue to Queries</Button>
            </>
          )}
        </section>
      ) : null}

      {stage === 2 ? (
        <section aria-labelledby="portfolio-queries-title" className="space-y-5">
          <div className="section-head"><div><h3 id="portfolio-queries-title">Queries</h3><p className="mt-1 max-w-2xl text-sm text-secondary">Apply reusable query sets to selected Targets. Templates create drafts for review before they enter the query library.</p></div></div>
          {!draft ? <p className="text-sm text-secondary">Confirm at least one Target first.</p> : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setSelectedTargetKeys(confirmedTargets.map(target => target.stableKey))}>Select all confirmed Targets</Button>
                {draft.groups.map(group => <Button key={group.stableKey} size="sm" variant="outline" onClick={() => selectTargetKeys(group.targetKeys)}>Select members of {group.label}</Button>)}
                <Button size="sm" variant="ghost" disabled={selectedTargetKeys.length === 0} onClick={() => setSelectedTargetKeys([])}>Clear selection</Button>
                <span className="self-center text-sm text-secondary">{selectedConfirmedTargetKeys.length} confirmed selected</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-surface-subtle px-3 py-2">
                <Button size="sm" variant="outline" disabled={!selectedTargetsHaveAssignments} onClick={() => updateDraft(clearTargetAssignments(draft, selectedConfirmedTargetKeys))}>Clear selected query assignments</Button>
                <p className="text-xs text-muted">This only changes the draft. It does not delete tracked queries.</p>
              </div>
              <p className="text-sm text-secondary">Groups organize reporting and competitors only. Query assignments always belong to Targets.</p>
              {isQueryLoading ? <div className="h-24 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading tracked queries" /> : isQueryError ? <div className="rounded-md border border-negative-800/40 bg-negative-950/20 p-3 text-sm text-negative">Could not load tracked queries.{onRetryQueries ? <Button className="ml-3" size="sm" variant="outline" onClick={onRetryQueries}>Try again</Button> : null}</div> : (
                <div className="grid gap-5 xl:grid-cols-2">
                  <div className="space-y-4 border-t border-default pt-4">
                    <h4 className="font-medium text-heading">Save a query set</h4>
                    <Field label="Query set name" value={querySetName} onChange={setQuerySetName} placeholder="Local intent" />
                    <fieldset><legend className="text-sm font-medium text-secondary">Tracked queries</legend><div className="mt-2 max-h-52 space-y-2 overflow-y-auto">{allQueries.map(query => <label key={query.id} className="flex min-h-11 items-center gap-3 rounded border border-default px-3 py-2 text-sm text-primary"><input type="checkbox" checked={selectedQuerySet.has(query.id)} onChange={event => setSelectedQueryIds(current => event.target.checked ? [...new Set([...current, query.id])] : current.filter(id => id !== query.id))} />{query.query}</label>)}</div></fieldset>
                    <label className="block"><span className="text-sm font-medium text-secondary">Query set location</span><select aria-label="Query set location" className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none" value={querySetLocation} onChange={event => setQuerySetLocation(event.target.value)}><option value={PROJECT_DEFAULT_CONTEXT}>Project default</option><option value={NO_LOCATION_CONTEXT}>No location</option>{locations.map(location => <option key={location.label} value={location.label}>{location.label}</option>)}</select></label>
                    <Button size="sm" disabled={!querySetName.trim() || selectedQueryIds.length === 0} onClick={saveQuerySet}>Save query set</Button>
                  </div>
                  <div className="space-y-4 border-t border-default pt-4">
                    <h4 className="font-medium text-heading">Saved query sets</h4>
                    {draft.querySets.length === 0 ? <p className="text-sm text-secondary">No draft query sets yet.</p> : <div className="overflow-x-auto"><table className="evidence-table min-w-[480px]"><thead><tr><th>Set</th><th>Queries</th><th>Location</th><th><span className="sr-only">Apply</span></th></tr></thead><tbody>{draft.querySets.map(set => { const appliedCount = confirmedTargets.filter(target => set.queryIds.every(queryId => draft.assignments.some(item => item.targetKey === target.stableKey && item.queryId === queryId && contextsMatch(item.context, set.context)))).length; return <tr key={set.key}><td className="font-medium text-heading">{set.label}</td><td className="tabular-nums text-secondary">{set.queryIds.length}</td><td className="text-secondary">{contextLabel(set.context)}</td><td className="text-right"><Button size="sm" variant="outline" disabled={selectedConfirmedTargetKeys.length === 0} onClick={() => applySet(set.key)}>Apply {set.label}</Button>{appliedCount > 0 ? <span className="mt-1 block text-xs text-muted">{appliedCount} Targets use this set</span> : null}</td></tr>})}</tbody></table></div>}
                  </div>
                </div>
              )}
              <div className="space-y-3 border-t border-default pt-4">
                <div><h4 className="font-medium text-heading">Query template</h4><p className="mt-1 text-sm text-secondary">Use {'{target.label}'} once. Review every expanded query before creating it.</p></div>
                <Field label="Query template" value={templateText} onChange={setTemplateText} placeholder="reviews for {target.label}" />
                <label className="block max-w-md"><span className="text-sm font-medium text-secondary">Template location</span><select aria-label="Template location" className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none" value={templateLocation} onChange={event => setTemplateLocation(event.target.value)}><option value={PROJECT_DEFAULT_CONTEXT}>Project default</option><option value={NO_LOCATION_CONTEXT}>No location</option>{locations.map(location => <option key={location.label} value={location.label}>{location.label}</option>)}</select></label>
                <Button size="sm" variant="outline" disabled={!templateText.includes('{target.label}') || selectedConfirmedTargetKeys.length === 0} onClick={previewTemplate}>Preview query drafts</Button>
                {templateDrafts.length > 0 ? <div className="space-y-3"><div className="overflow-x-auto"><table className="evidence-table min-w-[560px]"><thead><tr><th>Target</th><th>Draft query</th></tr></thead><tbody>{templateDrafts.map(item => <tr key={item.targetKey}><td className="text-secondary">{draft.targets.find(target => target.stableKey === item.targetKey)?.label}</td><td className="text-primary">{item.text}</td></tr>)}</tbody></table></div><Button size="sm" disabled={busy === 'create'} onClick={() => void createTemplateQueries()}>{busy === 'create' ? 'Creating…' : `Create ${templateDrafts.length} tracked queries`}</Button></div> : null}
              </div>
              <div className="space-y-3 border-t border-default pt-4">
                <div><h4 className="font-medium text-heading">Reporting group</h4><p className="mt-1 text-sm text-secondary">Create an optional reporting view for the selected Targets. The group does not own queries or locations.</p></div>
                <div className="grid gap-3 md:grid-cols-2"><Field label="Group name" value={groupName} onChange={setGroupName} placeholder="North region" /><Field label="Competitor domains (optional)" value={groupCompetitor} onChange={setGroupCompetitor} placeholder="one.example, two.example" /></div>
                <Button size="sm" variant="outline" disabled={!groupName.trim() || selectedConfirmedTargetKeys.length === 0} onClick={saveReportingGroup}>Save reporting group</Button>
                {draft.groups.length > 0 ? <div className="overflow-x-auto"><table className="evidence-table min-w-[560px]"><thead><tr><th>Group</th><th>Targets</th><th>Competitors</th></tr></thead><tbody>{draft.groups.map(group => <tr key={group.stableKey}><td className="font-medium text-heading">{group.label}</td><td className="tabular-nums text-secondary">{group.targetKeys.length}</td><td className="text-secondary">{group.competitors?.join(', ') || 'None'}</td></tr>)}</tbody></table></div> : null}
              </div>
              <Button onClick={() => setStage(3)}>Continue to Review & publish</Button>
            </>
          )}
        </section>
      ) : null}

      {stage === 3 ? (
        <section aria-labelledby="portfolio-review-title" className="space-y-5">
          <div className="section-head"><div><h3 id="portfolio-review-title">Review & publish</h3><p className="mt-1 max-w-2xl text-sm text-secondary">Review assignments and resolve failed checks before publishing a new revision.</p></div></div>
          {!draft ? <p className="text-sm text-secondary">Complete setup before publishing.</p> : !planInput ? (
            <div role="alert" className="space-y-3 rounded-md border border-caution-800/40 bg-caution-950/20 p-4 text-sm text-caution">
              <p className="font-medium">Resolve these setup items before checking the plan.</p>
              <ul className="list-disc space-y-1 pl-5">
                {proposedTargetKeys.length > 0 ? <li>{proposedTargetKeys.length} {proposedTargetKeys.length === 1 ? 'Target still needs' : 'Targets still need'} confirmation or rejection.</li> : null}
                {unreviewedExceptions.length > 0 ? <li>{unreviewedExceptions.length} {unreviewedExceptions.length === 1 ? 'URL still needs' : 'URLs still need'} review.</li> : null}
                {pendingCoverageReviews.length > 0 ? <li>{pendingCoverageReviews.length} {pendingCoverageReviews.length === 1 ? 'Target still needs' : 'Targets still need'} a URL coverage decision.</li> : null}
                {draftValidation.filter(issue => issue.code !== 'target-review-required' && issue.code !== 'exception-review-required' && issue.code !== 'coverage-review-required').map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}
              </ul>
              <Button size="sm" variant="outline" onClick={() => setStage(1)}>Return to Targets</Button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border border-default"><table className="evidence-table min-w-[720px]"><thead><tr><th>Target</th><th>URLs</th><th>Tracked queries</th><th>Location</th></tr></thead><tbody>{confirmedTargets.map(target => { const assignments = draft.assignments.filter(item => item.targetKey === target.stableKey); const contexts = [...new Set(assignments.map(item => contextLabel(item.context)))]; return <tr key={target.stableKey}><td className="font-medium text-heading">{target.label}</td><td className="tabular-nums text-secondary">{target.urls.length}</td><td className="text-secondary">{assignments.map(item => queryById.get(item.queryId) ?? 'Missing query').join(', ') || 'None selected'}</td><td className="text-secondary">{contexts.join(', ') || 'Project default'}</td></tr>})}</tbody></table></div>
              {draftValidation.length > 0 ? <p className="text-sm text-caution">The draft needs attention before it can pass server checks.</p> : null}
              <div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={busy === 'check'} onClick={() => void checkPlan()}>{busy === 'check' ? 'Checking…' : 'Check plan'}</Button><span className="text-sm text-secondary">Estimated cost is unavailable</span></div>
              {compilePreview ? <div className="space-y-2" aria-live="polite">{compilePreview.checks.length === 0 ? <p className="text-sm text-positive">No blocking checks.</p> : compilePreview.checks.map((check, index) => <div key={`${check.id}:${index}`} className={`rounded-md border p-3 text-sm ${check.severity === 'fail' ? 'border-negative-800/40 bg-negative-950/20 text-negative' : 'border-caution-800/40 bg-caution-950/20 text-caution'}`}><p className="font-medium">{friendlyCheckName(check.id)}</p><p className="mt-1">{check.message}</p></div>)}</div> : null}
              {planDiff ? <div className="overflow-x-auto rounded-md border border-default" aria-label="Plan change summary"><table className="evidence-table min-w-[560px]"><caption className="px-3 py-2 text-left text-sm text-secondary">{planDiff.activeRevision === null ? 'Compared with a new setup' : `Compared with revision ${planDiff.activeRevision}`}</caption><thead><tr><th>Area</th><th>Added</th><th>Removed</th><th>Changed</th></tr></thead><tbody><tr><td className="font-medium text-heading">Targets</td><td className="tabular-nums text-secondary">+{planDiff.targets.added.length}</td><td className="tabular-nums text-secondary">−{planDiff.targets.removed.length}</td><td className="tabular-nums text-secondary">~{planDiff.targets.changed.length}</td></tr><tr><td className="font-medium text-heading">Reporting groups</td><td className="tabular-nums text-secondary">+{planDiff.groups.added.length}</td><td className="tabular-nums text-secondary">−{planDiff.groups.removed.length}</td><td className="tabular-nums text-secondary">~{planDiff.groups.changed.length}</td></tr><tr><td className="font-medium text-heading">Query assignments</td><td className="tabular-nums text-secondary">+{planDiff.querySelections.added.length}</td><td className="tabular-nums text-secondary">−{planDiff.querySelections.removed.length}</td><td className="tabular-nums text-secondary">~{planDiff.querySelections.changed.length}</td></tr></tbody></table></div> : null}
              <div className="flex flex-wrap items-center gap-3"><Button disabled={!compilePreview?.ok || compileFails.length > 0 || busy === 'publish' || checkedBinding?.fingerprint !== planFingerprint || checkedBinding?.activeKey !== activeKey} onClick={() => void publishPlan()}>{busy === 'publish' ? 'Publishing…' : 'Publish plan'}</Button>{publishedPlan ? <span className="text-sm text-positive">Revision {publishedPlan.revision} is active.</span> : null}</div>
              <p className="text-xs text-muted">Publishing saves configuration only. It does not start an engine run.</p>
            </>
          )}
        </section>
      ) : null}

      {stage === 4 ? (
        <section aria-labelledby="portfolio-report-title" className="space-y-4">
          <div className="section-head"><div><h3 id="portfolio-report-title">Report</h3><p className="mt-1 max-w-2xl text-sm text-secondary">Stored evidence for the active revision.</p></div></div>
          <PortfolioReport activePlan={activePlan} report={report} isLoading={isReportLoading} isError={isReportError} onRetry={onRetryReport} />
        </section>
      ) : null}
    </div>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-secondary">{label}</span>
      <input aria-label={label} className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  )
}
