import crypto from 'node:crypto'
import fs from 'node:fs'
import { parse } from 'yaml'
import {
  measurementDiscoveryRequestSchema,
  measurementDiscoveryRuleSchema,
  measurementPlanInputSchema,
  type MeasurementDiscoveryRequest,
  type MeasurementDiscoveryRule,
  type MeasurementOverviewResponse,
  type MeasurementPlanInput,
  type MeasurementPropertyEvidenceResponse,
  type MeasurementQueryClassFilter,
  type MetricValue,
} from '@ainyc/canonry-contracts'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import { createApiClient } from '../client.js'

function readPlan(source: string): MeasurementPlanInput {
  const content = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
  const parsed: unknown = source.endsWith('.json') ? JSON.parse(content) : parse(content)
  return measurementPlanInputSchema.parse(parsed)
}

function readDiscoveryRule(source: string): MeasurementDiscoveryRule {
  const content = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
  const parsed: unknown = source.endsWith('.json') ? JSON.parse(content) : parse(content)
  return measurementDiscoveryRuleSchema.parse(parsed)
}

export async function showMeasurementPlan(project: string, revision?: number): Promise<void> {
  const client = createApiClient()
  console.log(JSON.stringify(revision === undefined
    ? await client.getMeasurementPlan(project)
    : await client.getMeasurementPlanVersion(project, revision), null, 2))
}

export async function listMeasurementPlanVersions(project: string): Promise<void> {
  console.log(JSON.stringify(await createApiClient().listMeasurementPlanVersions(project), null, 2))
}

export async function publishMeasurementPlan(project: string, source: string): Promise<void> {
  const client = createApiClient()
  const plan = readPlan(source)
  const current = await client.getMeasurementPlan(project)
  console.log(JSON.stringify(await client.publishMeasurementPlan(project, {
    expectedActiveRevision: current.active?.revision ?? null,
    plan,
  }), null, 2))
}

export async function retireMeasurementPlanSegment(project: string, stableKey: string): Promise<void> {
  console.log(JSON.stringify(await createApiClient().retireMeasurementPlanSegment(project, stableKey), null, 2))
}

export interface MeasurementAssignmentApplyOptions {
  groupKeys?: string[]
  targetKeys?: string[]
  queryIds: string[]
  allProperties?: boolean
}

/** Preview the exact resolved audience and execution impact before one ETag-bound write. */
export async function applyMeasurementPlanAssignments(
  project: string,
  opts: MeasurementAssignmentApplyOptions,
): Promise<void> {
  const client = createApiClient()
  const current = await client.getMeasurementPlanDraft(project)
  if (!current.draft || !current.etag) {
    throw new Error(`Project "${project}" has no Advanced Measurement draft. Start setup in the dashboard or create a draft first.`)
  }
  const targetKeys = opts.allProperties
    ? current.draft.authoring.targets
      .filter(target => target.status === 'included')
      .map(target => target.stableKey)
    : opts.targetKeys
  const request = {
    ...(targetKeys?.length ? { targetKeys } : {}),
    ...(opts.groupKeys?.length ? { groupKeys: opts.groupKeys } : {}),
    queryIds: opts.queryIds,
  }
  const preview = await client.previewMeasurementDraftAssignments(project, request)
  const result = await client.applyMeasurementDraftAssignments(
    project,
    request,
    crypto.randomUUID(),
    preview.draftEtag,
  )
  console.log(JSON.stringify({ preview, result }, null, 2))
}

function readGroupMembershipCsv(source: string): string {
  return source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
}

export async function previewMeasurementPlanGroups(project: string, source: string): Promise<void> {
  const preview = await createApiClient().previewMeasurementDraftGroupMembership(project, {
    csv: readGroupMembershipCsv(source),
  })
  console.log(JSON.stringify(preview, null, 2))
}

export interface MeasurementGroupApplyOptions {
  acceptedRows?: number[]
  acceptAllMatched?: boolean
  acknowledgeSkipped?: boolean
}

