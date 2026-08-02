import type {
  LocationContext,
  MeasurementDiscoveryResponse,
  MeasurementPlanInput,
  MeasurementPlanResponse,
  QueryDto,
} from '@ainyc/canonry-api-client'
import {
  normalizeMeasurementExactUrl,
  normalizeMeasurementHost,
  normalizeMeasurementPathPrefix,
} from '@ainyc/canonry-contracts'

export type DraftTargetUrl = MeasurementPlanInput['targets'][number]['urls'][number]
export type DraftReportingGroup = NonNullable<MeasurementPlanInput['groups']>[number]
export type DraftTargetStatus = 'proposed' | 'confirmed' | 'rejected'

export interface DraftTarget {
  stableKey: string
  label: string
  status: DraftTargetStatus
  urls: DraftTargetUrl[]
  aliases: string[]
  metadata?: Record<string, string>
}

export interface DraftDiscoveryException {
  key: string
  bucket: 'shared' | 'unmatched' | 'excluded' | 'diagnostic'
  url: string
  canonicalUrl: string | null
  reason: string
  targetKey?: string
  duplicateOf?: string
  status: 'unreviewed' | 'reviewed'
}

export type DraftCoverageResolution = 'pending' | 'keep-existing' | 'replace-with-imported'

export interface DraftCoverageReview {
  targetKey: string
  existingUrls: DraftTargetUrl[]
  importedUrls: DraftTargetUrl[]
  previousStatus: DraftTargetStatus
  resolution: DraftCoverageResolution
}

/** `undefined` inherits the project default; `null` explicitly disables location. */
export type DraftExecutionContext = LocationContext | null | undefined

export interface DraftQuerySet {
  key: string
  label: string
  queryIds: string[]
  context: DraftExecutionContext
}

export interface DraftQueryTemplate {
  key: string
  label: string
  template: string
  context: DraftExecutionContext
}

export interface DraftQueryAssignment {
  targetKey: string
  queryId: string
  context: DraftExecutionContext
}

export interface ExpandedTemplateQuery {
  targetKey: string
  queryText: string
  context: DraftExecutionContext
}

export interface PortfolioSetupDraft {
  schemaVersion: 1
  targets: DraftTarget[]
  exceptions: DraftDiscoveryException[]
  coverageReviews: DraftCoverageReview[]
  querySets: DraftQuerySet[]
  queryTemplates: DraftQueryTemplate[]
  assignments: DraftQueryAssignment[]
  groups: DraftReportingGroup[]
}

export type DraftValidationCode =
  | 'no-confirmed-targets'
  | 'target-review-required'
  | 'target-url-required'
  | 'coverage-review-required'
  | 'exception-review-required'
  | 'assignment-target-unavailable'
  | 'group-target-unavailable'
  | 'group-target-required'
  | 'query-set-empty'
  | 'template-placeholder-required'
  | 'duplicate-stable-key'

export interface DraftValidationIssue {
  severity: 'error'
  code: DraftValidationCode
  message: string
  targetKey?: string
}

type ActivePlan = NonNullable<MeasurementPlanResponse['active']>['plan']

const TARGET_LABEL_TOKEN = '{target.label}'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function canonicalMetadata(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value || Object.keys(value).length === 0) return undefined
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)))
}

function normalizeTargetUrl(value: DraftTargetUrl): DraftTargetUrl {
  if (value.kind === 'host') return { kind: 'host', host: normalizeMeasurementHost(value.host) }
  if (value.kind === 'prefix') {
    return {
      kind: 'prefix',
      host: normalizeMeasurementHost(value.host),
      pathPrefix: normalizeMeasurementPathPrefix(value.pathPrefix),
      pathCase: value.pathCase,
    }
  }
  return {
    kind: 'exact',
    url: normalizeMeasurementExactUrl(value.url),
    pathCase: value.pathCase,
  }
}

export function targetUrlKey(value: DraftTargetUrl): string {
  const url = normalizeTargetUrl(value)
  if (url.kind === 'host') return `host\u0000${url.host}`
  if (url.kind === 'prefix') return `prefix\u0000${url.host}\u0000${url.pathPrefix}\u0000${url.pathCase}`
  return `exact\u0000${url.url}\u0000${url.pathCase}`
}

function canonicalTargetUrls(values: readonly DraftTargetUrl[]): DraftTargetUrl[] {
  const byKey = new Map<string, DraftTargetUrl>()
  for (const value of values) {
    const normalized = normalizeTargetUrl(value)
    byKey.set(targetUrlKey(normalized), normalized)
  }
  const parts = (value: DraftTargetUrl): { host: string; path: string; specificity: number } => {
    if (value.kind === 'host') return { host: value.host, path: '', specificity: 1 }
    if (value.kind === 'prefix') return { host: value.host, path: value.pathPrefix, specificity: 2 }
    const parsed = new URL(value.url)
    return { host: parsed.hostname, path: parsed.pathname, specificity: 3 }
  }
  return [...byKey.values()].sort((left, right) => {
    const leftParts = parts(left)
    const rightParts = parts(right)
    return compareText(leftParts.host, rightParts.host)
      || rightParts.specificity - leftParts.specificity
      || compareText(leftParts.path, rightParts.path)
      || compareText(targetUrlKey(left), targetUrlKey(right))
  })
}

