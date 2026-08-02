import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MeasurementDraftAuthoring,
  MeasurementDraftCompileCheck,
  MeasurementDraftDiff,
  MeasurementDraftResponse,
  MeasurementDraftWarning,
  MeasurementSetupResponse,
} from '@ainyc/canonry-contracts'
import type { QueryDto } from '@ainyc/canonry-api-client'
import type { MeasurementPlanResponse } from '@ainyc/canonry-api-client'

import { Button } from '../../ui/button.js'
import { AdvancedMeasurementSetup } from './AdvancedMeasurementSetup.js'
import type {
  AdvancedMeasurementImportDraft,
  AdvancedMeasurementProperty as ImportProperty,
  AdvancedMeasurementReviewState,
} from './SetupImportProperties.js'
import type {
  AdvancedMeasurementFlaggedException,
  AdvancedMeasurementGroup,
  AdvancedMeasurementGroupDraft,
  AdvancedMeasurementProperty as SetupProperty,
  AdvancedMeasurementQuery,
} from './SetupQueriesGroupsReview.js'
import {
  advancedMeasurementService,
  isDraftConflict,
  setupErrorMessage,
  type AdvancedMeasurementService,
  type SitemapImportInput,
} from './service.js'

type SetupStep = 'import' | 'properties' | 'queries' | 'groups' | 'review'
type Draft = NonNullable<MeasurementDraftResponse['draft']>
type DraftTarget = MeasurementDraftAuthoring['targets'][number]

interface ReviewedSetup {
  etag: string
  baseActiveRevision: number | null
  compiledChecksum: string
  changes: { title: string; items: string[] }
}

export interface AdvancedMeasurementSectionProps {
  projectName: string
  queries: readonly QueryDto[]
  isQueryLoading: boolean
  isQueryError: boolean
  onRetryQueries?: () => void
  publishedPlan?: MeasurementPlanResponse['active']
  canEdit?: boolean
  onManageProjectQueries?: () => void
  onPublished?: () => void
  service?: AdvancedMeasurementService
}

const DEFAULT_IMPORT_DRAFT: AdvancedMeasurementImportDraft = {
  sitemapUrl: '',
  examplePropertyUrl: '',
  preferredHost: '',
  propertyPathPattern: '',
  additionalHost: '',
  additionalPathPattern: '',
  excludedPaths: '',
}
const DEFAULT_GROUP_DRAFT: AdvancedMeasurementGroupDraft = {
  name: '',
  propertyIds: [],
  competitorDomains: '',
}
const DEFAULT_VISIBLE_PROPERTIES = 50

function normalizedHost(value: string): string | null {
  const candidate = value.trim()
  if (!candidate) return null
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname.toLocaleLowerCase()
  } catch {
    return null
  }
}

function normalizedSitemapUrl(value: string): string {
  const candidate = value.trim()
  if (!candidate) throw new Error('Add a sitemap URL.')
  let parsed: URL
  try {
    parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
  } catch {
    throw new Error('Sitemap URL must be a valid web address.')
  }
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/sitemap.xml'
  return parsed.toString()
}

function pathTemplateFor(draft: AdvancedMeasurementImportDraft): string {
  const supplied = draft.propertyPathPattern.trim()
  if (supplied) {
    const value = supplied.startsWith('/') ? supplied : `/${supplied}`
    const segments = value.split('/').slice(1)
    const placeholders = segments.filter(segment => segment === '*' || segment === '{slug}')
    if (placeholders.length !== 1 || segments.some(segment => segment.includes('*') && segment !== '*')) {
      throw new Error('Property URL pattern must contain exactly one * or {slug} segment.')
    }
    return `/${segments.map(segment => segment === '*' ? '{slug}' : segment).join('/')}`
  }

  const example = draft.examplePropertyUrl.trim()
  if (!example) throw new Error('Add one example Property page so Canonry can identify the matching URLs.')
  try {
    const segments = new URL(example).pathname.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error()
    segments[segments.length - 1] = '{slug}'
    return `/${segments.join('/')}`
  } catch {
    throw new Error('Example Property page must be a valid web address.')
  }
}

