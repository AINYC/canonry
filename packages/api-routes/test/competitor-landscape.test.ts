import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  apiKeys,
  competitors,
  createClient,
  domainClassifications,
  migrate,
  measurementPlans,
  measurementPlanDrafts,
  measurementPlanVersions,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  canonicalMeasurementPlanV2Json,
  competitorLandscapeResponseSchema,
  measurementPlanV2Schema,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const NOW = '2026-08-20T12:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-landscape-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_northwind',
    name: 'northwind',
    displayName: 'Northwind',
    canonicalDomain: 'northwind.example',
    ownedDomains: ['shop.northwind.example'],
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(competitors).values({
    id: 'pinned_rival',
    projectId: 'project_northwind',
    domain: 'rival.example',
    provenance: 'manual',
    createdAt: NOW,
  }).run()
  db.insert(queries).values({
    id: 'market-query',
    projectId: 'project_northwind',
    query: 'homes near northwind',
    createdAt: NOW,
  }).run()
  db.insert(domainClassifications).values([
    {
      id: crypto.randomUUID(),
      projectId: 'project_northwind',
      domain: 'challenger.example',
      competitorType: 'direct-competitor',
      hits: 2,
      sessionId: null,
      updatedAt: NOW,
    },
    {
      id: crypto.randomUUID(),
      projectId: 'project_northwind',
      domain: 'guide.example',
      competitorType: 'editorial-media',
      hits: 1,
      sessionId: null,
      updatedAt: NOW,
    },
  ]).run()
  db.insert(runs).values([
    {
      id: 'run_normal',
      projectId: 'project_northwind',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      location: null,
      createdAt: NOW,
    },
    {
      id: 'run_probe',
      projectId: 'project_northwind',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'probe',
      location: null,
      createdAt: NOW,
    },
    {
      id: 'run_failed',
      projectId: 'project_northwind',
      kind: 'answer-visibility',
      status: 'failed',
      trigger: 'manual',
      location: null,
      createdAt: NOW,
    },
  ]).run()
  db.insert(querySnapshots).values([
    {
      id: 'snapshot_answer',
      runId: 'run_normal',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: true,
      answerText: 'Northwind, Rival, and Challenger are all relevant choices.',
      citedDomains: ['rival.example', 'challenger.example', 'guide.example'],
      citedUrls: ['https://guide.example/overview'],
      captureStatus: 'complete',
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
    {
      id: 'snapshot_source_only',
      runId: 'run_normal',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: null,
      answerText: null,
      citedDomains: ['rival.example'],
      citedUrls: null,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
    {
      id: 'snapshot_probe',
      runId: 'run_probe',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Probe Rival',
      citedDomains: ['rival.example'],
      citedUrls: null,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
    {
      id: 'snapshot_failed',
      runId: 'run_failed',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Failed Rival result',
      citedDomains: ['rival.example'],
      citedUrls: null,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
  ]).run()

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /projects/:name/analytics/competitors', () => {
  it('returns probe-excluded stored answer and citation evidence with pinned rows first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all',
    })

    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(competitorLandscapeResponseSchema.safeParse(body).success).toBe(true)
    expect(body).not.toHaveProperty('modelComparison')
    expect(body.filters).not.toHaveProperty('model')
    expect(body.filters).not.toHaveProperty('groupBy')
    expect(body).toMatchObject({
      window: 'all',
      scope: { kind: 'project' },
      evidence: {
        answeredResults: 1,
        sourceResults: 2,
        missingAnswerTextResults: 1,
        mentionCredits: 3,
        incompleteSourceResults: 1,
        excludedProbeResults: 1,
        excludedNonCompletedResults: 1,
      },
    })
    expect(body.project).toMatchObject({ domain: 'northwind.example', mentionCount: 1, shareOfVoice: 33.3 })
    expect(body.pinned).toEqual([expect.objectContaining({
      domain: 'rival.example',
      pinned: true,
      mentionCount: 1,
      shareOfVoice: 33.3,
      citationCount: 2,
    })])
    expect(body.observed).toEqual([expect.objectContaining({
      domain: 'challenger.example',
      pinned: false,
      mentionCount: 1,
      shareOfVoice: 33.3,
      citationCount: 1,
    })])
    expect(body.otherSources).toEqual([expect.objectContaining({
      domain: 'guide.example',
      surfaceClass: 'editorial-media',
      shareOfVoice: null,
      citationCount: 1,
    })])
  })

  it.each([null, '', ' \t '])('keeps an unavailable Simple question (%j) only in All, including model groups', async unavailableQuery => {
    db.insert(querySnapshots).values([
      { id: 'unavailable-query', queryText: unavailableQuery },
      { id: 'known-branded-query', queryText: 'Northwind options' },
      { id: 'known-non-brand-query', queryText: 'Housing options' },
    ].map(row => ({
      ...marketSnapshot(row.id, 'run_normal', null, 'Northwind and Rival.', 'rival.example'),
      queryId: null,
      queryText: row.queryText,
      model: 'query-class-model',
    }))).run()

    for (const [queryClass, expectedCount] of [['all', 3], ['branded', 1], ['non-brand', 1]] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=query-class-model&groupBy=model&queryClass=${queryClass}`,
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({
        evidence: { answeredResults: expectedCount },
        project: { mentionCount: expectedCount },
        modelComparison: {
          totalGroups: 1,
          groups: [{
            model: 'query-class-model',
            snapshotCount: expectedCount,
            evidence: { answeredResults: expectedCount },
          }],
        },
      })
    }
  })

  it.each(['', '&groupKey=regional', '&scope=all-markets'])('does not turn generated project pin labels into curated aliases (%s)', async scope => {
    db.insert(competitors).values(['car.com', 'www.car.com'].map((domain, index) => ({
      id: `short-domain-pin-${index}`,
      projectId: 'project_northwind',
      domain,
      provenance: 'manual',
      createdAt: NOW,
    }))).run()
    const plan = marketPlan('short-label-node', 'car.com', 'Car Services')
    plan.groups[0]!.competitors[0]!.aliases = []
    seedVersion('short_label_plan', 1, plan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'short_label_plan', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values({
      id: 'short_label_run', projectId: 'project_northwind', kind: 'answer-visibility',
      status: 'completed', trigger: 'manual', measurementPlanVersionId: 'short_label_plan', createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      ...marketSnapshot('short_label_snapshot', 'short_label_run', 'short-label-node', 'Northwind helps you rent a car.', 'car.com'),
      // The Advanced class remains available through the frozen execution,
      // even when both legacy question text and the current query are absent.
      queryId: null,
      queryText: null,
      model: 'short-label-model',
    }).run()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=short-label-model&groupBy=model${scope}${scope ? '&queryClass=non-brand' : ''}`,
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = competitorLandscapeResponseSchema.parse(response.json())
    expect(body.project).toMatchObject({ mentionCount: 1, shareOfVoice: 100 })
    expect(body.pinned.find(row => row.domain === 'car.com'))
      .toMatchObject({ mentionCount: 0, citationCount: 1, shareOfVoice: 0 })
    expect(body.modelComparison!.groups[0]!.pinned.find(row => row.domain === 'car.com'))
      .toMatchObject({ mentionCount: 0, citationCount: 1, shareOfVoice: 0 })
    expect(body.evidence.answeredResults).toBe(1)
  })

  it.each([
    { input: {}, label: 'car.com', aliases: [], mentions: 0 },
    { input: { label: 'CAR' }, label: 'CAR', aliases: ['CAR'], mentions: 1 },
    { input: { aliases: ['CAR'] }, label: 'car.com', aliases: ['CAR'], mentions: 1 },
  ])('keeps Advanced domain-only pins distinct from explicit brand names ($input)', async ({ input, label, aliases, mentions }) => {
    const plan = marketPlan('domain-pin-node', 'market-rival.example', 'Market Rival')
    seedVersion('domain_pin_plan', 1, plan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'domain_pin_plan', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values({
      id: 'domain_pin_run', projectId: 'project_northwind', kind: 'answer-visibility',
      status: 'completed', trigger: 'manual', measurementPlanVersionId: 'domain_pin_plan', createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      ...marketSnapshot('domain_pin_snapshot', 'domain_pin_run', 'domain-pin-node', 'Northwind helps you rent a car.', 'car.com'),
      model: 'domain-pin-model',
    }).run()

    const pin = await app.inject({
      method: 'POST', url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'domain-only-pin' },
      payload: { expectedActiveRevision: 1, groupKey: 'regional', domain: 'car.com', ...input },
    })
    expect(pin.statusCode, pin.body).toBe(200)
    expect(pin.json().competitor).toMatchObject({ label, domain: 'car.com', aliases })
    // A later domain-only upsert must preserve an already-curated identity.
    const retained = await app.inject({
      method: 'POST', url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'retain-pin-identity' },
      payload: { expectedActiveRevision: 1, groupKey: 'regional', domain: 'car.com' },
    })
    expect(retained.statusCode, retained.body).toBe(200)
    expect(retained.json().competitor).toEqual(pin.json().competitor)

    for (const scope of ['groupKey=regional', 'scope=all-markets']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=domain-pin-model&groupBy=model&${scope}`,
      })
      expect(response.statusCode, response.body).toBe(200)
      const body = competitorLandscapeResponseSchema.parse(response.json())
      expect(body.pinned.find(row => row.domain === 'car.com')).toMatchObject({ mentionCount: mentions, citationCount: 1 })
      expect(body.modelComparison!.groups[0]!.pinned.find(row => row.domain === 'car.com')).toMatchObject({ mentionCount: mentions, citationCount: 1 })
      expect(body.project.shareOfVoice).toBe(mentions ? 50 : 100)
    }
  })

  it('groups stored requested identities by provider with separate sample counts and raw served evidence', async () => {
    db.insert(querySnapshots).values([
      { ...marketSnapshot('shared_openai_1', 'run_normal', null, 'Rival.', 'rival.example'), model: 'shared', servedModel: 'shared-2026-01', answerMentioned: false },
      { ...marketSnapshot('shared_openai_2', 'run_normal', null, 'Rival.', 'rival.example'), model: 'shared', servedModel: 'shared-2026-02', answerMentioned: false },
      { ...marketSnapshot('shared_openai_3', 'run_normal', null, 'No brands.', 'guide.example'), model: ' shared ', servedModel: null, answerMentioned: false },
      { ...marketSnapshot('shared_gemini', 'run_normal', null, 'Northwind.', 'northwind.example'), provider: 'gemini', model: 'shared', servedModel: 'different-served-id' },
      { ...marketSnapshot('empty_requested', 'run_normal', null, 'Northwind.', 'northwind.example'), model: '  ', servedModel: 'reported-only-id' },
      { ...marketSnapshot('excluded_only', 'run_probe', null, 'Rival.', 'rival.example'), model: 'not-measured' },
    ]).run()
    db.update(querySnapshots).set({ model: 'shared' }).where(eq(querySnapshots.id, 'snapshot_probe')).run()
    db.update(querySnapshots).set({ model: 'shared' }).where(eq(querySnapshots.id, 'snapshot_failed')).run()
    db.update(projects).set({ providerModels: { openai: 'current-unmeasured-model' } }).where(eq(projects.id, 'project_northwind')).run()

    const aggregate = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all' })
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupBy=model' })
    expect(response.statusCode, response.body).toBe(200)
    const body = competitorLandscapeResponseSchema.parse(response.json())
    const { modelComparison, ...combined } = body
    const { groupBy: _groupBy, ...unchangedFilters } = combined.filters
    expect({ ...combined, filters: unchangedFilters }).toEqual(aggregate.json())
    expect(modelComparison).toMatchObject({ basis: 'requested-model', totalGroups: 3, truncated: false })
    expect(modelComparison!.groups.map(group => [group.provider, group.model])).toEqual([
      ['gemini', 'shared'], ['openai', null], ['openai', 'shared'],
    ])
    const [gemini, unknown, openai] = modelComparison!.groups
    expect(gemini).toMatchObject({
      snapshotCount: 1,
      servedModels: { status: 'known', model: 'different-served-id' },
      project: { mentionCount: 1, citationCount: 1, shareOfVoice: 100 },
      pinned: [{ domain: 'rival.example', mentionCount: 0, citationCount: 0, answeredResults: 1 }],
      evidence: { answeredResults: 1, excludedProbeResults: 0, excludedNonCompletedResults: 0 },
    })
    expect(unknown).toMatchObject({
      snapshotCount: 3,
      servedModels: { status: 'mixed', models: ['reported-only-id'], includesUnknown: true },
      evidence: { answeredResults: 2, sourceResults: 3, missingAnswerTextResults: 1, incompleteSourceResults: 1 },
    })
    expect(openai).toMatchObject({
      snapshotCount: 3,
      servedModels: { status: 'mixed', models: ['shared-2026-01', 'shared-2026-02'], includesUnknown: true },
      project: { mentionCount: 0, citationCount: 0, shareOfVoice: 0 },
      pinned: [{ domain: 'rival.example', mentionCount: 2, citationCount: 2, answeredResults: 3, shareOfVoice: 100 }],
      evidence: { answeredResults: 3, excludedProbeResults: 1, excludedNonCompletedResults: 1 },
    })
    expect(modelComparison!.groups.reduce((sum, group) => sum + group.snapshotCount, 0)).toBe(7)
    expect(modelComparison!.groups.reduce((sum, group) => sum + group.evidence.answeredResults, 0)).toBe(body.evidence.answeredResults)
    expect(modelComparison!.groups.reduce((sum, group) => sum + group.evidence.mentionCredits, 0)).toBe(body.evidence.mentionCredits)
    for (const row of [body.project, ...body.pinned, ...body.observed, ...body.otherSources]) {
      const pieces = modelComparison!.groups.flatMap(group => [group.project, ...group.pinned, ...group.observed, ...group.otherSources])
        .filter(piece => piece.domain === row.domain)
      expect(pieces.reduce((sum, piece) => sum + piece.mentionCount, 0)).toBe(row.mentionCount)
      expect(pieces.reduce((sum, piece) => sum + piece.citationCount, 0)).toBe(row.citationCount)
    }
    const filtered = await app.inject({
      method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=%20shared%20&groupBy=model',
    })
    expect(filtered.statusCode, filtered.body).toBe(200)
    expect(filtered.json()).toMatchObject({
      filters: { model: 'shared' },
      evidence: { answeredResults: 3, excludedProbeResults: 1, excludedNonCompletedResults: 1 },
      modelComparison: { totalGroups: 1, groups: [{ provider: 'openai', model: 'shared', snapshotCount: 3 }] },
    })
  })

  it('filters exact requested model before aggregate totals, exclusions, and optional groups', async () => {
    db.update(querySnapshots).set({ model: 'model-a', servedModel: 'model-b' }).where(eq(querySnapshots.id, 'snapshot_answer')).run()
    db.update(querySnapshots).set({ model: 'model-b', servedModel: 'model-a' }).where(eq(querySnapshots.id, 'snapshot_source_only')).run()
    db.update(querySnapshots).set({ model: 'model-b' }).where(eq(querySnapshots.id, 'snapshot_probe')).run()
    db.update(querySnapshots).set({ model: 'model-a' }).where(eq(querySnapshots.id, 'snapshot_failed')).run()
    db.insert(querySnapshots).values({
      ...marketSnapshot('other_provider_same_id', 'run_normal', null, 'Northwind.', 'northwind.example'),
      provider: 'gemini', model: 'model-a',
    }).run()

    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=model-a' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      filters: { provider: 'openai', model: 'model-a' },
      evidence: { answeredResults: 1, sourceResults: 1, missingAnswerTextResults: 0, incompleteSourceResults: 0, excludedProbeResults: 0, excludedNonCompletedResults: 1 },
      pinned: [{ domain: 'rival.example', mentionCount: 1, citationCount: 1 }],
    })
    expect(response.json()).not.toHaveProperty('modelComparison')
    const empty = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=absent&groupBy=model' })
    expect(empty.statusCode, empty.body).toBe(200)
    expect(empty.json()).toMatchObject({
      evidence: { answeredResults: 0, sourceResults: 0, excludedProbeResults: 0, excludedNonCompletedResults: 0 },
      modelComparison: { basis: 'requested-model', totalGroups: 0, groups: [], truncated: false },
      pinned: [{ domain: 'rival.example', answeredResults: 0, shareOfVoice: null }],
    })
  })

  it.each(['model=model-a', 'provider=openai&model=', 'provider=openai&model=%20%20', 'groupBy=provider', 'groupBy=model&groupKey=regional&scope=all-markets'])(
    'rejects invalid model comparison filters: %s', async query => {
      const response = await app.inject({ method: 'GET', url: `/api/v1/projects/northwind/analytics/competitors?window=all&${query}` })
      expect(response.statusCode, response.body).toBe(400)
    },
  )

  it('caps model groups deterministically without truncating combined totals', async () => {
    db.insert(querySnapshots).values(Array.from({ length: 52 }, (_, index) => ({
      ...marketSnapshot(`model_cap_${index}`, 'run_normal', null, 'Rival.', 'rival.example'),
      model: `model-${String(51 - index).padStart(2, '0')}`,
    }))).run()
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupBy=model' })
    expect(response.statusCode, response.body).toBe(200)
    const body = competitorLandscapeResponseSchema.parse(response.json())
    expect(body).toMatchObject({
      truncated: false,
      evidence: { answeredResults: 53 },
      modelComparison: { totalGroups: 53, truncated: true },
    })
    expect(body.modelComparison!.groups).toHaveLength(50)
    expect(body.modelComparison!.groups.map(group => group.model)).toEqual([
      null, ...Array.from({ length: 49 }, (_, index) => `model-${String(index).padStart(2, '0')}`),
    ])
    expect(body.modelComparison!.groups[1]).toMatchObject({
      servedModels: { status: 'unknown' }, snapshotCount: 1, pinned: [{ domain: 'rival.example' }],
    })
  })

  it('uses the run creation timestamp for rolling windows', async () => {
    const now = new Date().toISOString()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    db.insert(runs).values([
      {
        id: 'window_current_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location: null,
        createdAt: now,
      },
      {
        id: 'window_old_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location: null,
        createdAt: old,
      },
    ]).run()
    db.insert(querySnapshots).values([
      marketSnapshot('window_current_snapshot', 'window_current_run', null, 'Northwind and Rival.', 'rival.example', now),
      marketSnapshot('window_old_snapshot', 'window_old_run', null, 'Northwind and Rival.', 'rival.example', old),
    ]).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=7d',
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      window: '7d',
      evidence: { answeredResults: 1 },
      pinned: [expect.objectContaining({ domain: 'rival.example', mentionCount: 1 })],
    })
  })

  it('caps ranked observed and other source rows deterministically without dropping pins', async () => {
    const ranked = Array.from({ length: 101 }, (_, index) => String(index).padStart(3, '0'))
    db.insert(domainClassifications).values(ranked.map(index => ({
      id: crypto.randomUUID(),
      projectId: 'project_northwind',
      domain: `ranked-${index}.example`,
      competitorType: 'direct-competitor',
      hits: 1,
      sessionId: null,
      updatedAt: NOW,
    }))).run()
    db.insert(querySnapshots).values(ranked.map(index => ({
      id: `ranked-source-${index}`,
      runId: 'run_normal',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited' as const,
      answerMentioned: null,
      answerText: null,
      citedDomains: [`ranked-${index}.example`, `source-${index}.example`],
      citedUrls: null,
      captureStatus: 'complete' as const,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    }))).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all',
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ truncated: true })
    expect(body.pinned.map((row: { domain: string }) => row.domain)).toEqual(['rival.example'])
    expect(body.observed).toHaveLength(100)
    expect(body.otherSources).toHaveLength(100)
    expect(body.observed.map((row: { domain: string }) => row.domain)).toEqual(
      [...body.observed.map((row: { domain: string }) => row.domain)].sort((a, b) => a.localeCompare(b)),
    )
    expect(body.otherSources.map((row: { domain: string }) => row.domain)).toEqual(
      [...body.otherSources.map((row: { domain: string }) => row.domain)].sort((a, b) => a.localeCompare(b)),
    )
    const grouped = await app.inject({
      method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupBy=model',
    })
    const group = competitorLandscapeResponseSchema.parse(grouped.json()).modelComparison!.groups[0]!
    expect(group).toMatchObject({ model: null, truncated: true, snapshotCount: 103 })
    expect(group.observed).toHaveLength(100)
    expect(group.otherSources).toHaveLength(100)
    expect(group.pinned.map(row => row.domain)).toEqual(['rival.example'])
  })

  it('uses each run\'s frozen v2 market membership and supports an explicit all-markets aggregate', async () => {
    const historicalPlan = marketPlan('old-node', 'legacy-rival.example', 'Legacy Rival')
    const activePlan = marketPlan('current-node', 'current-rival.example', 'Current Rival')
    activePlan.groups.push({
      stableKey: 'southern',
      label: 'Southern',
      targetKeys: ['market-target'],
      competitors: [],
    })
    seedVersion('plan_v1', 1, historicalPlan)
    seedVersion('plan_v2', 2, activePlan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind',
      activeVersionId: 'plan_v2',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    db.insert(runs).values([
      {
        id: 'market_old_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        measurementPlanVersionId: 'plan_v1',
        location: null,
        createdAt: '2026-08-10T12:00:00.000Z',
      },
      {
        id: 'market_current_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        measurementPlanVersionId: 'plan_v2',
        location: null,
        createdAt: NOW,
      },
    ]).run()
    db.insert(querySnapshots).values([
      marketSnapshot('market_old_snapshot', 'market_old_run', 'old-node', 'Northwind and Legacy Rival are alternatives.', 'legacy-rival.example'),
      marketSnapshot('market_current_snapshot', 'market_current_run', 'current-node', 'Northwind and Current Rival are alternatives.', 'current-rival.example'),
      marketSnapshot('market_out_of_scope', 'market_current_run', 'not-a-market-node', 'Northwind and Rival are alternatives.', 'rival.example'),
    ]).run()

    const groupResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupKey=regional',
    })
    expect(groupResponse.statusCode, groupResponse.body).toBe(200)
    const group = groupResponse.json()
    expect(group).toMatchObject({
      scope: { kind: 'group', groupKey: 'regional' },
      filters: { scope: 'project', groupKey: 'regional' },
      evidence: { answeredResults: 2 },
      marketState: { activeRevision: 2, draft: null },
    })
    expect(group.pinned.map((row: { domain: string }) => row.domain)).toEqual([
      'current-rival.example',
      'rival.example',
    ])
    expect(group.observed).toEqual([expect.objectContaining({
      domain: 'legacy-rival.example',
      surfaceClass: 'direct-competitor',
      mentionCount: 1,
      citationCount: 1,
    })])
    expect(group.otherSources.some((row: { domain: string }) => row.domain === 'legacy-rival.example')).toBe(false)

    // A removed tracked-query row leaves its historic snapshot query_id NULL,
    // but the frozen execution still identifies its assigned class. The market reading
    // must retain that stored answer under its frozen non-brand scope.
    db.insert(querySnapshots).values({
      ...marketSnapshot(
        'market_orphaned_query_snapshot',
        'market_current_run',
        'current-node',
        'Northwind and Current Rival are alternatives.',
        'current-rival.example',
        NOW,
        null,
        'homes near northwind',
      ),
      provider: 'gemini',
    }).run()
    const nonBrandResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupKey=regional&queryClass=non-brand',
    })
    expect(nonBrandResponse.statusCode, nonBrandResponse.body).toBe(200)
    expect(nonBrandResponse.json()).toMatchObject({
      scope: { kind: 'group', groupKey: 'regional' },
      evidence: { answeredResults: 3 },
    })

    const pinned = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-legacy-rival' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: 'legacy-rival.example',
        label: 'Legacy Rival',
      },
    })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(pinned.json()).toMatchObject({
      draftCreated: true,
      groupKey: 'regional',
      competitor: { domain: 'legacy-rival.example', label: 'Legacy Rival' },
      published: { revision: 2, competitorsChanged: false },
    })
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-legacy-rival' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: 'legacy-rival.example',
        label: 'Legacy Rival',
      },
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(pinned.json())
    expect(db.select().from(measurementPlanDrafts)
      .where(eq(measurementPlanDrafts.projectId, 'project_northwind')).all()).toHaveLength(1)
    const activeFrozen = JSON.parse(db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.id, 'plan_v2')).get()!.canonicalJson) as { groups: Array<{ competitors: Array<{ domain: string }> }> }
    expect(activeFrozen.groups[0]!.competitors.map(competitor => competitor.domain)).toEqual(['current-rival.example'])

    const rescanned = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupKey=regional&groupBy=model',
    })
    expect(rescanned.statusCode, rescanned.body).toBe(200)
    expect(rescanned.json()).toMatchObject({
      marketState: {
        activeRevision: 2,
        draft: { pendingCompetitorDomains: ['legacy-rival.example'] },
      },
    })
    expect(rescanned.json().pinned.map((row: { domain: string }) => row.domain)).toEqual([
      'legacy-rival.example',
      'current-rival.example',
      'rival.example',
    ])
    expect(rescanned.json().pinned.find((row: { domain: string }) => row.domain === 'legacy-rival.example'))
      .toMatchObject({ mentionCount: 1, citationCount: 1 })
    expect(rescanned.json().modelComparison.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai', model: null,
        pinned: expect.arrayContaining([expect.objectContaining({ domain: 'legacy-rival.example', mentionCount: 1, citationCount: 1 })]),
      }),
      expect.objectContaining({
        provider: 'gemini', model: null,
        pinned: expect.arrayContaining([expect.objectContaining({ domain: 'legacy-rival.example', mentionCount: 0, citationCount: 0 })]),
      }),
    ]))

    const allMarketsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets&queryClass=non-brand',
    })
    expect(allMarketsResponse.statusCode, allMarketsResponse.body).toBe(200)
    expect(allMarketsResponse.json()).toMatchObject({
      scope: { kind: 'all-markets' },
      filters: { scope: 'all-markets', groupKey: null, queryClass: 'non-brand' },
      evidence: { answeredResults: 3 },
    })

    // A domain can be published in one market while still pending in another.
    // All-markets must compare draft membership per group, not against the
    // union of published competitors across every group.
    const crossMarketPin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-current-rival-southern' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'southern',
        domain: 'current-rival.example',
      },
    })
    expect(crossMarketPin.statusCode, crossMarketPin.body).toBe(200)
    const allMarketsWithCrossMarketDraft = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets',
    })
    expect(allMarketsWithCrossMarketDraft.statusCode, allMarketsWithCrossMarketDraft.body).toBe(200)
    expect(allMarketsWithCrossMarketDraft.json().marketState.draft.pendingCompetitorDomains)
      .toEqual(['legacy-rival.example', 'current-rival.example'])

    const longDomain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(40)}.example`
    const longDomainPin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-long-valid-domain' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: longDomain,
      },
    })
    expect(longDomainPin.statusCode, longDomainPin.body).toBe(200)
    expect(longDomainPin.json().competitor).toMatchObject({ domain: longDomain })
    expect(longDomainPin.json().competitor.stableKey).toHaveLength(128)

    const removedGroup = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/remove-group',
      headers: { 'if-match': longDomainPin.json().etag, 'idempotency-key': 'remove-regional-group' },
      payload: { groupKey: 'regional' },
    })
    expect(removedGroup.statusCode, removedGroup.body).toBe(200)
    const missingGroupDraft = db.select().from(measurementPlanDrafts).get()!
    const rejectedPin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'do-not-restore-regional-group' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: 'should-not-recreate.example',
      },
    })
    expect(rejectedPin.statusCode, rejectedPin.body).toBe(400)
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(missingGroupDraft)
  })

  it.each(['groupKey=regional', 'scope=all-markets'])('retains frozen competitor identities within each model group (%s)', async scope => {
    const historicalPlan = marketPlan('old-only-node', 'alphaco.example', 'AlphaCo')
    const activePlan = marketPlan('current-only-node', 'betaco.example', 'BetaCo')
    seedVersion('frozen_plan_v1', 1, historicalPlan)
    seedVersion('frozen_plan_v2', 2, activePlan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'frozen_plan_v2', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values([
      {
        id: 'frozen_old_run', projectId: 'project_northwind', kind: 'answer-visibility',
        status: 'completed', trigger: 'manual', measurementPlanVersionId: 'frozen_plan_v1',
        location: null, createdAt: '2026-08-10T12:00:00.000Z',
      },
      {
        id: 'frozen_current_run', projectId: 'project_northwind', kind: 'answer-visibility',
        status: 'completed', trigger: 'manual', measurementPlanVersionId: 'frozen_plan_v2',
        location: null, createdAt: NOW,
      },
    ]).run()
    db.insert(querySnapshots).values([
      { ...marketSnapshot('frozen_old_snapshot', 'frozen_old_run', 'old-only-node', 'Northwind and BetaCo.', 'betaco.example'), model: 'historical-model', servedModel: 'historical-served-id' },
      { ...marketSnapshot('frozen_current_snapshot', 'frozen_current_run', 'current-only-node', 'Northwind and AlphaCo.', 'alphaco.example'), model: 'current-model' },
      { ...marketSnapshot('frozen_out_of_scope', 'frozen_current_run', 'unrelated-node', 'Northwind and AlphaCo.', 'alphaco.example'), model: 'unrelated-model' },
    ]).run()

    const response = await app.inject({
      method: 'GET', url: `/api/v1/projects/northwind/analytics/competitors?window=all&${scope}&groupBy=model`,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().pinned).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'betaco.example', mentionCount: 1 }),
    ]))
    expect(response.json().evidence.mentionCredits).toBe(3)
    expect(response.json().observed.find((row: { domain: string }) => row.domain === 'alphaco.example')?.mentionCount ?? 0).toBe(0)
    const modelComparison = competitorLandscapeResponseSchema.parse(response.json()).modelComparison!
    expect(modelComparison).toMatchObject({ totalGroups: 2, truncated: false })
    expect(modelComparison.groups.map(group => group.model)).toEqual(['current-model', 'historical-model'])
    expect(modelComparison.groups[0]).toMatchObject({
      snapshotCount: 1,
      servedModels: { status: 'unknown' },
      evidence: { answeredResults: 1, mentionCredits: 1 },
      observed: [],
      otherSources: [expect.objectContaining({ domain: 'alphaco.example', surfaceClass: 'unknown' })],
    })
    expect(modelComparison.groups[1]).toMatchObject({
      snapshotCount: 1,
      servedModels: { status: 'known', model: 'historical-served-id' },
      pinned: expect.arrayContaining([expect.objectContaining({ domain: 'betaco.example', mentionCount: 1 })]),
    })
    const filtered = await app.inject({
      method: 'GET', url: `/api/v1/projects/northwind/analytics/competitors?window=all&${scope}&provider=openai&model=historical-model&queryClass=non-brand&runId=frozen_old_run&groupBy=model`,
    })
    expect(filtered.statusCode, filtered.body).toBe(200)
    expect(filtered.json()).toMatchObject({
      evidence: { answeredResults: 1, mentionCredits: 2 },
      modelComparison: { totalGroups: 1, groups: [{ model: 'historical-model', snapshotCount: 1 }] },
    })
  })

  it('resolves sibling-host classification conflicts deterministically', async () => {
    db.insert(domainClassifications).values([
      {
        id: crypto.randomUUID(), projectId: 'project_northwind', domain: 'shop.contoso.com',
        competitorType: 'direct-competitor', hits: 1, sessionId: null, updatedAt: NOW,
      },
      {
        id: crypto.randomUUID(), projectId: 'project_northwind', domain: 'news.contoso.com',
        competitorType: 'editorial-media', hits: 1, sessionId: null, updatedAt: NOW,
      },
    ]).run()
    db.insert(querySnapshots).values({
      id: 'classified_subdomain_snapshot', runId: 'run_normal', queryId: null,
      provider: 'openai', citationState: 'not-cited', answerMentioned: null, answerText: null,
      citedDomains: ['shop.contoso.com'], citedUrls: null, captureStatus: 'complete',
      competitorOverlap: [], location: null, createdAt: NOW,
    }).run()

    const response = await app.inject({
      method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all',
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'contoso.com', surfaceClass: 'direct-competitor', citationCount: 1 }),
    ]))
  })

  it.each([
    { scope: 'groupKey=regional', queryId: 'market-query' },
    { scope: 'scope=all-markets', queryId: 'market-query' },
    { scope: 'groupKey=regional', queryId: null },
    { scope: 'scope=all-markets', queryId: null },
  ])('keeps same-query classes bound to their frozen Target execution context ($scope, queryId=$queryId)', async ({ scope, queryId }) => {
    const plan = marketPlan('branded-node', 'market-rival.example', 'Market Rival')
    plan.assignments[0]!.queryClass = 'branded'
    plan.executionNodes[0]!.context.models = { openai: 'branded-model' }
    plan.targets.push({ ...plan.targets[0]!, stableKey: 'other-target', label: 'Other Target' })
    plan.groups[0]!.targetKeys.push('other-target')
    plan.assignments.push({ targetKey: 'other-target', queryId: 'market-query', queryClass: 'non-brand', executionNodeKey: 'non-brand-node' })
    plan.executionNodes.push({
      ...plan.executionNodes[0]!, stableKey: 'non-brand-node',
      context: { providers: ['openai'], models: { openai: 'non-brand-model' }, location: null },
    })
    plan.usageEdges.push({ targetKey: 'other-target', queryId: 'market-query', executionNodeKey: 'non-brand-node' })
    seedVersion('class-context-plan', 1, plan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'class-context-plan', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values({
      id: 'class-context-run', projectId: 'project_northwind', kind: 'answer-visibility',
      status: 'completed', trigger: 'manual', measurementPlanVersionId: 'class-context-plan', location: null, createdAt: NOW,
    }).run()
    db.update(runs).set({ measurementPlanVersionId: 'class-context-plan' }).where(eq(runs.id, 'run_probe')).run()
    db.insert(querySnapshots).values([
      { ...marketSnapshot('class-context-branded', 'class-context-run', 'branded-node', 'Northwind and Rival.', 'rival.example', NOW, queryId), model: 'branded-model' },
      { ...marketSnapshot('class-context-non-brand', 'class-context-run', 'non-brand-node', 'Northwind and Challenger.', 'challenger.example', NOW, queryId), model: 'non-brand-model' },
      { ...marketSnapshot('class-context-probe', 'run_probe', 'non-brand-node', 'Northwind and Challenger.', 'challenger.example', NOW, queryId), model: 'non-brand-model' },
    ]).run()

    for (const [queryClass, model, excludedProbeResults] of [
      ['branded', 'branded-model', 0], ['non-brand', 'non-brand-model', 1],
    ] as const) {
      const response = await app.inject({
        method: 'GET', url: `/api/v1/projects/northwind/analytics/competitors?window=all&${scope}&queryClass=${queryClass}&groupBy=model`,
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({
        evidence: { answeredResults: 1, excludedProbeResults },
        modelComparison: { totalGroups: 1, groups: [{ model, snapshotCount: 1, evidence: { answeredResults: 1, excludedProbeResults } }] },
      })
    }
  })

  it('unions aliases when one competitor domain appears in multiple markets', async () => {
    const plan = marketPlan('north-alias-node', 'parentco.com', 'AlphaCo')
    plan.targets.push({
      stableKey: 'south-target', label: 'South Target', aliases: ['Southwind'],
      urlMatchers: [{ kind: 'host', host: 'northwind.example' }], mentionNotApplicable: false, discoveryIdentity: null,
    })
    plan.groups.push({
      stableKey: 'southern', label: 'Southern', targetKeys: ['south-target'],
      competitors: [{ stableKey: 'parentco-south', label: 'BetaCo', domain: 'parentco.com', aliases: ['BetaCo'] }],
    })
    plan.querySnapshots.push({
      queryId: 'south-query', queryText: 'south homes',
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })
    plan.assignments.push({
      targetKey: 'south-target', queryId: 'south-query', queryClass: 'non-brand', executionNodeKey: 'south-alias-node',
    })
    plan.executionNodes.push({
      stableKey: 'south-alias-node', queryId: 'south-query', queryText: 'south homes',
      context: { providers: ['openai'], models: {}, location: null }, expectedSnapshots: 1,
    })
    plan.usageEdges.push({ executionNodeKey: 'south-alias-node', targetKey: 'south-target', queryId: 'south-query' })
    seedVersion('multi_market_alias_plan', 1, plan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'multi_market_alias_plan', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values({
      id: 'multi_market_alias_run', projectId: 'project_northwind', kind: 'answer-visibility',
      status: 'completed', trigger: 'manual', measurementPlanVersionId: 'multi_market_alias_plan',
      location: null, createdAt: NOW,
    }).run()
    db.insert(queries).values({
      id: 'south-query', projectId: 'project_northwind', query: 'south homes', createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values([
      { ...marketSnapshot('north_alias', 'multi_market_alias_run', 'north-alias-node', 'Northwind and AlphaCo.', 'parentco.com'), model: 'north-model', location: 'North' },
      { ...marketSnapshot('south_alias', 'multi_market_alias_run', 'south-alias-node', 'Northwind and BetaCo.', 'parentco.com', NOW, 'south-query', 'south homes'), model: 'south-model', location: 'South' },
    ]).run()

    const response = await app.inject({
      method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets',
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().pinned).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'parentco.com', mentionCount: 2, citationCount: 2 }),
    ]))
    const grouped = await app.inject({
      method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets&groupBy=model',
    })
    const groups = competitorLandscapeResponseSchema.parse(grouped.json()).modelComparison!.groups
    expect(groups.map(group => [group.model, group.snapshotCount])).toEqual([['north-model', 1], ['south-model', 1]])
    for (const group of groups) {
      expect(group.pinned).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: 'parentco.com', mentionCount: 1, citationCount: 1 }),
      ]))
    }
    const selected = await app.inject({
      method: 'GET', url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets&groupBy=model&provider=openai&model=south-model&location=South&queryClass=non-brand',
    })
    expect(selected.json()).toMatchObject({
      evidence: { answeredResults: 1 },
      modelComparison: { totalGroups: 1, groups: [{ model: 'south-model', snapshotCount: 1 }] },
    })
  })

  it('scopes classes to Target usages when two markets share one execution', async () => {
    const plan = marketPlan('shared-class-node', 'market-rival.example', 'Market Rival')
    plan.assignments[0]!.queryClass = 'branded'
    plan.targets.push({ ...plan.targets[0]!, stableKey: 'other-target', label: 'Other Target' })
    plan.groups.push({ stableKey: 'southern', label: 'Southern', targetKeys: ['other-target'], competitors: [] })
    plan.assignments.push({ targetKey: 'other-target', queryId: 'market-query', queryClass: 'non-brand', executionNodeKey: 'shared-class-node' })
    plan.usageEdges.push({ targetKey: 'other-target', queryId: 'market-query', executionNodeKey: 'shared-class-node' })
    seedVersion('shared-class-plan', 1, plan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'shared-class-plan', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(runs).values({
      id: 'shared-class-run', projectId: 'project_northwind', kind: 'answer-visibility',
      status: 'completed', trigger: 'manual', measurementPlanVersionId: 'shared-class-plan', location: null, createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      ...marketSnapshot('shared-class-snapshot', 'shared-class-run', 'shared-class-node', 'Northwind and Rival.', 'rival.example'),
      model: 'shared-model',
    }).run()
    for (const [scope, queryClass, count] of [
      ['groupKey=regional', 'branded', 1], ['groupKey=regional', 'non-brand', 0],
      ['groupKey=southern', 'branded', 0], ['groupKey=southern', 'non-brand', 1],
      ['scope=all-markets', 'branded', 1], ['scope=all-markets', 'non-brand', 1], ['scope=all-markets', 'all', 1],
    ] as const) {
      const response = await app.inject({
        method: 'GET', url: `/api/v1/projects/northwind/analytics/competitors?window=all&${scope}&queryClass=${queryClass}&groupBy=model`,
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({
        evidence: { answeredResults: count },
        modelComparison: { totalGroups: count, groups: count === 0 ? [] : [{ model: 'shared-model', snapshotCount: 1 }] },
      })
    }
  })

  it('allows scoped read-only keys in Simple and Advanced scopes without changing stored evidence', async () => {
    const plan = marketPlan('reader-node', 'market-rival.example', 'Market Rival')
    seedVersion('reader-plan', 1, plan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind', activeVersionId: 'reader-plan', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.update(runs).set({ measurementPlanVersionId: 'reader-plan' }).where(eq(runs.id, 'run_normal')).run()
    db.update(querySnapshots).set({ model: 'reader-model', measurementExecutionId: 'reader-node' })
      .where(eq(querySnapshots.id, 'snapshot_answer')).run()
    db.insert(projects).values({
      id: 'project_foreign', name: 'foreign', displayName: 'Foreign', canonicalDomain: 'foreign.example',
      country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    const key = 'cnry_competitor_model_reader'
    db.insert(apiKeys).values({
      id: 'model-reader-key', name: 'Model reader', keyHash: hashApiKey(key), keyPrefix: key.slice(0, 9),
      scopes: ['read'], projectId: 'project_northwind', createdAt: NOW,
    }).run()
    await app.close()
    app = Fastify()
    app.register(apiRoutes, { db })
    await app.ready()
    const before = {
      snapshots: db.select().from(querySnapshots).all(),
      competitors: db.select().from(competitors).all(),
      classifications: db.select().from(domainClassifications).all(),
      versions: db.select().from(measurementPlanVersions).all(),
      drafts: db.select().from(measurementPlanDrafts).all(),
    }
    const headers = { authorization: `Bearer ${key}` }
    for (const scope of ['', '&groupKey=regional', '&scope=all-markets']) {
      const response = await app.inject({
        method: 'GET', headers,
        url: `/api/v1/projects/northwind/analytics/competitors?window=all&provider=openai&model=reader-model&groupBy=model${scope}`,
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ modelComparison: { totalGroups: 1, groups: [{ model: 'reader-model', snapshotCount: 1 }] } })
    }
    const foreign = await app.inject({
      method: 'GET', headers, url: '/api/v1/projects/foreign/analytics/competitors?window=all&groupBy=model',
    })
    expect(foreign.statusCode, foreign.body).toBe(403)
    expect({
      snapshots: db.select().from(querySnapshots).all(),
      competitors: db.select().from(competitors).all(),
      classifications: db.select().from(domainClassifications).all(),
      versions: db.select().from(measurementPlanVersions).all(),
      drafts: db.select().from(measurementPlanDrafts).all(),
    }).toEqual(before)
  })
})

function seedVersion(id: string, revision: number, plan: ReturnType<typeof marketPlan>) {
  db.insert(measurementPlanVersions).values({
    id,
    projectId: 'project_northwind',
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: `${String(revision).repeat(64)}`,
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
}

function marketPlan(nodeKey: string, competitorDomain: string, competitorLabel: string) {
  return measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: {
      projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] },
    },
    targets: [{
      stableKey: 'market-target',
      label: 'Market Target',
      aliases: ['Northwind'],
      urlMatchers: [{ kind: 'host', host: 'northwind.example' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [{
      stableKey: 'regional',
      label: 'Regional',
      targetKeys: ['market-target'],
      competitors: [{ stableKey: competitorDomain.replace('.', '-'), label: competitorLabel, domain: competitorDomain, aliases: [competitorLabel] }],
    }],
    querySnapshots: [{
      queryId: 'market-query',
      queryText: 'homes near northwind',
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    }],
    assignments: [{ targetKey: 'market-target', queryId: 'market-query', queryClass: 'non-brand', executionNodeKey: nodeKey }],
    executionNodes: [{
      stableKey: nodeKey,
      queryId: 'market-query',
      queryText: 'homes near northwind',
      context: { providers: ['openai'], models: {}, location: null },
      expectedSnapshots: 1,
    }],
    usageEdges: [{ executionNodeKey: nodeKey, targetKey: 'market-target', queryId: 'market-query' }],
    compiledChecksum: 'a'.repeat(64),
  })
}

function marketSnapshot(
  id: string,
  runId: string,
  measurementExecutionId: string | null,
  answerText: string,
  citedDomain: string,
  createdAt = NOW,
  queryId: string | null = 'market-query',
  queryText = 'homes near northwind',
) {
  return {
    id,
    runId,
    queryId,
    queryText,
    provider: 'openai',
    citationState: 'not-cited' as const,
    answerMentioned: true,
    answerText,
    citedDomains: [citedDomain],
    citedUrls: null,
    captureStatus: 'complete' as const,
    competitorOverlap: [],
    location: null,
    measurementExecutionId,
    createdAt,
  }
}
