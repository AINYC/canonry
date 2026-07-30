import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createClient,
  gscPlatformDailyTotals,
  gscPlatformProperties,
  gscPlatformQueryDailyTotals,
  gscPlatformSearchData,
  gscSearchData,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'

const fetchSearchAnalyticsMock = vi.fn()
const refreshAccessTokenMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>(
    '@ainyc/canonry-integration-google',
  )
  return {
    ...actual,
    fetchSearchAnalytics: (...args: unknown[]) => fetchSearchAnalyticsMock(...args),
    refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
  }
})

const { executeGscPlatformSync } = await import('../src/gsc-platform-sync.js')

const PROJECT_ID = 'project-1'
const DOMAIN = 'example.com'
const PROPERTY_ID = 'platform-1'
const SITE_URL = '12345'

function daysAgo(days: number): string {
  const value = new Date()
  value.setDate(value.getDate() - days)
  return value.toISOString().slice(0, 10)
}

function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gsc-platform-sync-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: PROJECT_ID,
    name: 'example',
    displayName: 'Example',
    canonicalDomain: DOMAIN,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(gscPlatformProperties).values([
    {
      id: PROPERTY_ID,
      projectId: PROJECT_ID,
      siteUrl: SITE_URL,
      displayName: 'Video channel',
      platform: 'youtube',
      kind: 'social-video',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'platform-2',
      projectId: PROJECT_ID,
      siteUrl: '67890',
      displayName: 'Social account',
      platform: 'instagram',
      kind: 'social-video',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ]).run()
  return { db, dir, now }
}

function seedRun(
  db: ReturnType<typeof createClient>,
  id: string,
  status: 'queued' | 'completed' = 'queued',
  sourceId = PROPERTY_ID,
) {
  db.insert(runs).values({
    id,
    projectId: PROJECT_ID,
    kind: 'gsc-sync',
    sourceId,
    status,
    trigger: 'manual',
    createdAt: new Date().toISOString(),
  }).run()
}

function config(): CanonryConfig {
  const now = new Date().toISOString()
  return {
    google: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connections: [{
        domain: DOMAIN,
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        createdAt: now,
        updatedAt: now,
      }],
    },
  } as unknown as CanonryConfig
}

beforeEach(() => {
  fetchSearchAnalyticsMock.mockReset()
  refreshAccessTokenMock.mockReset()
})