function excludedSlugPatterns(value: string): NonNullable<SitemapImportInput['rule']['excludedSlugPatterns']> {
  const slugs = new Set<string>()
  for (const entry of value.split(/[\n,]+/)) {
    const trimmed = entry.trim().replace(/\/+$/, '')
    if (!trimmed) continue
    const pieces = trimmed.split('/').filter(Boolean)
    slugs.add(pieces.at(-1) ?? trimmed)
  }
  return [...slugs].sort().map(value => ({ kind: 'exact' as const, value }))
}

export function sitemapImportInput(draft: AdvancedMeasurementImportDraft): SitemapImportInput {
  const sitemapUrl = normalizedSitemapUrl(draft.sitemapUrl)
  const exampleHost = draft.examplePropertyUrl.trim() ? normalizedHost(draft.examplePropertyUrl) : null
  const host = normalizedHost(draft.preferredHost) ?? exampleHost ?? normalizedHost(sitemapUrl)
  if (!host) throw new Error('Add a valid sitemap or Property page URL.')

  const additionalHost = normalizedHost(draft.additionalHost)
  const hasAdditionalHost = draft.additionalHost.trim().length > 0
  const hasAdditionalPath = draft.additionalPathPattern.trim().length > 0
  if (hasAdditionalHost !== hasAdditionalPath || (hasAdditionalHost && !additionalHost)) {
    throw new Error('Add both an additional domain and its Property URL pattern.')
  }

  const excluded = excludedSlugPatterns(draft.excludedPaths)
  return {
    sitemapUrl,
    rule: {
      primary: { host, pathTemplate: pathTemplateFor(draft) },
      ...(additionalHost ? {
        aliases: [{
          host: additionalHost,
          pathTemplate: pathTemplateFor({
            ...draft,
            examplePropertyUrl: '',
            propertyPathPattern: draft.additionalPathPattern,
          }),
        }],
      } : {}),
      ...(excluded.length > 0 ? { excludedSlugPatterns: excluded } : {}),
    },
  }
}

function initialStepFor(draft: Draft | null): SetupStep {
  if (!draft || draft.authoring.targets.length === 0) return 'import'
  if (draft.authoring.targets.some(target => target.status === 'proposed')) return 'properties'
  if (draft.authoring.assignments.length === 0) return 'queries'
  return draft.baseActiveRevision === null ? 'review' : 'properties'
}

function recoveredStepFor(draft: Draft | null, current: SetupStep): SetupStep {
  if (!draft || draft.authoring.targets.length === 0) return 'import'
  if (!draft.authoring.targets.some(target => target.status !== 'excluded')) return 'properties'
  if (draft.authoring.targets.some(target => target.status === 'proposed')) return 'properties'
  if (draft.authoring.assignments.length === 0 && (current === 'groups' || current === 'review')) return 'queries'
  return current
}

function propertyUrls(target: DraftTarget): string[] {
  return [...new Set([
    ...(target.discoveredUrl ? [target.discoveredUrl] : []),
    ...target.urlMatchers,
  ])]
}

function propertyState(status: DraftTarget['status']): ImportProperty['state'] {
  if (status === 'included') return 'confirmed'
  if (status === 'excluded') return 'excluded'
  return 'proposed'
}

