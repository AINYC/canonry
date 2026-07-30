import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createClient,
  gscPlatformDailyTotals,
  gscPlatformProperties,
  gscPlatformQueryDailyTotals,
  gscPlatformSearchData,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'

const listSitesMock = vi.fn()
vi.mock('@ainyc/canonry-integration-google', async () => ({
  ...(await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')),
  listSites: (...args: unknown[]) => listSitesMock(...args),
}))

const { googleRoutes } = await import('../src/google.js')

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-properties-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = '2026-07-30T00:00:00.000Z'
  for (const [id, name] of [['p1', 'one'], ['p2', 'two']]) db.insert(projects).values({ id, name, displayName: name, canonicalDomain: `${name}.example.com`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  const app = Fastify(); app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => error instanceof AppError ? reply.status(error.statusCode).send(error.toJSON()) : reply.send(error))
  const requested: Array<{ runId: string; projectId: string; sourceId: string }> = []
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: (domain) => ({ domain, connectionType: 'gsc' as const, propertyId: 'sc-domain:website.example', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now }),
      upsertConnection: (x) => x, updateConnection: () => undefined, deleteConnection: () => false,
    },
    googleStateSecret: 'test-secret',
    onGscPlatformSyncRequested: (runId, projectId, opts) => requested.push({ runId, projectId, sourceId: opts.sourceId }),
  })
  return { app, db, dir, requested }
}

beforeEach(() => { listSitesMock.mockReset(); listSitesMock.mockResolvedValue([{ siteUrl: '12345', permissionLevel: 'siteOwner' }]) })