describe('executeGscPlatformSync', () => {
  test('replaces only the selected property window and leaves website and sibling data untouched', async () => {
    const { db, dir, now } = makeDatabase()
    try {
      const targetDate = daysAgo(5)
      seedRun(db, 'old-run', 'completed')
      seedRun(db, 'new-run')
      db.insert(gscPlatformSearchData).values([
        {
          id: 'old-selected',
          propertyId: PROPERTY_ID,
          projectId: PROJECT_ID,
          syncRunId: 'old-run',
          date: targetDate,
          query: 'old query',
          page: 'old page',
          clicks: 1,
          impressions: 10,
          ctr: '0.1',
          position: '9',
          createdAt: now,
        },
        {
          id: 'sibling',
          propertyId: 'platform-2',
          projectId: PROJECT_ID,
          syncRunId: 'old-run',
          date: targetDate,
          query: 'sibling query',
          page: 'sibling page',
          clicks: 2,
          impressions: 20,
          ctr: '0.1',
          position: '8',
          createdAt: now,
        },
      ]).run()
      db.insert(gscPlatformDailyTotals).values({
        id: 'old-daily',
        propertyId: PROPERTY_ID,
        projectId: PROJECT_ID,
        syncRunId: 'old-run',
        date: targetDate,
        clicks: 1,
        impressions: 10,
        position: '9',
        createdAt: now,
      }).run()
      db.insert(gscPlatformQueryDailyTotals).values({
        id: 'old-query',
        propertyId: PROPERTY_ID,
        projectId: PROJECT_ID,
        syncRunId: 'old-run',
        date: targetDate,
        query: 'old query',
        clicks: 1,
        impressions: 10,
        position: '9',
        syncedAt: now,
        createdAt: now,
      }).run()
      db.insert(gscSearchData).values({
        id: 'website-row',
        projectId: PROJECT_ID,
        syncRunId: 'old-run',
        date: targetDate,
        query: 'website query',
        page: 'https://example.com/page',
        clicks: 3,
        impressions: 30,
        ctr: '0.1',
        position: '7',
        createdAt: now,
      }).run()

      fetchSearchAnalyticsMock.mockImplementation(
        (_token: string, property: string, options: { dimensions?: string[] }) => {
          expect(property).toBe(SITE_URL)
          if (options.dimensions?.join(',') === 'date') {
            return Promise.resolve([{
              keys: [targetDate],
              clicks: 20,
              impressions: 250,
              ctr: 0.08,
              position: 5,
            }])
          }
          if (options.dimensions?.join(',') === 'date,query') {
            return Promise.resolve([{
              keys: [targetDate, 'new query'],
              clicks: 7,
              impressions: 70,
              ctr: 0.1,
              position: 3,
            }])
          }
          return Promise.resolve([{
            keys: [
              'new query',
              'https://youtube.com/watch?v=1',
              'usa',
              'MOBILE',
              targetDate,
            ],
            clicks: 15,
            impressions: 200,
            ctr: 0.075,
            position: 4,
          }])
        },
      )

      await executeGscPlatformSync(
        db,
        'new-run',
        PROJECT_ID,
        PROPERTY_ID,
        { config: config() },
      )

      expect(fetchSearchAnalyticsMock).toHaveBeenCalledTimes(3)
      expect(
        db.select().from(gscPlatformSearchData)
          .where(eq(gscPlatformSearchData.propertyId, PROPERTY_ID))
          .all(),
      ).toEqual([
        expect.objectContaining({
          syncRunId: 'new-run',
          query: 'new query',
          page: 'https://youtube.com/watch?v=1',
          clicks: 15,
          impressions: 200,
        }),
      ])
      expect(
        db.select().from(gscPlatformDailyTotals)
          .where(eq(gscPlatformDailyTotals.propertyId, PROPERTY_ID))
          .get(),
      ).toMatchObject({ syncRunId: 'new-run', clicks: 20, impressions: 250 })
      expect(
        db.select().from(gscPlatformQueryDailyTotals)
          .where(eq(gscPlatformQueryDailyTotals.propertyId, PROPERTY_ID))
          .get(),
      ).toMatchObject({ syncRunId: 'new-run', query: 'new query', clicks: 7 })
      expect(
        db.select().from(gscPlatformSearchData)
          .where(eq(gscPlatformSearchData.propertyId, 'platform-2'))
          .get(),
      ).toMatchObject({ id: 'sibling', query: 'sibling query' })
      expect(db.select().from(gscSearchData).where(eq(gscSearchData.id, 'website-row')).get())
        .toMatchObject({ query: 'website query' })
      expect(db.select().from(runs).where(eq(runs.id, 'new-run')).get())
        .toMatchObject({ status: 'completed', sourceId: PROPERTY_ID })
      expect(db.select().from(gscPlatformProperties).where(eq(gscPlatformProperties.id, PROPERTY_ID)).get())
        .toMatchObject({ status: 'active', lastError: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('preserves the previous window and marks the run and property when fetching fails', async () => {
    const { db, dir, now } = makeDatabase()
    try {
      const targetDate = daysAgo(5)
      seedRun(db, 'old-run', 'completed')
      seedRun(db, 'failed-run')
      db.insert(gscPlatformDailyTotals).values({
        id: 'previous-total',
        propertyId: PROPERTY_ID,
        projectId: PROJECT_ID,
        syncRunId: 'old-run',
        date: targetDate,
        clicks: 4,
        impressions: 40,
        position: '6',
        createdAt: now,
      }).run()
      fetchSearchAnalyticsMock.mockRejectedValueOnce(new Error('quota exceeded'))
      fetchSearchAnalyticsMock.mockResolvedValue([])

      await expect(executeGscPlatformSync(
        db,
        'failed-run',
        PROJECT_ID,
        PROPERTY_ID,
        { config: config() },
      )).rejects.toThrow('quota exceeded')

      expect(
        db.select().from(gscPlatformDailyTotals)
          .where(eq(gscPlatformDailyTotals.id, 'previous-total'))
          .get(),
      ).toMatchObject({ clicks: 4, impressions: 40 })
      expect(db.select().from(runs).where(eq(runs.id, 'failed-run')).get())
        .toMatchObject({ status: 'failed', error: 'quota exceeded' })
      expect(db.select().from(gscPlatformProperties).where(eq(gscPlatformProperties.id, PROPERTY_ID)).get())
        .toMatchObject({ status: 'error', lastError: 'quota exceeded' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects a callback whose property does not match the run source', async () => {
    const { db, dir } = makeDatabase()
    try {
      seedRun(db, 'mismatched-run', 'queued', 'platform-2')

      await expect(executeGscPlatformSync(
        db,
        'mismatched-run',
        PROJECT_ID,
        PROPERTY_ID,
        { config: config() },
      )).rejects.toThrow(/source/i)

      expect(fetchSearchAnalyticsMock).not.toHaveBeenCalled()
      expect(db.select().from(runs).where(eq(runs.id, 'mismatched-run')).get())
        .toMatchObject({ status: 'failed' })
      expect(db.select().from(gscPlatformProperties).where(eq(gscPlatformProperties.id, PROPERTY_ID)).get())
        .toMatchObject({ status: 'active', lastError: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
