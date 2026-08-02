import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MeasurementDiscoveryRequest,
  MeasurementPlanCompilePreviewResponse,
  MeasurementPlanDiffPreviewResponse,
  MeasurementPlanInput,
  MeasurementPlanResponse,
} from '@ainyc/canonry-api-client'

import { Button } from '../../ui/button.js'
import type { PortfolioSectionProps } from '../PortfolioSection.js'
import {
  assignQueriesToTargets,
  clearTargetAssignments,
  confirmTarget,
  createDraftFromDiscovery,
  parsePortfolioDraft,
  reconcileDraftWithDiscovery,
  rejectTarget,
  removeReportingGroup,
  resolveCoverageReviews,
  reviewAllExceptions,
  stateFromActivePlan,
  toMeasurementPlanInput,
  upsertReportingGroup,
  validatePortfolioDraft,
  type DraftCoverageResolution,
  type DraftValidationIssue,
  type PortfolioSetupDraft,
} from '../portfolio-setup-model.js'
import { AdvancedMeasurementSetup } from './AdvancedMeasurementSetup.js'
import {
  advancedMeasurementDraftStorageKey,
  legacyPortfolioDraftStorageKey,
} from './draft-storage.js'
import type {
  AdvancedMeasurementImportDraft,
  AdvancedMeasurementProperty as ImportProperty,
  AdvancedMeasurementReviewState,
} from './SetupImportProperties.js'
import type {
  AdvancedMeasurementAvailability,
  AdvancedMeasurementFlaggedException,
  AdvancedMeasurementGroup,
  AdvancedMeasurementGroupDraft,
  AdvancedMeasurementProperty as SetupProperty,
  AdvancedMeasurementQuery,
} from './SetupQueriesGroupsReview.js'

type SetupStep = 'import' | 'properties' | 'queries' | 'groups' | 'review'
type ActivePlan = MeasurementPlanResponse['active']

interface ReviewedChanges {
  title: string
  items: string[]
}

interface ReviewedSetup {
  fingerprint: string
  activeKey: string
  input: MeasurementPlanInput
  changes: ReviewedChanges
}

type ReviewedDiff = Extract<MeasurementPlanDiffPreviewResponse, { ok: true }>['diff']

/**
 * Temporary controller for the advanced setup presentation. It deliberately
 * uses the existing v1 plan endpoints and keeps all in-progress editing in a
 * browser-local compatibility draft until a current plan is published.
 */
export type AdvancedMeasurementSectionProps = Pick<PortfolioSectionProps,
  | 'projectName'
  | 'queries'
  | 'isQueryLoading'
  | 'isQueryError'
  | 'onRetryQueries'
  | 'activePlan'
  | 'isPlanLoading'
  | 'isPlanError'
  | 'onRetryPlan'
  | 'onDiscover'
  | 'onCompilePlan'
  | 'onDiffPlan'
  | 'onPublishPlan'
> & {
  canEdit?: boolean
  onManageProjectQueries?: () => void
  onPublished?: () => void
}

interface StoredCompatibilityDraft {
  schemaVersion: 1
  baseActiveKey: string
  importDraft: AdvancedMeasurementImportDraft
  groupDraft: AdvancedMeasurementGroupDraft
  editingGroupId: string | null
  portfolio: PortfolioSetupDraft | null
}

const COMPATIBILITY_DRAFT_VERSION = 1
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

function copyImportDraft(draft = DEFAULT_IMPORT_DRAFT): AdvancedMeasurementImportDraft {
  return { ...draft }
}

function copyGroupDraft(draft = DEFAULT_GROUP_DRAFT): AdvancedMeasurementGroupDraft {
  return { ...draft, propertyIds: [...draft.propertyIds] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseImportDraft(value: unknown): AdvancedMeasurementImportDraft | null {
  if (!isRecord(value)) return null
  const fields: Array<keyof AdvancedMeasurementImportDraft> = [
    'sitemapUrl',
    'examplePropertyUrl',
    'preferredHost',
    'propertyPathPattern',
    'excludedPaths',
  ]
  if (fields.some(field => typeof value[field] !== 'string')) return null
  if (value.additionalHost !== undefined && typeof value.additionalHost !== 'string') return null
  if (value.additionalPathPattern !== undefined && typeof value.additionalPathPattern !== 'string') return null
  return {
    sitemapUrl: value.sitemapUrl as string,
    examplePropertyUrl: value.examplePropertyUrl as string,
    preferredHost: value.preferredHost as string,
    propertyPathPattern: value.propertyPathPattern as string,
    additionalHost: typeof value.additionalHost === 'string' ? value.additionalHost : '',
    additionalPathPattern: typeof value.additionalPathPattern === 'string' ? value.additionalPathPattern : '',
    excludedPaths: value.excludedPaths as string,
  }
}

function parseGroupDraft(value: unknown): AdvancedMeasurementGroupDraft | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.competitorDomains !== 'string' || !Array.isArray(value.propertyIds)) return null
  if (!value.propertyIds.every(item => typeof item === 'string')) return null
  return {
    name: value.name,
    propertyIds: [...value.propertyIds] as string[],
    competitorDomains: value.competitorDomains,
  }
}

