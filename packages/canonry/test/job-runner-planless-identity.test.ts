import { expect, onTestFinished, test } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  buildMeasurementExecutionIdentity,
  canonicalMeasurementExecutionIdentityJson,
  type MeasurementExecutionIdentity,
  type MeasurementExecutionIdentityInput,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, competitors, queries, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { fakeAdapter, type RecordedCall } from './fake-measurement-provider.js'

/**
 * Byte-identity guard for the planless path.
 *
 * The runner grew a plan-aware branch. A project that has published no
 * measurement plan must keep the behaviour it had before that branch existed:
 * the same provider calls, in the same shape, and the same snapshot rows —
 * including three columns (`measurement_execution_id`, `requested_context`,
 * `supported_context`) that a planless run must never populate.
 *
 * The expectations below are written out literally rather than derived from
 * the runner, so a change in the runner cannot quietly move the goalposts.
 */

function buildEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-planless-identity-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

function seed(db: ReturnType<typeof createClient>) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const now = '2026-08-01T00:00:00.000Z'

  db.insert(projects).values({
    id: projectId,
    name: 'planless',
    displayName: 'Planless Co',
    canonicalDomain: 'example.com',
    ownedDomains: ['shop.example'],
    aliases: ['Planless'],
    country: 'US',
    language: 'en',
    providers: ['openai', 'gemini'],
    locations: [{ label: 'north-city', city: 'North City', region: 'NC', country: 'US' }],
    defaultLocation: 'north-city',
    createdAt: now,
    updatedAt: now,
  }).run()

  const queryIds = new Map<string, string>()
  for (const query of ['widget pricing', 'widget repair']) {
    const id = crypto.randomUUID()
    queryIds.set(query, id)
    db.insert(queries).values({ id, projectId, query, createdAt: now }).run()
  }

  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'rival.example',
    createdAt: now,
  }).run()

  db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()

  return { projectId, runId, queryIds }
}

function registryFor(calls: RecordedCall[], models: Partial<Record<'openai' | 'gemini', string>> = {}) {
  const registry = new ProviderRegistry()
  for (const name of ['openai', 'gemini'] as const) {
    registry.register(fakeAdapter({ name, calls }), {
      provider: name,
      apiKey: 'test-key',
      ...(models[name] === undefined ? {} : { model: models[name] }),
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 },
    })
  }
  return registry
}

function executionIdentity(input: MeasurementExecutionIdentityInput): MeasurementExecutionIdentity {
  return buildMeasurementExecutionIdentity(
    input,
    crypto.createHash('sha256').update(canonicalMeasurementExecutionIdentityJson(input)).digest('hex'),
  )
}

function callKey(call: RecordedCall): string {
  return `${call.provider} ${call.query}`
}

