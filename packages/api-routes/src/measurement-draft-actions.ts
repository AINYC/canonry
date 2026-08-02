import {
  measurementDraftApplyAssignmentsRequestSchema,
  measurementDraftClassifyAssignmentsRequestSchema,
  measurementDraftClearAssignmentsRequestSchema,
  measurementDraftExcludeTargetRequestSchema,
  measurementDraftMergeTargetsRequestSchema,
  measurementDraftRebindTargetRequestSchema,
  measurementDraftRemoveAssignmentRequestSchema,
  measurementDraftRemoveCompetitorRequestSchema,
  measurementDraftRemoveGroupRequestSchema,
  measurementDraftRenameTargetRequestSchema,
  measurementDraftUpsertCompetitorRequestSchema,
  measurementDraftUpsertGroupRequestSchema,
  measurementDraftUpsertTargetRequestSchema,
  notFound,
  validationError,
  type MeasurementDraftAssignment,
  type MeasurementDraftAuthoring,
  type MeasurementDraftGroup,
  type MeasurementDraftTarget,
  type MeasurementDraftWarning,
} from '@ainyc/canonry-contracts'
import { proposeQueryClass } from './measurement-draft-compile.js'
import type { ZodType } from 'zod'

/** Every typed action the draft service owns. Sitemap import and rebind selection live in the discovery slice. */
export const MEASUREMENT_DRAFT_ACTIONS = [
  'upsert-target',
  'rename-target',
  'merge-targets',
  'exclude-target',
  'rebind-target',
  'apply-assignments',
  'remove-assignment',
  'clear-assignments',
  'classify-assignments',
  'upsert-group',
  'remove-group',
  'upsert-competitor',
  'remove-competitor',
] as const
export type MeasurementDraftActionName = (typeof MEASUREMENT_DRAFT_ACTIONS)[number]

export interface DraftActionContext {
  brandNames: readonly string[]
  queriesById: ReadonlyMap<string, string>
}

export interface DraftActionResult {
  authoring: MeasurementDraftAuthoring
  warnings: MeasurementDraftWarning[]
}

function parseBody<T>(schema: ZodType<T>, body: unknown, action: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw validationError(`Invalid "${action}" payload`, { issues: parsed.error.issues })
  }
  return parsed.data
}

function requireTarget(authoring: MeasurementDraftAuthoring, targetKey: string): MeasurementDraftTarget {
  const target = authoring.targets.find(candidate => candidate.stableKey === targetKey)
  if (!target) throw notFound('Measurement draft Target', targetKey)
  return target
}

function requireGroup(authoring: MeasurementDraftAuthoring, groupKey: string): MeasurementDraftGroup {
  const group = authoring.groups.find(candidate => candidate.stableKey === groupKey)
  if (!group) throw notFound('Measurement draft group', groupKey)
  return group
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function warn(code: string, message: string, path: (string | number)[]): MeasurementDraftWarning {
  return { code, message, path }
}

function upsertTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { target } = parseBody(measurementDraftUpsertTargetRequestSchema, body, 'upsert-target')
  const index = authoring.targets.findIndex(candidate => candidate.stableKey === target.stableKey)
  const targets = [...authoring.targets]
  if (index === -1) targets.push(target)
  else targets[index] = target
  return { authoring: { ...authoring, targets }, warnings: [] }
}

function renameTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, label } = parseBody(measurementDraftRenameTargetRequestSchema, body, 'rename-target')
  requireTarget(authoring, targetKey)
  return {
    authoring: {
      ...authoring,
      targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, label } : target)),
    },
    warnings: [],
  }
}

/**
 * The survivor keeps its stable key, so its assignments and group membership
 * survive untouched; everything the merged Targets carried is folded into it.
 * A class the survivor already decided wins over the merged Target's, because
 * the merge is not an occasion to reopen a classification.
 */
function mergeTargets(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, mergedKeys } = parseBody(measurementDraftMergeTargetsRequestSchema, body, 'merge-targets')
  const survivor = requireTarget(authoring, targetKey)
  const absorbed = mergedKeys.filter(key => key !== targetKey)
  for (const key of absorbed) requireTarget(authoring, key)
  if (absorbed.length === 0) return { authoring, warnings: [warn('merge-targets-noop', 'The merge named only the surviving Target.', ['mergedKeys'])] }

  const absorbedSet = new Set(absorbed)
  const merged: MeasurementDraftTarget = {
    ...survivor,
    aliases: unique([...survivor.aliases, ...authoring.targets.filter(target => absorbedSet.has(target.stableKey)).flatMap(target => target.aliases)]),
    urlMatchers: unique([...survivor.urlMatchers, ...authoring.targets.filter(target => absorbedSet.has(target.stableKey)).flatMap(target => target.urlMatchers)]),
  }

  const assignments: MeasurementDraftAssignment[] = []
  const seen = new Set<string>()
  for (const assignment of authoring.assignments) {
    const owner = absorbedSet.has(assignment.targetKey) ? targetKey : assignment.targetKey
    const key = `${owner} ${assignment.queryId}`
    if (seen.has(key)) continue
    seen.add(key)
    assignments.push({ ...assignment, targetKey: owner })
  }

  return {
    authoring: {
      ...authoring,
      targets: authoring.targets
        .filter(target => !absorbedSet.has(target.stableKey))
        .map(target => (target.stableKey === targetKey ? merged : target)),
      assignments,
      groups: authoring.groups.map(group => ({
        ...group,
        targetKeys: unique(group.targetKeys.map(key => (absorbedSet.has(key) ? targetKey : key))),
      })),
    },
    warnings: [],
  }
}

function excludeTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, cleanup } = parseBody(measurementDraftExcludeTargetRequestSchema, body, 'exclude-target')
  requireTarget(authoring, targetKey)
  const stranded = authoring.assignments.filter(assignment => assignment.targetKey === targetKey).length
  if (cleanup === 'assignments-and-group-memberships') {
    return {
      authoring: {
        ...authoring,
        targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, status: 'excluded' as const } : target)),
        assignments: authoring.assignments.filter(assignment => assignment.targetKey !== targetKey),
        groups: authoring.groups.map(group => ({
          ...group,
          targetKeys: group.targetKeys.filter(key => key !== targetKey),
        })),
      },
      warnings: [],
    }
  }
  return {
    authoring: {
      ...authoring,
      targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, status: 'excluded' as const } : target)),
    },
    // The assignments are kept rather than deleted: an exclusion is a review
    // decision that can be undone, and silently dropping the operator's query
    // selection would make undoing it a retype. Publish names them instead.
    warnings: stranded > 0
      ? [warn('excluded-target-has-assignments', `Target "${targetKey}" still has ${stranded} assignment(s); remove them or include the Target before publishing.`, ['assignments'])]
      : [],
  }
}

/**
 * Rebinding follows a Target across a site restructure. The stable key is
 * untouched by construction, so assignments and group membership follow it; the
 * matcher that pointed at the old discovered URL is replaced rather than added
 * to, or the new one is appended when nothing matched.
 */
function rebindTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, discoveryIdentity, discoveredUrl } = parseBody(measurementDraftRebindTargetRequestSchema, body, 'rebind-target')
  const target = requireTarget(authoring, targetKey)
  const previous = target.discoveredUrl
  const replaced = previous
    ? target.urlMatchers.map(matcher => (matcher === previous ? discoveredUrl : matcher))
    : target.urlMatchers
  const urlMatchers = replaced.includes(discoveredUrl) ? unique(replaced) : unique([...replaced, discoveredUrl])
  return {
    authoring: {
      ...authoring,
      targets: authoring.targets.map(candidate => (candidate.stableKey === targetKey
        ? { ...candidate, discoveryIdentity, discoveredUrl, urlMatchers }
        : candidate)),
    },
    warnings: [],
  }
}

/**
 * Assigns project queries to selected Targets and proposes a class for the new ones.
 *
 * An assignment that already carries an operator classification keeps it: §7.3
 * says a proposal never overwrites an operator decision, and re-running the
 * rule over an operator's call is exactly that overwrite.
 */
function applyAssignments(
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  const parsed = parseBody(measurementDraftApplyAssignmentsRequestSchema, body, 'apply-assignments')
  const { queryIds, contextOverride } = parsed
  const targetKeys = unique('targetKeys' in parsed ? parsed.targetKeys : [parsed.targetKey])
  for (const targetKey of targetKeys) requireTarget(authoring, targetKey)
  const unknown = queryIds.filter(queryId => !context.queriesById.has(queryId))
  if (unknown.length) {
    throw validationError(`The project has no query ${unknown.map(id => `"${id}"`).join(', ')}. Add it before assigning it.`)
  }

  const assignments = [...authoring.assignments]
  const assignmentIndexes = new Map(assignments.map((assignment, index) => [
    `${assignment.targetKey}\u0000${assignment.queryId}`,
    index,
  ]))
  for (const targetKey of targetKeys) {
    for (const queryId of unique(queryIds)) {
      const key = `${targetKey}\u0000${queryId}`
      const index = assignmentIndexes.get(key)
      if (index === undefined) {
        assignmentIndexes.set(key, assignments.length)
        assignments.push({
          targetKey,
          queryId,
          ...(contextOverride ? { contextOverride } : {}),
          queryClass: proposeQueryClass(context.queriesById.get(queryId)!, context.brandNames),
          classificationSource: 'rule',
        })
        continue
      }
      const existing = assignments[index]!
      assignments[index] = {
        ...existing,
        ...(contextOverride ? { contextOverride } : {}),
        ...(existing.classificationSource === 'operator'
          ? {}
          : { queryClass: proposeQueryClass(context.queriesById.get(queryId)!, context.brandNames) }),
      }
    }
  }
  return { authoring: { ...authoring, assignments }, warnings: [] }
}