function readCompatibilityDraft(projectName: string, fallbackActiveKey: string): StoredCompatibilityDraft | null {
  if (typeof window === 'undefined') return null
  try {
    const serialized = window.localStorage.getItem(advancedMeasurementDraftStorageKey(projectName))
    if (serialized) {
      const parsed: unknown = JSON.parse(serialized)
      if (!isRecord(parsed) || parsed.schemaVersion !== COMPATIBILITY_DRAFT_VERSION) return null
      const importDraft = parseImportDraft(parsed.importDraft)
      const groupDraft = parseGroupDraft(parsed.groupDraft)
      const editingGroupId = parsed.editingGroupId === undefined || parsed.editingGroupId === null
        ? null
        : typeof parsed.editingGroupId === 'string' ? parsed.editingGroupId : undefined
      if (!importDraft || !groupDraft || editingGroupId === undefined || (parsed.portfolio !== null && !isRecord(parsed.portfolio))) return null
      return {
        schemaVersion: 1,
        baseActiveKey: typeof parsed.baseActiveKey === 'string' ? parsed.baseActiveKey : fallbackActiveKey,
        importDraft,
        groupDraft,
        editingGroupId,
        portfolio: parsed.portfolio === null ? null : parsePortfolioDraft(JSON.stringify(parsed.portfolio)),
      }
    }

    const legacy = window.localStorage.getItem(legacyPortfolioDraftStorageKey(projectName))
    if (!legacy) return null
    const migrated: StoredCompatibilityDraft = {
      schemaVersion: 1,
      baseActiveKey: fallbackActiveKey,
      importDraft: copyImportDraft(),
      groupDraft: copyGroupDraft(),
      editingGroupId: null,
      portfolio: parsePortfolioDraft(legacy),
    }
    try {
      // Do not delete the old draft until the new key was written successfully.
      window.localStorage.setItem(advancedMeasurementDraftStorageKey(projectName), JSON.stringify(migrated))
      window.localStorage.removeItem(legacyPortfolioDraftStorageKey(projectName))
    } catch {
      // Keep the parsed legacy draft available for this page. The normal save
      // effect will show the storage-unavailable state.
    }
    return migrated
  } catch {
    return null
  }
}

function saveCompatibilityDraft(projectName: string, draft: StoredCompatibilityDraft): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(advancedMeasurementDraftStorageKey(projectName), JSON.stringify({
      schemaVersion: COMPATIBILITY_DRAFT_VERSION,
      baseActiveKey: draft.baseActiveKey,
      importDraft: draft.importDraft,
      groupDraft: draft.groupDraft,
      editingGroupId: draft.editingGroupId,
      portfolio: draft.portfolio,
    }))
    return true
  } catch {
    return false
  }
}

function clearCompatibilityDraft(projectName: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(advancedMeasurementDraftStorageKey(projectName))
    window.localStorage.removeItem(legacyPortfolioDraftStorageKey(projectName))
  } catch {
    // A browser that prevents storage cannot retain a compatibility draft.
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return customerCopy(error instanceof Error ? error.message : fallback)
}

/** Keep transport and compiler vocabulary out of the operator-facing surface. */
function customerCopy(value: string): string {
  return value
    .replace(/\bstable[ -]?key\b/gi, 'property name')
    .replace(/\bchecksums?\b/gi, 'saved setup')
    .replace(/\brevisions?\b/gi, 'saved setup')
    .replace(/\bexecution nodes?\b/gi, 'measurements')
    .replace(/\busage edges?\b/gi, 'measurement links')
    .replace(/\bmanifests?\b/gi, 'measurement setup')
    .replace(/\btargets?\b/gi, match => match.toLocaleLowerCase() === 'target' ? 'Property' : 'Properties')
}

function customerValidationCopy(issue: DraftValidationIssue): string {
  switch (issue.code) {
    case 'no-confirmed-targets':
      return 'Confirm at least one Property before publishing.'
    case 'exception-review-required':
      return 'Review sitemap entries that are not assigned to a Property.'
    case 'coverage-review-required':
      return 'Choose which Property URLs to keep after the sitemap update.'
    case 'assignment-target-unavailable':
      return 'A query is assigned to a Property that is not confirmed.'
    case 'group-target-unavailable':
      return customerCopy(issue.message)
    case 'group-target-required':
      return customerCopy(issue.message)
    case 'duplicate-stable-key':
      return 'Each Property and group needs a unique name.'
    default:
      return customerCopy(issue.message)
  }
}

function normalizedHost(value: string): string | null {
  const candidate = value.trim()
  if (!candidate) return null
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname
  } catch {
    return null
  }
}

function pathTemplateFor(draft: AdvancedMeasurementImportDraft): string {
  const supplied = draft.propertyPathPattern.trim()
  if (supplied) {
    const value = supplied.startsWith('/') ? supplied : `/${supplied}`
    const segments = value.split('/').slice(1)
    const placeholders = segments.filter(segment => segment === '*' || segment === '{slug}')
    if (placeholders.length !== 1 || segments.some(segment => segment.includes('*') && segment !== '*')) {
      throw new Error('Property path pattern must contain exactly one * or {slug} segment.')
    }
    return segments.map(segment => segment === '*' ? '{slug}' : segment).join('/').replace(/^/, '/')
  }

  if (draft.examplePropertyUrl.trim()) {
    try {
      const pathname = new URL(draft.examplePropertyUrl).pathname
      const segments = pathname.split('/').filter(Boolean)
      if (segments.length === 0) return '/{slug}'
      segments[segments.length - 1] = '{slug}'
      return `/${segments.join('/')}`
    } catch {
      throw new Error('Example Property URL must be a valid URL.')
    }
  }

  return '/{slug}'
}

function excludedSlugPatterns(value: string): NonNullable<MeasurementDiscoveryRequest['rule']['excludedSlugPatterns']> {
  const slugs = new Set<string>()
  for (const entry of value.split(/[\n,]+/)) {
    const trimmed = entry.trim().replace(/\/+$/, '')
    if (!trimmed) continue
    const pieces = trimmed.split('/').filter(Boolean)
    slugs.add(pieces.at(-1) ?? trimmed)
  }
  return [...slugs].sort().map(value => ({ kind: 'exact', value }))
}