describe('GSC platform properties routes', () => {
  test('requires exact authorization, upserts idempotently, and audits the mutation', async () => {
    const { app, db, dir } = makeApp(); await app.ready()
    try {
      listSitesMock.mockResolvedValueOnce([{ siteUrl: 'other', permissionLevel: 'siteOwner' }])
      expect((await app.inject({ method: 'PUT', url: '/projects/one/google/gsc/platform-properties', payload: { siteUrl: '12345', platform: 'youtube' } })).statusCode).toBe(400)
      listSitesMock.mockResolvedValueOnce([{ siteUrl: '12345', permissionLevel: 'siteUnverifiedUser' }])
      expect((await app.inject({ method: 'PUT', url: '/projects/one/google/gsc/platform-properties', payload: { siteUrl: '12345', platform: 'youtube' } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'PUT', url: '/projects/one/google/gsc/platform-properties', payload: { siteUrl: 'sc-domain:website.example', platform: 'youtube' } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'PUT', url: '/projects/one/google/gsc/platform-properties', payload: { siteUrl: '12345', platform: 'unsupported' } })).statusCode).toBe(400)
      const first = await app.inject({ method: 'PUT', url: '/projects/one/google/gsc/platform-properties', payload: { siteUrl: '12345', platform: 'youtube', displayName: 'Channel' } })
      expect(first.statusCode).toBe(200); const saved = first.json() as { id: string; permissionLevel: string; kind: string }
      expect(saved).toMatchObject({ permissionLevel: 'siteOwner', kind: 'social-video' })
      db.update(gscPlatformProperties).set({ status: 'error', lastError: 'old failure' }).where(eq(gscPlatformProperties.id, saved.id)).run()
      const second = await app.inject({ method: 'PUT', url: '/projects/one/google/gsc/platform-properties', payload: { siteUrl: '12345', platform: 'youtube', displayName: 'Renamed' } })
      expect(second.json()).toMatchObject({ id: saved.id, displayName: 'Renamed', status: 'active', lastError: null })
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-properties' })).json()).toMatchObject({ properties: [{ id: saved.id, displayName: 'Renamed' }] })
      expect(db.select().from(gscPlatformProperties).where(eq(gscPlatformProperties.projectId, 'p1')).all()).toHaveLength(1)
      expect(db.$client.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE project_id = 'p1'").get()).toEqual({ count: 2 })
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('rejects cross-project delete and sync, and persists the property as run sourceId', async () => {
    const { app, db, dir, requested } = makeApp(); await app.ready()
    try {
      db.insert(gscPlatformProperties).values({ id: 'owned-by-two', projectId: 'p2', siteUrl: '999', platform: 'youtube', kind: 'social-video', status: 'active', createdAt: 'x', updatedAt: 'x' }).run()
      expect((await app.inject({ method: 'DELETE', url: '/projects/one/google/gsc/platform-properties/owned-by-two' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: '/projects/one/google/gsc/platform-properties/owned-by-two/sync' })).statusCode).toBe(404)
      db.insert(gscPlatformProperties).values({ id: 'owned-by-one', projectId: 'p1', siteUrl: '12345', platform: 'youtube', kind: 'social-video', status: 'active', createdAt: 'x', updatedAt: 'x' }).run()
      const response = await app.inject({ method: 'POST', url: '/projects/one/google/gsc/platform-properties/owned-by-one/sync' })
      expect(response.statusCode).toBe(200); const run = response.json() as { id: string; sourceId: string }
      expect(run.sourceId).toBe('owned-by-one'); expect(requested).toEqual([{ runId: run.id, projectId: 'p1', sourceId: 'owned-by-one' }])
      const duplicate = await app.inject({ method: 'POST', url: '/projects/one/google/gsc/platform-properties/owned-by-one/sync' })
      expect(duplicate.json()).toMatchObject({ id: run.id, sourceId: 'owned-by-one' })
      expect(requested).toHaveLength(1)
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('computes weighted aggregates and applies dimensions, property filtering, and pagination', async () => {
    const { app, db, dir } = makeApp(); await app.ready()
    try {
      for (const id of ['a', 'b']) db.insert(gscPlatformProperties).values({ id, projectId: 'p1', siteUrl: id, platform: 'youtube', kind: 'social-video', status: 'active', createdAt: 'x', updatedAt: 'x' }).run()
      db.insert(runs).values({ id: 'r', projectId: 'p1', kind: 'gsc-sync', status: 'completed', trigger: 'manual', createdAt: 'x' }).run()
      const search = (id: string, propertyId: string, page: string, clicks: number, impressions: number, position: string) => db.insert(gscPlatformSearchData).values({ id, propertyId, projectId: 'p1', syncRunId: 'r', date: '2026-07-01', query: 'q', page, clicks, impressions, ctr: '0', position, createdAt: 'x' }).run()
      search('s1', 'a', 'one', 10, 100, '2'); search('s2', 'a', 'two', 5, 100, '6'); search('s3', 'b', 'three', 1, 10, '10')
      db.insert(gscPlatformDailyTotals).values({ id: 'd1', propertyId: 'a', projectId: 'p1', syncRunId: 'r', date: '2026-07-01', clicks: 20, impressions: 250, position: '5', createdAt: 'x' }).run()
      db.insert(gscPlatformDailyTotals).values({ id: 'd2', propertyId: 'b', projectId: 'p1', syncRunId: 'r', date: '2026-07-01', clicks: 2, impressions: 20, position: '8', createdAt: 'x' }).run()
      db.insert(gscPlatformQueryDailyTotals).values({ id: 'q1', propertyId: 'a', projectId: 'p1', syncRunId: 'r', date: '2026-07-01', query: 'query-one', clicks: 7, impressions: 70, position: '3', syncedAt: 'x', createdAt: 'x' }).run()
      const page = await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?propertyId=a&dimension=page&startDate=2026-07-01&endDate=2026-07-01&limit=1' })
      expect(page.statusCode).toBe(200); expect(page.json()).toMatchObject({ totals: { clicks: 20, impressions: 250, ctr: 0.08, position: 5 }, daily: [{ date: '2026-07-01', clicks: 20, impressions: 250, ctr: 0.08, position: 5 }], pagination: { limit: 1, offset: 0, hasMore: true } })
      expect((page.json() as { rows: unknown[] }).rows).toHaveLength(1)
      const query = await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?propertyId=a&dimension=query&startDate=2026-07-01&endDate=2026-07-01' })
      expect(query.json()).toMatchObject({ totals: { clicks: 20, impressions: 250, position: 5 }, rows: [{ value: 'query-one', dimension: 'query' }] })
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?dimension=invalid' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?window=invalid' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?startDate=not-a-date' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?startDate=2026-07-02&endDate=2026-07-01' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?limit=1row' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?limit=0' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?offset=-1' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?limit=999' })).json()).toMatchObject({ pagination: { limit: 500 } })
      const empty = await app.inject({ method: 'GET', url: '/projects/one/google/gsc/platform-performance?propertyId=a&startDate=2020-01-01&endDate=2020-01-02' })
      expect(empty.json()).toMatchObject({ totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, daily: [], rows: [] })
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
