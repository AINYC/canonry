import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  measurementPlanCompilePreviewResponseSchema,
  measurementPlanDiffPreviewResponseSchema,
  type MeasurementGroup,
  type MeasurementTarget,
  type MeasurementTargetQuerySelection,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlanVersions,
  measurementSegments,
  projects,
  migrate,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const ROOT_KEY = 'cnry_target_root'
const PLAN_KEY = 'cnry_target_plan'
const RUNS_KEY = 'cnry_target_runs'
const SCOPED_PLAN_KEY = 'cnry_target_scoped'
const READ_ONLY_KEY = 'cnry_target_read'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let tracked: Array<{ id: string; query: string }>

type TestPlan = {
  schemaVersion: 1
  targets: MeasurementTarget[]
  groups: MeasurementGroup[]
  targetQuerySelections: MeasurementTargetQuerySelection[]
}

function seedKey(name: string, token: string, scopes: string[], projectId?: string) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    projectId: projectId ?? null,
    createdAt: new Date().toISOString(),
  }).run()
}

function request(method: 'GET' | 'POST' | 'PUT', url: string, token = ROOT_KEY, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

function plan(overrides: Partial<TestPlan> = {}): TestPlan {
  return {
    schemaVersion: 1,
    targets: [
      {
        stableKey: 'chelsea',
        label: 'Chelsea',
        urls: [{ kind: 'prefix', host: 'www.example.com', pathPrefix: '/new-york/chelsea', pathCase: 'insensitive' }],
        aliases: ['Example Chelsea'],
        metadata: { borough: 'Manhattan' },
      },
      {
        stableKey: 'soho',
        label: 'SoHo',
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/new-york/soho', pathCase: 'sensitive' }],
        aliases: [],
      },
    ],
    groups: [{
      stableKey: 'nyc-portfolio',
      label: 'New York portfolio',
      targetKeys: ['chelsea'],
      competitors: ['RIVAL.COM'],
    }],
    targetQuerySelections: [
      { targetKey: 'chelsea', queryIds: [tracked[0]!.id, tracked[1]!.id] },
      { targetKey: 'soho', queryIds: [tracked[2]!.id], context: null },
    ],
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-target-plan-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('plan-writer', PLAN_KEY, ['measurement-plan.write'])
  seedKey('run-writer', RUNS_KEY, ['runs.write'])
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['gemini', 'openai'] })
  await app.ready()

  const created = await request('PUT', '/api/v1/projects/example', ROOT_KEY, {
    displayName: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    locations: [{ label: 'nyc', city: 'New York', region: 'NY', country: 'US' }],
    defaultLocation: 'nyc',
  })
  expect(created.statusCode).toBe(201)
  await request('POST', '/api/v1/projects/example/queries', ROOT_KEY, {
    queries: ['example chelsea reviews', 'best apartments in new york', 'best apartment operators'],
  })
  tracked = db.select({ id: queries.id, query: queries.query }).from(queries).all()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Target measurement-plan API', () => {
  it('enforces project scope and read-only access across the complete plan lifecycle', async () => {
    const ownProject = db.select().from(projects).where(eq(projects.name, 'example')).get()!
    seedKey('scoped-plan-writer', SCOPED_PLAN_KEY, ['measurement-plan.write'], ownProject.id)
    seedKey('scoped-reader', READ_ONLY_KEY, ['read'], ownProject.id)

    expect((await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())).statusCode).toBe(201)
    expect((await request('PUT', '/api/v1/projects/sibling', ROOT_KEY, {
      displayName: 'Sibling',
      canonicalDomain: 'sibling.example',
      country: 'US',
      language: 'en',
    })).statusCode).toBe(201)

    const foreignRequests: Array<Promise<{ statusCode: number }>> = [
      request('GET', '/api/v1/projects/sibling/measurement-plan', SCOPED_PLAN_KEY),
      request('POST', '/api/v1/projects/sibling/measurement-plan/compile-preview', SCOPED_PLAN_KEY, plan()),
      request('POST', '/api/v1/projects/sibling/measurement-plan/diff-preview', SCOPED_PLAN_KEY, plan()),
      request('PUT', '/api/v1/projects/sibling/measurement-plan', SCOPED_PLAN_KEY, plan()),
      request('POST', '/api/v1/projects/sibling/measurement-plan/segments/missing/retire', SCOPED_PLAN_KEY),
      request('GET', '/api/v1/projects/sibling/measurement-plan/versions', SCOPED_PLAN_KEY),
      request('GET', '/api/v1/projects/sibling/measurement-plan/versions/1', SCOPED_PLAN_KEY),
    ]
    for (const response of await Promise.all(foreignRequests)) expect(response.statusCode).toBe(403)

    expect((await request('GET', '/api/v1/projects/example/measurement-plan', READ_ONLY_KEY)).statusCode).toBe(200)
    expect((await request('GET', '/api/v1/projects/example/measurement-plan/versions', READ_ONLY_KEY)).statusCode).toBe(200)
    expect((await request('GET', '/api/v1/projects/example/measurement-plan/versions/1', READ_ONLY_KEY)).statusCode).toBe(200)
    const readOnlyWrites = [
      request('POST', '/api/v1/projects/example/measurement-plan/compile-preview', READ_ONLY_KEY, plan()),
      request('POST', '/api/v1/projects/example/measurement-plan/diff-preview', READ_ONLY_KEY, plan()),
      request('PUT', '/api/v1/projects/example/measurement-plan', READ_ONLY_KEY, plan()),
      request('POST', '/api/v1/projects/example/measurement-plan/segments/chelsea/retire', READ_ONLY_KEY),
    ]
    for (const response of await Promise.all(readOnlyWrites)) expect(response.statusCode).toBe(403)
  })

  it('returns planless state and keeps previews pure while requiring plan-write scope', async () => {
    const empty = await request('GET', '/api/v1/projects/example/measurement-plan')
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ active: null })

    const denied = await request('POST', '/api/v1/projects/example/measurement-plan/compile-preview', RUNS_KEY, plan())
    expect(denied.statusCode).toBe(403)

    const compiled = await request('POST', '/api/v1/projects/example/measurement-plan/compile-preview', PLAN_KEY, plan())
    expect(compiled.statusCode).toBe(200)
    expect(measurementPlanCompilePreviewResponseSchema.safeParse(compiled.json()).success).toBe(true)
    expect(compiled.json()).toMatchObject({
      ok: true,
      checks: [],
      usageEdges: { baseline: 3, target: 3 },
      estCostUsd: null,
      executionNodes: expect.arrayContaining([expect.objectContaining({ expectedSnapshots: 2 })]),
      plan: {
        defaultContext: { label: 'nyc' },
        targets: expect.arrayContaining([expect.objectContaining({ stableKey: 'chelsea' })]),
        warnings: [],
      },
      counts: {
        targets: 2,
        groups: 1,
        queries: 3,
        baselineEdges: 3,
        targetEdges: 3,
      },
    })
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(0)
    expect(db.select().from(measurementSegments).all()).toHaveLength(0)

    const diff = await request('POST', '/api/v1/projects/example/measurement-plan/diff-preview', PLAN_KEY, plan())
    expect(diff.statusCode).toBe(200)
    expect(measurementPlanDiffPreviewResponseSchema.safeParse(diff.json()).success).toBe(true)
    const diffBody = diff.json() as {
      warnings: unknown[]
      diff: { activeRevision: number | null; targets: { added: Array<{ stableKey: string }> }; execution: { counts: { before: unknown } } }
    }
    expect(diffBody.warnings).toEqual([])
    expect(diffBody.diff.activeRevision).toBeNull()
    expect(diffBody.diff.targets.added).toEqual(expect.arrayContaining([expect.objectContaining({ stableKey: 'chelsea' })]))
    expect(diffBody.diff.execution.counts.before).toBeNull()
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(0)
    expect(db.select().from(measurementSegments).all()).toHaveLength(0)
  })

  it('publishes a canonical Target/group revision idempotently and exposes active/history/show', async () => {
    const first = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, plan())
    expect(first.statusCode).toBe(201)
    const body = first.json() as { active: { revision: number; checksum: string; plan: Record<string, unknown> } }
    expect(body.active).toMatchObject({
      revision: 1,
      plan: {
        effectiveOwnedHosts: ['example.com'],
        projectBrandNames: ['Example'],
        targets: [expect.objectContaining({ stableKey: 'chelsea' }), expect.objectContaining({ stableKey: 'soho', mentionNotApplicable: true })],
        groups: [expect.objectContaining({ stableKey: 'nyc-portfolio', competitors: ['rival.com'] })],
        querySnapshots: expect.arrayContaining([expect.objectContaining({ queryId: tracked[0]!.id, queryText: tracked[0]!.query })]),
        executionNodes: expect.arrayContaining([expect.objectContaining({ expectedSnapshots: 2 })]),
        usageEdges: expect.not.arrayContaining([expect.objectContaining({ kind: 'group' })]),
      },
    })
    expect(body.active.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(db.select().from(measurementSegments).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stableKey: 'chelsea', kind: 'target' }),
      expect.objectContaining({ stableKey: 'nyc-portfolio', kind: 'group' }),
    ]))

    const repeat = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, plan())
    expect(repeat.statusCode).toBe(200)
    expect((repeat.json() as { active: { revision: number } }).active.revision).toBe(1)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)

    const changed = plan()
    changed.targets[0]!.metadata = { borough: 'Downtown Manhattan' }
    const second = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, changed)
    expect(second.statusCode).toBe(201)
    expect((second.json() as { active: { revision: number } }).active.revision).toBe(2)

    const active = await request('GET', '/api/v1/projects/example/measurement-plan')
    expect((active.json() as { active: { revision: number } }).active.revision).toBe(2)
    const versions = await request('GET', '/api/v1/projects/example/measurement-plan/versions')
    expect((versions.json() as { versions: Array<{ revision: number; active: boolean }> }).versions)
      .toEqual([
        expect.objectContaining({ revision: 2, active: true }),
        expect.objectContaining({ revision: 1, active: false }),
      ])
    const original = await request('GET', '/api/v1/projects/example/measurement-plan/versions/1')
    expect((original.json() as { version: { revision: number; active: boolean } }).version)
      .toMatchObject({ revision: 1, active: false })
  })

  it('returns a semantic Target/group/query-selection and execution diff without writing', async () => {
    await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())
    const next = plan()
    next.targets[0]!.label = 'Chelsea Heights'
    next.groups[0]!.label = 'Updated New York portfolio'
    next.targetQuerySelections[0]!.queryIds = [tracked[0]!.id]

    const response = await request('POST', '/api/v1/projects/example/measurement-plan/diff-preview', PLAN_KEY, next)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      diff: {
        activeRevision: 1,
        targets: { changed: [expect.objectContaining({ stableKey: 'chelsea' })] },
        groups: { changed: [expect.objectContaining({ stableKey: 'nyc-portfolio' })] },
        querySelections: { changed: [expect.objectContaining({ targetKey: 'chelsea' })] },
        execution: {
          counts: {
            before: expect.objectContaining({ targetEdges: 3 }),
            after: expect.objectContaining({ targetEdges: 2 }),
            delta: expect.objectContaining({ targetEdges: -1 }),
          },
        },
      },
    })
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
  })

  it('passes prefix-overlap warnings through previews and publication', async () => {
    const warningPlan = plan()
    warningPlan.targets[1]!.aliases = ['Example Chelsea Heights']

    const preview = await request('POST', '/api/v1/projects/example/measurement-plan/compile-preview', PLAN_KEY, warningPlan)
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      ok: true,
      checks: [expect.objectContaining({ id: 'target-alias-prefix-overlap', severity: 'warn' })],
      warnings: [expect.objectContaining({ code: 'target-alias-prefix-overlap' })],
    })

    const published = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, warningPlan)
    expect(published.statusCode).toBe(201)
    expect((published.json() as { active: { plan: { warnings: Array<{ code: string }> } } }).active.plan.warnings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'target-alias-prefix-overlap' })]))
  })

  it('returns typed preview checks for invalid plans while publication still rejects them', async () => {
    const brandCollision = plan()
    brandCollision.targets[0]!.aliases = ['Example']
    const brandPreview = await request('POST', '/api/v1/projects/example/measurement-plan/compile-preview', PLAN_KEY, brandCollision)
    expect(brandPreview.statusCode).toBe(200)
    expect(brandPreview.json()).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ id: 'target-alias-project-brand-collision', severity: 'fail' })],
      executionNodes: [],
      dedupSaved: 0,
      usageEdges: { baseline: 0, target: 0 },
      estCostUsd: null,
    })
    expect((brandPreview.json() as Record<string, unknown>).error).toBeUndefined()
    expect((await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, brandCollision)).statusCode).toBe(400)

    const unknownQuery = plan()
    unknownQuery.targetQuerySelections[0]!.queryIds = ['gone']
    const unknown = await request('POST', '/api/v1/projects/example/measurement-plan/compile-preview', PLAN_KEY, unknownQuery)
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json()).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ id: 'unknown-query', severity: 'fail', message: 'Unknown tracked query: gone' })],
    })
    const invalidDiff = await request('POST', '/api/v1/projects/example/measurement-plan/diff-preview', PLAN_KEY, unknownQuery)
    expect(invalidDiff.statusCode).toBe(200)
    expect(measurementPlanDiffPreviewResponseSchema.safeParse(invalidDiff.json()).success).toBe(true)
    expect(invalidDiff.json()).toMatchObject({ ok: false, diff: null })

    const unownedHost = plan()
    unownedHost.targets[0]!.urls = [{ kind: 'host', host: 'evil.test' }]
    const host = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, unownedHost)
    expect(host.statusCode).toBe(400)
    expect(JSON.stringify(host.json())).toContain('owned host')

    const invalidContext = plan()
    invalidContext.targetQuerySelections[0]!.context = { label: 'la', city: 'Los Angeles', region: 'CA', country: 'US' }
    const location = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, invalidContext)
    expect(location.statusCode).toBe(400)
    expect(JSON.stringify(location.json())).toContain('configured project location')
  })

  it('enforces one stable-key namespace and immutable Target/group kind', async () => {
    await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())
    const crossKind = plan({
      targets: [{
        stableKey: 'new-target',
        label: 'New target',
        urls: [{ kind: 'host', host: 'example.com' }],
        aliases: [],
      }],
      groups: [{
        stableKey: 'chelsea',
        label: 'Chelsea group',
        targetKeys: ['new-target'],
      }],
      targetQuerySelections: [],
    })

    const response = await request('PUT', '/api/v1/projects/example/measurement-plan', PLAN_KEY, crossKind)
    expect(response.statusCode).toBe(400)
    expect(JSON.stringify(response.json())).toContain('cannot change kind')
  })

  it('retires inactive Target/group keys from canonical active-plan content and prevents reuse', async () => {
    await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())
    const active = await request('POST', '/api/v1/projects/example/measurement-plan/segments/chelsea/retire', PLAN_KEY)
    expect(active.statusCode).toBe(400)
    expect(JSON.stringify(active.json())).toContain('active plan')

    const withoutChelsea = plan({
      targets: [plan().targets[1]!],
      groups: [],
      targetQuerySelections: [{ targetKey: 'soho', queryIds: [tracked[2]!.id], context: null }],
    })
    expect((await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, withoutChelsea)).statusCode).toBe(201)

    const retired = await request('POST', '/api/v1/projects/example/measurement-plan/segments/chelsea/retire', PLAN_KEY)
    expect(retired.statusCode).toBe(200)
    const first = retired.json() as { stableKey: string; retiredAt: string }
    expect(first).toMatchObject({ stableKey: 'chelsea' })
    expect(first.retiredAt).toContain('T')
    const repeated = await request('POST', '/api/v1/projects/example/measurement-plan/segments/chelsea/retire', PLAN_KEY)
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json()).toEqual(first)

    const reuse = await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())
    expect(reuse.statusCode).toBe(400)
    expect(JSON.stringify(reuse.json())).toContain('retired and cannot be reused')
  })

  it('retires an inactive Group idempotently and permanently reserves its key', async () => {
    await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())
    const active = await request('POST', '/api/v1/projects/example/measurement-plan/segments/nyc-portfolio/retire', PLAN_KEY)
    expect(active.statusCode).toBe(400)

    const withoutGroup = plan({ groups: [] })
    expect((await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, withoutGroup)).statusCode).toBe(201)

    const retired = await request('POST', '/api/v1/projects/example/measurement-plan/segments/nyc-portfolio/retire', PLAN_KEY)
    expect(retired.statusCode).toBe(200)
    const first = retired.json()
    expect(first).toMatchObject({ stableKey: 'nyc-portfolio' })
    expect((await request('POST', '/api/v1/projects/example/measurement-plan/segments/nyc-portfolio/retire', PLAN_KEY)).json()).toEqual(first)

    const reuse = await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())
    expect(reuse.statusCode).toBe(400)
    expect(JSON.stringify(reuse.json())).toContain('retired and cannot be reused')
  })

  it('does not register a cohort-run route or mutate ordinary run state', async () => {
    const project = db.select().from(projects).where(eq(projects.name, 'example')).get()!
    const ordinaryId = crypto.randomUUID()
    db.insert(runs).values({
      id: ordinaryId,
      projectId: project.id,
      kind: 'answer-visibility',
      status: 'queued',
      trigger: 'manual',
      location: null,
      queries: [tracked[0]!.query],
      measurementPlanVersionId: null,
      measurementManifest: null,
      createdAt: new Date().toISOString(),
    }).run()
    expect(db.select().from(runs).where(eq(runs.id, ordinaryId)).get()).toMatchObject({
      measurementPlanVersionId: null,
      measurementManifest: null,
    })

    expect((await request('PUT', '/api/v1/projects/example/measurement-plan', ROOT_KEY, plan())).statusCode).toBe(201)
    expect(db.select().from(runs).where(eq(runs.id, ordinaryId)).get()).toMatchObject({
      measurementPlanVersionId: null,
      measurementManifest: null,
    })
    const cohortRoute = await request('POST', '/api/v1/projects/example/cohorts/nyc/runs', ROOT_KEY)
    expect(cohortRoute.statusCode).toBe(404)
  })
})
