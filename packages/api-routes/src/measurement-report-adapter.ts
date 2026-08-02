/**
 * Immutable-plan report reconstruction.
 *
 * This is deliberately an adapter rather than a route: it reads exactly one
 * persisted plan version and one persisted run. It does not use current
 * project identity, call providers, or repair missing evidence.
 */

import { and, desc, eq, inArray, isNull, lt, ne } from 'drizzle-orm'
import {
  brandLabelFromDomain,
  brandKeyFromText,
  buildMeasurementRunManifestV1,
  deriveCitedUrlCandidates,
  filterCapturedCitedUrls,
  isVertexGroundingRedirect,
  parseMeasurementRunManifestV1,
  parseStoredMeasurementPlan,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type LocationContext,
  type MeasurementPlan,
  type MeasurementReportResponse,
  type MeasurementRunManifestV1,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  buildMeasurementReport,
  normalizeMeasurementLocation,
  type MeasurementExpectedSlotInput,
  type MeasurementReportInput,
  type MeasurementTargetUrlInput,
  type MeasurementUsageEdgeInput,
} from './measurement-report.js'

export type StoredMeasurementReport =
  | { kind: 'no-plan'; revision: number }
  | { kind: 'no-population'; reason: 'no-run'; report: MeasurementReportResponse }
  | { kind: 'report'; report: MeasurementReportResponse }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedProviders(values: readonly string[]): string[] {
  const providers = values.map(value => value.trim().toLocaleLowerCase('en'))
  if (providers.some(value => !value)) throw new Error('measurement manifest provider must be non-empty')
  if (new Set(providers).size !== providers.length) throw new Error('measurement manifest providers must be unique')
  return providers.sort(compareText)
}

function canonicalContext(value: LocationContext | null): string {
  if (value === null) return 'null'
  return JSON.stringify({
    city: value.city,
    country: value.country,
    label: value.label,
    region: value.region,
    ...(value.timezone ? { timezone: value.timezone } : {}),
  })
}

function manifestExecutionId(nodeKey: string): string {
  return nodeKey
}

/** Materializes the provider-expanded, deterministic snapshot slots for one frozen plan. */
export function buildMeasurementRunManifest(
  plan: MeasurementPlan,
  providerRoster: readonly string[],
): MeasurementRunManifestV1 {
  const providers = normalizedProviders(providerRoster)
  const expectedSlots: MeasurementRunManifestV1['expectedSlots'] = []
  for (const node of [...plan.executionNodes].sort((left, right) => compareText(left.stableKey, right.stableKey))) {
    if (node.expectedSnapshots !== providers.length) {
      throw new Error(`measurement manifest provider roster does not satisfy execution ${node.stableKey}`)
    }
    for (const provider of providers) {
      expectedSlots.push({
        executionId: manifestExecutionId(node.stableKey),
        queryText: node.queryText,
        provider,
        context: node.context,
      })
    }
  }
  return buildMeasurementRunManifestV1({ expectedSlots })
}

function manifestFailure(message: string): never {
  throw new Error(`measurement manifest is corrupt: ${message}`)
}

function parseManifest(value: unknown, plan: MeasurementPlan): MeasurementRunManifestV1 {
  let manifest: MeasurementRunManifestV1
  try {
    manifest = parseMeasurementRunManifestV1(value)
  } catch {
    manifestFailure('unsupported shape')
  }
  const nodes = new Map(plan.executionNodes.map(node => [manifestExecutionId(node.stableKey), node]))
  const seenNodeProviders = new Set<string>()
  const counts = new Map<string, number>()
  for (const slot of manifest.expectedSlots) {
    const node = nodes.get(slot.executionId)
    if (!node) manifestFailure(`unknown execution ${slot.executionId}`)
    if (slot.queryText !== node.queryText) manifestFailure(`query text mismatch for ${node.stableKey}`)
    if (canonicalContext(slot.context) !== canonicalContext(node.context)) manifestFailure(`context mismatch for ${node.stableKey}`)
    const nodeProvider = `${node.stableKey}\u0000${slot.provider}`
    if (seenNodeProviders.has(nodeProvider)) manifestFailure('duplicate node provider')
    seenNodeProviders.add(nodeProvider)
    counts.set(node.stableKey, (counts.get(node.stableKey) ?? 0) + 1)
  }
  for (const node of plan.executionNodes) {
    if ((counts.get(node.stableKey) ?? 0) !== node.expectedSnapshots) {
      manifestFailure(`expected slot count mismatch for ${node.stableKey}`)
    }
  }
  return manifest
}

function matcherInput(targetKey: string, matcher: MeasurementPlan['targets'][number]['urls'][number], index: number): MeasurementTargetUrlInput {
  if (matcher.kind === 'host') return { id: `${targetKey}:url:${index}`, mode: 'host', host: matcher.host }
  if (matcher.kind === 'prefix') {
    return { id: `${targetKey}:url:${index}`, mode: 'prefix', host: matcher.host, path: matcher.pathPrefix, pathCase: matcher.pathCase }
  }
  const parsed = new URL(matcher.url)
  return { id: `${targetKey}:url:${index}`, mode: 'exact', host: parsed.hostname, path: parsed.pathname, pathCase: matcher.pathCase }
}

