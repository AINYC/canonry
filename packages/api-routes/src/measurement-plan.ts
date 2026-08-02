import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  compileMeasurementPlanPreview,
  effectiveBrandNames,
  MeasurementPlanValidationError,
  measurementPlanCounts,
  notFound,
  parseStoredMeasurementPlan,
  validationError,
  type MeasurementPlan,
  type MeasurementPlanContext,
  type MeasurementPlanCounts,
  type MeasurementPlanInput,
} from '@ainyc/canonry-contracts'
import {
  measurementPlans,
  measurementPlanVersions,
  measurementSegments,
  projects,
  queries,
} from '@ainyc/canonry-db'
import { requireScope } from './auth.js'
import { resolveProject, writeAuditLog } from './helpers.js'

export const MEASUREMENT_PLAN_WRITE_SCOPE = 'measurement-plan.write'

export interface MeasurementPlanRoutesOptions {
  getRunnableProviderNames?: () => readonly string[]
}

type PlanCounts = MeasurementPlanCounts

type StableKeyed = { stableKey: string }
type SemanticSelection = {
  targetKey: string
  context: MeasurementPlan['defaultContext']
  queryIds: string[]
}

function parseStoredPlan(canonicalJson: unknown): MeasurementPlan {
  return parseStoredMeasurementPlan(canonicalJson)
}

function versionDto(row: typeof measurementPlanVersions.$inferSelect, active: boolean) {
  return {
    revision: row.revision,
    checksum: row.checksum,
    createdAt: row.createdAt,
    active,
    plan: parseStoredPlan(row.canonicalJson),
  }
}

function activeDto(row: typeof measurementPlanVersions.$inferSelect) {
  const { active: _active, ...dto } = versionDto(row, true)
  return dto
}

function versionMetadata(row: typeof measurementPlanVersions.$inferSelect, activeVersionId: string | null) {
  return {
    revision: row.revision,
    checksum: row.checksum,
    createdAt: row.createdAt,
    active: row.id === activeVersionId,
  }
}

function activePlanVersion(app: FastifyInstance, projectId: string) {
  const plan = app.db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
  if (!plan) return null
  const version = app.db.select().from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, projectId),
    eq(measurementPlanVersions.id, plan.activeVersionId),
  )).get()
  if (!version) throw new Error(`Measurement plan ${projectId} points to missing version ${plan.activeVersionId}`)
  return { plan, version }
}

function normalizedProviderNames(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))].sort()
}

function compileContextForProject(
  app: FastifyInstance,
  project: typeof projects.$inferSelect,
  opts: MeasurementPlanRoutesOptions,
): MeasurementPlanContext {
  const trackedQueries = app.db.select({ id: queries.id, query: queries.query })
    .from(queries).where(eq(queries.projectId, project.id)).all()
  const defaultContext = project.defaultLocation
    ? project.locations.find(location => location.label === project.defaultLocation) ?? null
    : null
  const projectProviders = normalizedProviderNames(project.providers)
  const selectedProviders = projectProviders.length > 0
    ? projectProviders
    : normalizedProviderNames(opts.getRunnableProviderNames?.() ?? [])

  return {
    canonicalDomain: project.canonicalDomain,
    ownedDomains: project.ownedDomains,
    brandNames: effectiveBrandNames(project),
    expectedSnapshots: selectedProviders.length,
    defaultContext,
    locations: project.locations,
    trackedQueries,
  }
}

function compileForProject(
  app: FastifyInstance,
  project: typeof projects.$inferSelect,
  input: unknown,
  opts: MeasurementPlanRoutesOptions,
): MeasurementPlan {
  try {
    return compileMeasurementPlan(input as MeasurementPlanInput, compileContextForProject(app, project, opts))
  } catch (error) {
    if (error instanceof MeasurementPlanValidationError) {
      throw validationError(error.message, { issues: error.issues })
    }
    throw validationError(error instanceof Error ? error.message : 'Invalid measurement plan')
  }
}