function removeAssignment(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const parsed = parseBody(measurementDraftRemoveAssignmentRequestSchema, body, 'remove-assignment')
  const { queryId } = parsed
  const targetKeys = new Set('targetKeys' in parsed ? parsed.targetKeys : [parsed.targetKey])
  // The project query itself is never touched: other Targets may still assign
  // it, and every published snapshot of it has to stay readable.
  return {
    authoring: {
      ...authoring,
      assignments: authoring.assignments.filter(assignment => !(targetKeys.has(assignment.targetKey) && assignment.queryId === queryId)),
    },
    warnings: [],
  }
}

function clearAssignments(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey } = parseBody(measurementDraftClearAssignmentsRequestSchema, body, 'clear-assignments')
  return {
    authoring: {
      ...authoring,
      assignments: authoring.assignments.filter(assignment => assignment.targetKey !== targetKey),
    },
    warnings: [],
  }
}

/** An explicit classification is operator-sourced by definition; the server records that, not the caller. */
function classifyAssignments(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { queryClass, assignments: selected } = parseBody(measurementDraftClassifyAssignmentsRequestSchema, body, 'classify-assignments')
  const wanted = new Set(selected.map(entry => `${entry.targetKey} ${entry.queryId}`))
  const missing = selected.filter(entry => !authoring.assignments.some(
    assignment => assignment.targetKey === entry.targetKey && assignment.queryId === entry.queryId,
  ))
  if (missing.length) {
    throw notFound('Measurement draft assignment', `${missing[0]!.targetKey}/${missing[0]!.queryId}`)
  }
  return {
    authoring: {
      ...authoring,
      assignments: authoring.assignments.map(assignment => (
        wanted.has(`${assignment.targetKey} ${assignment.queryId}`)
          ? { ...assignment, queryClass, classificationSource: 'operator' as const }
          : assignment
      )),
    },
    warnings: [],
  }
}

/**
 * Reporting membership only. A legacy payload omits competitors and carries
 * the confirmed list forward. A full editor save includes competitors and
 * replaces the complete list in this same draft mutation.
 */
function upsertGroup(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { group } = parseBody(measurementDraftUpsertGroupRequestSchema, body, 'upsert-group')
  const index = authoring.groups.findIndex(candidate => candidate.stableKey === group.stableKey)
  const groups = [...authoring.groups]
  const next: MeasurementDraftGroup = {
    stableKey: group.stableKey,
    label: group.label,
    targetKeys: unique(group.targetKeys),
    competitors: group.competitors === undefined
      ? (index === -1 ? [] : groups[index]!.competitors)
      : group.competitors,
  }
  if (index === -1) groups.push(next)
  else groups[index] = next
  const unknown = next.targetKeys.filter(key => !authoring.targets.some(target => target.stableKey === key))
  return {
    authoring: { ...authoring, groups },
    warnings: unknown.length
      ? [warn('group-unknown-target', `Group "${group.stableKey}" names ${unknown.length} Target(s) the draft does not hold yet.`, ['groups'])]
      : [],
  }
}

function removeGroup(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey } = parseBody(measurementDraftRemoveGroupRequestSchema, body, 'remove-group')
  return {
    authoring: { ...authoring, groups: authoring.groups.filter(group => group.stableKey !== groupKey) },
    warnings: [],
  }
}

function upsertCompetitor(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey, competitor } = parseBody(measurementDraftUpsertCompetitorRequestSchema, body, 'upsert-competitor')
  const group = requireGroup(authoring, groupKey)
  const index = group.competitors.findIndex(candidate => candidate.stableKey === competitor.stableKey)
  const competitors = [...group.competitors]
  if (index === -1) competitors.push(competitor)
  else competitors[index] = competitor
  return {
    authoring: {
      ...authoring,
      groups: authoring.groups.map(candidate => (candidate.stableKey === groupKey ? { ...candidate, competitors } : candidate)),
    },
    warnings: [],
  }
}

function removeCompetitor(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey, competitorKey } = parseBody(measurementDraftRemoveCompetitorRequestSchema, body, 'remove-competitor')
  requireGroup(authoring, groupKey)
  return {
    authoring: {
      ...authoring,
      groups: authoring.groups.map(group => (group.stableKey === groupKey
        ? { ...group, competitors: group.competitors.filter(competitor => competitor.stableKey !== competitorKey) }
        : group)),
    },
    warnings: [],
  }
}

export function applyDraftAction(
  action: MeasurementDraftActionName,
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  switch (action) {
    case 'upsert-target': return upsertTarget(authoring, body)
    case 'rename-target': return renameTarget(authoring, body)
    case 'merge-targets': return mergeTargets(authoring, body)
    case 'exclude-target': return excludeTarget(authoring, body)
    case 'rebind-target': return rebindTarget(authoring, body)
    case 'apply-assignments': return applyAssignments(authoring, body, context)
    case 'remove-assignment': return removeAssignment(authoring, body)
    case 'clear-assignments': return clearAssignments(authoring, body)
    case 'classify-assignments': return classifyAssignments(authoring, body)
    case 'upsert-group': return upsertGroup(authoring, body)
    case 'remove-group': return removeGroup(authoring, body)
    case 'upsert-competitor': return upsertCompetitor(authoring, body)
    case 'remove-competitor': return removeCompetitor(authoring, body)
  }
}