function historicalEvidence(rawResponse: string | null): { urls: string[]; complete: boolean } {
  if (!rawResponse) return { urls: [], complete: false }
  try {
    const parsed = JSON.parse(rawResponse) as { groundingSources?: unknown }
    if (!Array.isArray(parsed.groundingSources)) return { urls: [], complete: false }
    const sources = parsed.groundingSources.map(source => {
      if (!source || typeof source !== 'object' || typeof (source as { uri?: unknown }).uri !== 'string') return null
      const uri = (source as { uri: string }).uri
      try {
        const protocol = new URL(uri).protocol
        return protocol === 'http:' || protocol === 'https:' ? { uri } : null
      } catch {
        return null
      }
    })
    const candidates = deriveCitedUrlCandidates(sources.filter((source): source is { uri: string } => source !== null))
    const unresolvedRedirect = candidates.some(candidate => isVertexGroundingRedirect(new URL(candidate)))
    return {
      urls: filterCapturedCitedUrls(candidates),
      complete: sources.every(source => source !== null) && !unresolvedRedirect,
    }
  } catch {
    return { urls: [], complete: false }
  }
}

function slotLocation(slot: MeasurementRunManifestV1['expectedSlots'][number]): string | null {
  return slot.context?.label ?? null
}

function validateExecutionSnapshot(
  snapshot: typeof querySnapshots.$inferSelect,
  slot: MeasurementRunManifestV1['expectedSlots'][number],
): void {
  if (snapshot.queryText !== slot.queryText || snapshot.provider.trim().toLocaleLowerCase('en') !== slot.provider) {
    throw new Error(`measurement snapshot provenance is corrupt: ${snapshot.id}`)
  }
  if (canonicalContext(snapshot.requestedContext) !== canonicalContext(slot.context)) {
    throw new Error(`measurement snapshot context is corrupt: ${snapshot.id}`)
  }
  if (slot.requestedModel !== undefined && snapshot.model !== slot.requestedModel) {
    throw new Error(`measurement snapshot requested model is corrupt: ${snapshot.id}`)
  }
  if (normalizeMeasurementLocation(snapshot.location) !== normalizeMeasurementLocation(slotLocation(slot))) {
    throw new Error(`measurement snapshot location is corrupt: ${snapshot.id}`)
  }
}

function supportsRequestedContext(
  snapshot: typeof querySnapshots.$inferSelect,
  slot: MeasurementRunManifestV1['expectedSlots'][number],
): boolean {
  if (slot.context === null) return true
  const support = snapshot.supportedContext
  if (support === null || support.status === 'ignored' || support.status === 'unknown') return false
  if (support.resolved !== undefined && support.resolved !== null
    && canonicalContext(support.resolved) !== canonicalContext(slot.context)) {
    throw new Error(`measurement snapshot resolved context is corrupt: ${snapshot.id}`)
  }
  return true
}

function reportInput(
  revision: number,
  plan: MeasurementPlan,
  manifest: MeasurementRunManifestV1,
  snapshots: readonly (typeof querySnapshots.$inferSelect)[],
  legacy: boolean,
): MeasurementReportInput {
  const slots: MeasurementExpectedSlotInput[] = manifest.expectedSlots.map(slot => ({
    id: `slot:${slot.executionId}:${slot.provider}`,
    executionId: slot.executionId,
    queryText: slot.queryText,
    provider: slot.provider,
    location: slotLocation(slot),
  }))
  const usageEdges: MeasurementUsageEdgeInput[] = plan.usageEdges.map(edge => edge.kind === 'baseline'
    ? { id: `baseline:${edge.queryId}:${edge.executionNodeKey}`, type: 'baseline' as const, executionId: manifestExecutionId(edge.executionNodeKey) }
    : { id: `target:${edge.targetKey}:${edge.queryId}:${edge.executionNodeKey}`, type: 'target' as const, executionId: manifestExecutionId(edge.executionNodeKey), targetId: edge.targetKey })
  const slotsByExecution = new Map(manifest.expectedSlots.map(slot => [`${slot.executionId}\u0000${slot.provider}`, slot]))

  return {
    revision,
    ownedHosts: plan.effectiveOwnedHosts,
    projectBrandNames: plan.projectBrandNames,
    projectDomain: plan.projectCanonicalHost,
    targets: plan.targets.map(target => ({
      id: target.stableKey,
      label: target.label,
      aliases: target.aliases,
      urls: target.urls.map((matcher, index) => matcherInput(target.stableKey, matcher, index)),
    })),
    groups: plan.groups.map(group => ({
      id: group.stableKey,
      label: group.label,
      targetIds: group.targetKeys,
      competitors: (group.competitors ?? []).map(domain => {
        const alias = brandLabelFromDomain(domain)
        return { domain, aliases: brandKeyFromText(alias).length >= 4 ? [alias] : [] }
      }),
    })),
    expectedSlots: slots,
    usageEdges,
    observations: snapshots.flatMap(snapshot => {
      if (legacy ? snapshot.measurementExecutionId !== null : snapshot.measurementExecutionId === null) return []
      if (snapshot.measurementExecutionId !== null) {
        const slot = slotsByExecution.get(`${snapshot.measurementExecutionId}\u0000${snapshot.provider.trim().toLocaleLowerCase('en')}`)
        if (!slot) throw new Error(`measurement snapshot provenance is corrupt: ${snapshot.id}`)
        validateExecutionSnapshot(snapshot, slot)
        if (!supportsRequestedContext(snapshot, slot)) return []
      }
      const directCitations = snapshot.citedUrls
      return [{
        id: snapshot.id,
        executionId: snapshot.measurementExecutionId,
        queryText: snapshot.queryText ?? '',
        provider: snapshot.provider.trim().toLocaleLowerCase('en'),
        location: snapshot.location,
        answerText: snapshot.answerText,
        citedUrls: directCitations,
        citedUrlsComplete: directCitations !== null && snapshot.captureStatus === 'complete',
        ...(directCitations === null ? (() => {
          const historical = historicalEvidence(snapshot.rawResponse)
          return { historicalCitedUrls: historical.urls, historicalCitedUrlsComplete: historical.complete }
        })() : {}),
      }]
    }),
  }
}