function sameTargetUrls(left: readonly DraftTargetUrl[], right: readonly DraftTargetUrl[]): boolean {
  const normalizedLeft = canonicalTargetUrls(left)
  const normalizedRight = canonicalTargetUrls(right)
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((url, index) => targetUrlKey(url) === targetUrlKey(normalizedRight[index]!))
}

function targetUrlFromDiscovery(value: string): DraftTargetUrl {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Discovery returned a non-HTTP URL')
  return normalizeTargetUrl({
    kind: 'prefix',
    host: parsed.hostname,
    pathPrefix: parsed.pathname || '/',
    pathCase: 'insensitive',
  })
}

function normalizeContext(value: DraftExecutionContext): DraftExecutionContext {
  if (value === undefined || value === null) return value
  return {
    label: value.label.trim(),
    city: value.city.trim(),
    region: value.region.trim(),
    country: value.country.trim(),
    ...(value.timezone ? { timezone: value.timezone.trim() } : {}),
  }
}

function contextKey(value: DraftExecutionContext): string {
  if (value === undefined) return 'inherit'
  if (value === null) return 'none'
  const normalized = normalizeContext(value)
  return ['location', normalized?.label, normalized?.city, normalized?.region, normalized?.country, normalized?.timezone ?? ''].join('\u0000')
}

function assignmentKey(value: Pick<DraftQueryAssignment, 'targetKey' | 'queryId' | 'context'>): string {
  return `${value.targetKey}\u0000${value.queryId}\u0000${contextKey(value.context)}`
}

function canonicalAssignments(values: readonly DraftQueryAssignment[]): DraftQueryAssignment[] {
  const byKey = new Map<string, DraftQueryAssignment>()
  for (const value of values) {
    const normalized: DraftQueryAssignment = {
      targetKey: value.targetKey.trim(),
      queryId: value.queryId.trim(),
      context: normalizeContext(value.context),
    }
    byKey.set(assignmentKey(normalized), normalized)
  }
  return [...byKey.values()].sort((left, right) => (
    compareText(left.targetKey, right.targetKey)
    || compareText(left.queryId, right.queryId)
    || compareText(contextKey(left.context), contextKey(right.context))
  ))
}

function normalizeGroup(value: DraftReportingGroup): DraftReportingGroup {
  const competitors = uniqueSorted(value.competitors ?? []).map(competitor => competitor.toLowerCase())
  return {
    stableKey: value.stableKey.trim(),
    label: value.label.trim(),
    targetKeys: uniqueSorted(value.targetKeys.map(targetKey => targetKey.trim())),
    ...(competitors.length > 0 ? { competitors } : {}),
  }
}

function canonicalDraft(draft: PortfolioSetupDraft): PortfolioSetupDraft {
  return {
    schemaVersion: 1,
    targets: [...draft.targets].map(target => ({
      stableKey: target.stableKey.trim(),
      label: target.label.trim(),
      status: target.status,
      urls: canonicalTargetUrls(target.urls),
      aliases: uniqueSorted(target.aliases.map(alias => alias.trim()).filter(Boolean)),
      ...(canonicalMetadata(target.metadata) ? { metadata: canonicalMetadata(target.metadata) } : {}),
    })).sort((left, right) => compareText(left.stableKey, right.stableKey)),
    exceptions: [...draft.exceptions].map(item => ({
      ...item,
      ...(item.targetKey ? { targetKey: item.targetKey.trim() } : {}),
      ...(item.duplicateOf ? { duplicateOf: item.duplicateOf } : {}),
    })).sort((left, right) => compareText(left.key, right.key)),
    coverageReviews: [...draft.coverageReviews].map(review => ({
      targetKey: review.targetKey.trim(),
      existingUrls: canonicalTargetUrls(review.existingUrls),
      importedUrls: canonicalTargetUrls(review.importedUrls),
      previousStatus: review.previousStatus,
      resolution: review.resolution,
    })).sort((left, right) => compareText(left.targetKey, right.targetKey)),
    querySets: [...draft.querySets].map(set => ({
      key: set.key.trim(),
      label: set.label.trim(),
      queryIds: uniqueSorted(set.queryIds.map(queryId => queryId.trim()).filter(Boolean)),
      context: normalizeContext(set.context),
    })).sort((left, right) => compareText(left.key, right.key)),
    queryTemplates: [...draft.queryTemplates].map(template => ({
      key: template.key.trim(),
      label: template.label.trim(),
      template: template.template.trim(),
      context: normalizeContext(template.context),
    })).sort((left, right) => compareText(left.key, right.key)),
    assignments: canonicalAssignments(draft.assignments),
    groups: [...draft.groups].map(normalizeGroup).sort((left, right) => compareText(left.stableKey, right.stableKey)),
  }
}