/** Re-preview source and bind the confirmed mutation to the returned checksum and ETag. */
export async function applyMeasurementPlanGroups(
  project: string,
  source: string,
  opts: MeasurementGroupApplyOptions,
): Promise<void> {
  const client = createApiClient()
  const csv = readGroupMembershipCsv(source)
  const preview = await client.previewMeasurementDraftGroupMembership(project, { csv })
  if (opts.acceptAllMatched && preview.counts.needsAttention > 0 && !opts.acknowledgeSkipped) {
    throw new Error(
      `${preview.counts.needsAttention} CSV rows need attention. Correct them, select rows with --accept-row, `
      + 'or add --acknowledge-skipped to apply only matched rows.',
    )
  }
  const acceptedRows = opts.acceptAllMatched
    ? preview.rows.filter(row => row.status === 'matched').map(row => row.dataRow)
    : opts.acceptedRows ?? []
  if (acceptedRows.length === 0) throw new Error('No matched CSV rows were selected for apply.')
  const result = await client.applyMeasurementDraftGroupMembership(project, {
    csv,
    sourceChecksum: preview.sourceChecksum,
    previewChecksum: preview.previewChecksum,
    acceptedRows,
  }, crypto.randomUUID(), preview.draftEtag)
  console.log(JSON.stringify({ preview, result }, null, 2))
}

export async function discoverMeasurementTargets(
  project: string,
  sitemapUrl: string,
  ruleSource: string,
  maxUrls?: number,
): Promise<void> {
  const request: MeasurementDiscoveryRequest = measurementDiscoveryRequestSchema.parse({
    sitemapUrl,
    rule: readDiscoveryRule(ruleSource),
    ...(maxUrls === undefined ? {} : { maxUrls }),
  })
  console.log(JSON.stringify(await createApiClient().discoverMeasurementTargets(project, request), null, 2))
}

export async function showMeasurementReport(project: string, revision: number): Promise<void> {
  console.log(JSON.stringify(await createApiClient().getMeasurementReport(project, revision), null, 2))
}

/**
 * How a metric reads in a terminal. An unavailable one prints its reason and
 * never a percentage: "0%" is a measurement, "not measured" is the absence of
 * one, and the two must not look alike.
 */
const METRIC_REASONS: Record<string, string> = {
  plan_v1: 'not measured (setup update required)',
  no_completed_run: 'not measured (no completed run)',
  no_population: 'not measured (no questions of this type)',
  evidence_incomplete: 'not measured (evidence incomplete)',
  not_applicable: 'not measured (not applicable)',
}

function metricText(metric: MetricValue): string {
  if (metric.state === 'unavailable') return METRIC_REASONS[metric.reason] ?? `not measured (${metric.reason})`
  const percent = `${Math.round(metric.value * 100)}%`
  return metric.numerator === undefined || metric.denominator === undefined
    ? percent
    : `${metric.numerator} of ${metric.denominator} (${percent})`
}

export interface MeasurementPropertyOptions {
  targetKey: string
  queryClass?: MeasurementQueryClassFilter
  provider?: string
  location?: string
  runId?: string
  format?: string
}

/**
 * `canonry measurement-plan property <project> --target-key <key>` — one
 * Property out of the scoped overview. `--format json` is byte-for-byte the
 * endpoint's response so an agent can swap the two.
 */