function discoveryRequestFor(draft: AdvancedMeasurementImportDraft): MeasurementDiscoveryRequest {
  const exampleHost = draft.examplePropertyUrl.trim() ? normalizedHost(draft.examplePropertyUrl) : null
  const sitemapHost = normalizedHost(draft.sitemapUrl)
  const host = normalizedHost(draft.preferredHost) ?? exampleHost ?? sitemapHost
  if (!host) throw new Error('Add a valid Sitemap URL, Preferred host, or Example Property URL.')
  const additionalHost = normalizedHost(draft.additionalHost)
  const hasAdditionalHost = draft.additionalHost.trim().length > 0
  const hasAdditionalPath = draft.additionalPathPattern.trim().length > 0
  if (hasAdditionalHost !== hasAdditionalPath || (hasAdditionalHost && !additionalHost)) {
    throw new Error('Add both a valid Additional URL domain and Additional URL pattern.')
  }
  const excluded = excludedSlugPatterns(draft.excludedPaths)
  return {
    sitemapUrl: draft.sitemapUrl.trim(),
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function confirmedPropertyIds(draft: PortfolioSetupDraft | null): string[] {
  return draft?.targets.filter(property => property.status === 'confirmed').map(property => property.stableKey) ?? []
}

function querySource(queryId: string, draft: PortfolioSetupDraft): Pick<AdvancedMeasurementQuery, 'source' | 'sourceDetail'> {
  const sets = draft.querySets.filter(set => set.queryIds.includes(queryId))
  if (sets.length === 0) return { source: 'saved-project-queries' }
  return {
    source: 'query-sets',
    sourceDetail: sets.map(set => set.label).join(', '),
  }
}

function propertyUrlLabel(url: PortfolioSetupDraft['targets'][number]['urls'][number] | undefined): string {
  if (!url) return 'No URL'
  if (url.kind === 'exact') return url.url
  if (url.kind === 'prefix') return `https://${url.host}${url.pathPrefix}`
  return `https://${url.host}`
}

function sitemapExceptionReason(reason: string): string {
  switch (reason) {
    case 'shared-path': return 'Shared page, not a single Property'
    case 'unmatched-path': return 'Does not match the Property URL pattern'
    case 'excluded-slug': return 'Matches an ignored URL path'
    case 'outside-project': return 'Outside this project domain'
    case 'duplicate-url': return 'Duplicate sitemap URL'
    case 'url-not-rediscovered': return 'No longer present in the sitemap'
    case 'target-not-rediscovered': return 'Property was not found in the latest sitemap'
    default: return 'Needs review before publishing'
  }
}

/**
 * The shared model exposes target-wide clearing, but no single-query removal.
 * Rebuild the affected target assignments through its existing primitives so a
 * removal cannot silently erase an unrelated query assignment.
 */
function removeQueryAssignments(draft: PortfolioSetupDraft, queryId: string): PortfolioSetupDraft {
  const affectedTargetKeys = unique(draft.assignments
    .filter(assignment => assignment.queryId === queryId)
    .map(assignment => assignment.targetKey))
  if (affectedTargetKeys.length === 0) return draft

  let next = clearTargetAssignments(draft, affectedTargetKeys)
  for (const assignment of draft.assignments) {
    if (!affectedTargetKeys.includes(assignment.targetKey) || assignment.queryId === queryId) continue
    next = assignQueriesToTargets(next, {
      targetKeys: [assignment.targetKey],
      queryIds: [assignment.queryId],
      context: assignment.context,
    })
  }
  return next
}

/**
 * Bulk selection means "ensure these links exist". It must not silently replace
 * an existing location choice when the v1 editor cannot display that choice.
 */
function applyMissingQueryAssignments(
  draft: PortfolioSetupDraft,
  selection: { queryIds: readonly string[]; propertyIds: readonly string[] },
): PortfolioSetupDraft {
  const existingPairs = new Set(draft.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
  let next = draft
  for (const propertyId of unique(selection.propertyIds)) {
    for (const queryId of unique(selection.queryIds)) {
      const pair = `${propertyId}\u0000${queryId}`
      if (existingPairs.has(pair)) continue
      next = assignQueriesToTargets(next, {
        targetKeys: [propertyId],
        queryIds: [queryId],
        context: undefined,
      })
      existingPairs.add(pair)
    }
  }
  return next
}

function normalizedGroupName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function groupStableKey(name: string, index: number): string {
  const normalized = normalizedGroupName(name)
  return `group-${normalized || index + 1}`
}

function checksToFlags(checks: readonly MeasurementPlanCompilePreviewResponse['checks'][number][]): AdvancedMeasurementFlaggedException[] {
  return checks.map((check, index) => ({
    id: `current-check-${index}:${check.id}`,
    title: check.severity === 'fail' ? 'Current plan check failed' : 'Current plan check needs review',
    detail: customerCopy(check.message),
    tone: check.severity === 'fail' ? 'negative' : 'caution',
  }))
}

function compileFails(response: MeasurementPlanCompilePreviewResponse | MeasurementPlanDiffPreviewResponse): boolean {
  return response.checks.some(check => check.severity === 'fail')
}

function changeCount(label: string, added: number, removed: number, changed: number): string | null {
  const parts = [
    added > 0 ? `${added} added` : null,
    removed > 0 ? `${removed} removed` : null,
    changed > 0 ? `${changed} changed` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `${label}: ${parts.join(', ')}` : null
}

function summarizeReviewedChanges(response: MeasurementPlanDiffPreviewResponse): ReviewedChanges {
  // Keep this boundary defensive even though the generated DTO guarantees a
  // diff for successful responses. A stale or hand-written client must not
  // crash the publish review screen.
  const diff = (response as { diff?: ReviewedDiff | null }).diff
  if (!response.ok || !diff) {
    return { title: 'Setup checked', items: ['The setup passed its current checks.'] }
  }
  const items = [
    changeCount('Properties', diff.targets.added.length, diff.targets.removed.length, diff.targets.changed.length),
    changeCount('Query assignments', diff.querySelections.added.length, diff.querySelections.removed.length, diff.querySelections.changed.length),
    changeCount('Groups', diff.groups.added.length, diff.groups.removed.length, diff.groups.changed.length),
  ].filter((item): item is string => item !== null)
  return {
    title: diff.activeRevision === null ? 'New setup checked' : 'Changes checked',
    items: items.length > 0 ? items : ['No changes from the published setup.'],
  }
}

export function AdvancedMeasurementSection({
  projectName,
  queries,
  isQueryLoading,
  isQueryError,
  onRetryQueries,
  activePlan,
  isPlanLoading,
  isPlanError,
  onRetryPlan,
  onDiscover,
  onCompilePlan,
  onDiffPlan,
  onPublishPlan,
  canEdit = true,
  onManageProjectQueries,
  onPublished,
}: AdvancedMeasurementSectionProps) {
  const [initialState] = useState(() => {
    const initialActiveKey = activePlan && !isPlanLoading && !isPlanError
      ? `${activePlan.revision}:${activePlan.checksum}`
      : 'none'
    const stored = readCompatibilityDraft(projectName, initialActiveKey)
    const active = !isPlanLoading && !isPlanError && activePlan ? stateFromActivePlan(activePlan.plan) : null
    return {
      stored,
      baseActiveKey: stored?.baseActiveKey ?? initialActiveKey,
      portfolio: stored?.portfolio ?? active,
      step: stored?.portfolio ? 'properties' as SetupStep : active ? 'properties' as SetupStep : 'import' as SetupStep,
    }
  })
  const [draft, setDraft] = useState<PortfolioSetupDraft | null>(initialState.portfolio)
  const [importDraft, setImportDraft] = useState(() => copyImportDraft(initialState.stored?.importDraft))
  const [groupDraft, setGroupDraft] = useState(() => copyGroupDraft(initialState.stored?.groupDraft))
  const [editingGroupId, setEditingGroupId] = useState<string | null>(initialState.stored?.editingGroupId ?? null)
  const [step, setStep] = useState<SetupStep>(initialState.step)
  const [hasCompatibilityDraft, setHasCompatibilityDraft] = useState(initialState.stored !== null)
  const [draftBaseActiveKey, setDraftBaseActiveKey] = useState(initialState.baseActiveKey)
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [reviewState, setReviewState] = useState<AdvancedMeasurementReviewState>('idle')
  const [propertiesSearch, setPropertiesSearch] = useState('')
  const [maxVisibleProperties, setMaxVisibleProperties] = useState(DEFAULT_VISIBLE_PROPERTIES)
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>(() => confirmedPropertyIds(initialState.portfolio))
  const [selectedQueryIds, setSelectedQueryIds] = useState<string[]>([])
  const [isApplying, setIsApplying] = useState(false)
  const [isSavingGroup, setIsSavingGroup] = useState(false)
  const [isReviewingChanges, setIsReviewingChanges] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [coverageResolution, setCoverageResolution] = useState<Exclude<DraftCoverageResolution, 'pending'>>('keep-existing')
  const [actionError, setActionError] = useState<string | null>(null)
  const [serverFlags, setServerFlags] = useState<AdvancedMeasurementFlaggedException[]>([])
  const [reviewedSetup, setReviewedSetup] = useState<ReviewedSetup | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [publishedPlan, setPublishedPlan] = useState<ActivePlan | null>(null)
  const seededActiveKeyRef = useRef<string | null>(activePlan && !isPlanLoading && !isPlanError ? `${activePlan.revision}:${activePlan.checksum}` : null)
  const projectRef = useRef(projectName)
  const currentFingerprintRef = useRef<string | null>(null)
  const currentActiveKeyRef = useRef('none')

  const effectiveActivePlan = publishedPlan ?? activePlan
  const activeKey = effectiveActivePlan ? `${effectiveActivePlan.revision}:${effectiveActivePlan.checksum}` : 'none'

  useEffect(() => {
    if (projectRef.current === projectName) return
    projectRef.current = projectName
    const nextActiveKey = activePlan && !isPlanLoading && !isPlanError
      ? `${activePlan.revision}:${activePlan.checksum}`
      : 'none'
    const stored = readCompatibilityDraft(projectName, nextActiveKey)
    const active = !isPlanLoading && !isPlanError && activePlan ? stateFromActivePlan(activePlan.plan) : null
    setDraft(stored?.portfolio ?? active)
    setImportDraft(copyImportDraft(stored?.importDraft))
    setGroupDraft(copyGroupDraft(stored?.groupDraft))
    setEditingGroupId(stored?.editingGroupId ?? null)
    setStep(stored?.portfolio ? 'properties' : active ? 'properties' : 'import')
    setHasCompatibilityDraft(stored !== null)
    setDraftBaseActiveKey(stored?.baseActiveKey ?? nextActiveKey)
    setStorageUnavailable(false)
    setMaxVisibleProperties(DEFAULT_VISIBLE_PROPERTIES)
    setSelectedPropertyIds(confirmedPropertyIds(stored?.portfolio ?? active))
    setSelectedQueryIds([])
    setActionError(null)
    setServerFlags([])
    setReviewedSetup(null)
    setSuccessMessage(null)
    seededActiveKeyRef.current = activePlan ? `${activePlan.revision}:${activePlan.checksum}` : null
  }, [activePlan, isPlanError, isPlanLoading, projectName])

  useEffect(() => {
    if (isPlanLoading || isPlanError || hasCompatibilityDraft || !activePlan) return
    const nextActiveKey = `${activePlan.revision}:${activePlan.checksum}`
    if (seededActiveKeyRef.current === nextActiveKey) return
    setDraft(stateFromActivePlan(activePlan.plan))
    setDraftBaseActiveKey(nextActiveKey)
    setSelectedPropertyIds(activePlan.plan.targets.map(property => property.stableKey))
    setSelectedQueryIds([])
    setStep('properties')
    setPublishedPlan(null)
    setEditingGroupId(null)
    setReviewedSetup(null)
    setSuccessMessage(null)
    seededActiveKeyRef.current = nextActiveKey
  }, [activePlan, hasCompatibilityDraft, isPlanError, isPlanLoading])

  useEffect(() => {
    if (!hasCompatibilityDraft) return
    const saved = saveCompatibilityDraft(projectName, {
      schemaVersion: 1,
      baseActiveKey: draftBaseActiveKey,
      importDraft,
      groupDraft,
      editingGroupId,
      portfolio: draft,
    })
    setStorageUnavailable(!saved)
  }, [draft, draftBaseActiveKey, editingGroupId, groupDraft, hasCompatibilityDraft, importDraft, projectName])

  useEffect(() => {
    setServerFlags([])
    setReviewedSetup(null)
  }, [draft])

  const importProperties = useMemo<ImportProperty[]>(() => (
    (draft?.targets ?? []).map(property => ({
      id: property.stableKey,
      name: property.label,
      url: propertyUrlLabel(property.urls[0]),
      urls: property.urls.map(propertyUrlLabel),
      state: property.status === 'confirmed' ? 'confirmed' : property.status === 'rejected' ? 'excluded' : 'proposed',
    }))
  ), [draft])

  const confirmedProperties = useMemo<SetupProperty[]>(() => (
    (draft?.targets ?? [])
      .filter(property => property.status === 'confirmed')
      .map(property => ({ id: property.stableKey, label: property.label, urlCount: property.urls.length }))
  ), [draft])

  const setupQueries = useMemo<AdvancedMeasurementQuery[]>(() => {
    if (!draft) return []
    const availableQueryIds = new Set(queries.map(query => query.id))
    const available = queries.map(query => ({
      id: query.id,
      text: query.query,
      ...querySource(query.id, draft),
      // v1 plan data records assignments but carries no branded/non-brand
      // classification. The presentation intentionally renders this as needs
      // review instead of guessing from query text.
      propertyIds: unique(draft.assignments
        .filter(assignment => assignment.queryId === query.id)
        .map(assignment => assignment.targetKey)),
    }))
    const missing = unique(draft.assignments
      .map(assignment => assignment.queryId)
      .filter(queryId => !availableQueryIds.has(queryId)))
      .map(queryId => ({
        id: queryId,
        text: `Unavailable tracked query (${queryId})`,
        source: 'unavailable-tracked-query' as const,
        state: 'missing' as const,
        propertyIds: unique(draft.assignments
          .filter(assignment => assignment.queryId === queryId)
          .map(assignment => assignment.targetKey)),
      }))
    return [...available, ...missing]
  }, [draft, queries])

  const setupGroups = useMemo<AdvancedMeasurementGroup[]>(() => (
    (draft?.groups ?? []).map(group => ({
      id: group.stableKey,
      name: group.label,
      propertyIds: group.targetKeys,
      competitors: group.competitors ?? [],
    }))
  ), [draft])

  const validationIssues = useMemo(() => draft ? validatePortfolioDraft(draft) : [], [draft])
  const assignmentCount = useMemo(() => {
    if (!draft) return 0
    const confirmed = new Set(draft.targets.filter(property => property.status === 'confirmed').map(property => property.stableKey))
    return draft.assignments.filter(assignment => confirmed.has(assignment.targetKey)).length
  }, [draft])
  const planInput = useMemo<MeasurementPlanInput | null>(() => {
    if (!draft || validationIssues.length > 0) return null
    try {
      return toMeasurementPlanInput(draft)
    } catch {
      return null
    }
  }, [draft, validationIssues])
  const planFingerprint = planInput ? JSON.stringify(planInput) : null
  currentFingerprintRef.current = planFingerprint
  currentActiveKeyRef.current = activeKey
  const hasDraftConflict = hasCompatibilityDraft && draftBaseActiveKey !== activeKey

  const pendingSitemapExceptions = useMemo(() => (
    draft?.exceptions.filter(exception => exception.status === 'unreviewed') ?? []
  ), [draft])
  const pendingCoverageReviews = useMemo(() => {
    if (!draft) return []
    const statusByProperty = new Map(draft.targets.map(property => [property.stableKey, property.status]))
    return draft.coverageReviews.filter(review => (
      review.resolution === 'pending' && statusByProperty.get(review.targetKey) !== 'rejected'
    ))
  }, [draft])
  const reviewFlags = useMemo<AdvancedMeasurementFlaggedException[]>(() => [
    ...(assignmentCount === 0 ? [{
      id: 'local-validation:no-query-assignments',
      title: 'Assign at least one query',
      detail: 'Choose a tracked query and apply it to at least one Property before publishing.',
      tone: 'negative' as const,
    }] : []),
    ...validationIssues
      .filter(issue => issue.code !== 'exception-review-required' && issue.code !== 'coverage-review-required')
      .map((issue, index) => ({
      id: `local-validation-${index}:${issue.code}`,
      title: 'Setup needs attention',
      detail: customerValidationCopy(issue),
      tone: 'negative' as const,
      })),
    ...serverFlags,
  ], [assignmentCount, serverFlags, validationIssues])

  const queryAvailability: AdvancedMeasurementAvailability = isQueryLoading
    ? { status: 'unavailable', message: 'Tracked queries are loading. Wait for the current list before assigning Properties.' }
    : isQueryError
      ? { status: 'unavailable', message: 'Tracked queries could not be loaded. Retry the current list before assigning Properties.' }
      : { status: 'available' }

  function markCompatibilityDraft(): void {
    if (!hasCompatibilityDraft) setDraftBaseActiveKey(activeKey)
    setHasCompatibilityDraft(true)
  }

  function updateDraft(next: PortfolioSetupDraft): void {
    if (!canEdit) return
    setDraft(next)
    markCompatibilityDraft()
    setActionError(null)
    setSuccessMessage(null)
  }

  function updateImportDraft(next: AdvancedMeasurementImportDraft): void {
    if (!canEdit) return
    setImportDraft(next)
    setReviewState('idle')
    markCompatibilityDraft()
    setActionError(null)
    setSuccessMessage(null)
  }

  async function reviewSitemap(nextImportDraft: AdvancedMeasurementImportDraft): Promise<void> {
    if (!canEdit) return
    let request: MeasurementDiscoveryRequest
    try {
      request = discoveryRequestFor(nextImportDraft)
    } catch (error) {
      setReviewState('idle')
      setActionError(errorMessage(error, 'Check the import rules and try again.'))
      return
    }
    setReviewState('reviewing')
    setActionError(null)
    try {
      const response = await onDiscover(request)
      const next = draft ? reconcileDraftWithDiscovery(draft, response) : createDraftFromDiscovery(response)
      updateDraft(next)
      setSelectedPropertyIds(confirmedPropertyIds(next))
      setPropertiesSearch('')
      setMaxVisibleProperties(DEFAULT_VISIBLE_PROPERTIES)
      setStep('properties')
      setReviewState('idle')
    } catch {
      setReviewState('error')
      setActionError(null)
    }
  }

  function continueProperties(selectedIds: readonly string[]): void {
    if (!canEdit || !draft) return
    const selected = new Set(selectedIds)
    const excludedIds = draft.targets
      .filter(property => !selected.has(property.stableKey))
      .map(property => property.stableKey)
    const excluded = new Set(excludedIds)
    let next = draft.targets.reduce((current, property) => (
      selected.has(property.stableKey)
        ? confirmTarget(current, property.stableKey)
        : rejectTarget(current, property.stableKey)
    ), draft)

    // Excluding a Property is a destructive setup choice, so remove every
    // dependent assignment and group membership at the same boundary. Leaving
    // those links behind can revive stale assignments during a later edit.
    next = clearTargetAssignments(next, excludedIds)
    for (const group of next.groups) {
      const targetKeys = group.targetKeys.filter(targetKey => !excluded.has(targetKey))
      next = targetKeys.length > 0
        ? upsertReportingGroup(next, { ...group, targetKeys })
        : removeReportingGroup(next, group.stableKey)
    }
    updateDraft(next)
    setSelectedPropertyIds(confirmedPropertyIds(next))
    setStep('queries')
  }

  async function applySelectedQueries(selection: { queryIds: readonly string[]; propertyIds: readonly string[] }): Promise<void> {
    if (!canEdit || !draft) return
    setIsApplying(true)
    setActionError(null)
    try {
      updateDraft(applyMissingQueryAssignments(draft, selection))
      setSelectedQueryIds([])
    } catch (error) {
      setActionError(errorMessage(error, 'Could not apply these queries.'))
    } finally {
      setIsApplying(false)
    }
  }

  function removeQuery(queryId: string): void {
    if (!canEdit || !draft) return
    try {
      updateDraft(removeQueryAssignments(draft, queryId))
      setSelectedQueryIds(current => current.filter(id => id !== queryId))
    } catch (error) {
      setActionError(errorMessage(error, 'Could not remove this query assignment.'))
    }
  }

  async function saveGroup(nextGroupDraft: AdvancedMeasurementGroupDraft): Promise<void> {
    if (!canEdit || !draft) return
    setIsSavingGroup(true)
    setActionError(null)
    try {
      const proposedStableKey = groupStableKey(nextGroupDraft.name, draft.groups.length)
      const proposedNameKey = normalizedGroupName(nextGroupDraft.name)
      const conflictingGroup = draft.groups.find(group => (
        group.stableKey !== editingGroupId
        && (group.stableKey === proposedStableKey || normalizedGroupName(group.label) === proposedNameKey)
      ))
      if (conflictingGroup) {
        throw new Error(`A group named "${conflictingGroup.label}" already exists. Edit it or choose a different name.`)
      }
      updateDraft(upsertReportingGroup(draft, {
        stableKey: editingGroupId ?? proposedStableKey,
        label: nextGroupDraft.name,
        targetKeys: [...nextGroupDraft.propertyIds],
        ...(nextGroupDraft.competitorDomains.trim() ? {
          competitors: unique(nextGroupDraft.competitorDomains.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)),
        } : {}),
      }))
      setGroupDraft(copyGroupDraft())
      setEditingGroupId(null)
    } catch (error) {
      setActionError(errorMessage(error, 'Could not save this group.'))
    } finally {
      setIsSavingGroup(false)
    }
  }

  function editGroup(groupId: string): void {
    if (!canEdit || !draft) return
    const group = draft.groups.find(item => item.stableKey === groupId)
    if (!group) return
    setEditingGroupId(group.stableKey)
    setGroupDraft({
      name: group.label,
      propertyIds: [...group.targetKeys],
      competitorDomains: (group.competitors ?? []).join(', '),
    })
    markCompatibilityDraft()
  }

  function removeGroup(groupId: string): void {
    if (!canEdit || !draft) return
    try {
      updateDraft(removeReportingGroup(draft, groupId))
      if (editingGroupId === groupId) {
        setEditingGroupId(null)
        setGroupDraft(copyGroupDraft())
      }
    } catch (error) {
      setActionError(errorMessage(error, 'Could not remove this group.'))
    }
  }

  function clearGroupDraft(): void {
    if (!canEdit) return
    setEditingGroupId(null)
    setGroupDraft(copyGroupDraft())
  }

  function resolveSitemapReview(): void {
    if (!canEdit || !draft) return
    try {
      let next = pendingSitemapExceptions.length > 0 ? reviewAllExceptions(draft) : draft
      if (pendingCoverageReviews.length > 0) {
        next = resolveCoverageReviews(next, pendingCoverageReviews.map(review => review.targetKey), coverageResolution)
      }
      updateDraft(next)
    } catch (error) {
      setActionError(errorMessage(error, 'Could not apply the sitemap review.'))
    }
  }

  async function reviewSetupChanges(): Promise<void> {
    if (!canEdit || hasDraftConflict || !planInput || assignmentCount === 0 || validationIssues.length > 0 || isReviewingChanges || isPublishing) return
    const checkedFingerprint = JSON.stringify(planInput)
    const checkedActiveKey = activeKey
    setIsReviewingChanges(true)
    setActionError(null)
    setServerFlags([])
    setReviewedSetup(null)
    try {
      const [compile, diff] = await Promise.all([onCompilePlan(planInput), onDiffPlan(planInput)])
      if (currentFingerprintRef.current !== checkedFingerprint || currentActiveKeyRef.current !== checkedActiveKey) {
        setActionError('The setup changed while it was being checked. Review it again before publishing.')
        return
      }
      const checks = [...compile.checks, ...diff.checks]
      setServerFlags(checksToFlags(checks))
      if (compileFails(compile) || compileFails(diff)) return

      setReviewedSetup({
        fingerprint: checkedFingerprint,
        activeKey: checkedActiveKey,
        input: planInput,
        changes: summarizeReviewedChanges(diff),
      })
    } catch (error) {
      setActionError(errorMessage(error, 'Could not review this setup.'))
    } finally {
      setIsReviewingChanges(false)
    }
  }

  async function publishSetup(): Promise<void> {
    if (!canEdit || hasDraftConflict || !reviewedSetup || isPublishing || isReviewingChanges) return
    if (currentFingerprintRef.current !== reviewedSetup.fingerprint || currentActiveKeyRef.current !== reviewedSetup.activeKey) {
      setReviewedSetup(null)
      setActionError('The setup changed after it was checked. Review the current changes before publishing.')
      return
    }
    setIsPublishing(true)
    setActionError(null)
    try {
      const response = await onPublishPlan(reviewedSetup.input, effectiveActivePlan?.revision ?? null)

      clearCompatibilityDraft(projectName)
      setHasCompatibilityDraft(false)
      setStorageUnavailable(false)
      setImportDraft(copyImportDraft())
      setGroupDraft(copyGroupDraft())
      setEditingGroupId(null)
      setPublishedPlan(response.active)
      if (response.active) {
        setDraftBaseActiveKey(`${response.active.revision}:${response.active.checksum}`)
        setDraft(stateFromActivePlan(response.active.plan))
        setStep('properties')
        setSuccessMessage('Advanced measurement setup published.')
        seededActiveKeyRef.current = `${response.active.revision}:${response.active.checksum}`
        onPublished?.()
      } else {
        setDraft(null)
        setStep('import')
        setActionError('The setup was published, but the current setup was not returned. Refresh before editing it again.')
      }
    } catch (error) {
      setActionError(errorMessage(error, 'Could not publish this setup.'))
    } finally {
      setIsPublishing(false)
    }
  }

  function discardCompatibilityDraft(): void {
    if (!canEdit) return
    clearCompatibilityDraft(projectName)
    setHasCompatibilityDraft(false)
    setDraftBaseActiveKey(activeKey)
    setStorageUnavailable(false)
    setImportDraft(copyImportDraft())
    setGroupDraft(copyGroupDraft())
    setEditingGroupId(null)
    const active = effectiveActivePlan ? stateFromActivePlan(effectiveActivePlan.plan) : null
    setSelectedPropertyIds(confirmedPropertyIds(active))
    setSelectedQueryIds([])
    setActionError(null)
    setServerFlags([])
    setReviewedSetup(null)
    setSuccessMessage(null)
    setDraft(active)
    setStep(active ? 'properties' : 'import')
  }

  if (isPlanLoading) {
    return (
      <section aria-labelledby="advanced-measurement-loading-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-loading-title">Advanced measurement setup</h2></div>
        <div className="h-28 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading advanced measurement setup" />
      </section>
    )
  }

  if (isPlanError) {
    return (
      <section aria-labelledby="advanced-measurement-error-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-error-title">Advanced measurement setup</h2></div>
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
          <p>Could not load the active measurement setup.</p>
          {onRetryPlan ? <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onRetryPlan}>Try again</Button> : null}
        </div>
      </section>
    )
  }

  const compatibilityNotice = hasCompatibilityDraft && storageUnavailable ? (
    <p role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-3 text-sm text-secondary">
      Unpublished changes are only available on this page. This browser cannot save them.
    </p>
  ) : null

  const conflictNotice = hasDraftConflict ? (
    <p role="alert" className="border-y border-caution-800/40 bg-caution-950/20 py-3 text-sm text-secondary">
      The published setup changed in another session. Discard these unpublished changes and start again before publishing.
    </p>
  ) : null

  const retryQueries = isQueryError && onRetryQueries ? (
    <div className="flex justify-end">
      <Button type="button" size="sm" variant="outline" onClick={onRetryQueries}>Retry tracked queries</Button>
    </div>
  ) : null

  return (
    <div className="space-y-4">
      {compatibilityNotice}
      {conflictNotice}
      {successMessage ? <p role="status" className="border-y border-positive-800/40 bg-positive-950/20 py-3 text-sm text-positive">{successMessage}</p> : null}
      {actionError ? <p role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">{actionError}</p> : null}
      {retryQueries}
      {step === 'import' || step === 'properties' ? (
        <AdvancedMeasurementSetup
          currentStep={step}
          hasDraft={hasCompatibilityDraft}
          canEdit={canEdit}
          onDiscard={discardCompatibilityDraft}
          importProperties={{
            importDraft,
            onImportDraftChange: updateImportDraft,
            onReviewSitemap: draft => { void reviewSitemap(draft) },
            reviewState,
            properties: importProperties,
            propertiesState: 'ready',
            propertiesSearch,
            onPropertiesSearchChange: setPropertiesSearch,
            maxVisibleProperties,
            onShowAllProperties: () => setMaxVisibleProperties(importProperties.length),
            selectedPropertyIds,
            onSelectedPropertyIdsChange: ids => setSelectedPropertyIds([...ids]),
            onContinue: continueProperties,
            onRetryProperties: () => onRetryPlan?.(),
            onReturnToImport: () => setStep('import'),
          }}
        />
      ) : step === 'queries' ? (
        <AdvancedMeasurementSetup
          currentStep="queries"
          hasDraft={hasCompatibilityDraft}
          canEdit={canEdit}
          onDiscard={discardCompatibilityDraft}
          onManageProjectQueries={onManageProjectQueries}
          queries={{
            availability: queryAvailability,
            properties: confirmedProperties,
            queries: setupQueries,
            selectedPropertyIds,
            selectedQueryIds,
            isApplying,
            onSelectedPropertyIdsChange: ids => setSelectedPropertyIds([...ids]),
            onSelectedQueryIdsChange: ids => setSelectedQueryIds([...ids]),
            onApplySelectedQueries: selection => { void applySelectedQueries(selection) },
            onRemoveQuery: removeQuery,
            canContinue: assignmentCount > 0,
            onBack: () => setStep('properties'),
            onContinue: () => {
              if (assignmentCount > 0) setStep('groups')
            },
          }}
        />
      ) : step === 'groups' ? (
        <AdvancedMeasurementSetup
          currentStep="groups"
          hasDraft={hasCompatibilityDraft}
          canEdit={canEdit}
          onDiscard={discardCompatibilityDraft}
          groups={{
            properties: confirmedProperties,
            groups: setupGroups,
            groupDraft,
            isSaving: isSavingGroup,
            onGroupDraftChange: next => {
              if (!canEdit) return
              setGroupDraft(copyGroupDraft(next))
              markCompatibilityDraft()
            },
            onSaveGroup: draft => { void saveGroup(draft) },
            onEditGroup: group => editGroup(group.id),
            onRemoveGroup: removeGroup,
            onClearGroupDraft: clearGroupDraft,
            onBack: () => setStep('queries'),
            onContinue: () => setStep('review'),
          }}
        />
      ) : (
        <AdvancedMeasurementSetup
          currentStep="review"
          hasDraft={hasCompatibilityDraft}
          canEdit={canEdit}
          onDiscard={discardCompatibilityDraft}
          review={{
            counts: {
              properties: confirmedProperties.length,
              queries: new Set(draft?.assignments.map(assignment => assignment.queryId) ?? []).size,
              groups: setupGroups.length,
            },
            flaggedExceptions: reviewFlags,
            sitemapReview: pendingSitemapExceptions.length > 0 || pendingCoverageReviews.length > 0 ? {
              exceptionCount: pendingSitemapExceptions.length,
              coverageReviewCount: pendingCoverageReviews.length,
              items: pendingSitemapExceptions.map(item => ({
                url: item.url,
                reason: sitemapExceptionReason(item.reason),
              })),
              coverageItems: pendingCoverageReviews.map(review => ({
                property: draft?.targets.find(property => property.stableKey === review.targetKey)?.label ?? 'Unknown Property',
                savedUrls: review.existingUrls.map(propertyUrlLabel),
                currentSitemapUrls: review.importedUrls.map(propertyUrlLabel),
              })),
              coverageResolution,
              onCoverageResolutionChange: setCoverageResolution,
              onResolve: resolveSitemapReview,
            } : undefined,
            reviewedChanges: reviewedSetup?.changes,
            isReviewing: isReviewingChanges,
            canReviewChanges: canEdit && !hasDraftConflict && planInput !== null && assignmentCount > 0 && validationIssues.length === 0 && !isPublishing,
            onReviewChanges: () => { void reviewSetupChanges() },
            onBack: () => setStep('groups'),
            canPublish: canEdit && !hasDraftConflict && reviewedSetup !== null && assignmentCount > 0 && validationIssues.length === 0 && !isPublishing && !isReviewingChanges,
            isPublishing,
            onPublish: () => { void publishSetup() },
          }}
        />
      )}
    </div>
  )
}