function exceptionKey(bucket: DraftDiscoveryException['bucket'], reason: string, url: string): string {
  return `${bucket}\u0000${reason}\u0000${url}`
}

export function createDraftFromDiscovery(discovery: MeasurementDiscoveryResponse): PortfolioSetupDraft {
  const targets: DraftTarget[] = discovery.proposed.map(candidate => ({
    stableKey: candidate.stableKey,
    label: candidate.label,
    status: 'proposed',
    urls: canonicalTargetUrls([
      targetUrlFromDiscovery(candidate.primaryUrl),
      ...candidate.aliasCoverageUrls.map(targetUrlFromDiscovery),
    ]),
    aliases: [candidate.label],
  }))

  const exceptions: DraftDiscoveryException[] = []
  for (const bucket of ['excluded', 'shared', 'unmatched'] as const) {
    for (const item of discovery[bucket]) {
      exceptions.push({
        key: exceptionKey(bucket, item.reason, item.url),
        bucket,
        url: item.url,
        canonicalUrl: item.canonicalUrl,
        reason: item.reason,
        status: 'unreviewed',
      })
    }
  }
  for (const diagnostic of discovery.diagnostics) {
    exceptions.push({
      key: exceptionKey('diagnostic', diagnostic.kind, diagnostic.url),
      bucket: 'diagnostic',
      url: diagnostic.url,
      canonicalUrl: diagnostic.canonicalUrl,
      reason: diagnostic.kind,
      ...(diagnostic.duplicateOf ? { duplicateOf: diagnostic.duplicateOf } : {}),
      status: 'unreviewed',
    })
  }

  return canonicalDraft({
    schemaVersion: 1,
    targets,
    exceptions,
    coverageReviews: [],
    querySets: [],
    queryTemplates: [],
    assignments: [],
    groups: [],
  })
}

/**
 * Refresh discovery without erasing reviewed setup. Existing identities,
 * assignments and reporting groups remain intact; new URL coverage requires a
 * fresh Target confirmation and missing coverage remains until explicitly
 * reviewed.
 */
export function reconcileDraftWithDiscovery(
  draft: PortfolioSetupDraft,
  discovery: MeasurementDiscoveryResponse,
): PortfolioSetupDraft {
  const incoming = createDraftFromDiscovery(discovery)
  const incomingByKey = new Map(incoming.targets.map(target => [target.stableKey, target]))
  const existingByKey = new Map(draft.targets.map(target => [target.stableKey, target]))
  const priorCoverageByKey = new Map(draft.coverageReviews.map(review => [review.targetKey, review]))
  const targets: DraftTarget[] = []
  const churn: DraftDiscoveryException[] = []
  const coverageReviews: DraftCoverageReview[] = []

  const reconcileExistingCoverage = (
    existing: DraftTarget,
    importedUrls: DraftTargetUrl[],
    missingReason: 'url-not-rediscovered' | 'target-not-rediscovered' = 'url-not-rediscovered',
  ): DraftTarget => {
    const prior = priorCoverageByKey.get(existing.stableKey)
    const expectedPriorUrls = prior?.resolution === 'keep-existing'
      ? prior.existingUrls
      : prior?.resolution === 'replace-with-imported'
        ? prior.importedUrls
        : prior
          ? canonicalTargetUrls([...prior.existingUrls, ...prior.importedUrls])
          : null
    const canReusePrior = prior !== undefined
      && sameTargetUrls(prior.importedUrls, importedUrls)
      && expectedPriorUrls !== null
      && sameTargetUrls(existing.urls, expectedPriorUrls)

    if (canReusePrior && prior.resolution === 'replace-with-imported') {
      return { ...existing, status: prior.previousStatus, urls: canonicalTargetUrls(importedUrls) }
    }

    const existingUrls = prior?.resolution === 'pending'
      ? prior.existingUrls
      : canReusePrior
        ? prior.existingUrls
        : existing.urls
    if (sameTargetUrls(existingUrls, importedUrls)) {
      return {
        ...existing,
        status: canReusePrior ? prior.previousStatus : existing.status,
        urls: canonicalTargetUrls(importedUrls),
      }
    }

    const review: DraftCoverageReview = canReusePrior ? prior : {
      targetKey: existing.stableKey,
      existingUrls: canonicalTargetUrls(existingUrls),
      importedUrls: canonicalTargetUrls(importedUrls),
      previousStatus: prior?.resolution === 'pending' ? prior.previousStatus : existing.status,
      resolution: 'pending',
    }
    coverageReviews.push(review)

    const importedKeys = new Set(importedUrls.map(targetUrlKey))
    for (const url of review.existingUrls) {
      if (importedKeys.has(targetUrlKey(url))) continue
      const label = matcherUrl(url)
      churn.push({
        key: exceptionKey('diagnostic', missingReason, `${existing.stableKey}:${label}`),
        bucket: 'diagnostic',
        url: label,
        canonicalUrl: label,
        reason: missingReason,
        targetKey: existing.stableKey,
        status: 'unreviewed',
      })
    }

    if (review.resolution === 'keep-existing') {
      return { ...existing, status: review.previousStatus, urls: review.existingUrls }
    }
    return {
      ...existing,
      status: review.previousStatus === 'confirmed' ? 'proposed' : review.previousStatus,
      urls: canonicalTargetUrls([...review.existingUrls, ...review.importedUrls]),
    }
  }

  for (const candidate of incoming.targets) {
    const existing = existingByKey.get(candidate.stableKey)
    if (!existing) {
      targets.push(candidate)
      continue
    }
    targets.push(reconcileExistingCoverage(existing, candidate.urls))
  }

  for (const existing of draft.targets) {
    if (incomingByKey.has(existing.stableKey)) continue
    targets.push(reconcileExistingCoverage(existing, [], 'target-not-rediscovered'))
  }

  const priorExceptions = new Map(draft.exceptions.map(item => [item.key, item]))
  const exceptions = [...incoming.exceptions, ...churn].map(item => {
    const prior = priorExceptions.get(item.key)
    return prior?.status === 'reviewed' ? { ...item, status: 'reviewed' as const } : item
  })
  return canonicalDraft({ ...draft, targets, exceptions, coverageReviews })
}

