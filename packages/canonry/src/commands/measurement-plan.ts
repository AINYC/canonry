import fs from 'node:fs'
import { parse } from 'yaml'
import { measurementPlanInputSchema, type MeasurementPlanInput } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

function readPlan(source: string): MeasurementPlanInput {
  const content = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
  const parsed: unknown = source.endsWith('.json') ? JSON.parse(content) : parse(content)
  return measurementPlanInputSchema.parse(parsed)
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
  console.log(JSON.stringify(await createApiClient().publishMeasurementPlan(project, readPlan(source)), null, 2))
}

export async function retireMeasurementPlanSegment(project: string, stableKey: string): Promise<void> {
  console.log(JSON.stringify(await createApiClient().retireMeasurementPlanSegment(project, stableKey), null, 2))
}