export async function showMeasurementProperty(project: string, opts: MeasurementPropertyOptions): Promise<void> {
  const response = await createApiClient().getMeasurementOverview(project, {
    scope: 'property',
    targetKey: opts.targetKey,
    ...(opts.queryClass === undefined ? {} : { queryClass: opts.queryClass }),
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.location === undefined ? {} : { location: opts.location }),
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  printMeasurementProperty(response)
}

function printMeasurementProperty(response: MeasurementOverviewResponse): void {
  const row = response.properties.items.at(0)
  const lines: string[] = []
  lines.push(`${response.scope.label} — ${response.queryClass} questions`)
  lines.push(`Measurement: ${response.measurement.state}${response.measurement.displayedRunId ? ` · run ${response.measurement.displayedRunId}` : ''}`)
  lines.push('')
  lines.push(`Mentioned  ${metricText(row ? row.mentionCoverage : response.metrics.mentionCoverage)}`)
  lines.push(`Cited      ${metricText(row ? row.citationCoverage : response.metrics.citationCoverage)}`)
  if (row && row.flags > 0) lines.push(`Flagged    ${row.flags} ${row.flags === 1 ? 'result needs' : 'results need'} review`)

  if (row && row.providers.length > 0) {
    lines.push('')
    lines.push(`${'Engine'.padEnd(14)}${'Mentioned'.padEnd(34)}Cited`)
    for (const provider of row.providers) {
      lines.push(`${provider.provider.padEnd(14)}${metricText(provider.mentionCoverage).padEnd(34)}${metricText(provider.citationCoverage)}`)
    }
  }
  console.log(lines.join('\n'))
}

export interface MeasurementPropertyEvidenceOptions {
  targetKey: string
  queryClass?: MeasurementQueryClassFilter
  provider?: string
  location?: string
  runId?: string
  cursor?: string
  limit?: number
  format?: string
}

/**
 * `canonry measurement-plan property-evidence <project> --target-key <key>` —
 * one Property's source evidence, cursor-paged exactly like the endpoint.
 */
export async function showMeasurementPropertyEvidence(
  project: string,
  opts: MeasurementPropertyEvidenceOptions,
): Promise<void> {
  const response = await createApiClient().getMeasurementPropertyEvidence(project, {
    targetKey: opts.targetKey,
    ...(opts.queryClass === undefined ? {} : { queryClass: opts.queryClass }),
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.location === undefined ? {} : { location: opts.location }),
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
    ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  })

  if (opts.format === 'jsonl') {
    // A bare row stream cannot tell an unmeasured Property from a measured one
    // with no evidence, and drops the run and cursor a consumer needs to page.
    // The header line carries that state; the rows follow unchanged.
    emitJsonl([{
      kind: 'measurement-property-evidence-header' as const,
      property: response.property,
      queryClass: response.queryClass,
      measurement: response.measurement,
      totalEstimate: response.evidence.totalEstimate ?? null,
      nextCursor: response.evidence.nextCursor ?? null,
    }])
    emitJsonl(response.evidence.items)
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  printMeasurementPropertyEvidence(response)
}

function printMeasurementPropertyEvidence(response: MeasurementPropertyEvidenceResponse): void {
  const lines: string[] = []
  lines.push(`${response.property.label} — ${response.queryClass} questions`)
  if (response.measurement.state === 'not_measured') {
    // An empty page here is the absence of a measurement, not a measured zero.
    lines.push('Not measured yet. Run a measurement to collect source evidence.')
    console.log(lines.join('\n'))
    return
  }
  const page = response.evidence
  lines.push(`Measurement: ${response.measurement.state}${response.measurement.displayedRunId ? ` · run ${response.measurement.displayedRunId}` : ''}`)
  if (page.items.length === 0) {
    lines.push('No source evidence matched this Property in the displayed run.')
    console.log(lines.join('\n'))
    return
  }
  lines.push(`${page.items.length} of ${page.totalEstimate ?? page.items.length} evidence rows`)
  lines.push('')
  lines.push(`${'Match'.padEnd(14)}${'Engine'.padEnd(12)}${'Question'.padEnd(40)}URL`)
  for (const item of page.items) {
    lines.push(`${item.classification.padEnd(14)}${item.provider.padEnd(12)}${item.queryText.slice(0, 39).padEnd(40)}${item.sourceUrl}`)
  }
  if (page.nextCursor) lines.push(`\nMore rows: --cursor ${page.nextCursor}`)
  console.log(lines.join('\n'))
}