function stableKey(value: string, prefix: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${prefix}-${normalized || 'item'}`.slice(0, 128)
}

function normalizedDomain(value: string): string | null {
  return normalizedHost(value)
}

function reviewCheckFlag(check: MeasurementDraftCompileCheck, index: number): AdvancedMeasurementFlaggedException {
  const mentionsInternalModel = /\b(?:target|revision|checksum|node|edge|manifest|stable[ -]?key)s?\b/i.test(check.message)
  return {
    id: `${check.ruleId}-${index}`,
    title: check.severity === 'fail' ? 'Setup needs attention' : 'Review suggested',
    detail: mentionsInternalModel
      ? 'Return to the earlier setup steps and review the affected Property or query.'
      : check.message,
    tone: check.severity === 'fail' ? 'negative' : 'caution',
  }
}

function warningFlag(warning: MeasurementDraftWarning, index: number): AdvancedMeasurementFlaggedException {
  const mentionsInternalModel = /\b(?:target|revision|checksum|node|edge|manifest|stable[ -]?key)s?\b/i.test(warning.message)
  return {
    id: `${warning.code}-${index}`,
    title: 'Review suggested',
    detail: mentionsInternalModel ? 'Review the affected Property before publishing.' : warning.message,
    tone: 'caution',
  }
}

function reviewedChanges(diff: MeasurementDraftDiff): ReviewedSetup['changes'] {
  const items: string[] = []
  const targetChanges = diff.targets.added.length + diff.targets.removed.length + diff.targets.changed.length
  const groupChanges = diff.groups.added.length + diff.groups.removed.length + diff.groups.changed.length
  const assignmentChanges = diff.assignments.added + diff.assignments.removed + diff.assignments.reclassified
  if (targetChanges > 0) items.push(`${targetChanges} Property ${targetChanges === 1 ? 'change' : 'changes'}`)
  if (assignmentChanges > 0) items.push(`${assignmentChanges} query assignment ${assignmentChanges === 1 ? 'change' : 'changes'}`)
  if (groupChanges > 0) items.push(`${groupChanges} group ${groupChanges === 1 ? 'change' : 'changes'}`)
  return {
    title: diff.activeRevision === null ? 'New setup ready' : 'Changes ready',
    items: items.length > 0 ? items : ['No changes from the published setup.'],
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function matcherString(matcher: {
  kind: 'exact' | 'prefix' | 'host'
  url?: string
  host?: string
  pathPrefix?: string
}): string {
  if (matcher.kind === 'exact') return matcher.url ?? ''
  if (matcher.kind === 'prefix') return `https://${matcher.host ?? ''}${matcher.pathPrefix === '/' ? '' : matcher.pathPrefix ?? ''}/*`
  return matcher.host ?? ''
}

function publishedAuthoring(active: NonNullable<MeasurementPlanResponse['active']>): MeasurementDraftAuthoring {
  const plan = active.plan
  if (plan.schemaVersion === 2) {
    return {
      defaultContext: { providers: [], locations: [] },
      targets: plan.targets.map(target => ({
        stableKey: target.stableKey,
        label: target.label,
        status: 'included',
        aliases: [...target.aliases],
        urlMatchers: target.urlMatchers.map(matcherString).filter(Boolean),
        source: target.discoveryIdentity ? 'sitemap' : 'manual',
        ...(target.discoveryIdentity ? { discoveryIdentity: target.discoveryIdentity } : {}),
      })),
      assignments: plan.assignments.map(assignment => ({
        targetKey: assignment.targetKey,
        queryId: assignment.queryId,
        queryClass: assignment.queryClass,
        classificationSource: 'operator',
      })),
      groups: plan.groups.map(group => ({
        stableKey: group.stableKey,
        label: group.label,
        targetKeys: [...group.targetKeys],
        competitors: group.competitors.map(competitor => ({ ...competitor, aliases: [...competitor.aliases] })),
      })),
    }
  }

  const assignments = plan.targetQuerySelections.flatMap(selection => selection.queryIds.map(queryId => ({
    targetKey: selection.targetKey,
    queryId,
    queryClass: 'unclassified' as const,
    classificationSource: 'rule' as const,
  })))
  return {
    defaultContext: { providers: [], locations: [] },
    targets: plan.targets.map(target => ({
      stableKey: target.stableKey,
      label: target.label,
      status: 'included',
      aliases: [...target.aliases],
      urlMatchers: target.urls.map(matcherString).filter(Boolean),
      source: 'manual',
    })),
    assignments,
    groups: plan.groups.map(group => ({
      stableKey: group.stableKey,
      label: group.label,
      targetKeys: [...group.targetKeys],
      competitors: (group.competitors ?? []).map(domain => ({
        stableKey: stableKey(domain, 'competitor'),
        label: domain,
        domain,
        aliases: [],
      })),
    })),
  }
}

