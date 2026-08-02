import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  type MeasurementOverviewResponse,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-08-01T12:00:00.000Z'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string
let plan: MeasurementPlanV2

function seedVersion(revision: number): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  return id
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: NOW,
    updatedAt: NOW,
  }).onConflictDoUpdate({
    target: measurementPlans.projectId,
    set: { activeVersionId: versionId, updatedAt: NOW },
  }).run()
}

function seedRun(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: buildMeasurementPlanV2Manifest(plan),
    finishedAt: NOW,
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

function seedSnapshot(runId: string, executionKey: string, provider: string, values: Partial<typeof querySnapshots.$inferInsert> = {}): void {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === executionKey)!
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId: null,
    queryText: node.queryText,
    provider,
    citationState: 'cited',
    answerMentioned: true,
    // Names the project and a competitor in one answer, so a shared denominator
    // has to count credits rather than slots.
    answerText: 'Northstar Harbor Homes and Challenger both come up.',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    measurementExecutionId: executionKey,
    requestedContext: node.context.location,
    supportedContext: { status: 'applied', resolved: node.context.location },
    location: node.context.location?.label ?? null,
    citedUrls: ['https://northstar.example/locations/harbor/details'],
    captureStatus: 'complete',
    createdAt: NOW,
    ...values,
  }).run()
}

/** A completed full sweep with every expected slot answered. */
function seedMeasuredRun(versionId: string): string {
  const runId = seedRun(versionId)
  for (const provider of ['openai', 'gemini']) {
    seedSnapshot(runId, 'exec-nearby', provider)
    seedSnapshot(runId, 'exec-brand', provider, { answerText: 'Northstar is well reviewed.' })
  }
  return runId
}

