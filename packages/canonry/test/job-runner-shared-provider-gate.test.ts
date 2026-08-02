import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, onTestFinished, beforeEach } from 'vitest'
import type {
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

/**
 * NEW-3: `ProviderExecutionGate` holds the per-provider concurrency and
 * rate-limit budget for one upstream API key. Two runs for two DIFFERENT
 * projects can be in flight at once (the scheduler does not serialize
 * projects against each other), and both name the same provider — they share
 * the same upstream key and the same real-world rate limit. A gate built
 * fresh per run gives each run its own independent budget against that same
 * key, silently multiplying the configured limit by the number of concurrent
 * runs. The gate must be shared process-wide, one per provider name.
 */

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

function buildAdapter(onDispatch: () => Promise<void> | void): ProviderAdapter {
  return {
    name: 'gemini',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      await onDispatch()
      return {
        provider: 'gemini',
        rawResponse: {},
        model: 'stub-model',
        groundingSources: [],
        searchQueries: [],
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'gemini',
        answerText: 'stub answer',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
  }
}

function seedProjectAndRun(db: ReturnType<typeof createClient>, queryCount: number) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: `project-${projectId}`,
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  for (let index = 0; index < queryCount; index++) {
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: `query-${index + 1}`,
      createdAt: now,
    }).run()
  }

  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'queued',
    createdAt: now,
  }).run()

  return { projectId, runId }
}

test('two concurrent runs for different projects share one concurrency budget for the same provider', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-shared-gate-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  let inFlight = 0
  let maxSeen = 0
  const adapter = buildAdapter(async () => {
    inFlight++
    maxSeen = Math.max(maxSeen, inFlight)
    await new Promise(resolve => setTimeout(resolve, 30))
    inFlight--
  })

  const registry = new ProviderRegistry()
  registry.register(adapter, {
    provider: 'gemini',
    apiKey: 'test-key',
    // A budget of 1 in-flight request against this provider. If each run
    // gets its own gate, two runs dispatching at once will still peak at 2 —
    // the whole point of a SHARED gate is that the peak stays at 1 no matter
    // how many runs are in flight for it concurrently.
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 },
  })

  const runnerA = new JobRunner(db, registry)
  const runnerB = new JobRunner(db, registry)
  const { projectId: projectA, runId: runIdA } = seedProjectAndRun(db, 2)
  const { projectId: projectB, runId: runIdB } = seedProjectAndRun(db, 2)

  await Promise.all([
    runnerA.executeRun(runIdA, projectA),
    runnerB.executeRun(runIdB, projectB),
  ])

  expect(maxSeen).toBe(1)
})