export function AdvancedMeasurementSection({
  projectName,
  queries,
  isQueryLoading,
  isQueryError,
  onRetryQueries,
  publishedPlan,
  canEdit = true,
  onManageProjectQueries,
  onPublished,
  service = advancedMeasurementService,
}: AdvancedMeasurementSectionProps) {
  const [setup, setSetup] = useState<MeasurementSetupResponse | null>(null)
  const [draftResponse, setDraftResponse] = useState<MeasurementDraftResponse | null>(null)
  const [step, setStep] = useState<SetupStep>('import')
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [serverFlags, setServerFlags] = useState<AdvancedMeasurementFlaggedException[]>([])
  const [importDraft, setImportDraft] = useState<AdvancedMeasurementImportDraft>({ ...DEFAULT_IMPORT_DRAFT })
  const [reviewState, setReviewState] = useState<AdvancedMeasurementReviewState>('idle')
  const [propertiesSearch, setPropertiesSearch] = useState('')
  const [maxVisibleProperties, setMaxVisibleProperties] = useState(DEFAULT_VISIBLE_PROPERTIES)
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([])
  const [selectedQueryIds, setSelectedQueryIds] = useState<string[]>([])
  const [groupDraft, setGroupDraft] = useState<AdvancedMeasurementGroupDraft>({ ...DEFAULT_GROUP_DRAFT })
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<ReviewedSetup | null>(null)
  const requestVersionRef = useRef(0)

  const draft = draftResponse?.draft ?? null
  const etag = draftResponse?.etag ?? null
  const publishedDraftView = useMemo(() => (
    !canEdit && publishedPlan
      ? { baseActiveRevision: publishedPlan.revision, authoring: publishedAuthoring(publishedPlan) }
      : null
  ), [canEdit, publishedPlan])
  const viewDraft = draft ?? publishedDraftView

  async function loadCurrent(createIfMissing: boolean): Promise<void> {
    const requestVersion = ++requestVersionRef.current
    setIsLoading(true)
    setLoadError(null)
    try {
      let [nextSetup, nextDraft] = await Promise.all([
        service.loadSetup(projectName),
        service.loadDraft(projectName),
      ])
      if (!nextDraft.draft && createIfMissing && canEdit) {
        await service.createDraft(projectName, nextSetup.activeRevision)
        ;[nextSetup, nextDraft] = await Promise.all([
          service.loadSetup(projectName),
          service.loadDraft(projectName),
        ])
      }
      if (requestVersion !== requestVersionRef.current) return
      setSetup(nextSetup)
      setDraftResponse(nextDraft)
      setStep(initialStepFor(nextDraft.draft))
      setSelectedPropertyIds(nextDraft.draft?.authoring.targets
        .filter(target => target.status !== 'excluded')
        .map(target => target.stableKey) ?? [])
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return
      setLoadError(setupErrorMessage(error, 'Could not load advanced measurement setup.'))
    } finally {
      if (requestVersion === requestVersionRef.current) setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadCurrent(true)
    return () => { requestVersionRef.current += 1 }
  }, [projectName, canEdit, service])

  useEffect(() => {
    if (!isLoading && !draft && publishedDraftView) setStep('properties')
  }, [draft, isLoading, publishedDraftView])

  async function refreshDraft(): Promise<MeasurementDraftResponse> {
    const next = await service.loadDraft(projectName)
    setDraftResponse(next)
    return next
  }

  async function recoverConflict(message: string): Promise<void> {
    setReviewed(null)
    try {
      const [nextSetup, nextDraft] = await Promise.all([
        service.loadSetup(projectName),
        service.loadDraft(projectName),
      ])
      setSetup(nextSetup)
      setDraftResponse(nextDraft)
      setSelectedPropertyIds(nextDraft.draft?.authoring.targets
        .filter(target => target.status !== 'excluded')
        .map(target => target.stableKey) ?? [])
      setStep(current => recoveredStepFor(nextDraft.draft, current))
      setActionError(message)
    } catch (error) {
      setActionError(setupErrorMessage(error, message))
    }
  }

  async function mutate(
    action: string,
    run: (currentEtag: string) => Promise<{ etag: string; warnings?: MeasurementDraftWarning[] }>,
    fallback: string,
  ): Promise<MeasurementDraftResponse | null> {
    if (!canEdit || !etag || busyAction) return null
    setBusyAction(action)
    setActionError(null)
    setReviewed(null)
    try {
      const result = await run(etag)
      setServerFlags((result.warnings ?? []).map(warningFlag))
      return await refreshDraft()
    } catch (error) {
      if (isDraftConflict(error)) {
        await recoverConflict('This setup changed in another session. The latest draft is loaded; review your changes again.')
      } else {
        setActionError(setupErrorMessage(error, fallback))
      }
      return null
    } finally {
      setBusyAction(null)
    }
  }

  const importProperties = useMemo<ImportProperty[]>(() => (
    (viewDraft?.authoring.targets ?? []).map(target => {
      const urls = propertyUrls(target)
      return {
        id: target.stableKey,
        name: target.label,
        url: urls[0] ?? 'No URL',
        urls,
        state: propertyState(target.status),
      }
    })
  ), [viewDraft])

  const includedTargets = useMemo(() => (
    viewDraft?.authoring.targets.filter(target => target.status === 'included') ?? []
  ), [viewDraft])
  const confirmedProperties = useMemo<SetupProperty[]>(() => (
    includedTargets.map(target => ({ id: target.stableKey, label: target.label, urlCount: propertyUrls(target).length }))
  ), [includedTargets])
  const assignmentCount = viewDraft?.authoring.assignments.length ?? 0

  const setupQueries = useMemo<AdvancedMeasurementQuery[]>(() => {
    if (!viewDraft) return []
    const projectQueryIds = new Set(queries.map(query => query.id))
    const available = queries.map(query => ({
      id: query.id,
      text: query.query,
      source: 'saved-project-queries' as const,
      propertyIds: unique(viewDraft.authoring.assignments
        .filter(assignment => assignment.queryId === query.id)
        .map(assignment => assignment.targetKey)),
    }))
    const missing = unique(viewDraft.authoring.assignments
      .map(assignment => assignment.queryId)
      .filter(queryId => !projectQueryIds.has(queryId)))
      .map(queryId => ({
        id: queryId,
        source: 'unavailable-tracked-query' as const,
        state: 'missing' as const,
        propertyIds: unique(viewDraft.authoring.assignments
          .filter(assignment => assignment.queryId === queryId)
          .map(assignment => assignment.targetKey)),
      }))
    return [...available, ...missing]
  }, [queries, viewDraft])

  const setupGroups = useMemo<AdvancedMeasurementGroup[]>(() => (
    (viewDraft?.authoring.groups ?? []).map(group => ({
      id: group.stableKey,
      name: group.label,
      propertyIds: group.targetKeys,
      competitors: group.competitors.map(competitor => competitor.domain),
    }))
  ), [viewDraft])

  const reviewFlags = useMemo<AdvancedMeasurementFlaggedException[]>(() => [
    ...(assignmentCount === 0 ? [{
      id: 'no-query-assignments',
      title: 'Assign at least one query',
      detail: 'Apply a tracked query to at least one Property before publishing.',
      tone: 'negative' as const,
    }] : []),
    ...((viewDraft?.authoring.assignments.some(assignment => assignment.queryClass === 'unclassified')
      && !(publishedDraftView && publishedPlan?.plan.schemaVersion === 1)) ? [{
      id: 'unclassified-query-assignments',
      title: 'Remove an unavailable query',
      detail: 'One or more saved assignments no longer have a tracked query. Clear them before publishing.',
      tone: 'negative' as const,
    }] : []),
    ...serverFlags,
  ], [assignmentCount, publishedDraftView, publishedPlan, serverFlags, viewDraft])

  const queryAvailability = isQueryLoading
    ? { status: 'unavailable' as const, message: 'Tracked queries are loading.' }
    : isQueryError
      ? { status: 'unavailable' as const, message: 'Tracked queries could not be loaded. Retry before assigning Properties.' }
      : { status: 'available' as const }

  async function reviewSitemap(nextImportDraft: AdvancedMeasurementImportDraft): Promise<void> {
    let input: SitemapImportInput
    try {
      input = sitemapImportInput(nextImportDraft)
    } catch (error) {
      setActionError(setupErrorMessage(error, 'Check the sitemap details and try again.'))
      return
    }
    setImportDraft(nextImportDraft)
    setReviewState('reviewing')
    const next = await mutate('import', currentEtag => service.importSitemap(projectName, currentEtag, input), 'Could not review this sitemap.')
    if (next?.draft) {
      const proposed = next.draft.authoring.targets.filter(target => target.status === 'proposed').map(target => target.stableKey)
      const alreadyIncluded = next.draft.authoring.targets.filter(target => target.status === 'included').map(target => target.stableKey)
      setSelectedPropertyIds([...alreadyIncluded, ...proposed])
      setPropertiesSearch('')
      setMaxVisibleProperties(DEFAULT_VISIBLE_PROPERTIES)
      setStep('properties')
      setReviewState('idle')
    } else {
      setReviewState('error')
    }
  }

  async function continueProperties(selectedIds: readonly string[]): Promise<void> {
    if (!draft || !etag || busyAction) return
    const selected = new Set(selectedIds)
    const proposed = draft.authoring.targets.filter(target => target.status === 'proposed' && target.discoveryIdentity)
    const selections = proposed.map(target => ({
      discoveryIdentity: target.discoveryIdentity!,
      action: selected.has(target.stableKey) ? 'create' as const : 'ignore' as const,
    }))
    const selectionChanged = selections.length > 0 || draft.authoring.targets.some(target =>
      target.status !== 'proposed' && (target.status === 'included') !== selected.has(target.stableKey))

    setBusyAction('properties')
    setActionError(null)
    setReviewed(null)
    try {
      if (!selectionChanged) {
        setSelectedPropertyIds([...selected])
        setStep('queries')
        return
      }
      await service.applySitemapSelection(projectName, etag, selections, [...selected])
      const next = await refreshDraft()
      setSelectedPropertyIds(next.draft?.authoring.targets.filter(target => target.status === 'included').map(target => target.stableKey) ?? [])
      setStep('queries')
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('This setup changed in another session. The latest Properties are loaded.')
      else setActionError(setupErrorMessage(error, 'Could not save the selected Properties.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function applySelectedQueries(selection: { queryIds: readonly string[]; propertyIds: readonly string[] }): Promise<void> {
    const next = await mutate(
      'assignments',
      currentEtag => service.applyAssignments(projectName, currentEtag, unique(selection.propertyIds), unique(selection.queryIds)),
      'Could not apply these queries.',
    )
    if (next) setSelectedQueryIds([])
  }

  async function clearQueryAssignments(queryId: string): Promise<void> {
    if (!draft) return
    const targetKeys = unique(draft.authoring.assignments
      .filter(assignment => assignment.queryId === queryId)
      .map(assignment => assignment.targetKey))
    if (targetKeys.length === 0) return
    const next = await mutate(
      `remove-${queryId}`,
      currentEtag => service.removeAssignment(projectName, currentEtag, targetKeys, queryId),
      'Could not clear this query assignment.',
    )
    if (next) setSelectedQueryIds(current => current.filter(id => id !== queryId))
  }

  async function saveGroup(nextGroupDraft: AdvancedMeasurementGroupDraft): Promise<void> {
    if (!draft || !etag || busyAction) return
    const label = nextGroupDraft.name.trim()
    if (!label) return
    const groupKey = editingGroupId ?? stableKey(label, 'group')
    const existing = draft.authoring.groups.find(group => group.stableKey === groupKey)
    if (existing && editingGroupId === null) {
      setActionError(`A group named "${existing.label}" already exists. Edit it or choose a different name.`)
      return
    }
    const domainEntries = nextGroupDraft.competitorDomains.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
    const invalidDomain = domainEntries.find(value => normalizedDomain(value) === null)
    if (invalidDomain) {
      setActionError(`"${invalidDomain}" is not a valid competitor domain.`)
      return
    }
    const domains = unique(domainEntries.map(value => normalizedDomain(value)!))

    setBusyAction('group')
    setActionError(null)
    setReviewed(null)
    try {
      await service.upsertGroup(projectName, etag, {
        stableKey: groupKey,
        label,
        targetKeys: unique(nextGroupDraft.propertyIds),
        competitors: domains.map(domain => existing?.competitors.find(competitor => competitor.domain === domain) ?? {
          stableKey: stableKey(domain, 'competitor'),
          label: domain,
          domain,
          aliases: [],
        }),
      })
      await refreshDraft()
      setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
      setEditingGroupId(null)
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('This setup changed in another session. The latest groups are loaded.')
      else setActionError(setupErrorMessage(error, 'Could not save this group.'))
    } finally {
      setBusyAction(null)
    }
  }

  function editGroup(groupId: string): void {
    const group = draft?.authoring.groups.find(item => item.stableKey === groupId)
    if (!group) return
    setEditingGroupId(groupId)
    setGroupDraft({
      name: group.label,
      propertyIds: [...group.targetKeys],
      competitorDomains: group.competitors.map(competitor => competitor.domain).join(', '),
    })
  }

  async function removeGroup(groupId: string): Promise<void> {
    const next = await mutate('remove-group', currentEtag => service.removeGroup(projectName, currentEtag, groupId), 'Could not remove this group.')
    if (next && editingGroupId === groupId) {
      setEditingGroupId(null)
      setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
    }
  }

  async function reviewSetupChanges(): Promise<void> {
    if (!draft || !etag || busyAction || assignmentCount === 0) return
    setBusyAction('review')
    setActionError(null)
    setReviewed(null)
    try {
      const [compile, diff] = await Promise.all([
        service.compilePreview(projectName),
        service.diffPreview(projectName),
      ])
      const checks = [...compile.checks, ...diff.checks]
      setServerFlags(checks.map(reviewCheckFlag))
      if (!compile.ok || !diff.ok || !diff.diff) return
      if (diff.diff.activeRevision !== draft.baseActiveRevision) {
        await recoverConflict('The published setup changed while you were reviewing. The latest draft is loaded; review it again.')
        return
      }
      if (compile.compiledChecksum !== diff.compiledChecksum) {
        setActionError('The setup changed while it was being reviewed. Review the latest changes again.')
        return
      }
      setReviewed({
        etag,
        baseActiveRevision: draft.baseActiveRevision,
        compiledChecksum: compile.compiledChecksum,
        changes: reviewedChanges(diff.diff),
      })
    } catch (error) {
      setActionError(setupErrorMessage(error, 'Could not review this setup.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function publishSetup(): Promise<void> {
    if (!draft || !etag || !reviewed || busyAction) return
    if (etag !== reviewed.etag || draft.baseActiveRevision !== reviewed.baseActiveRevision) {
      setReviewed(null)
      setActionError('The setup changed after review. Review the latest changes before publishing.')
      return
    }
    setBusyAction('publish')
    setActionError(null)
    try {
      await service.publish(projectName, etag, {
        expectedActiveRevision: reviewed.baseActiveRevision,
        expectedCompiledChecksum: reviewed.compiledChecksum,
      })
      setDraftResponse({ draft: null, etag: null })
      setReviewed(null)
      onPublished?.()
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('The setup changed before it could be published. Review the latest draft and publish again.')
      else setActionError(setupErrorMessage(error, 'Could not publish this setup.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function discardDraft(): Promise<void> {
    if (!etag || busyAction) return
    setBusyAction('discard')
    setActionError(null)
    try {
      await service.discard(projectName, etag)
      setDraftResponse({ draft: null, etag: null })
      setReviewed(null)
      onPublished?.()
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('This setup changed in another session. The latest draft is loaded.')
      else setActionError(setupErrorMessage(error, 'Could not discard these changes.'))
    } finally {
      setBusyAction(null)
    }
  }

  if (isLoading) {
    return (
      <section aria-labelledby="advanced-measurement-loading-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-loading-title">Advanced measurement setup</h2></div>
        <div className="h-28 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading advanced measurement setup" />
      </section>
    )
  }

  if (loadError) {
    return (
      <section aria-labelledby="advanced-measurement-error-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-error-title">Advanced measurement setup</h2></div>
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
          <p>{loadError}</p>
          <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => { void loadCurrent(true) }}>Try again</Button>
        </div>
      </section>
    )
  }

  if (!viewDraft || (canEdit && !etag)) {
    return (
      <section aria-labelledby="advanced-measurement-empty-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-empty-title">Advanced measurement setup</h2></div>
        <p className="text-sm text-secondary">{canEdit ? 'Start setup from the project Overview.' : 'No advanced setup is available to review.'}</p>
      </section>
    )
  }

  const retryQueries = isQueryError && onRetryQueries ? (
    <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={onRetryQueries}>Retry tracked queries</Button></div>
  ) : null

  return (
    <div className="space-y-4">
      {setup?.mode === 'active-v1' ? (
        <p role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-3 text-sm text-secondary">
          Review and publish this setup to enable class-filtered reporting.
        </p>
      ) : null}
      {actionError ? <p role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">{actionError}</p> : null}
      {retryQueries}
      {step === 'import' || step === 'properties' ? (
        <AdvancedMeasurementSetup
          currentStep={step}
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          importProperties={{
            importDraft,
            onImportDraftChange: next => {
              setImportDraft(next)
              setReviewState('idle')
              setActionError(null)
            },
            onReviewSitemap: next => { void reviewSitemap(next) },
            reviewState,
            properties: importProperties,
            propertiesState: 'ready',
            propertiesSearch,
            onPropertiesSearchChange: setPropertiesSearch,
            maxVisibleProperties,
            onShowAllProperties: () => setMaxVisibleProperties(importProperties.length),
            selectedPropertyIds,
            onSelectedPropertyIdsChange: ids => setSelectedPropertyIds([...ids]),
            onContinue: ids => { void continueProperties(ids) },
            onRetryProperties: () => { void refreshDraft() },
            onReturnToImport: () => setStep('import'),
          }}
        />
      ) : step === 'queries' ? (
        <AdvancedMeasurementSetup
          currentStep="queries"
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          onManageProjectQueries={onManageProjectQueries}
          queries={{
            availability: queryAvailability,
            properties: confirmedProperties,
            queries: setupQueries,
            selectedPropertyIds,
            selectedQueryIds,
            isApplying: busyAction === 'assignments',
            onSelectedPropertyIdsChange: ids => setSelectedPropertyIds([...ids]),
            onSelectedQueryIdsChange: ids => setSelectedQueryIds([...ids]),
            onApplySelectedQueries: selection => applySelectedQueries(selection),
            onClearQueryAssignments: clearQueryAssignments,
            onRemoveQuery: clearQueryAssignments,
            canContinue: assignmentCount > 0,
            onBack: () => setStep('properties'),
            onContinue: () => setStep('groups'),
          }}
        />
      ) : step === 'groups' ? (
        <AdvancedMeasurementSetup
          currentStep="groups"
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          groups={{
            properties: confirmedProperties,
            groups: setupGroups,
            groupDraft,
            isSaving: busyAction === 'group',
            onGroupDraftChange: setGroupDraft,
            onSaveGroup: saveGroup,
            onEditGroup: group => editGroup(group.id),
            onRemoveGroup: removeGroup,
            onClearGroupDraft: () => {
              setEditingGroupId(null)
              setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
            },
            onBack: () => setStep('queries'),
            onContinue: () => setStep('review'),
          }}
        />
      ) : (
        <AdvancedMeasurementSetup
          currentStep="review"
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          review={{
            counts: {
              properties: includedTargets.length,
              queries: new Set(viewDraft.authoring.assignments.map(assignment => assignment.queryId)).size,
              groups: viewDraft.authoring.groups.length,
            },
            flaggedExceptions: reviewFlags,
            reviewedChanges: reviewed?.changes,
            isReviewing: busyAction === 'review',
            canReviewChanges: assignmentCount > 0 && !busyAction,
            onReviewChanges: reviewSetupChanges,
            onBack: () => setStep('groups'),
            canPublish: reviewed !== null && !busyAction,
            isPublishing: busyAction === 'publish',
            onPublish: publishSetup,
          }}
        />
      )}
    </div>
  )
}