async function overview(query: string): Promise<{ status: number; body: MeasurementOverviewResponse }> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/measurement-overview?${query}` })
  return { status: response.statusCode, body: response.json() as MeasurementOverviewResponse }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-overview-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'current.example',
    ownedDomains: ['current-owned.example'],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  plan = measurementPlanV2Fixture()

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement overview', () => {
  it('answers 404 until a plan is active', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/northstar/measurement-overview?scope=all' })
    expect(response.statusCode).toBe(404)
  })

  it('marks every metric unavailable with no_completed_run before the first run', async () => {
    activate(seedVersion(1))

    const { status, body } = await overview('scope=all')

    expect(status).toBe(200)
    expect(body.mode).toBe('active-v2')
    expect(body.measurement.state).toBe('not_measured')
    expect(body.measurement).toMatchObject({ completed: 0, expected: 4 })
    expect(body.measurement.displayedRunId).toBeUndefined()
    expect(Object.values(body.metrics)).toEqual(Array.from(
      { length: 5 },
      () => ({ state: 'unavailable', reason: 'no_completed_run' }),
    ))
    expect(body.nextAction).toEqual({ kind: 'run_measurement' })
    expect(body.properties.items.every(row => row.mentionCoverage.state === 'unavailable')).toBe(true)
  })

  it('refuses a run pinned to another revision rather than joining across them', async () => {
    const older = seedVersion(1)
    const active = seedVersion(2)
    activate(active)
    const olderRun = seedRun(older)
    seedMeasuredRun(active)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-overview?scope=all&runId=${olderRun}`,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error: { code: 'MEASUREMENT_RUN_REVISION_MISMATCH', details: { runRevision: 1, activeRevision: 2 } },
    })
  })

  it('never displays a scoped spot check by default but honours it by id', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const spotCheck = seedRun(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })

    const auto = await overview('scope=all')
    expect(auto.body.measurement.state).toBe('not_measured')
    expect(auto.body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'no_completed_run' })

    const named = await overview(`scope=all&runId=${spotCheck}`)
    expect(named.status).toBe(200)
    expect(named.body.measurement.displayedRunId).toBe(spotCheck)
  })

  it('emits brandPresence and the deprecated sov alias with the identical value', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedMeasuredRun(versionId)

    const { body } = await overview('scope=all')

    expect(body.measurement).toMatchObject({ state: 'complete', displayedRunId: runId, completed: 4, expected: 4 })
    expect(body.metrics.brandPresence).toMatchObject({ state: 'available' })
    expect(body.metrics.sov).toEqual(body.metrics.brandPresence)
  })

  it('counts a question shared by two Properties once in the denominator', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const { body } = await overview('scope=group&groupKey=regional&queryClass=non-brand')

    // exec-nearby is reused by both Properties. Two providers is two slots, and
    // the second Property must not make it four.
    expect(body.metrics.mentionCoverage).toMatchObject({ denominator: 2 })
    expect(body.metrics.brandPresence).toMatchObject({ denominator: 2 })
    expect(body.properties.items.map(row => row.targetKey)).toEqual(['bayside', 'harbor'])
  })

  it('restricts the population to one question class', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const all = await overview('scope=property&targetKey=harbor')
    const branded = await overview('scope=property&targetKey=harbor&queryClass=branded')
    const nonBrand = await overview('scope=property&targetKey=harbor&queryClass=non-brand')

    expect(all.body.metrics.mentionCoverage).toMatchObject({ denominator: 4 })
    expect(branded.body.metrics.mentionCoverage).toMatchObject({ denominator: 2 })
    expect(nonBrand.body.metrics.mentionCoverage).toMatchObject({ denominator: 2 })
    expect(nonBrand.body.queryClass).toBe('non-brand')
  })

  it('publishes Named Share of Voice only for a Non-brand group basket', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const group = await overview('scope=group&groupKey=regional&queryClass=non-brand')
    expect(group.body.namedShareOfVoice).toEqual({
      groupKey: 'regional',
      queryClass: 'non-brand',
      denominator: 4,
      entries: [
        { kind: 'project', stableKey: 'project', label: 'Northstar', domain: 'northstar.example', credits: 2, share: 0.5 },
        { kind: 'competitor', stableKey: 'challenger', label: 'Challenger', domain: 'challenger.example', credits: 2, share: 0.5 },
      ],
    })

    for (const scope of ['scope=all&queryClass=non-brand', 'scope=property&targetKey=harbor&queryClass=non-brand', 'scope=group&groupKey=regional']) {
      const other = await overview(scope)
      expect(other.body.namedShareOfVoice, scope).toBeUndefined()
    }
  })

  it('computes every metric before search and lets search filter rows only', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const unfiltered = await overview('scope=group&groupKey=regional&queryClass=non-brand')
    const searched = await overview('scope=group&groupKey=regional&queryClass=non-brand&search=HARBOR')

    expect(searched.body.metrics).toEqual(unfiltered.body.metrics)
    expect(searched.body.flags).toEqual(unfiltered.body.flags)
    expect(searched.body.namedShareOfVoice).toEqual(unfiltered.body.namedShareOfVoice)
    expect(unfiltered.body.properties.items.map(row => row.targetKey)).toEqual(['bayside', 'harbor'])
    expect(searched.body.properties.items.map(row => row.targetKey)).toEqual(['harbor'])
  })

  it('pages Properties deterministically through an opaque cursor', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    seedMeasuredRun(versionId)

    const first = await overview('scope=all&limit=1')
    expect(first.body.properties.items.map(row => row.targetKey)).toEqual(['bayside'])
    expect(first.body.properties.nextCursor).toEqual(expect.any(String))

    const second = await overview(`scope=all&limit=1&cursor=${encodeURIComponent(first.body.properties.nextCursor!)}`)
    expect(second.body.properties.items.map(row => row.targetKey)).toEqual(['harbor'])
    expect(second.body.properties.nextCursor).toBeNull()
  })

  it('rejects a scope without the key it needs', async () => {
    activate(seedVersion(1))

    for (const query of ['scope=group', 'scope=property', 'scope=group&groupKey=missing', 'scope=property&targetKey=missing']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northstar/measurement-overview?${query}` })
      expect(response.statusCode, query).toBe(400)
    }
  })

  it('withholds class-dependent metrics under an active v1 plan', async () => {
    const v1 = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'harbor',
        label: 'Harbor Homes',
        urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
        aliases: ['Harbor Homes'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }],
    }, {
      canonicalDomain: 'northstar.example',
      ownedDomains: [],
      brandNames: ['Northstar'],
      trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }],
      locations: [],
      defaultContext: null,
      expectedSnapshots: 1,
    })
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId,
      projectId,
      revision: 1,
      canonicalJson: canonicalMeasurementPlanJson(v1),
      checksum: 'a'.repeat(64),
      createdAt: NOW,
    }).run()
    activate(versionId)

    const { body } = await overview('scope=all')

    expect(body.mode).toBe('active-v1')
    expect(body.metrics.mentionCoverage).toEqual({ state: 'unavailable', reason: 'plan_v1' })
    expect(body.metrics.sov).toEqual({ state: 'unavailable', reason: 'plan_v1' })
    expect(body.nextAction).toEqual({ kind: 'republish_setup' })
    expect(body.properties.items).toEqual([
      { targetKey: 'harbor', label: 'Harbor Homes', mentionCoverage: { state: 'unavailable', reason: 'plan_v1' }, citationCoverage: { state: 'unavailable', reason: 'plan_v1' }, flags: 0 },
    ])
  })
})