/**
 * Selects the latest eligible pinned answer-visibility run for a project and
 * reconstructs its report from the exact immutable plan revision it used.
 */
function responseFromReport(
  revision: number,
  report: ReturnType<typeof buildMeasurementReport>,
  run: MeasurementReportResponse['run'],
): MeasurementReportResponse {
  return {
    revision,
    run,
    groups: report.groups,
    targets: report.targets,
    evidence: report.evidence,
    diagnostics: report.diagnostics,
  }
}

export function buildStoredMeasurementReport(db: DatabaseClient, projectId: string, revision: number): StoredMeasurementReport {
  const version = db.select().from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, projectId),
    eq(measurementPlanVersions.revision, revision),
  )).get()
  if (!version) return { kind: 'no-plan', revision }

  const run = db.select().from(runs).where(and(
    eq(runs.projectId, projectId),
    eq(runs.measurementPlanVersionId, version.id),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
    ne(runs.trigger, RunTriggers.probe),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).get()
  const plan = parseStoredMeasurementPlan(version.canonicalJson)
  let selectedRun = run
  let manifest: MeasurementRunManifestV1
  let legacy = false
  if (selectedRun) {
    if (selectedRun.measurementManifest === null) manifestFailure(`missing for run ${selectedRun.id}`)
    manifest = parseManifest(selectedRun.measurementManifest, plan)
  } else {
    // A revision with no plan-aware measurement may display the latest completed
    // pre-plan run. Its provider roster is safe to infer only from a completed
    // run, and must satisfy every frozen execution node's expected slot count.
    selectedRun = db.select().from(runs).where(and(
      eq(runs.projectId, projectId),
      isNull(runs.measurementPlanVersionId),
      eq(runs.kind, RunKinds['answer-visibility']),
      eq(runs.status, RunStatuses.completed),
      ne(runs.trigger, RunTriggers.probe),
      lt(runs.createdAt, version.createdAt),
    )).orderBy(desc(runs.createdAt), desc(runs.id)).get()
    if (!selectedRun) {
      const report = buildMeasurementReport(reportInput(version.revision, plan, { schemaVersion: 1, expectedSlots: [] }, [], false))
      return { kind: 'no-population', reason: 'no-run', report: responseFromReport(version.revision, report, null) }
    }
    const legacySnapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, selectedRun.id)).all()
    const providers = [...new Set(legacySnapshots.map(snapshot => snapshot.provider.trim().toLocaleLowerCase('en')).filter(Boolean))]
    try {
      manifest = buildMeasurementRunManifest(plan, providers)
    } catch {
      const report = buildMeasurementReport(reportInput(version.revision, plan, { schemaVersion: 1, expectedSlots: [] }, [], false))
      return { kind: 'no-population', reason: 'no-run', report: responseFromReport(version.revision, report, null) }
    }
    legacy = true
  }
  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, selectedRun.id)).all()
  const report = buildMeasurementReport(reportInput(version.revision, plan, manifest, snapshots, legacy))
  return {
    kind: 'report',
    report: responseFromReport(version.revision, report, {
      id: selectedRun.id,
      status: selectedRun.status === RunStatuses.completed ? RunStatuses.completed : RunStatuses.partial,
      createdAt: selectedRun.createdAt,
      startedAt: selectedRun.startedAt,
      finishedAt: selectedRun.finishedAt,
    }),
  }
}