export function resolveCoverageReviews(
  draft: PortfolioSetupDraft,
  targetKeys: readonly string[],
  resolution: Exclude<DraftCoverageResolution, 'pending'>,
): PortfolioSetupDraft {
  const selected = new Set(uniqueSorted(targetKeys.map(targetKey => targetKey.trim()).filter(Boolean)))
  if (selected.size === 0) throw new Error('Choose at least one Target coverage review')
  const reviewsByKey = new Map(draft.coverageReviews.map(review => [review.targetKey, review]))
  const missing = [...selected].filter(targetKey => !reviewsByKey.has(targetKey))
  if (missing.length > 0) throw new Error(`Target coverage review not found: ${missing.join(', ')}`)

  const targets = draft.targets.map(target => {
    if (!selected.has(target.stableKey)) return target
    const review = reviewsByKey.get(target.stableKey)!
    return {
      ...target,
      status: review.previousStatus,
      urls: resolution === 'keep-existing' ? review.existingUrls : review.importedUrls,
    }
  })
  const coverageReviews = draft.coverageReviews.map(review => (
    selected.has(review.targetKey) ? { ...review, resolution } : review
  ))
  const exceptions = draft.exceptions.map(item => (
    item.targetKey && selected.has(item.targetKey)
      && (item.reason === 'url-not-rediscovered' || item.reason === 'target-not-rediscovered')
      ? { ...item, status: 'reviewed' as const }
      : item
  ))
  return canonicalDraft({ ...draft, targets, coverageReviews, exceptions })
}

function matcherUrl(url: DraftTargetUrl): string {
  if (url.kind === 'exact') return url.url
  if (url.kind === 'prefix') return `https://${url.host}${url.pathPrefix}`
  return `https://${url.host}`
}

export function stateFromActivePlan(plan: ActivePlan): PortfolioSetupDraft {
  const assignments: DraftQueryAssignment[] = []
  for (const selection of plan.targetQuerySelections) {
    for (const queryId of selection.queryIds) {
      assignments.push({ targetKey: selection.targetKey, queryId, context: selection.context })
    }
  }
  return canonicalDraft({
    schemaVersion: 1,
    targets: plan.targets.map(target => ({
      stableKey: target.stableKey,
      label: target.label,
      status: 'confirmed',
      urls: target.urls,
      aliases: target.aliases,
      ...(target.metadata ? { metadata: target.metadata } : {}),
    })),
    exceptions: [],
    coverageReviews: [],
    querySets: [],
    queryTemplates: [],
    assignments,
    groups: plan.groups,
  })
}

function updateTarget(draft: PortfolioSetupDraft, targetKey: string, update: (target: DraftTarget) => DraftTarget): PortfolioSetupDraft {
  if (!draft.targets.some(target => target.stableKey === targetKey)) throw new Error(`Target not found: ${targetKey}`)
  const targets = draft.targets.map(target => {
    if (target.stableKey !== targetKey) return target
    return update(target)
  })
  return canonicalDraft({ ...draft, targets })
}

export function confirmTarget(draft: PortfolioSetupDraft, targetKey: string): PortfolioSetupDraft {
  return updateTarget(draft, targetKey, target => ({ ...target, status: 'confirmed' }))
}

export function rejectTarget(draft: PortfolioSetupDraft, targetKey: string): PortfolioSetupDraft {
  return updateTarget(draft, targetKey, target => ({ ...target, status: 'rejected' }))
}