function planCounts(plan: MeasurementPlan): PlanCounts {
  return measurementPlanCounts(plan)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function keyedDiff<T extends StableKeyed>(before: readonly T[], after: readonly T[]) {
  const beforeByKey = new Map(before.map(value => [value.stableKey, value]))
  const afterByKey = new Map(after.map(value => [value.stableKey, value]))
  const added: T[] = []
  const removed: T[] = []
  const changed: Array<{ stableKey: string; before: T; after: T }> = []
  const unchanged: string[] = []

  for (const stableKey of [...afterByKey.keys()].sort()) {
    const afterValue = afterByKey.get(stableKey)!
    const beforeValue = beforeByKey.get(stableKey)
    if (!beforeValue) {
      added.push(afterValue)
    } else if (stableJson(beforeValue) === stableJson(afterValue)) {
      unchanged.push(stableKey)
    } else {
      changed.push({ stableKey, before: beforeValue, after: afterValue })
    }
  }
  for (const stableKey of [...beforeByKey.keys()].sort()) {
    if (!afterByKey.has(stableKey)) removed.push(beforeByKey.get(stableKey)!)
  }
  return { added, removed, changed, unchanged }
}

function semanticSelections(plan: MeasurementPlan): SemanticSelection[] {
  const byKey = new Map<string, SemanticSelection>()
  for (const selection of plan.targetQuerySelections) {
    const context = selection.context === undefined ? plan.defaultContext : selection.context
    const key = `${selection.targetKey}\u0000${stableJson(context)}`
    const existing = byKey.get(key)
    if (existing) {
      existing.queryIds = [...new Set([...existing.queryIds, ...selection.queryIds])].sort()
    } else {
      byKey.set(key, { targetKey: selection.targetKey, context, queryIds: [...selection.queryIds].sort() })
    }
  }
  return [...byKey.values()].sort((left, right) => (
    left.targetKey.localeCompare(right.targetKey) || stableJson(left.context).localeCompare(stableJson(right.context))
  ))
}

function querySelectionDiff(before: MeasurementPlan, after: MeasurementPlan) {
  const beforeByKey = new Map(semanticSelections(before).map(selection => [
    `${selection.targetKey}\u0000${stableJson(selection.context)}`,
    selection,
  ]))
  const afterByKey = new Map(semanticSelections(after).map(selection => [
    `${selection.targetKey}\u0000${stableJson(selection.context)}`,
    selection,
  ]))
  const added: SemanticSelection[] = []
  const removed: SemanticSelection[] = []
  const changed: Array<{ targetKey: string; before: SemanticSelection; after: SemanticSelection }> = []
  const unchanged: Array<{ targetKey: string; context: MeasurementPlan['defaultContext'] }> = []

  for (const key of [...afterByKey.keys()].sort()) {
    const afterValue = afterByKey.get(key)!
    const beforeValue = beforeByKey.get(key)
    if (!beforeValue) {
      added.push(afterValue)
    } else if (stableJson(beforeValue) === stableJson(afterValue)) {
      unchanged.push({ targetKey: afterValue.targetKey, context: afterValue.context })
    } else {
      changed.push({ targetKey: afterValue.targetKey, before: beforeValue, after: afterValue })
    }
  }
  for (const key of [...beforeByKey.keys()].sort()) {
    if (!afterByKey.has(key)) removed.push(beforeByKey.get(key)!)
  }
  return { added, removed, changed, unchanged }
}

function diffKeys<T extends { stableKey: string }>(before: readonly T[], after: readonly T[]): { added: string[]; removed: string[] } {
  const beforeKeys = new Set(before.map(value => value.stableKey))
  const afterKeys = new Set(after.map(value => value.stableKey))
  return {
    added: [...afterKeys].filter(key => !beforeKeys.has(key)).sort(),
    removed: [...beforeKeys].filter(key => !afterKeys.has(key)).sort(),
  }
}

function executionDiff(before: MeasurementPlan | null, after: MeasurementPlan) {
  const beforeCounts = before ? planCounts(before) : null
  const afterCounts = planCounts(after)
  const nodes = diffKeys(before?.executionNodes ?? [], after.executionNodes)
  const beforeEdges = before?.usageEdges ?? []
  const edgeKey = (edge: MeasurementPlan['usageEdges'][number]) => stableJson(edge)
  const beforeEdgeKeys = new Set(beforeEdges.map(edgeKey))
  const afterEdgeKeys = new Set(after.usageEdges.map(edgeKey))
  const counts = {
    before: beforeCounts,
    after: afterCounts,
    delta: beforeCounts
      ? Object.fromEntries(Object.entries(afterCounts).map(([key, value]) => [key, value - beforeCounts[key as keyof PlanCounts]])) as PlanCounts
      : null,
  }
  return {
    addedNodeKeys: nodes.added,
    removedNodeKeys: nodes.removed,
    addedUsageEdges: after.usageEdges.filter(edge => !beforeEdgeKeys.has(edgeKey(edge))),
    removedUsageEdges: beforeEdges.filter(edge => !afterEdgeKeys.has(edgeKey(edge))),
    counts,
  }
}

function planDiff(active: MeasurementPlan | null, candidate: MeasurementPlan, activeRevision: number | null) {
  return {
    activeRevision,
    targets: keyedDiff(active?.targets ?? [], candidate.targets),
    groups: keyedDiff(active?.groups ?? [], candidate.groups),
    querySelections: active
      ? querySelectionDiff(active, candidate)
      : {
          added: semanticSelections(candidate),
          removed: [],
          changed: [],
          unchanged: [],
        },
    execution: executionDiff(active, candidate),
  }
}

function desiredSegmentKinds(plan: MeasurementPlan): Map<string, 'target' | 'group'> {
  return new Map([
    ...plan.targets.map(target => [target.stableKey, 'target'] as const),
    ...plan.groups.map(group => [group.stableKey, 'group'] as const),
  ])
}

function assertStableSegmentKinds(
  existing: readonly typeof measurementSegments.$inferSelect[],
  desired: ReadonlyMap<string, 'target' | 'group'>,
): void {
  for (const segment of existing) {
    const kind = desired.get(segment.stableKey)
    if (kind && kind !== segment.kind) {
      throw validationError(
        `Measurement segment "${segment.stableKey}" cannot change kind from ${segment.kind} to ${kind}. Use a new stable key.`,
      )
    }
  }
}

function assertNoRetiredSegmentReuse(
  existing: readonly typeof measurementSegments.$inferSelect[],
  desired: ReadonlyMap<string, 'target' | 'group'>,
): void {
  for (const segment of existing) {
    if (!desired.has(segment.stableKey) || segment.retiredAt === null) continue
    throw validationError(
      `Measurement segment "${segment.stableKey}" is retired and cannot be reused. Use a new stable key.`,
    )
  }
}

function activePlanContainsKey(plan: MeasurementPlan, stableKey: string): boolean {
  return plan.targets.some(target => target.stableKey === stableKey)
    || plan.groups.some(group => group.stableKey === stableKey)
}

/** Immutable Target/group measurement-plan persistence. */
export async function measurementPlanRoutes(app: FastifyInstance, opts: MeasurementPlanRoutesOptions) {
  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan', async request => {
    const project = resolveProject(app.db, request.params.name)
    const active = activePlanVersion(app, project.id)
    return { active: active ? activeDto(active.version) : null }
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/compile-preview', async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    return compileMeasurementPlanPreview(request.body, compileContextForProject(app, project, opts))
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/diff-preview', async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const preview = compileMeasurementPlanPreview(request.body, compileContextForProject(app, project, opts))
    if (!preview.ok) return { ...preview, diff: null }
    const active = activePlanVersion(app, project.id)
    const activePlan = active ? parseStoredPlan(active.version.canonicalJson) : null
    return {
      ...preview,
      diff: planDiff(activePlan, preview.plan, active?.version.revision ?? null),
    }
  })

  app.put<{ Params: { name: string } }>('/projects/:name/measurement-plan', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const compiled = compileForProject(app, project, request.body, opts)
    const canonicalJson = canonicalMeasurementPlanJson(compiled)
    const checksum = crypto.createHash('sha256').update(canonicalJson).digest('hex')
    const now = new Date().toISOString()
    const desired = desiredSegmentKinds(compiled)
    const published = app.db.transaction(tx => {
      const activePlan = tx.select().from(measurementPlans)
        .where(eq(measurementPlans.projectId, project.id)).get()
      const activeVersion = activePlan
        ? tx.select().from(measurementPlanVersions).where(and(
            eq(measurementPlanVersions.projectId, project.id),
            eq(measurementPlanVersions.id, activePlan.activeVersionId),
          )).get()
        : null
      if (activePlan && !activeVersion) {
        throw new Error(`Measurement plan ${project.id} points to missing version ${activePlan.activeVersionId}`)
      }
      if (activeVersion && activeVersion.checksum === checksum) return { kind: 'existing' as const, version: activeVersion }

      const revision = (activeVersion?.revision ?? 0) + 1
      const versionId = crypto.randomUUID()
      const existing = tx.select().from(measurementSegments)
        .where(eq(measurementSegments.projectId, project.id)).all()
      assertStableSegmentKinds(existing, desired)
      assertNoRetiredSegmentReuse(existing, desired)
      const existingByKey = new Map(existing.map(segment => [segment.stableKey, segment]))
      for (const [stableKey, kind] of desired) {
        if (existingByKey.has(stableKey)) continue
        tx.insert(measurementSegments).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          stableKey,
          kind,
          retiredAt: null,
          createdAt: now,
        }).run()
      }
      tx.insert(measurementPlanVersions).values({
        id: versionId,
        projectId: project.id,
        revision,
        canonicalJson,
        checksum,
        createdAt: now,
      }).run()
      if (activePlan) {
        tx.update(measurementPlans)
          .set({ activeVersionId: versionId, updatedAt: now })
          .where(eq(measurementPlans.projectId, project.id)).run()
      } else {
        tx.insert(measurementPlans).values({
          projectId: project.id,
          activeVersionId: versionId,
          createdAt: now,
          updatedAt: now,
        }).run()
      }
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'measurement-plan.published',
        entityType: 'measurement-plan',
        entityId: String(revision),
      })
      return { kind: 'created' as const, versionId }
    })
    if (published.kind === 'existing') return reply.status(200).send({ active: activeDto(published.version) })

    const created = app.db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.id, published.versionId)).get()
    if (!created) throw new Error(`Measurement plan version ${published.versionId} was not created`)
    return reply.status(201).send({ active: activeDto(created) })
  })

  app.post<{ Params: { name: string; stableKey: string } }>('/projects/:name/measurement-plan/segments/:stableKey/retire', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const segment = app.db.select().from(measurementSegments).where(and(
      eq(measurementSegments.projectId, project.id),
      eq(measurementSegments.stableKey, request.params.stableKey),
    )).get()
    if (!segment) throw notFound('Measurement segment', request.params.stableKey)
    if (segment.retiredAt !== null) return reply.send({ stableKey: segment.stableKey, retiredAt: segment.retiredAt })

    const active = activePlanVersion(app, project.id)
    if (active && activePlanContainsKey(parseStoredPlan(active.version.canonicalJson), segment.stableKey)) {
      throw validationError(`Measurement segment "${segment.stableKey}" is in the active plan. Publish a revision without it before retiring it.`)
    }

    const retiredAt = new Date().toISOString()
    app.db.transaction(tx => {
      tx.update(measurementSegments).set({ retiredAt }).where(eq(measurementSegments.id, segment.id)).run()
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'measurement-segment.retired',
        entityType: 'measurement-segment',
        entityId: segment.id,
      })
    })
    return reply.send({ stableKey: segment.stableKey, retiredAt })
  })

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan/versions', async request => {
    const project = resolveProject(app.db, request.params.name)
    const active = activePlanVersion(app, project.id)
    const versions = app.db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.projectId, project.id))
      .orderBy(desc(measurementPlanVersions.revision)).all()
    return {
      versions: versions.map(version => versionMetadata(version, active?.version.id ?? null)),
    }
  })

  app.get<{ Params: { name: string; revision: string } }>('/projects/:name/measurement-plan/versions/:revision', async request => {
    const project = resolveProject(app.db, request.params.name)
    if (!/^[1-9]\d*$/.test(request.params.revision)) {
      throw notFound('Measurement plan revision', request.params.revision)
    }
    const revision = Number(request.params.revision)
    const row = app.db.select().from(measurementPlanVersions).where(and(
      eq(measurementPlanVersions.projectId, project.id),
      eq(measurementPlanVersions.revision, revision),
    )).get()
    if (!row) throw notFound('Measurement plan revision', request.params.revision)
    const active = activePlanVersion(app, project.id)
    return { version: versionDto(row, active?.version.id === row.id) }
  })
}