test('a planless run makes exactly the provider calls it always made', async () => {
  const db = buildEnv()
  const { projectId, runId } = seed(db)
  const calls: RecordedCall[] = []

  await new JobRunner(db, registryFor(calls)).executeRun(runId, projectId)

  expect([...calls].sort((left, right) => callKey(left).localeCompare(callKey(right)))).toEqual([
    {
      provider: 'gemini',
      query: 'widget pricing',
      canonicalDomains: ['example.com', 'shop.example'],
      competitorDomains: ['rival.example'],
      location: { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
    },
    {
      provider: 'gemini',
      query: 'widget repair',
      canonicalDomains: ['example.com', 'shop.example'],
      competitorDomains: ['rival.example'],
      location: { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
    },
    {
      provider: 'openai',
      query: 'widget pricing',
      canonicalDomains: ['example.com', 'shop.example'],
      competitorDomains: ['rival.example'],
      location: { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
    },
    {
      provider: 'openai',
      query: 'widget repair',
      canonicalDomains: ['example.com', 'shop.example'],
      competitorDomains: ['rival.example'],
      location: { label: 'north-city', city: 'North City', region: 'NC', country: 'US' },
    },
  ])
})

test('a planless run writes exactly the snapshot rows it always wrote', async () => {
  const db = buildEnv()
  const { projectId, runId, queryIds } = seed(db)
  const calls: RecordedCall[] = []

  await new JobRunner(db, registryFor(calls)).executeRun(runId, projectId)

  const rows = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
  expect(rows).toHaveLength(4)

  for (const row of rows) {
    expect(row.queryId).toBe(queryIds.get(row.queryText!))
    expect(row.location).toBe('north-city')
    expect(row.model).toBe('fake-model')
    expect(row.citationState).toBe('not-cited')
    // The three plan columns exist on the table but a planless run never
    // touches them: a row that claimed an execution id would be claiming
    // membership in a plan this project has not published.
    expect(row.measurementExecutionId).toBeNull()
    expect(row.requestedContext).toBeNull()
    expect(row.supportedContext).toBeNull()
  }

  expect(rows.map(row => `${row.provider} ${row.queryText}`).sort()).toEqual([
    'gemini widget pricing',
    'gemini widget repair',
    'openai widget pricing',
    'openai widget repair',
  ])

  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  expect(run.status).toBe('completed')
  expect(run.measurementPlanVersionId).toBeNull()
  expect(run.measurementManifest).toBeNull()
})

test('a queue-stamped planless run uses its frozen provider roster and model', async () => {
  const db = buildEnv()
  const { projectId, runId } = seed(db)
  db.update(runs).set({
    measurementExecutionIdentity: executionIdentity({
      providers: ['openai'],
      models: { openai: 'queued-model' },
    }),
  }).where(eq(runs.id, runId)).run()
  // Both project and registry settings move before the worker starts.
  db.update(projects).set({
    providers: ['gemini'],
    providerModels: { openai: 'edited-project-model' },
  }).where(eq(projects.id, projectId)).run()
  const calls: RecordedCall[] = []

  await new JobRunner(db, registryFor(calls, {
    openai: 'edited-registry-model',
    gemini: 'edited-gemini-model',
  })).executeRun(runId, projectId, ['gemini'])

  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.provider === 'openai' && call.model === 'queued-model')).toBe(true)
  expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all())
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', model: 'queued-model' }),
    ]))
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
})

test('a queue-stamped planless run fails closed when its provider is unavailable', async () => {
  const db = buildEnv()
  const { projectId, runId } = seed(db)
  db.update(runs).set({
    measurementExecutionIdentity: executionIdentity({
      providers: ['perplexity'],
      models: { perplexity: 'sonar' },
    }),
  }).where(eq(runs.id, runId)).run()
  const calls: RecordedCall[] = []

  await new JobRunner(db, registryFor(calls)).executeRun(runId, projectId)

  expect(calls).toEqual([])
  expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()).toEqual([])
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/Queued provider perplexity is unavailable/),
  })
})

test('a v2 planless run fails closed when the live route policy changed', async () => {
  const db = buildEnv()
  const { projectId, runId } = seed(db)
  db.update(runs).set({
    measurementExecutionIdentity: executionIdentity({
      providers: ['openai'],
      models: { openai: 'queued-model' },
      routes: {
        openai: {
          routeId: 'native:openai',
          routeRevision: 1,
          policyFingerprint: 'a'.repeat(64),
        },
      },
    }),
  }).where(eq(runs.id, runId)).run()
  const calls: RecordedCall[] = []

  await new JobRunner(db, registryFor(calls), {
    getProviderRouteDescriptors: () => ({
      openai: {
        routeId: 'native:openai',
        routeRevision: 1,
        policyFingerprint: 'b'.repeat(64),
      },
    }),
  }).executeRun(runId, projectId)

  expect(calls).toEqual([])
  expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()).toEqual([])
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/route policy for openai no longer matches/),
  })
})

test('a v2 planless run fails closed on a worker that cannot verify route policy', async () => {
  const db = buildEnv()
  const { projectId, runId } = seed(db)
  db.update(runs).set({
    measurementExecutionIdentity: executionIdentity({
      providers: ['openai'],
      models: { openai: 'queued-model' },
      routes: {
        openai: {
          routeId: 'native:openai',
          routeRevision: 1,
          policyFingerprint: 'a'.repeat(64),
        },
      },
    }),
  }).where(eq(runs.id, runId)).run()
  const calls: RecordedCall[] = []

  await new JobRunner(db, registryFor(calls)).executeRun(runId, projectId)

  expect(calls).toEqual([])
  expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()).toEqual([])
  expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/cannot verify the queued engine route policy/),
  })
})