export function renameTarget(draft: PortfolioSetupDraft, targetKey: string, label: string): PortfolioSetupDraft {
  const normalized = label.trim()
  if (!normalized) throw new Error('Target name is required')
  return updateTarget(draft, targetKey, target => ({
    ...target,
    label: normalized,
    aliases: target.aliases.map(alias => alias === target.label ? normalized : alias),
  }))
}

export function addTargetUrl(draft: PortfolioSetupDraft, targetKey: string, url: DraftTargetUrl): PortfolioSetupDraft {
  return updateTarget(draft, targetKey, target => ({ ...target, urls: [...target.urls, url] }))
}

export function removeTargetUrl(draft: PortfolioSetupDraft, targetKey: string, url: DraftTargetUrl): PortfolioSetupDraft {
  const key = targetUrlKey(url)
  return updateTarget(draft, targetKey, target => ({
    ...target,
    urls: target.urls.filter(candidate => targetUrlKey(candidate) !== key),
  }))
}

export function reviewException(draft: PortfolioSetupDraft, key: string): PortfolioSetupDraft {
  return reviewExceptions(draft, [key])
}

export function reviewExceptions(draft: PortfolioSetupDraft, keys: readonly string[]): PortfolioSetupDraft {
  const reviewedKeys = new Set(keys)
  const missing = [...reviewedKeys].filter(key => !draft.exceptions.some(item => item.key === key))
  if (missing.length > 0) throw new Error(`Review item not found: ${missing.join(', ')}`)
  const exceptions = draft.exceptions.map(item => {
    if (!reviewedKeys.has(item.key)) return item
    return { ...item, status: 'reviewed' as const }
  })
  return canonicalDraft({ ...draft, exceptions })
}

/** Use only for an explicit all-items acknowledgement action. */
export function reviewAllExceptions(draft: PortfolioSetupDraft): PortfolioSetupDraft {
  return reviewExceptions(draft, draft.exceptions.map(item => item.key))
}

export function upsertQuerySet(draft: PortfolioSetupDraft, querySet: DraftQuerySet): PortfolioSetupDraft {
  const next = {
    key: querySet.key.trim(),
    label: querySet.label.trim(),
    queryIds: uniqueSorted(querySet.queryIds.map(queryId => queryId.trim()).filter(Boolean)),
    context: normalizeContext(querySet.context),
  }
  if (!next.key || !next.label) throw new Error('Query set name is required')
  return canonicalDraft({
    ...draft,
    querySets: [...draft.querySets.filter(item => item.key !== next.key), next],
  })
}

export interface AssignQueriesInput {
  targetKeys: string[]
  queryIds: string[]
  context: DraftExecutionContext
}

export function assignQueriesToTargets(draft: PortfolioSetupDraft, input: AssignQueriesInput): PortfolioSetupDraft {
  const targetKeys = uniqueSorted(input.targetKeys.map(value => value.trim()).filter(Boolean))
  const queryIds = uniqueSorted(input.queryIds.map(value => value.trim()).filter(Boolean))
  const confirmed = new Set(draft.targets.filter(target => target.status === 'confirmed').map(target => target.stableKey))
  const unavailable = targetKeys.filter(targetKey => !confirmed.has(targetKey))
  if (unavailable.length > 0) throw new Error(`Confirm targets before assigning queries: ${unavailable.join(', ')}`)
  if (targetKeys.length === 0 || queryIds.length === 0) throw new Error('Choose targets and queries before applying')

  const additions = targetKeys.flatMap(targetKey => queryIds.map(queryId => ({
    targetKey,
    queryId,
    context: normalizeContext(input.context),
  })))
  return canonicalDraft({ ...draft, assignments: [...draft.assignments, ...additions] })
}

export function applyQuerySet(draft: PortfolioSetupDraft, querySetKey: string, targetKeys: string[]): PortfolioSetupDraft {
  const querySet = draft.querySets.find(item => item.key === querySetKey)
  if (!querySet) throw new Error(`Query set not found: ${querySetKey}`)
  return assignQueriesToTargets(draft, { targetKeys, queryIds: querySet.queryIds, context: querySet.context })
}

export function clearTargetAssignments(draft: PortfolioSetupDraft, targetKeys: readonly string[]): PortfolioSetupDraft {
  const selected = new Set(targetKeys)
  return canonicalDraft({
    ...draft,
    assignments: draft.assignments.filter(assignment => !selected.has(assignment.targetKey)),
  })
}

export function upsertQueryTemplate(draft: PortfolioSetupDraft, template: DraftQueryTemplate): PortfolioSetupDraft {
  const next: DraftQueryTemplate = {
    key: template.key.trim(),
    label: template.label.trim(),
    template: template.template.trim(),
    context: normalizeContext(template.context),
  }
  if (!next.key || !next.label || !next.template) throw new Error('Query template name and text are required')
  return canonicalDraft({
    ...draft,
    queryTemplates: [...draft.queryTemplates.filter(item => item.key !== next.key), next],
  })
}

