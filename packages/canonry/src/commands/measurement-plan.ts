import fs from 'node:fs'
import { parse } from 'yaml'
import {
  measurementDiscoveryRequestSchema,
  measurementDiscoveryRuleSchema,
  measurementPlanInputSchema,
  type MeasurementDiscoveryRequest,
  type MeasurementDiscoveryRule,
  type MeasurementPlanInput,
} from '@ainyc/canonry-contracts'
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