export function expandQueryTemplate(draft: PortfolioSetupDraft, templateKey: string, targetKeys: string[]): ExpandedTemplateQuery[] {
  const template = draft.queryTemplates.find(item => item.key === templateKey)
  if (!template) throw new Error(`Query template not found: ${templateKey}`)
  if (!template.template.includes(TARGET_LABEL_TOKEN)) throw new Error(`Template must include ${TARGET_LABEL_TOKEN}`)
  const targets = new Map(draft.targets.map(target => [target.stableKey, target]))

  return uniqueSorted(targetKeys).map(targetKey => {
    const target = targets.get(targetKey)
    if (!target || target.status !== 'confirmed') throw new Error(`Confirm target before generating queries: ${targetKey}`)
    return {
      targetKey,
      queryText: template.template.replaceAll(TARGET_LABEL_TOKEN, target.label).replace(/\s+/g, ' ').trim(),
      context: normalizeContext(template.context),
    }
  })
}

export function mapExpandedTemplateQueries(
  draft: PortfolioSetupDraft,
  expanded: readonly ExpandedTemplateQuery[],
  projectQueries: readonly Pick<QueryDto, 'id' | 'query'>[],
): PortfolioSetupDraft {
  const queryIdsByText = new Map(projectQueries.map(query => [query.query, query.id]))
  const missing = uniqueSorted(expanded.filter(item => !queryIdsByText.has(item.queryText)).map(item => item.queryText))
  if (missing.length > 0) throw new Error(`Generated queries were not saved: ${missing.join(', ')}`)

  const assignments = expanded.map(item => ({
    targetKey: item.targetKey,
    queryId: queryIdsByText.get(item.queryText)!,
    context: normalizeContext(item.context),
  }))
  return canonicalDraft({ ...draft, assignments: [...draft.assignments, ...assignments] })
}

export function upsertReportingGroup(draft: PortfolioSetupDraft, group: DraftReportingGroup): PortfolioSetupDraft {
  const next = normalizeGroup(group)
  if (!next.stableKey || !next.label) throw new Error('Group name is required')
  return canonicalDraft({
    ...draft,
    groups: [...draft.groups.filter(item => item.stableKey !== next.stableKey), next],
  })
}

export function removeReportingGroup(draft: PortfolioSetupDraft, stableKey: string): PortfolioSetupDraft {
  const key = stableKey.trim()
  if (!draft.groups.some(group => group.stableKey === key)) throw new Error(`Group not found: ${key}`)
  return canonicalDraft({
    ...draft,
    groups: draft.groups.filter(group => group.stableKey !== key),
  })
}

export function validatePortfolioDraft(draft: PortfolioSetupDraft): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = []
  const confirmed = draft.targets.filter(target => target.status === 'confirmed')
  const confirmedKeys = new Set(confirmed.map(target => target.stableKey))
  const statusByKey = new Map(draft.targets.map(target => [target.stableKey, target.status]))
  const activeGroups = draft.groups.filter(group => (
    group.targetKeys.length === 0 || group.targetKeys.some(targetKey => statusByKey.get(targetKey) !== 'rejected')
  ))
  const allKeys = draft.targets
    .filter(target => target.status !== 'rejected')
    .map(target => target.stableKey)
    .concat(activeGroups.map(group => group.stableKey))
  const seen = new Set<string>()
  for (const key of allKeys) {
    if (seen.has(key)) {
      issues.push({ severity: 'error', code: 'duplicate-stable-key', message: 'Each target and group needs a unique identity.' })
      break
    }
    seen.add(key)
  }
  if (confirmed.length === 0) {
    issues.push({ severity: 'error', code: 'no-confirmed-targets', message: 'Confirm at least one target before publishing.' })
  }
  for (const target of draft.targets) {
    if (target.status === 'proposed') {
      issues.push({
        severity: 'error',
        code: 'target-review-required',
        message: `Confirm or reject ${target.label}.`,
        targetKey: target.stableKey,
      })
    }
    if (target.status === 'confirmed' && target.urls.length === 0) {
      issues.push({
        severity: 'error',
        code: 'target-url-required',
        message: `${target.label} needs at least one URL.`,
        targetKey: target.stableKey,
      })
    }
  }
  if (draft.exceptions.some(item => item.status === 'unreviewed')) {
    issues.push({ severity: 'error', code: 'exception-review-required', message: 'Review the URLs that were not added to targets.' })
  }
  for (const review of draft.coverageReviews) {
    if (review.resolution === 'pending' && statusByKey.get(review.targetKey) !== 'rejected') {
      issues.push({
        severity: 'error',
        code: 'coverage-review-required',
        message: 'Choose whether to keep existing URL coverage or replace it with the latest import.',
        targetKey: review.targetKey,
      })
    }
  }
  for (const assignment of draft.assignments) {
    if (statusByKey.get(assignment.targetKey) === 'rejected') continue
    if (!confirmedKeys.has(assignment.targetKey)) {
      issues.push({
        severity: 'error',
        code: 'assignment-target-unavailable',
        message: 'A query is assigned to a target that is not confirmed.',
        targetKey: assignment.targetKey,
      })
    }
  }
  for (const group of draft.groups) {
    if (group.targetKeys.length === 0) {
      issues.push({ severity: 'error', code: 'group-target-required', message: `${group.label} needs at least one target.` })
    }
    for (const targetKey of group.targetKeys) {
      if (statusByKey.get(targetKey) === 'rejected') continue
      if (!confirmedKeys.has(targetKey)) {
        issues.push({
          severity: 'error',
          code: 'group-target-unavailable',
          message: `${group.label} includes a target that is not confirmed.`,
          targetKey,
        })
      }
    }
  }
  for (const querySet of draft.querySets) {
    if (querySet.queryIds.length === 0) {
      issues.push({ severity: 'error', code: 'query-set-empty', message: `${querySet.label} needs at least one query.` })
    }
  }
  for (const template of draft.queryTemplates) {
    if (!template.template.includes(TARGET_LABEL_TOKEN)) {
      issues.push({
        severity: 'error',
        code: 'template-placeholder-required',
        message: `${template.label} must include ${TARGET_LABEL_TOKEN}.`,
      })
    }
  }
  return issues
}

export function toMeasurementPlanInput(draft: PortfolioSetupDraft): MeasurementPlanInput {
  const normalized = canonicalDraft(draft)
  const issues = validatePortfolioDraft(normalized)
  if (issues.length > 0) throw new Error(`This setup is not ready to publish: ${issues.map(issue => issue.message).join(' ')}`)
  const confirmedKeys = new Set(normalized.targets.filter(target => target.status === 'confirmed').map(target => target.stableKey))

  const selections = new Map<string, { targetKey: string; queryIds: string[]; context: DraftExecutionContext }>()
  for (const assignment of normalized.assignments) {
    if (!confirmedKeys.has(assignment.targetKey)) continue
    const key = `${assignment.targetKey}\u0000${contextKey(assignment.context)}`
    const selection = selections.get(key) ?? { targetKey: assignment.targetKey, queryIds: [], context: assignment.context }
    selection.queryIds.push(assignment.queryId)
    selections.set(key, selection)
  }

  return {
    schemaVersion: 1,
    targets: normalized.targets.filter(target => target.status === 'confirmed').map(target => ({
      stableKey: target.stableKey,
      label: target.label,
      urls: target.urls,
      aliases: target.aliases,
      ...(target.metadata ? { metadata: target.metadata } : {}),
    })),
    groups: normalized.groups
      .map(group => normalizeGroup({
        ...group,
        targetKeys: group.targetKeys.filter(targetKey => confirmedKeys.has(targetKey)),
      }))
      .filter(group => group.targetKeys.length > 0),
    targetQuerySelections: [...selections.values()]
      .map(selection => ({
        targetKey: selection.targetKey,
        queryIds: uniqueSorted(selection.queryIds),
        ...(selection.context === undefined ? {} : { context: selection.context }),
      }))
      .sort((left, right) => compareText(left.targetKey, right.targetKey) || compareText(contextKey(left.context), contextKey(right.context))),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseContext(value: unknown): DraftExecutionContext {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isRecord(value)) throw new Error('Invalid context')
  if (typeof value.label !== 'string' || typeof value.city !== 'string' || typeof value.region !== 'string' || typeof value.country !== 'string') {
    throw new Error('Invalid context')
  }
  if (value.timezone !== undefined && typeof value.timezone !== 'string') throw new Error('Invalid context')
  return normalizeContext({
    label: value.label,
    city: value.city,
    region: value.region,
    country: value.country,
    ...(typeof value.timezone === 'string' ? { timezone: value.timezone } : {}),
  })
}

function parseTargetUrl(value: unknown): DraftTargetUrl {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('Invalid target URL')
  if (value.kind === 'host' && typeof value.host === 'string') return normalizeTargetUrl({ kind: 'host', host: value.host })
  if (value.kind === 'prefix' && typeof value.host === 'string' && typeof value.pathPrefix === 'string' && (value.pathCase === 'sensitive' || value.pathCase === 'insensitive')) {
    return normalizeTargetUrl({ kind: 'prefix', host: value.host, pathPrefix: value.pathPrefix, pathCase: value.pathCase })
  }
  if (value.kind === 'exact' && typeof value.url === 'string' && (value.pathCase === 'sensitive' || value.pathCase === 'insensitive')) {
    return normalizeTargetUrl({ kind: 'exact', url: value.url, pathCase: value.pathCase })
  }
  throw new Error('Invalid target URL')
}

function parseSavedDraft(value: unknown): PortfolioSetupDraft {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('Invalid version')
  if (!Array.isArray(value.targets) || !Array.isArray(value.exceptions) || !Array.isArray(value.querySets)
    || !Array.isArray(value.queryTemplates) || !Array.isArray(value.assignments) || !Array.isArray(value.groups)
    || (value.coverageReviews !== undefined && !Array.isArray(value.coverageReviews))) {
    throw new Error('Invalid collections')
  }

  const targets: DraftTarget[] = value.targets.map(item => {
    if (!isRecord(item) || typeof item.stableKey !== 'string' || typeof item.label !== 'string'
      || (item.status !== 'proposed' && item.status !== 'confirmed' && item.status !== 'rejected')
      || !Array.isArray(item.urls) || !isStringArray(item.aliases)) throw new Error('Invalid target')
    let metadata: Record<string, string> | undefined
    if (item.metadata !== undefined) {
      if (!isRecord(item.metadata) || !Object.values(item.metadata).every(entry => typeof entry === 'string')) throw new Error('Invalid target metadata')
      metadata = item.metadata as Record<string, string>
    }
    return {
      stableKey: item.stableKey,
      label: item.label,
      status: item.status,
      urls: item.urls.map(parseTargetUrl),
      aliases: item.aliases,
      ...(metadata ? { metadata } : {}),
    }
  })

  const exceptions: DraftDiscoveryException[] = value.exceptions.map(item => {
    if (!isRecord(item) || typeof item.key !== 'string'
      || (item.bucket !== 'shared' && item.bucket !== 'unmatched' && item.bucket !== 'excluded' && item.bucket !== 'diagnostic')
      || typeof item.url !== 'string' || (item.canonicalUrl !== null && typeof item.canonicalUrl !== 'string')
      || typeof item.reason !== 'string' || (item.targetKey !== undefined && typeof item.targetKey !== 'string')
      || (item.duplicateOf !== undefined && typeof item.duplicateOf !== 'string')
      || (item.status !== 'unreviewed' && item.status !== 'reviewed')) throw new Error('Invalid review item')
    return {
      key: item.key,
      bucket: item.bucket,
      url: item.url,
      canonicalUrl: item.canonicalUrl,
      reason: item.reason,
      ...(typeof item.targetKey === 'string' ? { targetKey: item.targetKey } : {}),
      ...(typeof item.duplicateOf === 'string' ? { duplicateOf: item.duplicateOf } : {}),
      status: item.status,
    }
  })

  const coverageReviews: DraftCoverageReview[] = (value.coverageReviews ?? []).map(item => {
    if (!isRecord(item) || typeof item.targetKey !== 'string' || !Array.isArray(item.existingUrls) || !Array.isArray(item.importedUrls)
      || (item.previousStatus !== 'proposed' && item.previousStatus !== 'confirmed' && item.previousStatus !== 'rejected')
      || (item.resolution !== 'pending' && item.resolution !== 'keep-existing' && item.resolution !== 'replace-with-imported')) {
      throw new Error('Invalid coverage review')
    }
    return {
      targetKey: item.targetKey,
      existingUrls: item.existingUrls.map(parseTargetUrl),
      importedUrls: item.importedUrls.map(parseTargetUrl),
      previousStatus: item.previousStatus,
      resolution: item.resolution,
    }
  })

  const querySets: DraftQuerySet[] = value.querySets.map(item => {
    if (!isRecord(item) || typeof item.key !== 'string' || typeof item.label !== 'string' || !isStringArray(item.queryIds)) throw new Error('Invalid query set')
    return { key: item.key, label: item.label, queryIds: item.queryIds, context: parseContext(item.context) }
  })
  const queryTemplates: DraftQueryTemplate[] = value.queryTemplates.map(item => {
    if (!isRecord(item) || typeof item.key !== 'string' || typeof item.label !== 'string' || typeof item.template !== 'string') throw new Error('Invalid query template')
    return { key: item.key, label: item.label, template: item.template, context: parseContext(item.context) }
  })
  const assignments: DraftQueryAssignment[] = value.assignments.map(item => {
    if (!isRecord(item) || typeof item.targetKey !== 'string' || typeof item.queryId !== 'string') throw new Error('Invalid query assignment')
    return { targetKey: item.targetKey, queryId: item.queryId, context: parseContext(item.context) }
  })
  const groups: DraftReportingGroup[] = value.groups.map(item => {
    if (!isRecord(item) || typeof item.stableKey !== 'string' || typeof item.label !== 'string' || !isStringArray(item.targetKeys)
      || (item.competitors !== undefined && !isStringArray(item.competitors))) throw new Error('Invalid group')
    return normalizeGroup({
      stableKey: item.stableKey,
      label: item.label,
      targetKeys: item.targetKeys,
      ...(item.competitors ? { competitors: item.competitors } : {}),
    })
  })

  return canonicalDraft({ schemaVersion: 1, targets, exceptions, coverageReviews, querySets, queryTemplates, assignments, groups })
}

export function serializePortfolioDraft(draft: PortfolioSetupDraft): string {
  return JSON.stringify(canonicalDraft(draft))
}

export function parsePortfolioDraft(serialized: string): PortfolioSetupDraft {
  try {
    return parseSavedDraft(JSON.parse(serialized) as unknown)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`The saved setup could not be read: ${detail}`)
  }
}
