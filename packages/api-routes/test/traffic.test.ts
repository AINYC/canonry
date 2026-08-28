import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  trafficSources,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  aiUserFetchEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  runs,
  auditLog,
  schedules,
} from '@ainyc/canonry-db'
import {
  TrafficSourceTypes,
  TrafficSourceStatuses,
  TrafficSourceAuthModes,
  SchedulableRunKinds,
  RunKinds,
  RunStatuses,
} from '@ainyc/canonry-contracts'
import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import type { CloudRunTrafficEventsPage } from '@ainyc/canonry-integration-cloud-run'
import type {
  ListWordpressTrafficEventsOptions,
  WordpressTrafficEventsPage,
} from '@ainyc/canonry-integration-wordpress-traffic'
import { WordpressTrafficApiError } from '@ainyc/canonry-integration-wordpress-traffic'
import type {
  ListVercelTrafficEventsOptions,
  VercelTrafficEventsPage,
} from '@ainyc/canonry-integration-vercel'
import { VercelLogsApiError } from '@ainyc/canonry-integration-vercel'
import { apiRoutes } from '../src/index.js'
import { tryClaimTrafficSyncLease } from '../src/traffic-sync-lease.js'
import type {
  CloudRunCredentialRecord,
  CloudRunCredentialStore,
  WordpressTrafficCredentialRecord,
  WordpressTrafficCredentialStore,
  VercelTrafficCredentialRecord,
  VercelTrafficCredentialStore,
  CloudflareTrafficCredentialRecord,
  CloudflareTrafficCredentialStore,
} from '../src/traffic.js'

function buildEvent(overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  const base: NormalizedTrafficRequest = {
    sourceType: 'cloud-run',
    evidenceKind: 'raw-request',
    confidence: 'observed',
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    observedAt: '2026-05-07T17:32:00.000Z',
    method: 'GET',
    requestUrl: 'https://example.com/blog/foo',
    host: 'example.com',
    path: '/blog/foo',
    queryString: null,
    status: 200,
    userAgent: 'GPTBot/1.0',
    remoteIp: '1.2.3.4',
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloud_run_revision', labels: {} },
    providerLabels: {},
  }
  return { ...base, ...overrides }
}

function buildWpEvent(overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return buildEvent({
    sourceType: 'wordpress',
    eventId: `wordpress:${overrides.observedAt ?? '2026-05-07T17:32:00.000Z'}:${Math.floor(Math.random() * 1_000_000)}`,
    providerResource: { type: 'wordpress_site', labels: { host: 'example.com' } },
    ...overrides,
  })
}

function buildVercelEvent(overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return buildEvent({
    sourceType: 'vercel',
    eventId: `vercel:${overrides.observedAt ?? '2026-05-07T17:32:00.000Z'}:${Math.floor(Math.random() * 1_000_000)}`,
    // The Vercel request-logs endpoint does not expose a client IP.
    remoteIp: null,
    providerResource: { type: 'vercel_deployment', labels: {} },
    ...overrides,
  })
}

function vercelRetentionError(): VercelLogsApiError {
  return new VercelLogsApiError(
    'Vercel request-logs endpoint returned HTTP 400',
    400,
    '{"error":{"name":"ExceedsBillingLimitError","message":"Requested window exceeds plan retention"}}',
  )
}

// Vercel `connect` seeds `lastSyncedAt = NOW` (the first-sync trap fix).
// Tests that need a non-zero sync window must backdate the row before
// triggering the sync; otherwise the drain short-circuits on a zero-width
// window and never exercises the pull. Use this helper instead of inlining
// the update so future first-sync tests can find the pattern.
function backdateLastSyncedAt(
  db: ReturnType<typeof createClient>,
  sourceId: string,
  ageMs: number,
): string {
  const stale = new Date(Date.now() - ageMs).toISOString()
  db.update(trafficSources)
    .set({ lastSyncedAt: stale })
    .where(eq(trafficSources.id, sourceId))
    .run()
  return stale
}

async function buildHarness(
  events: NormalizedTrafficRequest[],
  options: {
    bypassTimeFilter?: boolean
    /** Force the access-token resolver to fail with this message. */
    failResolveAccessTokenWith?: string
    /** Force the Cloud Run pull to fail with this message. */
    failPullWith?: string
    /** Mutate lifecycle state while a Cloud Run provider call is in flight. */
    onCloudRunPull?: () => void | Promise<void>
    /** Force the WordPress traffic pull (used for probe) to throw a `WordpressTrafficApiError`. */
    failWpProbeWith?: { status: number; message: string; body?: string }
    /** Force the WordPress traffic pull (used by sync) to throw an Error with this message. */
    failWpPullWith?: string
    /**
     * Programmable WordPress sync pull. When provided, replaces the default
     * empty-page probe stub for the WordPress pull function. Tests for WP
     * sync use this to model multi-page cursor pagination; the probe path
     * (limit=1, no cursor) is also routed through it.
     */
    wpPullPages?: (call: {
      cursor: string | undefined
      pageSize: number
      since: string | undefined
      until: string | undefined
    }) => WordpressTrafficEventsPage | Promise<WordpressTrafficEventsPage>
    /** Override the WordPress page cap to exercise a partial drain across syncs. */
    defaultWordpressMaxPages?: number
    /** Force the Vercel traffic pull (used for the connect probe) to throw a `VercelLogsApiError`. */
    failVercelProbeWith?: { status: number; message: string; body?: string }
    /** Force the Vercel traffic pull (used by sync / backfill) to throw an Error with this message. */
    failVercelPullWith?: string
    /**
     * Programmable Vercel sync / backfill pull. When provided, replaces the
     * default empty-page stub. The probe path (maxPages=1) is also routed
     * through it unless `failVercelProbeWith` is set. A test exercises the
     * hasMore-overflow path by returning `hasMore: true` from this callback.
     */
    vercelPullPages?: (call: {
      startDate: number
      endDate: number
      maxPages: number | undefined
      environment: string | undefined
    }) => VercelTrafficEventsPage
    /** Wall-clock budget (ms) for the Vercel sync drain. Tests set a tiny/zero value to exercise the deadline path. */
    vercelSyncDeadlineMs?: number
  } = {},
) {
  const trafficSyncedEvents: Array<unknown> = []
  const scheduleUpdates: Array<{ action: string; projectId: string; kind: string }> = []
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const credentials = new Map<string, CloudRunCredentialRecord>()
  const cloudRunCredentialStore: CloudRunCredentialStore = {
    getConnection: (projectName) => credentials.get(projectName),
    upsertConnection: (record) => {
      credentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => credentials.delete(projectName),
  }

  const wpCredentials = new Map<string, WordpressTrafficCredentialRecord>()
  const wordpressTrafficCredentialStore: WordpressTrafficCredentialStore = {
    getConnection: (projectName) => wpCredentials.get(projectName),
    upsertConnection: (record) => {
      wpCredentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => wpCredentials.delete(projectName),
  }

  const wpProbeInvocations: ListWordpressTrafficEventsOptions[] = []

  const vercelCredentials = new Map<string, VercelTrafficCredentialRecord>()
  const vercelTrafficCredentialStore: VercelTrafficCredentialStore = {
    getConnection: (projectName) => vercelCredentials.get(projectName),
    upsertConnection: (record) => {
      vercelCredentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => vercelCredentials.delete(projectName),
  }

  const vercelProbeInvocations: ListVercelTrafficEventsOptions[] = []

  const cloudflareCredentials = new Map<string, CloudflareTrafficCredentialRecord>()
  const cloudflareTrafficCredentialStore: CloudflareTrafficCredentialStore = {
    getConnection: (projectName) => cloudflareCredentials.get(projectName),
    getConnectionBySourceId: (sourceId) => {
      for (const record of cloudflareCredentials.values()) {
        if (record.sourceId === sourceId) return record
      }
      return undefined
    },
    upsertConnection: (record) => {
      cloudflareCredentials.set(record.projectName, record)
      return record
    },
    deleteConnection: (projectName) => cloudflareCredentials.delete(projectName),
  }

  let pullInvocations = 0
  const observedWindows: Array<{ startTime: string; endTime: string }> = []
  const observedFirstSync: Array<boolean | undefined> = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    cloudRunCredentialStore,
    pullCloudRunEvents: async (_token, pullOptions): Promise<CloudRunTrafficEventsPage> => {
      pullInvocations += 1
      await options.onCloudRunPull?.()
      observedWindows.push({ startTime: pullOptions.startTime, endTime: pullOptions.endTime })
      observedFirstSync.push(pullOptions.firstSync)
      if (options.failPullWith) throw new Error(options.failPullWith)
      // Default: mirror Cloud Logging's behavior and only return events inside the
      // requested window. Tests that exercise cross-sync boundary semantics
      // (where Cloud Logging may legitimately re-return the same event in two
      // adjacent pulls) opt out via `bypassTimeFilter`.
      const filtered = options.bypassTimeFilter
        ? events.slice()
        : events.filter((e) => {
          const t = new Date(e.observedAt).getTime()
          return t >= new Date(pullOptions.startTime).getTime()
            && t <= new Date(pullOptions.endTime).getTime()
        })
      return {
        events: filtered,
        rawEntryCount: filtered.length,
        skippedEntryCount: 0,
        nextPageToken: undefined,
        filter: 'mock',
      }
    },
    resolveCloudRunAccessToken: async () => {
      if (options.failResolveAccessTokenWith) throw new Error(options.failResolveAccessTokenWith)
      return 'mock-access-token'
    },
    wordpressTrafficCredentialStore,
    defaultWordpressMaxPages: options.defaultWordpressMaxPages,
    pullWordpressTrafficEvents: async (pullOptions): Promise<WordpressTrafficEventsPage> => {
      wpProbeInvocations.push(pullOptions)
      // Probe path: connect-route calls with pageSize=1, maxPages=1 — surface
      // the probe-failure injection here so the connect-route test still
      // works the same way it did before WP sync existed.
      if (pullOptions.pageSize === 1 && options.failWpProbeWith) {
        throw new WordpressTrafficApiError(
          options.failWpProbeWith.message,
          options.failWpProbeWith.status,
          options.failWpProbeWith.body,
        )
      }
      // `failWpPullWith` simulates a sync-time failure. The connect route
      // uses pageSize=1 for its up-front probe — gate the injection on
      // pageSize !== 1 so the same harness can still connect successfully
      // before the sync fails.
      if (pullOptions.pageSize !== 1 && options.failWpPullWith) throw new Error(options.failWpPullWith)
      if (options.wpPullPages) {
        const page = await options.wpPullPages({
          cursor: pullOptions.cursor,
          pageSize: pullOptions.pageSize ?? 500,
          since: pullOptions.since,
          until: pullOptions.until,
        })
        return {
          ...page,
          endpoint: `${pullOptions.baseUrl}/wp-json/canonry/v1/events`,
        }
      }
      return {
        events: [],
        rawEntryCount: 0,
        skippedEntryCount: 0,
        nextCursor: undefined,
        hasMore: false,
        endpoint: `${pullOptions.baseUrl}/wp-json/canonry/v1/events`,
      }
    },
    vercelTrafficCredentialStore,
    pullVercelTrafficEvents: async (pullOptions): Promise<VercelTrafficEventsPage> => {
      vercelProbeInvocations.push(pullOptions)
      const toMs = (v: number | string | Date): number =>
        typeof v === 'number' ? v : new Date(v).getTime()
      // Probe path: connect-route + doctor validator call with maxPages=1 —
      // surface the probe-failure injection here so the connect-route test
      // works the same way the WordPress one does.
      if (pullOptions.maxPages === 1 && options.failVercelProbeWith) {
        throw new VercelLogsApiError(
          options.failVercelProbeWith.message,
          options.failVercelProbeWith.status,
          options.failVercelProbeWith.body,
        )
      }
      // `failVercelPullWith` simulates a sync/backfill-time failure. The
      // connect route uses maxPages=1 for its probe — gate the injection on
      // maxPages !== 1 so the harness can still connect successfully first.
      if (pullOptions.maxPages !== 1 && options.failVercelPullWith) {
        throw new Error(options.failVercelPullWith)
      }
      if (options.vercelPullPages) {
        const page = options.vercelPullPages({
          startDate: toMs(pullOptions.startDate),
          endDate: toMs(pullOptions.endDate),
          maxPages: pullOptions.maxPages,
          environment: pullOptions.environment,
        })
        return { ...page, endpoint: 'https://vercel.com/api/logs/request-logs' }
      }
      return {
        events: [],
        rawEntryCount: 0,
        skippedEntryCount: 0,
        hasMore: false,
        endpoint: 'https://vercel.com/api/logs/request-logs',
      }
    },
    vercelSyncDeadlineMs: options.vercelSyncDeadlineMs,
    cloudflareTrafficCredentialStore,
    cloudflareTrafficIngestUrl: 'https://canonry.test/api/v1/projects/{name}/traffic/cloudflare/ingest',
    onTrafficSynced: (event) => { trafficSyncedEvents.push(event) },
    onScheduleUpdated: (action, projectId, kind) => { scheduleUpdates.push({ action, projectId, kind }) },
  })
  await app.ready()

  // Seed a project
  await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/test-project',
    payload: {
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    },
  })

  return {
    app,
    db,
    credentials,
    wpCredentials,
    vercelCredentials,
    cloudflareCredentials,
    tmpDir,
    getPullCount: () => pullInvocations,
    getObservedWindows: () => observedWindows,
    getObservedFirstSync: () => observedFirstSync,
    getTrafficSyncedEvents: () => trafficSyncedEvents,
    getScheduleUpdates: () => scheduleUpdates,
    getWpProbeInvocations: () => wpProbeInvocations,
    getVercelProbeInvocations: () => vercelProbeInvocations,
    close: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

const SA_KEY = JSON.stringify({
  client_email: 'sa@openclaw-nyc.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----',
})

describe('traffic source cutover staging', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  it.each([
    {
      adapter: 'Cloud Run',
      path: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      body: { gcpProjectId: 'gcp-race', keyJson: SA_KEY },
      targetId: (body: Record<string, unknown>) => body.id as string,
      competingType: TrafficSourceTypes.vercel,
    },
    {
      adapter: 'WordPress',
      path: '/api/v1/projects/test-project/traffic/connect/wordpress',
      body: { baseUrl: 'https://8.8.8.8', username: 'race', applicationPassword: 'wp-secret' },
      targetId: (body: Record<string, unknown>) => body.id as string,
      competingType: TrafficSourceTypes.vercel,
    },
    {
      adapter: 'Vercel',
      path: '/api/v1/projects/test-project/traffic/connect/vercel',
      body: { projectId: 'prj_race', teamId: 'team_race', token: 'vercel-secret' },
      targetId: (body: Record<string, unknown>) => body.id as string,
      competingType: TrafficSourceTypes['cloud-run'],
    },
    {
      adapter: 'Cloudflare Queue',
      path: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      body: {
        deliveryMode: 'queue-pull', accountId: 'account_race', queueId: 'queue_race',
        queueName: 'canonry-race', retentionSeconds: 86_400, apiToken: 'queue-secret-token',
      },
      targetId: (body: Record<string, unknown>) => body.sourceId as string,
      competingType: TrafficSourceTypes.vercel,
    },
    {
      adapter: 'Cloudflare direct push',
      path: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      body: {},
      targetId: (body: Record<string, unknown>) => body.sourceId as string,
      competingType: TrafficSourceTypes.vercel,
    },
  ])('serializes $adapter authority selection with a competing connect', async ({
    path, body, targetId, competingType,
  }) => {
    const project = (await import('@ainyc/canonry-db')).projects
    const projectId = h.db.select().from(project).all()[0]!.id
    const competingSourceId = `race-authority-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const originalTransaction = h.db.transaction.bind(h.db)
    let injected = false
    h.db.transaction = ((callback, config) => {
      if (!injected) {
        injected = true
        originalTransaction((tx) => {
          tx.insert(trafficSources).values({
            id: competingSourceId,
            projectId,
            sourceType: competingType,
            displayName: 'Concurrent authority',
            status: TrafficSourceStatuses.connected,
            configJson: {},
            createdAt: now,
            updatedAt: now,
          }).run()
          tx.insert(schedules).values({
            id: crypto.randomUUID(),
            projectId,
            kind: SchedulableRunKinds['traffic-sync'],
            cronExpr: '0 * * * *',
            preset: null,
            timezone: 'UTC',
            enabled: false,
            providers: [],
            sourceId: competingSourceId,
            createdAt: now,
            updatedAt: now,
          }).run()
        }, { behavior: 'immediate' })
      }
      return originalTransaction(callback, config)
    }) as typeof h.db.transaction

    const connected = await h.app.inject({ method: 'POST', url: path, payload: body })

    expect(connected.statusCode, connected.payload).toBe(200)
    const connectedBody = JSON.parse(connected.payload) as Record<string, unknown>
    const connectedTargetId = targetId(connectedBody)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, connectedTargetId)).get()?.status)
      .toBe(TrafficSourceStatuses.paused)
    expect(h.db.select().from(trafficSources).all()
      .filter(row => row.status === TrafficSourceStatuses.connected)
      .map(row => row.id)).toEqual([competingSourceId])
    expect(h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).get())
      .toEqual(expect.objectContaining({ sourceId: competingSourceId, enabled: false }))
    expect(h.getScheduleUpdates()).toEqual([])
  })

  it('keeps Cloud Run, WordPress, and Vercel connects staged while Queue pull is active', async () => {
    const queue = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {
        deliveryMode: 'queue-pull',
        accountId: 'account_queue',
        queueId: 'queue_queue',
        queueName: 'canonry-traffic-queue',
        retentionSeconds: 86_400,
        apiToken: 'queue-secret-token',
      },
    })
    expect(queue.statusCode).toBe(200)
    const queueSourceId = JSON.parse(queue.payload).sourceId as string

    const connections = [
      {
        path: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        body: { gcpProjectId: 'gcp-staged', keyJson: SA_KEY },
      },
      {
        path: '/api/v1/projects/test-project/traffic/connect/wordpress',
        body: { baseUrl: 'https://8.8.8.8', username: 'staged', applicationPassword: 'wp-secret' },
      },
      {
        path: '/api/v1/projects/test-project/traffic/connect/vercel',
        body: { projectId: 'prj_staged', teamId: 'team_staged', token: 'vercel-secret' },
      },
    ] as const

    const stagedSourceIds: string[] = []
    for (const { path, body } of connections) {
      const first = await h.app.inject({ method: 'POST', url: path, payload: body })
      expect(first.statusCode, first.payload).toBe(200)
      expect(JSON.parse(first.payload).status).toBe(TrafficSourceStatuses.paused)
      stagedSourceIds.push(JSON.parse(first.payload).id as string)

      const reconnect = await h.app.inject({ method: 'POST', url: path, payload: body })
      expect(reconnect.statusCode).toBe(200)
      expect(JSON.parse(reconnect.payload).status).toBe(TrafficSourceStatuses.paused)
    }

    const rows = h.db.select().from(trafficSources).all()
    expect(rows.filter(row => row.status === TrafficSourceStatuses.connected).map(row => row.id)).toEqual([queueSourceId])
    expect(h.db.select().from(schedules).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: queueSourceId, enabled: true }),
    ]))

    for (const sourceId of stagedSourceIds) {
      const pausedSync = await h.app.inject({
        method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
      })
      expect(pausedSync.statusCode).toBe(400)
      const pausedBackfill = await h.app.inject({
        method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`, payload: {},
      })
      expect(pausedBackfill.statusCode).toBe(400)
    }

    const cloudRunCredential = h.credentials.get('test-project')!
    h.credentials.set('test-project', { ...cloudRunCredential, privateKey: '' })
    const invalidCloudRun = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[0]}/activate`,
    })
    expect(invalidCloudRun.statusCode).toBe(400)
    h.credentials.set('test-project', cloudRunCredential)

    const wpCredential = h.wpCredentials.get('test-project')!
    h.wpCredentials.set('test-project', { ...wpCredential, applicationPassword: '' })
    const invalidWordpress = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[1]}/activate`,
    })
    expect(invalidWordpress.statusCode).toBe(400)
    h.wpCredentials.set('test-project', wpCredential)

    const vercelCredential = h.vercelCredentials.get('test-project')!
    h.vercelCredentials.set('test-project', { ...vercelCredential, token: '' })
    const invalidVercel = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[2]}/activate`,
    })
    expect(invalidVercel.statusCode).toBe(400)
    h.vercelCredentials.set('test-project', vercelCredential)

    const resetStaged = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[0]}/reset`,
      payload: { advanceToNow: true },
    })
    expect(resetStaged.statusCode).toBe(400)

    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
      .where(eq(trafficSources.id, stagedSourceIds[0])).run()
    const resetErroredSibling = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[0]}/reset`,
      payload: { advanceToNow: true },
    })
    expect(resetErroredSibling.statusCode).toBe(400)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, stagedSourceIds[0])).get()?.status)
      .toBe(TrafficSourceStatuses.error)
    const blockedErroredSync = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[0]}/sync`,
      payload: {},
    })
    expect(blockedErroredSync.statusCode).toBe(400)
    const blockedErroredBackfill = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${stagedSourceIds[0]}/backfill`,
      payload: {},
    })
    expect(blockedErroredBackfill.statusCode).toBe(400)
    expect(h.getPullCount()).toBe(0)
    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.paused })
      .where(eq(trafficSources.id, stagedSourceIds[0])).run()

    for (const sourceId of stagedSourceIds) {
      const activated = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/activate`,
      })
      expect(activated.statusCode, activated.payload).toBe(200)
      expect(h.db.select().from(trafficSources).all()
        .filter(row => row.status === TrafficSourceStatuses.connected)
        .map(row => row.id)).toEqual([sourceId])
      expect(h.db.select().from(schedules).all()).toEqual([
        expect.objectContaining({ sourceId, enabled: true }),
      ])
    }

    const queueReactivated = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${queueSourceId}/activate`,
    })
    expect(queueReactivated.statusCode).toBe(200)
    expect(h.db.select().from(schedules).all()).toEqual([
      expect.objectContaining({ sourceId: queueSourceId, enabled: true }),
    ])
  })

  it('preserves a disabled traffic-sync schedule across Queue reconnect and activation', async () => {
    const queueBody = {
      deliveryMode: 'queue-pull',
      accountId: 'account_disabled',
      queueId: 'queue_disabled',
      queueName: 'canonry-disabled',
      retentionSeconds: 86_400,
      apiToken: 'queue-secret-token',
    } as const
    const queue = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queueBody,
    })
    const queueSourceId = JSON.parse(queue.payload).sourceId as string
    h.db.update(schedules).set({ enabled: false }).where(eq(schedules.kind, 'traffic-sync')).run()

    const reconnected = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/test-project/traffic/connect/cloudflare', payload: queueBody,
    })
    expect(reconnected.statusCode).toBe(200)
    expect(h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).get())
      .toEqual(expect.objectContaining({ sourceId: queueSourceId, enabled: false }))

    const cloudRun = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'gcp-disabled', keyJson: SA_KEY },
    })
    const cloudRunSourceId = JSON.parse(cloudRun.payload).id as string
    const activatedCloudRun = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${cloudRunSourceId}/activate`,
    })
    expect(activatedCloudRun.statusCode).toBe(200)
    const reactivatedQueue = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${queueSourceId}/activate`,
    })
    expect(reactivatedQueue.statusCode).toBe(200)
    expect(h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).get())
      .toEqual(expect.objectContaining({ sourceId: queueSourceId, enabled: false }))
  })

  it('rebinds an existing traffic-sync schedule when a pull adapter connects as authority', async () => {
    const queue = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {
        deliveryMode: 'queue-pull', accountId: 'account_stale', queueId: 'queue_stale',
        queueName: 'canonry-stale-binding', retentionSeconds: 86_400, apiToken: 'queue-secret-token',
      },
    })
    const queueSourceId = JSON.parse(queue.payload).sourceId as string
    h.db.update(schedules).set({ enabled: false }).where(eq(schedules.kind, 'traffic-sync')).run()
    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
      .where(eq(trafficSources.id, queueSourceId)).run()

    const connects = [
      {
        path: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        body: { gcpProjectId: 'gcp-authority', keyJson: SA_KEY },
      },
      {
        path: '/api/v1/projects/test-project/traffic/connect/wordpress',
        body: { baseUrl: 'https://8.8.8.8', username: 'authority', applicationPassword: 'wp-secret' },
      },
      {
        path: '/api/v1/projects/test-project/traffic/connect/vercel',
        body: { projectId: 'prj_authority', teamId: 'team_authority', token: 'vercel-secret' },
      },
    ] as const

    for (const { path, body } of connects) {
      const connected = await h.app.inject({ method: 'POST', url: path, payload: body })
      expect(connected.statusCode, connected.payload).toBe(200)
      const sourceId = JSON.parse(connected.payload).id as string
      expect(JSON.parse(connected.payload).status).toBe(TrafficSourceStatuses.connected)
      expect(h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).get())
        .toEqual(expect.objectContaining({ sourceId, enabled: false }))
      h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
        .where(eq(trafficSources.id, sourceId)).run()
    }
  })

  it('discards an in-flight pull when cutover pauses its source before commit', async () => {
    let sourceId = ''
    const liveHarness: { current?: Awaited<ReturnType<typeof buildHarness>> } = {}
    await h.close()
    h = await buildHarness([buildEvent()], {
      bypassTimeFilter: true,
      onCloudRunPull: () => {
        if (!sourceId || !liveHarness.current) return
        liveHarness.current.db.update(trafficSources).set({ status: TrafficSourceStatuses.paused })
          .where(eq(trafficSources.id, sourceId)).run()
      },
    })
    liveHarness.current = h
    const connected = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'gcp-racing', keyJson: SA_KEY },
    })
    sourceId = JSON.parse(connected.payload).id as string

    const sync = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })

    expect(sync.statusCode).toBe(400)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()?.status)
      .toBe(TrafficSourceStatuses.paused)
    expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
    expect(h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).get()?.status)
      .toBe(RunStatuses.failed)
  })

  it('preserves an operator reset that completes while a pull is in flight', async () => {
    let sourceId = ''
    let resetStatus = 0
    const liveHarness: { current?: Awaited<ReturnType<typeof buildHarness>> } = {}
    await h.close()
    h = await buildHarness([buildEvent()], {
      bypassTimeFilter: true,
      onCloudRunPull: async () => {
        if (!sourceId || !liveHarness.current) return
        const reset = await liveHarness.current.app.inject({
          method: 'POST',
          url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
          payload: { advanceToNow: true },
        })
        resetStatus = reset.statusCode
      },
    })
    liveHarness.current = h
    const connected = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'gcp-reset-racing', keyJson: SA_KEY },
    })
    sourceId = JSON.parse(connected.payload).id as string

    const sync = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`, payload: {},
    })
    const after = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!

    expect(resetStatus).toBe(200)
    expect(sync.statusCode).toBe(400)
    expect(after.status).toBe(TrafficSourceStatuses.connected)
    expect(after.lastSyncedAt).not.toBeNull()
    expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
    expect(h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).get()?.status)
      .toBe(RunStatuses.failed)
  })

  it('removes a stale pull schedule when direct-push becomes authoritative', async () => {
    const queue = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {
        deliveryMode: 'queue-pull',
        accountId: 'account-stale',
        queueId: 'queue-stale',
        queueName: 'canonry-stale',
        retentionSeconds: 86_400,
        apiToken: 'queue-secret-token',
      },
    })
    const queueSourceId = JSON.parse(queue.payload).sourceId as string
    h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
      .where(eq(trafficSources.id, queueSourceId)).run()

    const direct = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    const directSourceId = JSON.parse(direct.payload).sourceId as string

    expect(direct.statusCode).toBe(200)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, directSourceId)).get()?.status)
      .toBe(TrafficSourceStatuses.connected)
    expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, queueSourceId)).get()?.status)
      .toBe(TrafficSourceStatuses.error)
    expect(h.db.select().from(schedules).where(eq(schedules.kind, SchedulableRunKinds['traffic-sync'])).all())
      .toHaveLength(0)
    expect(h.getScheduleUpdates().filter(update => update.action === 'delete')).toHaveLength(1)

    const now = new Date().toISOString()
    h.db.insert(schedules).values({
      id: crypto.randomUUID(),
      projectId: h.db.select().from(trafficSources).where(eq(trafficSources.id, directSourceId)).get()!.projectId,
      kind: SchedulableRunKinds['traffic-sync'],
      cronExpr: '*/30 * * * *',
      preset: null,
      timezone: 'UTC',
      enabled: true,
      providers: [],
      sourceId: queueSourceId,
      createdAt: now,
      updatedAt: now,
    }).run()

    const reconnected = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
      payload: {},
    })
    expect(reconnected.statusCode).toBe(200)
    expect(h.db.select().from(schedules).where(eq(schedules.kind, SchedulableRunKinds['traffic-sync'])).all())
      .toHaveLength(0)
    expect(h.getScheduleUpdates().filter(update => update.action === 'delete')).toHaveLength(2)
  })
})

describe('POST /traffic/connect/cloud-run', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  it('rejects requests without gcpProjectId', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { keyJson: SA_KEY },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.message).toMatch(/gcpProjectId/)
  })

  it('rejects requests without keyJson', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.message).toMatch(/keyJson/)
  })

  it('rejects malformed keyJson', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: 'not-json' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error.message).toMatch(/Invalid JSON/i)
  })

  it('persists credentials and creates a connected source row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: {
        gcpProjectId: 'openclaw-nyc',
        serviceName: 'openclaw-nyc',
        location: 'us-east1',
        keyJson: SA_KEY,
      },
    })
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    expect(dto.sourceType).toBe(TrafficSourceTypes['cloud-run'])
    expect(dto.status).toBe(TrafficSourceStatuses.connected)
    expect(dto.config.gcpProjectId).toBe('openclaw-nyc')
    expect(dto.config.serviceName).toBe('openclaw-nyc')
    expect(dto.config.authMode).toBe(TrafficSourceAuthModes['service-account'])
    expect(dto.archivedAt).toBeNull()

    const stored = h.credentials.get('test-project')
    expect(stored).toBeDefined()
    expect(stored?.clientEmail).toBe('sa@openclaw-nyc.iam.gserviceaccount.com')
    expect(stored?.privateKey).toContain('PRIVATE KEY')

    const sourceRows = h.db.select().from(trafficSources).all()
    expect(sourceRows.length).toBe(1)
    expect(sourceRows[0].status).toBe(TrafficSourceStatuses.connected)
  })

  it('reuses the existing source row on reconnect rather than creating a duplicate', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'old-project', keyJson: SA_KEY },
    })

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'new-project', serviceName: 'new-svc', keyJson: SA_KEY },
    })

    expect(second.statusCode).toBe(200)
    const sources = h.db.select().from(trafficSources).all()
    expect(sources.length).toBe(1)
    const config = sources[0].configJson
    expect(config.gcpProjectId).toBe('new-project')
    expect(config.serviceName).toBe('new-svc')
  })
})

describe('POST /traffic/connect/wordpress', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  const validBody = {
    baseUrl: 'https://8.8.8.8',
    username: 'canonry-bot',
    applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
  }

  it('rejects requests with an invalid baseUrl', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, baseUrl: 'not-a-url' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects baseUrl that resolves to a private / metadata address (SSRF guard)', async () => {
    // The probe attaches Basic-auth credentials, so an API-key holder could
    // otherwise coerce the server into reaching its own metadata service or
    // sidecar admin endpoints. The SSRF helper rejects RFC1918, link-local
    // (including 169.254.169.254), and loopback by default.
    const blocked = [
      'http://169.254.169.254/wp-json/',        // AWS / GCP metadata
      'http://10.0.0.5/wp-json/',               // RFC1918
      'http://192.168.1.1/wp-json/',            // RFC1918
      'http://127.0.0.1/wp-json/',              // loopback
      'http://[::1]/wp-json/',                  // IPv6 loopback
    ]
    for (const baseUrl of blocked) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/wordpress',
        payload: { ...validBody, baseUrl },
      })
      expect(res.statusCode, `expected ${baseUrl} to be blocked`).toBe(400)
      const err = JSON.parse(res.payload)
      expect(err.error?.code).toBe('VALIDATION_ERROR')
      expect(err.error?.message).toMatch(/WordPress baseUrl rejected/i)
    }
    // The SSRF guard must run BEFORE pullWordpressEvents — no probe should have
    // happened for any of the blocked targets.
    expect(h.getWpProbeInvocations().length).toBe(0)
  })

  it('rejects requests with empty applicationPassword', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, applicationPassword: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('probes the plugin endpoint, persists credentials, and creates the source row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, displayName: 'Example WP' },
    })
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    expect(dto.sourceType).toBe(TrafficSourceTypes.wordpress)
    expect(dto.status).toBe(TrafficSourceStatuses.connected)
    expect(dto.displayName).toBe('Example WP')
    expect(dto.config.baseUrl).toBe('https://8.8.8.8')
    expect(dto.config.username).toBe('canonry-bot')
    // Application password must never leak into the row config; it lives in
    // ~/.canonry/config.yaml only.
    expect(dto.config.applicationPassword).toBeUndefined()

    // Probe ran once before any persistence.
    const probes = h.getWpProbeInvocations()
    expect(probes.length).toBe(1)
    expect(probes[0]!.baseUrl).toBe('https://8.8.8.8')
    expect(probes[0]!.pageSize).toBe(1)

    const stored = h.wpCredentials.get('test-project')
    expect(stored?.applicationPassword).toBe('xxxx xxxx xxxx xxxx xxxx xxxx')

    const sourceRows = h.db.select().from(trafficSources).all()
    expect(sourceRows.length).toBe(1)
    expect(sourceRows[0].sourceType).toBe(TrafficSourceTypes.wordpress)
  })

  it('returns 502 and persists nothing when the probe fails with bad credentials', async () => {
    await h.close()
    h = await buildHarness([], {
      failWpProbeWith: { status: 401, message: 'Unauthorized', body: 'bad password' },
    })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: validBody,
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.payload).error.message).toMatch(/HTTP 401/)
    // Probe ran but neither credential nor source row was written.
    expect(h.wpCredentials.get('test-project')).toBeUndefined()
    expect(h.db.select().from(trafficSources).all().length).toBe(0)
  })

  it('reuses the existing source row on reconnect rather than creating a duplicate', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: validBody,
    })
    expect(first.statusCode).toBe(200)
    const sourceId = JSON.parse(first.payload).id as string
    h.db.update(trafficSources).set({
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
      lastCursor: 'PRESERVE_CURSOR',
      wordpressPendingUntil: '2026-05-02T00:00:00.000Z',
      lastEventIds: ['wordpress:preserve:1'],
      skippedThroughAt: '2026-04-30T00:00:00.000Z',
    }).where(eq(trafficSources.id, sourceId)).run()
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: { ...validBody, baseUrl: 'https://8.8.8.8', username: 'new-bot' },
    })
    expect(second.statusCode).toBe(200)
    const sources = h.db.select().from(trafficSources).all()
    expect(sources.length).toBe(1)
    const config = sources[0].configJson
    expect(config.username).toBe('new-bot')
    expect(sources[0]).toMatchObject({
      id: sourceId,
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
      lastCursor: 'PRESERVE_CURSOR',
      wordpressPendingUntil: '2026-05-02T00:00:00.000Z',
      lastEventIds: ['wordpress:preserve:1'],
      skippedThroughAt: '2026-04-30T00:00:00.000Z',
    })
  })
})

describe('POST /traffic/connect/vercel', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => { h = await buildHarness([]) })
  afterEach(async () => { await h.close() })

  const validBody = {
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
  }

  it('rejects requests with an empty projectId', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, projectId: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects requests with an empty token', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, token: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects requests with an invalid environment', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, environment: 'staging' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('probes request-logs, persists the token, and creates the source row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, environment: 'preview', displayName: 'Example Vercel' },
    })
    expect(res.statusCode).toBe(200)
    const dto = JSON.parse(res.payload)
    expect(dto.sourceType).toBe(TrafficSourceTypes.vercel)
    expect(dto.status).toBe(TrafficSourceStatuses.connected)
    expect(dto.displayName).toBe('Example Vercel')
    expect(dto.config.projectId).toBe('prj_abc')
    expect(dto.config.teamId).toBe('team_xyz')
    expect(dto.config.environment).toBe('preview')
    // The API token must never leak into the row config; it lives in
    // ~/.canonry/config.yaml only.
    expect(dto.config.token).toBeUndefined()

    // Probe ran once (maxPages=1) before any persistence.
    const probes = h.getVercelProbeInvocations()
    expect(probes.length).toBe(1)
    expect(probes[0]!.projectId).toBe('prj_abc')
    expect(probes[0]!.maxPages).toBe(1)

    const stored = h.vercelCredentials.get('test-project')
    expect(stored?.token).toBe('vcp_test_token')
    expect(stored?.environment).toBe('preview')

    const sourceRows = h.db.select().from(trafficSources).all()
    expect(sourceRows.length).toBe(1)
    expect(sourceRows[0].sourceType).toBe(TrafficSourceTypes.vercel)
  })

  it('seeds lastSyncedAt to NOW so the first sync uses a tight window', async () => {
    // Regression: before this fix, lastSyncedAt was null on connect. The first
    // sync then read DEFAULT_SYNC_WINDOW_MINUTES (30 days) — which exceeds
    // Vercel's request-logs retention (~14d) and made the very first sync
    // throw a retention error, leaving the source permanently stuck.
    const before = Date.now()
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(200)
    const after = Date.now()

    const row = h.db.select().from(trafficSources).all()[0]!
    expect(row.lastSyncedAt).not.toBeNull()
    const seededMs = new Date(row.lastSyncedAt!).getTime()
    expect(seededMs).toBeGreaterThanOrEqual(before)
    expect(seededMs).toBeLessThanOrEqual(after)
  })

  it('defaults environment to production when omitted', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).config.environment).toBe('production')
    expect(h.vercelCredentials.get('test-project')?.environment).toBe('production')
  })

  it('returns 502 and persists nothing when the probe fails with a bad token', async () => {
    await h.close()
    h = await buildHarness([], {
      failVercelProbeWith: { status: 403, message: 'Forbidden', body: 'bad token' },
    })

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.payload).error.message).toMatch(/HTTP 403/)
    // Probe ran but neither credential nor source row was written.
    expect(h.vercelCredentials.get('test-project')).toBeUndefined()
    expect(h.db.select().from(trafficSources).all().length).toBe(0)
  })

  it('reuses the existing source row on reconnect rather than creating a duplicate', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, projectId: 'prj_new', teamId: 'team_new' },
    })
    expect(second.statusCode).toBe(200)
    const sources = h.db.select().from(trafficSources).all()
    expect(sources.length).toBe(1)
    const config = sources[0].configJson
    expect(config.projectId).toBe('prj_new')
    expect(config.teamId).toBe('team_new')
    // Credential record updated in place too.
    expect(h.vercelCredentials.get('test-project')?.projectId).toBe('prj_new')
  })

  it('auto-creates a traffic-sync schedule bound to the new source', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    expect(res.statusCode).toBe(200)
    const sourceId = JSON.parse(res.payload).id as string

    // Without this schedule the watermark never advances and the next sync
    // pulls an unbounded window — the trap this closes.
    const schedRows = h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).all()
    expect(schedRows).toHaveLength(1)
    const sched = schedRows[0]!
    expect(sched.cronExpr).toBe('*/30 * * * *')
    expect(sched.sourceId).toBe(sourceId)
    expect(sched.enabled).toBe(true)
    expect(sched.timezone).toBe('UTC')
  })

  it('registers the new schedule with the live scheduler via onScheduleUpdated', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    const trafficUpdate = h.getScheduleUpdates().find((u) => u.kind === 'traffic-sync')
    expect(trafficUpdate).toBeDefined()
    expect(trafficUpdate?.action).toBe('upsert')
  })

  it('does not create or re-register a second schedule on reconnect (idempotent)', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: validBody,
    })
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { ...validBody, projectId: 'prj_reconnect' },
    })
    expect(h.db.select().from(schedules).where(eq(schedules.kind, 'traffic-sync')).all()).toHaveLength(1)
    // onScheduleUpdated fires only on the first (creating) connect.
    expect(h.getScheduleUpdates().filter((u) => u.kind === 'traffic-sync')).toHaveLength(1)
  })
})

describe('POST /traffic/sources/:id/sync — Vercel', () => {
  it('never walks lastSyncedAt backward when the cursor moved ahead mid-sync', async () => {
    // The reset rewind race. A sync already in flight when the cursor is
    // advanced out from under it (an operator `--advance-to-now`, or a backfill
    // committing a later window) used to commit its OWN older window end and
    // silently undo that advance — the source resumed from the past and
    // re-walked ground that had been deliberately skipped. Backfill always
    // guarded this; the incremental path did not, so a reset only stuck if you
    // first disabled the schedule and drained the in-flight run by hand.
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)

      // Stand in for the advance that lands while this sync is mid-flight: the
      // stored watermark is already ahead of any window this sync can produce.
      const ahead = new Date(Date.now() + 60 * 60_000).toISOString()
      h.db.update(trafficSources)
        .set({ lastSyncedAt: ahead })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThanOrEqual(new Date(ahead).getTime())
    } finally {
      await h.app.close()
    }
  })

  const vercelConnectBody = {
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
  }

  async function connectVercel(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: vercelConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

  it('returns validationError pointing to `canonry traffic connect vercel` when no Vercel credential is stored', async () => {
    // Seed a Vercel traffic source row WITHOUT going through the connect
    // route, so the credential store stays empty. Sync must surface a helpful
    // 400 that points to the connect CLI rather than a 500.
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_vercel_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.vercel,
        displayName: 'orphan vercel',
        status: TrafficSourceStatuses.connected,
        configJson: { projectId: 'prj_abc', teamId: 'team_xyz', environment: 'production' },
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_vercel_orphan/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/canonry traffic connect vercel/)
      // The run row must not linger as 'running'.
      expect(h.db.select().from(runs).all().length).toBe(0)
    } finally {
      await h.close()
    }
  })

  it('drains the window, lands rollups, advances lastSyncedAt to windowEnd, and finalizes the run as completed', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildVercelEvent({ eventId: 'vercel:s:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildVercelEvent({ eventId: 'vercel:s:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
      buildVercelEvent({
        eventId: 'vercel:s:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const observedMaxPages: Array<number | undefined> = []
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        observedMaxPages.push(maxPages)
        // Probe call (maxPages=1) returns nothing; the real sync pull walks
        // the whole window in one drained page (hasMore=false).
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        return { events, rawEntryCount: 3, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // Connect seeds lastSyncedAt = NOW; widen the sync window past the
      // test events (which sit ~25-59 min in the past) so they're inside it.
      backdateLastSyncedAt(h.db, sourceId, 90 * 60_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      expect(body.pulledEvents).toBe(3)
      expect(body.crawlerHits).toBe(2)
      expect(body.aiReferralHits).toBe(1)
      expect(body.crawlerBucketRows).toBe(1)
      expect(body.aiReferralBucketRows).toBe(1)
      expect(body.sampleRows).toBe(3)
      expect(body.runId).toBeDefined()

      // The sync pull used the generous default page budget — not the
      // probe's maxPages=1.
      expect(observedMaxPages).toContain(50)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      // Time-window adapter — no opaque cursor is persisted.
      expect(sourceRow.lastCursor).toBeNull()
      expect(sourceRow.lastSyncedAt).toBeTruthy()
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThan(0)
      expect(sourceRow.lastError).toBeNull()
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
      expect(aiRows[0].sessionsOrHits).toBe(1)

      expect(h.db.select().from(rawEventSamples).all().length).toBe(3)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].kind).toBe(RunKinds['traffic-sync'])
      expect(runRows[0].status).toBe(RunStatuses.completed)
      expect(runRows[0].sourceId).toBe(sourceId)
    } finally {
      await h.close()
    }
  })

  it('drains a window that overflows the per-sub-window page budget via sub-windows', async () => {
    // The first (full-window) pull reports hasMore=true; the drain halves the
    // span and the narrower slices drain cleanly, so the sync succeeds
    // instead of failing wholesale.
    const observedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
    let pullCount = 0
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        pullCount += 1
        if (pullCount === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: true, endpoint: '' }
        }
        return {
          events: [buildVercelEvent({ eventId: `vercel:sub:${pullCount}`, userAgent: 'GPTBot/1.0', path: '/x', observedAt })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // Connect seeds lastSyncedAt = NOW; widen past the 2-day-old test
      // events so the drain has a window worth subdividing.
      backdateLastSyncedAt(h.db, sourceId, 3 * 86_400_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)
      // The drain made more than one sub-window pull to cover the window.
      expect(pullCount).toBeGreaterThan(1)

      // The cursor advanced and the sub-window events rolled up.
      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.lastSyncedAt).not.toBeNull()
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBeGreaterThan(0)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('samples-and-advances instead of wedging when a one-second slice is irreducibly dense', async () => {
    // Regression: a single second holding more log pages than even the floor
    // budget used to throw, failing the sync so lastSyncedAt never advanced and
    // the source re-failed forever on that second. The incremental sync is
    // additive, so it now ingests the sample, advances past the slice, and
    // stays healthy.
    const observedAt = new Date(Date.now() - 1_000).toISOString()
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages, startDate }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        // hasMore stays true at every span and page budget — the slice cannot be
        // drained and time cannot be sliced below the one-second floor.
        return {
          events: [buildVercelEvent({ eventId: `vercel:dense:${startDate}`, userAgent: 'GPTBot/1.0', path: '/x', observedAt })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: true,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // A tight ~3s window so the second-by-second advance stays well under the
      // sub-window cap (a wide window would hit maxSubWindows — a different path).
      const stale = backdateLastSyncedAt(h.db, sourceId, 3_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      // The source advanced past the dense second instead of wedging.
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)
      expect(sourceRow.lastError).toBeNull()
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThan(new Date(stale).getTime())

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('returns 502 and marks the run failed when the Vercel pull throws', async () => {
    const h = await buildHarness([], { failVercelPullWith: 'request-logs 500: gateway' })
    try {
      const sourceId = await connectVercel(h)
      const stale = backdateLastSyncedAt(h.db, sourceId, 60 * 60_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)
      expect(JSON.parse(syncRes.payload).error.message).toMatch(/Vercel pull failed/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // The failed sync must not advance lastSyncedAt past the value we set.
      expect(sourceRow.lastSyncedAt).toBe(stale)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.failed)
    } finally {
      await h.close()
    }
  })

  it('fails without advancing lastSyncedAt when Vercel retention cannot cover the requested sync window', async () => {
    let enforceRetention = false
    const retentionBoundaryMs = Date.now() - 10 * 60_000
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate }) => {
        if (enforceRetention && startDate < retentionBoundaryMs) {
          throw vercelRetentionError()
        }
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      // Backdate past the harness's retention boundary so the sync window
      // crosses retention and the drain hits the retention-clamp throw.
      const stale = backdateLastSyncedAt(h.db, sourceId, 48 * 60 * 60_000)
      enforceRetention = true

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)
      expect(JSON.parse(syncRes.payload).error.message).toMatch(/refusing to advance/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // The failed sync must not advance lastSyncedAt past the value we set.
      expect(sourceRow.lastSyncedAt).toBe(stale)
      expect(h.db.select().from(crawlerEventsHourly).all()).toEqual([])

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.failed)
    } finally {
      await h.close()
    }
  })

  it('fails the run (not eternal running) when the drain budget elapses before any sub-window completes', async () => {
    // Regression for the production wedge: a dense/slow window made the
    // synchronous drain run for many minutes, timing out the caller and leaving
    // the run stuck 'running'. A zero budget trips the deadline before the first
    // pull, so the drain makes no progress — the route must fail the run rather
    // than complete an empty window or orphan a 'running' row.
    const h = await buildHarness([], {
      vercelSyncDeadlineMs: 0,
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        // Never reached — the deadline trips before the first sub-window pull.
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: true, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      const stale = backdateLastSyncedAt(h.db, sourceId, 60 * 60_000)

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)
      expect(JSON.parse(syncRes.payload).error.message).toMatch(/drain budget without completing any sub-window/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // Zero progress → the watermark must not advance.
      expect(sourceRow.lastSyncedAt).toBe(stale)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].status).toBe(RunStatuses.failed)
    } finally {
      await h.close()
    }
  })

  it('caps a drifted sync window to the last 24h instead of pulling from the stale watermark', async () => {
    // A watermark that drifted days back (schedule paused/missing) must not make
    // the drain request a multi-day window. The start is clamped forward to the
    // cap; the skipped span is surfaced and the watermark still advances to ~now.
    const observedStarts: number[] = []
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate, maxPages }) => {
        if (maxPages !== 1) observedStarts.push(startDate)
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      backdateLastSyncedAt(h.db, sourceId, 5 * 86_400_000) // 5 days
      const beforeMs = Date.now()

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      // No real pull reached back past the 24h cap (with a minute of slack).
      expect(observedStarts.length).toBeGreaterThan(0)
      const earliestStart = Math.min(...observedStarts)
      expect(earliestStart).toBeGreaterThanOrEqual(beforeMs - 24 * 60 * 60_000 - 60_000)

      // The capped window drained and committed, advancing past the drift.
      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThanOrEqual(beforeMs)
      expect(sourceRow.status).toBe(TrafficSourceStatuses.connected)
      expect(sourceRow.lastError).toBeNull()
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/backfill — Vercel', () => {
  const vercelConnectBody = {
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
  }

  async function connectVercel(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: vercelConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

  // Helper that polls the run row until status moves off 'running' or
  // the timeout trips, so async tests don't depend on internal scheduling.
  async function waitForRunComplete(
    db: ReturnType<typeof createClient>,
    runId: string,
    timeoutMs = 2000,
  ): Promise<typeof runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (row && row.status !== RunStatuses.running) return row
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`)
  }

  it('returns runId + status=running synchronously, then pulls the window and replaces rollups', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildVercelEvent({ eventId: 'vercel:bf:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildVercelEvent({ eventId: 'vercel:bf:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
      buildVercelEvent({
        eventId: 'vercel:bf:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const observedWindows: Array<{ startDate: number; endDate: number; maxPages: number | undefined }> = []
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate, endDate, maxPages }) => {
        observedWindows.push({ startDate, endDate, maxPages })
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        const eventsInWindow = events.filter((event) => {
          const observedMs = new Date(event.observedAt).getTime()
          return observedMs >= startDate && observedMs < endDate
        })
        return {
          events: eventsInWindow,
          rawEntryCount: eventsInWindow.length,
          skippedEntryCount: 0,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      expect(submitted.status).toBe(RunStatuses.running)
      expect(submitted.runId).toBeDefined()
      expect(submitted.daysApplied).toBe(7)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(finalRun.trigger).toBe('backfill')
      expect(finalRun.kind).toBe(RunKinds['traffic-sync'])

      // The backfill drains the requested window in contiguous hour chunks,
      // each with the larger one-shot backfill page budget.
      const backfillCalls = observedWindows.filter((c) => c.maxPages !== 1)
      expect(backfillCalls.length).toBeGreaterThan(1)
      expect(backfillCalls.every((c) => c.maxPages === 1000)).toBe(true)
      expect(backfillCalls[0]!.startDate).toBe(new Date(submitted.windowStart).getTime())
      expect(backfillCalls.at(-1)!.endDate).toBe(new Date(submitted.windowEnd).getTime())
      for (let i = 1; i < backfillCalls.length; i += 1) {
        expect(backfillCalls[i]!.startDate).toBe(backfillCalls[i - 1]!.endDate)
      }

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].sessionsOrHits).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')

      expect(h.db.select().from(rawEventSamples).all().length).toBe(3)
    } finally {
      await h.close()
    }
  })

  it('drains a backfill window that overflows the per-sub-window budget via sub-windows', async () => {
    // The first (full-window) pull reports hasMore=true; the drain halves the
    // span so the backfill completes instead of failing wholesale.
    const observedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
    let pullCount = 0
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        pullCount += 1
        if (pullCount === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: true, endpoint: '' }
        }
        return {
          events: [buildVercelEvent({ eventId: `vercel:bf:${pullCount}`, userAgent: 'GPTBot/1.0', path: '/x', observedAt })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(pullCount).toBeGreaterThan(1)
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBeGreaterThan(0)
    } finally {
      await h.close()
    }
  })

  it('deduplicates Vercel backfill events repeated across hour chunk boundaries', async () => {
    const shared = buildVercelEvent({
      eventId: 'vercel:bf:shared-boundary',
      userAgent: 'GPTBot/1.0',
      path: '/chunk-boundary',
      observedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    })
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        return { events: [shared], rawEntryCount: 1, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 1 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(1)
      expect(h.db.select().from(rawEventSamples).all().length).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('fails the backfill without replacing rollups when Vercel retention cannot cover the requested window', async () => {
    let enforceRetention = false
    const retentionBoundaryMs = Date.now() - 10 * 60_000
    const h = await buildHarness([], {
      vercelPullPages: ({ startDate }) => {
        if (enforceRetention && startDate < retentionBoundaryMs) {
          throw vercelRetentionError()
        }
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      enforceRetention = true

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      // Capture the connect-time lastSyncedAt before the failed backfill so
      // we can assert it stays put.
      const connectSyncedAt = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
        .lastSyncedAt

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/refusing to advance/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // The failed backfill must not advance lastSyncedAt past the connect-time value.
      expect(sourceRow.lastSyncedAt).toBe(connectSyncedAt)
      expect(h.db.select().from(crawlerEventsHourly).all()).toEqual([])
      expect(h.db.select().from(rawEventSamples).all()).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('fails fast (loud, no rollup replace) on an irreducibly dense one-second slice', async () => {
    // Backfill is replace mode: a truncated sample must never overwrite a full
    // window's rollup. The drain runs with abortOnTruncation, so it throws on
    // the FIRST irreducible second — it does not sample-and-advance through the
    // rest of a 7-day window it will reject anyway (a few bisecting pulls, not
    // thousands).
    let pullCount = 0
    const h = await buildHarness([], {
      vercelPullPages: ({ maxPages }) => {
        if (maxPages === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, hasMore: false, endpoint: '' }
        }
        pullCount += 1
        return {
          events: [buildVercelEvent({ eventId: `vercel:bf:dense:${pullCount}`, userAgent: 'GPTBot/1.0', path: '/x' })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          hasMore: true,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectVercel(h)
      const connectSyncedAt = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
        .lastSyncedAt

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/holds more than 1000 pages and cannot be drained further/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      // No rollup was replaced and the cursor never advanced.
      expect(sourceRow.lastSyncedAt).toBe(connectSyncedAt)
      expect(h.db.select().from(crawlerEventsHourly).all()).toEqual([])
      expect(h.db.select().from(rawEventSamples).all()).toEqual([])
      // Fail-fast: bisecting one hour chunk down to the floor is a handful of
      // pulls — nowhere near the thousands a full sample-and-advance would make.
      expect(pullCount).toBeLessThan(50)
    } finally {
      await h.close()
    }
  })

  it('returns validationError pointing to `canonry traffic connect vercel` when no Vercel credential is stored', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_vercel_bf_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.vercel,
        displayName: 'orphan vercel',
        status: TrafficSourceStatuses.connected,
        configJson: { projectId: 'prj_abc', teamId: 'team_xyz', environment: 'production' },
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_vercel_bf_orphan/backfill',
        payload: { days: 7 },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/canonry traffic connect vercel/)
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/sync', () => {

  it('returns 404 when the source does not belong to the project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/no-such-source/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('errors when no credentials are stored for the project', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      h.db.insert(trafficSources).values({
        id: 'src_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'orphan',
        status: TrafficSourceStatuses.connected,
        configJson: { gcpProjectId: 'orphan-project', authMode: 'service-account' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_orphan/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/credential/i)
    } finally {
      await h.close()
    }
  })

  it('pulls events, classifies, writes hourly buckets + samples + a completed run', async () => {
    // Anchor events inside the 120-min sync window the test requests below,
    // and snap to the top of an hour so the two crawler hits land in the
    // same hourly bucket regardless of when the test runs.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      // Two crawler hits same hour same path → should accumulate to hits=2 in one bucket
      buildEvent({ userAgent: 'GPTBot/1.0', remoteIp: '20.171.207.34', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', remoteIp: '20.171.207.34', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      // One AI referral via UTM
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
      // One unclassified hit
      buildEvent({ userAgent: 'curl/7.x', path: '/anything', status: 404, observedAt: fromBase(32) }),
    ]

    const h = await buildHarness(events)
    try {
      // Connect first
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', serviceName: 'openclaw-nyc', location: 'us-east1', keyJson: SA_KEY },
      })
      expect(connectRes.statusCode).toBe(200)
      const sourceId = JSON.parse(connectRes.payload).id

      // Sync
      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      expect(body.pulledEvents).toBe(4)
      expect(body.selfTrafficExcluded).toBe(0)
      expect(body.crawlerHits).toBe(2)
      expect(body.aiReferralHits).toBe(1)
      expect(body.unknownHits).toBe(1)
      expect(body.crawlerBucketRows).toBe(1)
      expect(body.aiReferralBucketRows).toBe(1)
      expect(body.sampleRows).toBe(4)
      expect(body.runId).toBeDefined()

      // Crawler bucket accumulated hits=2
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')

      // AI referral bucket
      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
      expect(aiRows[0].sessionsOrHits).toBe(1)

      // Samples
      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(4)
      const types = samples.map((s) => s.eventType).sort()
      expect(types).toEqual(['ai_referral', 'crawler', 'crawler', 'unknown'])

      // Source updated
      const sources = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).all()
      expect(sources[0].lastSyncedAt).toBeTruthy()
      expect(sources[0].lastError).toBeNull()

      // Run row marked completed with kind=traffic-sync
      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].kind).toBe(RunKinds['traffic-sync'])
      expect(runRows[0].status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('prunes source-local stale samples and does not persist stale pull evidence', async () => {
    const expiredAt = new Date(Date.now() - 31 * 86_400_000).toISOString()
    const retainedAt = new Date(Date.now() - 60_000).toISOString()
    const h = await buildHarness([
      buildEvent({ eventId: 'expired-pull-event', observedAt: expiredAt, path: '/expired' }),
      buildEvent({ eventId: 'retained-pull-event', observedAt: retainedAt, path: '/retained' }),
    ], { bypassTimeFilter: true })
    try {
      const connected = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'retention-sync', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connected.payload).id as string
      const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      h.db.insert(rawEventSamples).values({
        id: 'expired-before-sync',
        projectId: source.projectId,
        sourceId,
        ts: expiredAt,
        eventType: 'unknown',
        pathNormalized: '/expired-existing',
        classifierDetailsJson: {},
        createdAt: new Date().toISOString(),
      }).run()

      const synced = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      expect(synced.statusCode).toBe(200)
      expect(JSON.parse(synced.payload)).toMatchObject({ pulledEvents: 2, sampleRows: 1 })
      expect(h.db.select().from(rawEventSamples).all().map(row => row.ts)).toEqual([retainedAt])
    } finally {
      await h.close()
    }
  })

  it('drops Canonry self-traffic before rollup and surfaces the count in the sync response', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      // Canonry's own AEO auditor crawling the client's sitemap — must not count.
      buildEvent({ userAgent: 'AINYC-AEO-Audit/1.0', path: '/sitemap.xml', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'AINYC-AEO-Audit/1.0', path: '/llms.txt', status: 200, observedAt: fromBase(2) }),
      // A real crawler + a real human visitor — these count.
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(10) }),
      buildEvent({ userAgent: 'Mozilla/5.0', path: '/', status: 200, observedAt: fromBase(15) }),
    ]

    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', serviceName: 'openclaw-nyc', location: 'us-east1', keyJson: SA_KEY },
      })
      expect(connectRes.statusCode).toBe(200)
      const sourceId = JSON.parse(connectRes.payload).id

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      // Two self-audit hits dropped; pulledEvents counts only the real crawler +
      // human, and the drop is surfaced (never silent).
      expect(body.selfTrafficExcluded).toBe(2)
      expect(body.pulledEvents).toBe(2)
      expect(body.crawlerHits).toBe(1)
      expect(body.unknownHits).toBe(1)

      // No self-audit UA leaked into the persisted sample tail.
      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(2)
      expect(samples.some((s) => s.userAgent === 'AINYC-AEO-Audit/1.0')).toBe(false)

      // Only the real crawler made it into the hourly bucket.
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')
    } finally {
      await h.close()
    }
  })

  it('advances lastSyncedAt to windowEnd (not finishedAt) so events in the processing gap survive into the next sync', async () => {
    // Regression: if lastSyncedAt rolled forward to the transaction's
    // finishedAt instead of the pull's windowEnd, then events with
    // observedAt in (windowEnd, finishedAt] would be lost forever — sync 1
    // didn't pull them (timestamp > endTime) and sync 2 would clamp past
    // them. Assert the cursor matches windowEnd exactly, and that a new
    // event at the boundary is picked up by the next sync.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ eventId: 'evt-1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      const firstWindow = h.getObservedWindows()[0]!

      const sourceAfterFirst = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
      expect(sourceAfterFirst.lastSyncedAt).toBe(firstWindow.endTime)

      // Inject a new event AT the boundary timestamp — observable only by
      // sync 2 if its windowStart equals sync 1's windowEnd.
      events.push(buildEvent({
        eventId: 'evt-boundary',
        userAgent: 'GPTBot/1.0',
        path: '/blog/boundary',
        status: 200,
        observedAt: firstWindow.endTime,
      }))

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(second.payload).pulledEvents).toBe(1)
      const paths = h.db
        .select()
        .from(crawlerEventsHourly)
        .all()
        .map((r) => r.pathNormalized)
        .sort()
      expect(paths).toEqual(['/blog/boundary', '/blog/foo'])
    } finally {
      await h.close()
    }
  })

  it('clamps windowStart to lastSyncedAt so overlapping syncs do not double-count', async () => {
    // Event sits inside the default sync window for the first sync. After
    // the first sync, lastSyncedAt is "now-ish", so the second sync's window
    // collapses to roughly [lastSyncedAt, now] and no longer covers the event.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(first.payload).pulledEvents).toBe(1)

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(second.payload).pulledEvents).toBe(0)

      const rows = h.db.select().from(crawlerEventsHourly).all()
      expect(rows.length).toBe(1)
      expect(rows[0].hits).toBe(1)

      // The second sync's startTime should have been clamped to the first sync's
      // lastSyncedAt — i.e. ≥ the first sync's endTime.
      const windows = h.getObservedWindows()
      expect(windows.length).toBe(2)
      expect(new Date(windows[1].startTime).getTime()).toBeGreaterThanOrEqual(
        new Date(windows[0].endTime).getTime(),
      )
    } finally {
      await h.close()
    }
  })

  it('flags the first sync to the Cloud Run pull and clears it on subsequent syncs', async () => {
    // The route signals "first-time backfill" via a semantic flag — the
    // adapter decides what pull strategy that implies (timestamp desc here,
    // larger budget tomorrow). Steady-state syncs reset the flag so the
    // adapter's incremental defaults apply.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })

      expect(h.getObservedFirstSync()).toEqual([true, false])
    } finally {
      await h.close()
    }
  })

  it('keeps firstSync=true after a failed first sync (lastSyncedAt still null)', async () => {
    // A first sync that fails before commit leaves `lastSyncedAt` null, so the
    // next attempt is still effectively the first sync and must keep the flag —
    // otherwise a busy site that fails once at boot would silently skip its
    // recent week on the retry.
    const h = await buildHarness([], { failPullWith: 'transient 503' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })

      expect(h.getObservedFirstSync()).toEqual([true, true])
    } finally {
      await h.close()
    }
  })

  it('dedupes by eventId across syncs when the boundary window re-returns the same event', async () => {
    // Cloud Logging can legitimately re-return events whose timestamp equals
    // the boundary lastSyncedAt second. Without insertId-based dedupe the
    // hourly rollup `hits + N` upsert would double-count those rows. We
    // bypass the harness's time-window filter to simulate that overlap and
    // assert the second sync drops the duplicate while accepting any genuinely
    // new event.
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const dup = buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt, eventId: 'cloud-run:dup-1' })
    const fresh = buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/bar', status: 200, observedAt, eventId: 'cloud-run:fresh-1' })

    const events: NormalizedTrafficRequest[] = [dup]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      // First sync ingests the duplicate event for the first time.
      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(first.payload).pulledEvents).toBe(1)

      // The dup event ID should be persisted on the source row.
      const afterFirst = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).all()
      expect(afterFirst[0].lastEventIds ?? []).toContain('cloud-run:dup-1')

      // Push a new event into the harness's array — Cloud Logging's
      // bypass-time-filter mock will now return [dup, fresh]. The deduper
      // must drop dup and only roll up fresh.
      events.push(fresh)

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      // Only the genuinely-new event made it past dedupe.
      expect(JSON.parse(second.payload).pulledEvents).toBe(1)

      // The crawler rollup should now have exactly two distinct (path) rows,
      // each with hits=1 — proves the dup was not double-counted.
      const rows = h.db.select().from(crawlerEventsHourly).all()
      const byPath = Object.fromEntries(rows.map((r) => [r.pathNormalized, r.hits]))
      expect(byPath['/blog/foo']).toBe(1)
      expect(byPath['/blog/bar']).toBe(1)

      // Third sync with no new events: expect zero ingested, zero new rows.
      const third = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(third.payload).pulledEvents).toBe(0)
      const finalRows = h.db.select().from(crawlerEventsHourly).all()
      expect(finalRows.length).toBe(2)
      expect(finalRows.find((r) => r.pathNormalized === '/blog/foo')?.hits).toBe(1)
      expect(finalRows.find((r) => r.pathNormalized === '/blog/bar')?.hits).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('caps lastEventIds at MAX_TRACKED_EVENT_IDS so the ring buffer cannot grow unbounded', async () => {
    // Generate many distinct events; assert the persisted ring buffer
    // stays bounded and contains the most-recent IDs.
    const N = 1100
    const baseMs = Date.now() - 60 * 60_000
    const events: NormalizedTrafficRequest[] = []
    for (let i = 0; i < N; i++) {
      events.push(buildEvent({
        userAgent: 'GPTBot/1.0',
        path: `/p/${i}`,
        status: 200,
        observedAt: new Date(baseMs + i * 1_000).toISOString(),
        eventId: `cloud-run:bulk:${i.toString().padStart(4, '0')}`,
      }))
    }
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })

      const rows = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).all()
      const persisted: string[] = rows[0].lastEventIds ?? []
      // Ring buffer must be bounded.
      expect(persisted.length).toBeLessThanOrEqual(1_000)
      expect(persisted.length).toBeGreaterThan(0)
      // Must keep the most-recent IDs (highest indices), not the oldest.
      expect(persisted).toContain('cloud-run:bulk:1099')
      expect(persisted).not.toContain('cloud-run:bulk:0000')
    } finally {
      await h.close()
    }
  })

  it('marks the source as error and the run as failed when the pull throws', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-routes-test-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const credentials = new Map<string, CloudRunCredentialRecord>()
    const cloudRunCredentialStore: CloudRunCredentialStore = {
      getConnection: (n) => credentials.get(n),
      upsertConnection: (r) => { credentials.set(r.projectName, r); return r },
      deleteConnection: (n) => credentials.delete(n),
    }

    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      cloudRunCredentialStore,
      pullCloudRunEvents: async () => {
        throw new Error('Cloud Logging boom')
      },
      resolveCloudRunAccessToken: async () => 'mock-token',
    })
    await app.ready()

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-project',
      payload: { displayName: 'Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })

    const connectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: {},
    })
    // Upstream pull failure surfaces as PROVIDER_ERROR (502) so CLI exit code is
    // 2 (system error → retry) rather than 1 (user error). The DB transaction
    // for the failed run + source must commit before the error is thrown.
    expect(syncRes.statusCode).toBe(502)
    expect(JSON.parse(syncRes.payload).error.code).toBe('PROVIDER_ERROR')

    const sourceRow = db.select().from(trafficSources).all()[0]
    expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
    expect(sourceRow.lastError).toMatch(/boom/)

    const runRow = db.select().from(runs).all()[0]
    expect(runRow.status).toBe(RunStatuses.failed)
    expect(runRow.error).toMatch(/boom/)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('marks the source as error and returns PROVIDER_ERROR (502) when access-token resolution fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-routes-test-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const credentials = new Map<string, CloudRunCredentialRecord>()
    const cloudRunCredentialStore: CloudRunCredentialStore = {
      getConnection: (n) => credentials.get(n),
      upsertConnection: (r) => { credentials.set(r.projectName, r); return r },
      deleteConnection: (n) => credentials.delete(n),
    }

    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      cloudRunCredentialStore,
      pullCloudRunEvents: async () => ({
        events: [], rawEntryCount: 0, skippedEntryCount: 0, nextPageToken: undefined, filter: 'mock',
      }),
      resolveCloudRunAccessToken: async () => {
        throw new Error('IAM signBlob denied')
      },
    })
    await app.ready()

    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-project',
      payload: { displayName: 'Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    const connectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: {},
    })
    expect(syncRes.statusCode).toBe(502)
    expect(JSON.parse(syncRes.payload).error.code).toBe('PROVIDER_ERROR')
    expect(JSON.parse(syncRes.payload).error.message).toMatch(/IAM signBlob denied/)

    const sourceRow = db.select().from(trafficSources).all()[0]
    expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
    const runRow = db.select().from(runs).all()[0]
    expect(runRow.status).toBe(RunStatuses.failed)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('fires onTrafficSynced with status=completed and aggregated counts on success', async () => {
    const observedAt = new Date(Date.now() - 30 * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/bar', status: 200, observedAt, eventId: 'evt-2' }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)

      const fired = h.getTrafficSyncedEvents()
      expect(fired.length).toBe(1)
      const ev = fired[0] as {
        status: string; sourceType: string; sourceId: string
        pulledEvents: number; crawlerHits: number; aiReferralHits: number
        durationMs: number; errorCode?: string
      }
      expect(ev.status).toBe('completed')
      expect(ev.sourceType).toBe('cloud-run')
      expect(ev.sourceId).toBe(sourceId)
      expect(ev.pulledEvents).toBe(2)
      expect(ev.crawlerHits).toBeGreaterThanOrEqual(2)
      expect(ev.aiReferralHits).toBe(0)
      expect(ev.durationMs).toBeGreaterThanOrEqual(0)
      expect(ev.errorCode).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('fires onTrafficSynced with status=failed and errorCode=PROVIDER_AUTH when token resolution fails', async () => {
    const h = await buildHarness([], { failResolveAccessTokenWith: 'invalid_grant' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)

      const fired = h.getTrafficSyncedEvents()
      expect(fired.length).toBe(1)
      const ev = fired[0] as {
        status: string; pulledEvents: number; errorCode?: string
      }
      expect(ev.status).toBe('failed')
      expect(ev.errorCode).toBe('PROVIDER_AUTH')
      expect(ev.pulledEvents).toBe(0)
    } finally {
      await h.close()
    }
  })

  it('fires onTrafficSynced with errorCode=PROVIDER_PULL when the pull throws', async () => {
    const h = await buildHarness([], { failPullWith: 'Cloud Logging 503 backend unavailable' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(502)

      const fired = h.getTrafficSyncedEvents()
      expect(fired.length).toBe(1)
      expect((fired[0] as { errorCode: string }).errorCode).toBe('PROVIDER_PULL')
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/sync — WordPress', () => {
  const wpConnectBody = {
    baseUrl: 'https://8.8.8.8',
    username: 'canonry-bot',
    applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
  }

  async function connectWp(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: wpConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

  it('returns validationError pointing to `canonry traffic connect wordpress` when no WP credential is stored', async () => {
    // Seed a WP traffic source row WITHOUT going through the connect route,
    // so the credential store stays empty. Sync must surface a helpful 400
    // that points to the connect CLI rather than a 500.
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_wp_orphan',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes.wordpress,
        displayName: 'orphan wp',
        status: TrafficSourceStatuses.connected,
        configJson: { baseUrl: 'https://example.com', username: 'bot' },
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/src_wp_orphan/sync',
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.payload)
      expect(body.error.message).toMatch(/canonry traffic connect wordpress/)
    } finally {
      await h.close()
    }
  })

  it('bounds every page of a WordPress drain, clears its terminal cursor, lands rollups, advances lastSyncedAt to windowEnd, and finalizes the run as completed', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    // Two pages of events, joined by cursor pagination. Page 1 returns
    // next_cursor=PAGE2; the terminal page returns next_cursor=null. Every
    // page must retain one fixed [since, until) window.
    const page1Events: NormalizedTrafficRequest[] = [
      buildWpEvent({ eventId: 'wordpress:p1:1', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildWpEvent({ eventId: 'wordpress:p1:2', userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(20) }),
    ]
    const page2Events: NormalizedTrafficRequest[] = [
      buildWpEvent({
        eventId: 'wordpress:p2:3',
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(35),
      }),
    ]

    const pullObservations: Array<{
      cursor: string | undefined
      pageSize: number
      since: string | undefined
      until: string | undefined
    }> = []
    const h = await buildHarness([], {
      wpPullPages: ({ cursor, pageSize, since, until }) => {
        pullObservations.push({ cursor, pageSize, since, until })
        if (cursor === undefined || cursor === '') {
          return { events: page1Events, rawEntryCount: 2, skippedEntryCount: 0, nextCursor: 'PAGE2', hasMore: true, endpoint: '' }
        }
        if (cursor === 'PAGE2') {
          return { events: page2Events, rawEntryCount: 1, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        throw new Error(`Unexpected cursor: ${cursor}`)
      },
    })
    try {
      const sourceId = await connectWp(h)
      const lowerBound = fromBase(0)
      h.db.update(trafficSources)
        .set({ lastSyncedAt: lowerBound })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(syncRes.statusCode).toBe(200)
      const body = JSON.parse(syncRes.payload)
      expect(body.pulledEvents).toBe(3)
      expect(body.crawlerHits).toBe(2)
      expect(body.aiReferralHits).toBe(1)
      expect(body.crawlerBucketRows).toBe(1)
      expect(body.aiReferralBucketRows).toBe(1)
      expect(body.sampleRows).toBe(3)
      expect(body.runId).toBeDefined()

      // The connect probe has pageSize=1 and no window. Both sync pages carry
      // the same half-open interval, including the cursor continuation.
      const syncPulls = pullObservations.filter((call) => call.pageSize !== 1)
      expect(syncPulls).toHaveLength(2)
      expect(syncPulls.map((call) => call.cursor)).toEqual([undefined, 'PAGE2'])
      for (const call of syncPulls) {
        expect(call.since).toBe(lowerBound)
        expect(call.until).toBe(syncPulls[0]!.until)
      }
      expect(new Date(syncPulls[0]!.until!).getTime()).toBeGreaterThan(new Date(lowerBound).getTime())

      // A terminal plugin page emits no cursor, so the source is now ready to
      // start its next bounded window at lastSyncedAt instead of replaying.
      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.lastCursor).toBeNull()

      // lastSyncedAt advances to windowEnd (which the WP path defines as the
      // sync start moment) — not finishedAt. Asserting it is set + valid ISO is
      // enough; the Cloud Run path's regression test covers the precise gap
      // semantics and the same code path is reused.
      expect(sourceRow.lastSyncedAt).toBeTruthy()
      expect(new Date(sourceRow.lastSyncedAt!).getTime()).toBeGreaterThan(0)
      expect(sourceRow.lastError).toBeNull()

      // Crawler + AI referral rollups land in the same way as Cloud Run.
      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)
      expect(crawlerRows[0].botId).toBe('openai-gptbot')

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
      expect(aiRows[0].sessionsOrHits).toBe(1)

      const samples = h.db.select().from(rawEventSamples).all()
      expect(samples.length).toBe(3)

      const runRows = h.db.select().from(runs).all()
      expect(runRows.length).toBe(1)
      expect(runRows[0].kind).toBe(RunKinds['traffic-sync'])
      expect(runRows[0].status).toBe(RunStatuses.completed)
      expect(runRows[0].sourceId).toBe(sourceId)
    } finally {
      await h.close()
    }
  })

  it('accepts a bodyless WordPress sync and completes its run', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectWp(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      const run = h.db.select().from(runs).where(eq(runs.id, body.runId)).get()
      expect(run).toMatchObject({ status: RunStatuses.completed, sourceId })
    } finally {
      await h.close()
    }
  })

  it('rejects a WordPress sync while its source lease is held', async () => {
    let syncPulls = 0
    const h = await buildHarness([], {
      wpPullPages: ({ pageSize }) => {
        if (pageSize === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        syncPulls += 1
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectWp(h)
      expect(tryClaimTrafficSyncLease({
        db: h.db,
        sourceId,
        owner: 'other-worker',
        now: new Date().toISOString(),
        ttlMs: 5 * 60_000,
      })).toBe(true)

      const concurrent = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(concurrent.statusCode).toBe(409)
      expect(JSON.parse(concurrent.payload).error.code).toBe('OPERATION_IN_PROGRESS')
      expect(syncPulls).toBe(0)
      expect(h.db.select().from(runs).all()).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('preserves the lower watermark while a capped WordPress drain resumes from its cursor', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)

    const syncCalls: Array<{
      cursor: string | undefined
      since: string | undefined
      until: string | undefined
    }> = []
    const h = await buildHarness([], {
      defaultWordpressMaxPages: 1,
      wpPullPages: ({ cursor, pageSize, since, until }) => {
        if (pageSize === 1) {
          // Connect probe. It must not affect the incremental drain state.
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        syncCalls.push({ cursor, since, until })
        if (cursor === undefined || cursor === '') {
          // First sync hits its one-page cap, retaining a continuation cursor.
          return {
            events: [buildWpEvent({ eventId: 'wordpress:r:1', path: '/r1', observedAt: new Date(baseTime.getTime() + 5 * 60_000).toISOString() })],
            rawEntryCount: 1,
            skippedEntryCount: 0,
            nextCursor: 'RESUME_HERE',
            hasMore: true,
            endpoint: '',
          }
        }
        if (cursor !== 'RESUME_HERE') throw new Error(`Unexpected cursor: ${cursor}`)
        // Second sync must use the same lower watermark and finishes the drain.
        return {
          events: [buildWpEvent({ eventId: 'wordpress:r:2', path: '/r2', observedAt: new Date(baseTime.getTime() + 10 * 60_000).toISOString() })],
          rawEntryCount: 1,
          skippedEntryCount: 0,
          nextCursor: undefined,
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectWp(h)
      const lowerBound = new Date(baseTime.getTime() - 5 * 60_000).toISOString()
      h.db.update(trafficSources)
        .set({ lastSyncedAt: lowerBound })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const firstSync = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(firstSync.statusCode).toBe(200)
      const firstRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(firstRow.lastCursor).toBe('RESUME_HERE')
      expect(firstRow.lastSyncedAt).toBe(lowerBound)
      expect(firstRow.wordpressPendingUntil).toBe(syncCalls[0]!.until)

      const secondSync = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(secondSync.statusCode).toBe(200)

      // The second sync resumes from the saved cursor using the exact reserved
      // window, rather than moving either boundary while the drain is open.
      expect(syncCalls.map((call) => call.cursor)).toEqual([undefined, 'RESUME_HERE'])
      expect(syncCalls.map((call) => call.since)).toEqual([lowerBound, lowerBound])
      expect(syncCalls.map((call) => call.until)).toEqual([syncCalls[0]!.until, syncCalls[0]!.until])
      expect(new Date(syncCalls[0]!.until!).getTime()).toBeGreaterThan(new Date(lowerBound).getTime())

      const secondRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(secondRow.lastCursor).toBeNull()
      expect(secondRow.wordpressPendingUntil).toBeNull()
      expect(secondRow.lastSyncedAt).toBe(syncCalls[0]!.until)
    } finally {
      await h.close()
    }
  })

  it('archives WordPress history and creates a fresh source when the endpoint changes', async () => {
    const syncCalls: Array<{ cursor: string | undefined; since: string | undefined; until: string | undefined }> = []
    const h = await buildHarness([], {
      defaultWordpressMaxPages: 1,
      wpPullPages: ({ cursor, pageSize, since, until }) => {
        if (pageSize === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        syncCalls.push({ cursor, since, until })
        return {
          events: [],
          rawEntryCount: 0,
          skippedEntryCount: 0,
          nextCursor: 'OLD_SITE_CURSOR',
          hasMore: true,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectWp(h)
      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(first.statusCode).toBe(200)
      h.db.update(trafficSources)
        .set({ lastEventIds: ['wordpress:old-site:1'], skippedThroughAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(trafficSources.id, sourceId))
        .run()
      const oldSource = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      const now = new Date().toISOString()
      const tsHour = new Date(now)
      tsHour.setUTCMinutes(0, 0, 0)
      h.db.insert(crawlerEventsHourly).values({
        projectId: oldSource.projectId,
        sourceId,
        tsHour: tsHour.toISOString(),
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/old-site',
        status: 200,
        hits: 3,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: now,
        updatedAt: now,
      }).run()
      h.db.insert(schedules).values({
        id: crypto.randomUUID(),
        projectId: oldSource.projectId,
        kind: SchedulableRunKinds['traffic-sync'],
        cronExpr: '*/30 * * * *',
        preset: null,
        timezone: 'UTC',
        enabled: false,
        providers: [],
        sourceId,
        createdAt: now,
        updatedAt: now,
      }).run()

      const reconnect = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/wordpress',
        payload: { ...wpConnectBody, baseUrl: 'https://1.1.1.1' },
      })
      expect(reconnect.statusCode).toBe(200)
      const replacementSourceId = JSON.parse(reconnect.payload).id as string
      expect(replacementSourceId).not.toBe(sourceId)

      const archived = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(archived.status).toBe(TrafficSourceStatuses.archived)
      expect(archived.archivedAt).toBeTruthy()
      expect(archived.configJson).toMatchObject({ baseUrl: wpConnectBody.baseUrl })
      expect(archived.lastCursor).toBe('OLD_SITE_CURSOR')
      expect(archived.lastEventIds).toEqual(['wordpress:old-site:1'])
      expect(archived.skippedThroughAt).toBe('2026-01-01T00:00:00.000Z')
      expect(h.db.select().from(crawlerEventsHourly).where(eq(crawlerEventsHourly.sourceId, sourceId)).get())
        .toMatchObject({ hits: 3, pathNormalized: '/old-site' })

      const replacement = h.db.select().from(trafficSources).where(eq(trafficSources.id, replacementSourceId)).get()!
      expect(replacement.configJson).toMatchObject({ baseUrl: 'https://1.1.1.1' })
      expect(replacement.lastSyncedAt).toBeNull()
      expect(replacement.lastCursor).toBeNull()
      expect(replacement.wordpressPendingUntil).toBeNull()
      expect(replacement.lastEventIds).toBeNull()
      expect(replacement.skippedThroughAt).toBeNull()
      expect(h.db.select().from(schedules).where(eq(schedules.kind, SchedulableRunKinds['traffic-sync'])).get())
        .toMatchObject({ sourceId: replacementSourceId, enabled: false })
      const next = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${replacementSourceId}/sync`,
        payload: {},
      })
      expect(next.statusCode).toBe(200)
      expect(syncCalls.map((call) => call.cursor)).toEqual([undefined, undefined])
      expect(
        new Date(syncCalls[1]!.until!).getTime() - new Date(syncCalls[1]!.since!).getTime(),
      ).toBe(365 * 24 * 60 * 60_000)
      expect(h.db.select().from(crawlerEventsHourly).where(eq(crawlerEventsHourly.sourceId, replacementSourceId)).all())
        .toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('reserves a first WordPress window before I/O and retries its exact 365-day bounds', async () => {
    const syncCalls: Array<{ since: string | undefined; until: string | undefined }> = []
    let failFirstSync = true
    const h = await buildHarness([], {
      wpPullPages: ({ pageSize, since, until }) => {
        if (pageSize === 1) {
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        syncCalls.push({ since, until })
        if (failFirstSync) throw new Error('temporary WordPress failure')
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectWp(h)

      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(first.statusCode).toBe(502)

      const reserved = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(reserved.lastCursor).toBeNull()
      expect(reserved.wordpressPendingUntil).toBe(syncCalls[0]!.until)
      expect(reserved.lastSyncedAt).toBe(syncCalls[0]!.since)
      expect(
        new Date(syncCalls[0]!.until!).getTime() - new Date(syncCalls[0]!.since!).getTime(),
      ).toBe(365 * 24 * 60 * 60_000)

      failFirstSync = false
      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(second.statusCode).toBe(200)
      expect(syncCalls).toEqual([
        { since: syncCalls[0]!.since, until: syncCalls[0]!.until },
        { since: syncCalls[0]!.since, until: syncCalls[0]!.until },
      ])

      const completed = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(completed.lastCursor).toBeNull()
      expect(completed.wordpressPendingUntil).toBeNull()
      expect(completed.lastSyncedAt).toBe(syncCalls[0]!.until)
    } finally {
      await h.close()
    }
  })

  it('fails closed for a legacy WordPress cursor that has no bounded pending window', async () => {
    const syncCalls: Array<{ pageSize: number }> = []
    const h = await buildHarness([], {
      wpPullPages: ({ pageSize }) => {
        syncCalls.push({ pageSize })
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectWp(h)
      const staleWatermark = new Date(Date.now() - 15 * 60_000).toISOString()
      h.db.update(trafficSources)
        .set({ lastSyncedAt: staleWatermark, lastCursor: 'legacy-cursor' })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/legacy continuation cursor/)
      expect(syncCalls.filter((call) => call.pageSize !== 1)).toHaveLength(0)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      expect(sourceRow.lastCursor).toBe('legacy-cursor')
      expect(sourceRow.lastSyncedAt).toBe(staleWatermark)
      expect(sourceRow.wordpressPendingUntil).toBeNull()
    } finally {
      await h.close()
    }
  })

  it('fails without advancing the watermark when WordPress claims more data without a continuation cursor', async () => {
    const h = await buildHarness([], {
      wpPullPages: ({ pageSize }) => {
        if (pageSize === 1) {
          // Connect probe.
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: true, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectWp(h)
      const lowerBound = new Date(Date.now() - 15 * 60_000).toISOString()
      h.db.update(trafficSources)
        .set({ lastSyncedAt: lowerBound })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(res.statusCode).toBe(502)
      expect(JSON.parse(res.payload).error.message).toMatch(/has_more without a new continuation cursor/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      expect(sourceRow.lastCursor).toBeNull()
      expect(sourceRow.lastSyncedAt).toBe(lowerBound)
      expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('marks the source as error and returns PROVIDER_ERROR (502) when the WP pull throws', async () => {
    const h = await buildHarness([], { failWpPullWith: 'WordPress endpoint 500: gateway' })
    try {
      const sourceId = await connectWp(h)

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(res.statusCode).toBe(502)
      const body = JSON.parse(res.payload)
      expect(body.error.code).toBe('PROVIDER_ERROR')
      expect(body.error.message).toMatch(/gateway/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(sourceRow.status).toBe(TrafficSourceStatuses.error)
      expect(sourceRow.lastError).toMatch(/gateway/)

      // No rollup writes should have happened — failing before commit.
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBe(0)
      expect(h.db.select().from(aiReferralEventsHourly).all().length).toBe(0)
      expect(h.db.select().from(rawEventSamples).all().length).toBe(0)

      const runRow = h.db.select().from(runs).where(eq(runs.sourceId, sourceId)).all()[0]
      expect(runRow.status).toBe(RunStatuses.failed)
      expect(runRow.error).toMatch(/gateway/)

      const fired = h.getTrafficSyncedEvents()
      const wpEvent = fired.find((e) => (e as { sourceType: string }).sourceType === 'wordpress') as { status: string; errorCode: string } | undefined
      expect(wpEvent?.status).toBe('failed')
      expect(wpEvent?.errorCode).toBe('PROVIDER_PULL')
    } finally {
      await h.close()
    }
  })

  it('dedupes by eventId across syncs when the boundary cursor re-returns the same event', async () => {
    // Plugin (or upstream caching) may re-emit the same event on the next page
    // boundary — the sync must drop it via the cross-sync ring buffer and avoid
    // double-counting. Mirrors the cloud-run dedupe test.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const dupEvent = buildWpEvent({
      eventId: 'wordpress:dup:1',
      userAgent: 'GPTBot/1.0',
      path: '/blog/foo',
      status: 200,
      observedAt: new Date(baseTime.getTime() + 5 * 60_000).toISOString(),
    })
    const freshEvent = buildWpEvent({
      eventId: 'wordpress:fresh:1',
      userAgent: 'GPTBot/1.0',
      path: '/blog/bar',
      status: 200,
      observedAt: new Date(baseTime.getTime() + 10 * 60_000).toISOString(),
    })

    let pullCall = 0
    const h = await buildHarness([], {
      wpPullPages: () => {
        pullCall += 1
        if (pullCall === 1) {
          // Probe — empty.
          return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
        }
        if (pullCall === 2) {
          // First sync: just the dup, single page, has_more=false.
          return { events: [dupEvent], rawEntryCount: 1, skippedEntryCount: 0, nextCursor: 'CURSOR_AFTER_FIRST', hasMore: false, endpoint: '' }
        }
        // Second sync: plugin re-emits dup AND emits the fresh event.
        return {
          events: [dupEvent, freshEvent],
          rawEntryCount: 2,
          skippedEntryCount: 0,
          nextCursor: 'CURSOR_AFTER_SECOND',
          hasMore: false,
          endpoint: '',
        }
      },
    })
    try {
      const sourceId = await connectWp(h)

      const first = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      expect(JSON.parse(first.payload).pulledEvents).toBe(1)

      const second = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: {},
      })
      // Only the genuinely new event made it past dedupe.
      expect(JSON.parse(second.payload).pulledEvents).toBe(1)

      const rows = h.db.select().from(crawlerEventsHourly).all()
      const byPath = Object.fromEntries(rows.map((r) => [r.pathNormalized, r.hits]))
      expect(byPath['/blog/foo']).toBe(1)
      expect(byPath['/blog/bar']).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/backfill', () => {
  // Helper that polls the run row until status moves off 'running' or
  // the timeout trips, so async tests don't depend on internal scheduling.
  async function waitForRunComplete(
    db: ReturnType<typeof createClient>,
    runId: string,
    timeoutMs = 2000,
  ): Promise<typeof runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = db.select().from(runs).where(eq(runs.id, runId)).get()
      if (row && row.status !== RunStatuses.running) return row
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`)
  }

  it('allows an errored source to retry when it has no connected sibling', async () => {
    const h = await buildHarness([])
    try {
      const connected = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'gcp-retry', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connected.payload).id as string
      h.db.update(trafficSources).set({ status: TrafficSourceStatuses.error })
        .where(eq(trafficSources.id, sourceId)).run()

      const submitted = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 1 },
      })

      expect(submitted.statusCode, submitted.payload).toBe(200)
      const finalRun = await waitForRunComplete(h.db, JSON.parse(submitted.payload).runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
    } finally {
      await h.close()
    }
  })

  it('discards an in-flight backfill when activation cuts over to a sibling source', async () => {
    let cloudRunSourceId = ''
    let queueSourceId = ''
    let activationStatus = 0
    const liveHarness: { current?: Awaited<ReturnType<typeof buildHarness>> } = {}
    const h = await buildHarness([buildEvent()], {
      bypassTimeFilter: true,
      onCloudRunPull: async () => {
        if (!cloudRunSourceId || !queueSourceId || !liveHarness.current) return
        const activated = await liveHarness.current.app.inject({
          method: 'POST',
          url: `/api/v1/projects/test-project/traffic/sources/${queueSourceId}/activate`,
        })
        activationStatus = activated.statusCode
      },
    })
    liveHarness.current = h
    try {
      const cloudRun = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'gcp-backfill-cutover', keyJson: SA_KEY },
      })
      cloudRunSourceId = JSON.parse(cloudRun.payload).id as string
      const queue = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloudflare',
        payload: {
          deliveryMode: 'queue-pull', accountId: 'account_cutover', queueId: 'queue_cutover',
          queueName: 'canonry-cutover', retentionSeconds: 86_400, apiToken: 'queue-secret-token',
        },
      })
      queueSourceId = JSON.parse(queue.payload).sourceId as string

      const submitted = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${cloudRunSourceId}/backfill`,
        payload: { days: 1 },
      })
      const finalRun = await waitForRunComplete(h.db, JSON.parse(submitted.payload).runId)

      expect(activationStatus).toBe(200)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/deactivated or reconfigured/)
      expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, cloudRunSourceId)).get()?.status)
        .toBe(TrafficSourceStatuses.paused)
      expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, queueSourceId)).get()?.status)
        .toBe(TrafficSourceStatuses.connected)
      expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('preserves a reset that advances the source while a backfill pull is in flight', async () => {
    let sourceId = ''
    let resetSyncedAt: string | null = null
    const liveHarness: { current?: Awaited<ReturnType<typeof buildHarness>> } = {}
    const h = await buildHarness([buildEvent()], {
      bypassTimeFilter: true,
      onCloudRunPull: async () => {
        if (!sourceId || !liveHarness.current) return
        const reset = await liveHarness.current.app.inject({
          method: 'POST',
          url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
          payload: { advanceToNow: true },
        })
        expect(reset.statusCode).toBe(200)
        resetSyncedAt = liveHarness.current.db.select().from(trafficSources)
          .where(eq(trafficSources.id, sourceId)).get()!.lastSyncedAt
      },
    })
    liveHarness.current = h
    try {
      const connected = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'gcp-backfill-reset', keyJson: SA_KEY },
      })
      sourceId = JSON.parse(connected.payload).id as string

      const submitted = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 1 },
      })
      const finalRun = await waitForRunComplete(h.db, JSON.parse(submitted.payload).runId)
      const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!

      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/deactivated or reconfigured/)
      expect(source.status).toBe(TrafficSourceStatuses.connected)
      expect(source.lastSyncedAt).toBe(resetSyncedAt)
      expect(h.db.select().from(crawlerEventsHourly).all()).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('returns runId + status=running synchronously, then replaces rollups in the window once the background task finishes', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(15) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(30),
      }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      // Synchronous response: just the run handle, no counts yet.
      expect(submitted.status).toBe(RunStatuses.running)
      expect(submitted.runId).toBeDefined()
      expect(submitted.daysApplied).toBe(7)
      expect(submitted.daysRequested).toBe(7)

      // Wait for the background task to complete, then assert state.
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)
      expect(finalRun.trigger).toBe('backfill')
      expect(finalRun.kind).toBe(RunKinds['traffic-sync'])

      const crawlerRows = h.db.select().from(crawlerEventsHourly).all()
      expect(crawlerRows.length).toBe(1)
      expect(crawlerRows[0].hits).toBe(2)

      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].sessionsOrHits).toBe(1)
      expect(aiRows[0].evidenceType).toBe('utm')
    } finally {
      await h.close()
    }
  })

  it('keeps 90-day backfill rollups but retains only 30 days of raw samples', async () => {
    const expiredAt = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const retainedAt = new Date(Date.now() - 29 * 86_400_000).toISOString()
    const h = await buildHarness([
      buildEvent({ eventId: 'expired-backfill-event', observedAt: expiredAt, path: '/expired' }),
      buildEvent({ eventId: 'retained-backfill-event', observedAt: retainedAt, path: '/retained' }),
    ])
    try {
      const connected = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'retention-backfill', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connected.payload).id as string

      const submitted = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 90 },
      })
      const body = JSON.parse(submitted.payload)
      expect(body.daysApplied).toBe(90)
      expect((await waitForRunComplete(h.db, body.runId, 5_000)).status)
        .toBe(RunStatuses.completed)

      expect(h.db.select().from(crawlerEventsHourly).all().reduce((sum, row) => sum + row.hits, 0))
        .toBe(2)
      expect(h.db.select().from(rawEventSamples).all().map(row => row.ts)).toEqual([retainedAt])
    } finally {
      await h.close()
    }
  })

  it('replaces existing buckets in the window rather than accumulating (no double-counting)', async () => {
    // Seed via a normal sync, then backfill the same window with the same
    // source events. Crawler hits must stay at 2, not 4.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()
    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(15) }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      // Initial sync — accumulates hits=2.
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      const afterSync = h.db.select().from(crawlerEventsHourly).all()
      expect(afterSync[0].hits).toBe(2)

      // Backfill the same window. Replace mode should reset to hits=2,
      // not add to existing for hits=4.
      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      await waitForRunComplete(h.db, submitted.runId)

      const afterBackfill = h.db.select().from(crawlerEventsHourly).all()
      expect(afterBackfill.length).toBe(1)
      expect(afterBackfill[0].hits).toBe(2)
    } finally {
      await h.close()
    }
  })

  it('caps days at MAX_BACKFILL_DAYS (30) when a larger value is requested', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 365 },
      })
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)
      expect(submitted.daysRequested).toBe(365)
      expect(submitted.daysApplied).toBe(90)
    } finally {
      await h.close()
    }
  })

  it('rejects non-positive days', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const zero = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 0 },
      })
      expect(zero.statusCode).toBe(400)
      const negative = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: -3 },
      })
      expect(negative.statusCode).toBe(400)
    } finally {
      await h.close()
    }
  })

  it('returns 404 when the source does not belong to the project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/sources/no-such/backfill',
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('does not roll lastSyncedAt backward when the existing cursor is ahead of windowEnd', async () => {
    // First, seed a source with a lastSyncedAt that's > windowEnd (future).
    // The backfill must keep the existing cursor, not reset it to the older
    // backfill window — otherwise next incremental sync would re-pull a gap.
    const events: NormalizedTrafficRequest[] = [
      buildEvent({
        userAgent: 'GPTBot/1.0',
        path: '/blog/foo',
        status: 200,
        observedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      // Manually advance lastSyncedAt to 1h in the future.
      const future = new Date(Date.now() + 60 * 60_000).toISOString()
      h.db
        .update(trafficSources)
        .set({ lastSyncedAt: future, updatedAt: future })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      const submitted = JSON.parse(submitRes.payload)
      await waitForRunComplete(h.db, submitted.runId)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()
      expect(sourceRow?.lastSyncedAt).toBe(future)
    } finally {
      await h.close()
    }
  })

  it('treats an empty Cloud Run pull as a no-op and preserves existing rollup data', async () => {
    // Misconfigured serviceName, transient permission glitch, or genuinely
    // quiet site → pull returns 0 events. Backfill must NOT delete the
    // existing rollup buckets in the window (otherwise a misconfigured
    // backfill silently wipes historical data).
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const source = JSON.parse(connectRes.payload)

      // Seed an existing crawler bucket inside what will become the backfill
      // window. If the empty-pull guard is wrong, this row gets deleted.
      const seedTime = new Date().toISOString()
      const seededHour = new Date(Date.now() - 2 * 60 * 60_000)
      seededHour.setUTCMinutes(0, 0, 0)
      h.db.insert(crawlerEventsHourly).values({
        projectId: source.projectId,
        sourceId: source.id,
        tsHour: seededHour.toISOString(),
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/blog/foo',
        status: 200,
        hits: 7,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: seedTime,
        updatedAt: seedTime,
      }).run()
      h.db.insert(rawEventSamples).values([
        {
          id: 'expired-empty-backfill-sample',
          projectId: source.projectId,
          sourceId: source.id,
          ts: new Date(Date.now() - 31 * 86_400_000).toISOString(),
          eventType: 'unknown',
          pathNormalized: '/expired',
          classifierDetailsJson: {},
          createdAt: seedTime,
        },
        {
          id: 'retained-empty-backfill-sample',
          projectId: source.projectId,
          sourceId: source.id,
          ts: new Date(Date.now() - 29 * 86_400_000).toISOString(),
          eventType: 'unknown',
          pathNormalized: '/retained',
          classifierDetailsJson: {},
          createdAt: seedTime,
        },
      ]).run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${source.id}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      const buckets = h.db.select().from(crawlerEventsHourly).all()
      expect(buckets.length).toBe(1)
      expect(buckets[0].hits).toBe(7)
      expect(h.db.select().from(rawEventSamples).all().map(row => row.id)).toEqual([
        'retained-empty-backfill-sample',
      ])
    } finally {
      await h.close()
    }
  })

  it('replaces the boundary-hour bucket cleanly when windowStart falls mid-hour', async () => {
    // Without hour-flooring, an existing bucket at floor(windowStart, hour)
    // has tsHour < raw windowStart so the delete misses it, but the new pull
    // re-emits a bucket at the same tsHour — the plain insert then trips the
    // composite primary key and rolls the whole transaction back.
    const now = Date.now()
    const rawWindowStart = new Date(now - 86_400_000) // matches days=1
    const boundaryHour = new Date(rawWindowStart)
    boundaryHour.setUTCMinutes(0, 0, 0)
    const boundaryHourIso = boundaryHour.toISOString()
    // New event sits inside the boundary hour, after raw windowStart.
    const eventInBoundaryHour = new Date(boundaryHour.getTime() + 35 * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({
        userAgent: 'GPTBot/1.0',
        path: '/blog/foo',
        status: 200,
        observedAt: eventInBoundaryHour,
      }),
    ]
    const h = await buildHarness(events, { bypassTimeFilter: true })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const source = JSON.parse(connectRes.payload)

      // Pre-seed an existing bucket at the boundary hour with the SAME
      // (bot, verification, path, status) tuple as what the new event
      // would produce — that's what triggers the PK conflict.
      const seedTime = new Date().toISOString()
      h.db.insert(crawlerEventsHourly).values({
        projectId: source.projectId,
        sourceId: source.id,
        tsHour: boundaryHourIso,
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/blog/foo',
        status: 200,
        hits: 5,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: seedTime,
        updatedAt: seedTime,
      }).run()

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${source.id}/backfill`,
        payload: { days: 1 },
      })
      const submitted = JSON.parse(submitRes.payload)
      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.completed)

      const buckets = h.db.select().from(crawlerEventsHourly).all()
      expect(buckets.length).toBe(1)
      expect(buckets[0].tsHour).toBe(boundaryHourIso)
      // Replaced (1), not the seeded 5 nor the additive 6.
      expect(buckets[0].hits).toBe(1)
    } finally {
      await h.close()
    }
  })

  it('marks the run as failed when the pull throws and surfaces lastError on the source', async () => {
    const h = await buildHarness([], { failPullWith: 'Cloud Logging 503' })
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const submitRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      // Async — synchronous response is still 200; the failure shows up
      // on the run row and traffic_sources.last_error.
      expect(submitRes.statusCode).toBe(200)
      const submitted = JSON.parse(submitRes.payload)

      const finalRun = await waitForRunComplete(h.db, submitted.runId)
      expect(finalRun.status).toBe(RunStatuses.failed)
      expect(finalRun.error).toMatch(/503/)

      const sourceRow = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()
      expect(sourceRow?.status).toBe(TrafficSourceStatuses.error)
      expect(sourceRow?.lastError).toMatch(/503/)
    } finally {
      await h.close()
    }
  })
})

describe('POST /traffic/sources/:id/backfill — WordPress', () => {
  const wpConnectBody = {
    baseUrl: 'https://8.8.8.8',
    username: 'canonry-bot',
    applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
  }

  async function connectWp(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: wpConnectBody,
    })
    if (res.statusCode !== 200) throw new Error(`connect failed: ${res.statusCode} ${res.payload}`)
    return JSON.parse(res.payload).id
  }

  it('rejects generic WordPress replace backfill before it pulls or alters rollups', async () => {
    let nonProbePulls = 0
    const h = await buildHarness([], {
      wpPullPages: ({ pageSize }) => {
        if (pageSize !== 1) nonProbePulls += 1
        return { events: [], rawEntryCount: 0, skippedEntryCount: 0, nextCursor: undefined, hasMore: false, endpoint: '' }
      },
    })
    try {
      const sourceId = await connectWp(h)
      const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      const now = new Date().toISOString()
      const tsHour = new Date(now)
      tsHour.setUTCMinutes(0, 0, 0)
      h.db.insert(crawlerEventsHourly).values({
        projectId: source.projectId,
        sourceId,
        tsHour: tsHour.toISOString(),
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified',
        pathNormalized: '/preserve',
        status: 200,
        hits: 7,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 7 },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/retained coverage is unproven/)
      expect(nonProbePulls).toBe(0)
      expect(h.db.select().from(runs).all()).toHaveLength(0)
      expect(h.db.select().from(crawlerEventsHourly).where(eq(crawlerEventsHourly.sourceId, sourceId)).get())
        .toMatchObject({ hits: 7, pathNormalized: '/preserve' })
    } finally {
      await h.close()
    }
  })

  it('keeps the WordPress backfill guard in force after reset', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectWp(h)
      const reset = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(reset.statusCode).toBe(200)
      expect(JSON.parse(reset.payload).skippedThroughAt).toBeTruthy()

      const backfill = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/backfill`,
        payload: { days: 30 },
      })
      expect(backfill.statusCode).toBe(400)
      expect(JSON.parse(backfill.payload).error.message).toMatch(/retention-aware repair/)
      expect(h.db.select().from(runs).all()).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

})

describe('GET /traffic/sources', () => {
  it('returns an empty list when no sources are connected', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({ sources: [] })
    } finally { await h.close() }
  })

  it('returns the connected source after connect', async () => {
    const h = await buildHarness([])
    try {
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.sources.length).toBe(1)
      expect(body.sources[0].sourceType).toBe(TrafficSourceTypes['cloud-run'])
      expect(body.sources[0].status).toBe(TrafficSourceStatuses.connected)
    } finally { await h.close() }
  })

  it('omits archived sources', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_archived',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'old',
        status: TrafficSourceStatuses.archived,
        archivedAt: now,
        configJson: {},
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).sources.length).toBe(0)
    } finally { await h.close() }
  })

  it('404s for an unknown project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/no-such/traffic/sources' })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })
})

describe('GET /traffic/sources/:id', () => {
  it('returns 404 when the source does not belong to the project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/sources/no-such' })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })

  it('returns the source detail with 24h totals after a sync', async () => {
    // Snap to top-of-hour inside a fresh window so all events count toward totals24h.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
    ]

    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.id).toBe(sourceId)
      expect(body.status).toBe(TrafficSourceStatuses.connected)
      expect(body.totals24h.crawlerHits).toBe(2)
      expect(body.totals24h.aiReferralHits).toBe(1)
      expect(body.totals24h.sampleCount).toBe(3)
      expect(body.latestRun).not.toBeNull()
      expect(body.latestRun.status).toBe(RunStatuses.completed)
    } finally { await h.close() }
  })

  /**
   * A Location-redirect referral row is a hop, not an arrival. `aiReferralHits`
   * keeps its full-count contract, so the split is what tells a surface which
   * part of it a visitor actually received.
   */
  it('splits referral hits into landed and redirected by status', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      const projectId = h.db.select().from(trafficSources)
        .where(eq(trafficSources.id, sourceId)).get()!.projectId
      const tsHour = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 13) + ':00:00.000Z'
      const now = new Date().toISOString()
      const base = {
        projectId, sourceId, tsHour, product: 'ChatGPT', operator: 'OpenAI',
        sourceDomain: 'chatgpt.com', evidenceType: 'utm', paidSessionsOrHits: 0,
        usersEstimated: null, createdAt: now, updatedAt: now,
      }
      h.db.insert(aiReferralEventsHourly).values([
        { ...base, landingPathNormalized: '/landed', status: 200, sessionsOrHits: 4, organicSessionsOrHits: 4 },
        { ...base, landingPathNormalized: '/hop', status: 301, sessionsOrHits: 90, organicSessionsOrHits: 90 },
        // A 304 is a served page view from cache, NOT a hop — it must land.
        { ...base, landingPathNormalized: '/cached', status: 304, sessionsOrHits: 3, organicSessionsOrHits: 3 },
        { ...base, landingPathNormalized: '/gone', status: 404, sessionsOrHits: 6, organicSessionsOrHits: 6 },
        // A static-subresource 200 is neither a session (not a visit) nor a
        // redirect hop (nothing bounced). It lives only in the full count.
        { ...base, landingPathNormalized: '/favicon.ico', status: 200, sessionsOrHits: 7, organicSessionsOrHits: 7 },
      ]).run()

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      const t = JSON.parse(res.payload).totals24h

      // Full count is unchanged.
      expect(t.aiReferralHits).toBe(110)
      // 404 is an arrival at a broken page and 304 a served cache view, so
      // both land. The 301 is a hop and the favicon fetch is noise.
      expect(t.aiReferralLandedHits).toBe(13)
      expect(t.aiReferralRedirectedHits).toBe(90)
      // landed + redirected <= total; the gap is exactly the subresource noise,
      // which must never inflate either figure.
      expect(t.aiReferralHits - t.aiReferralLandedHits - t.aiReferralRedirectedHits).toBe(7)
    } finally { await h.close() }
  })

  it('returns null latestRun when the source has never synced', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.latestRun).toBeNull()
      expect(body.totals24h).toEqual({
        crawlerHits: 0,
        crawlerContentHits: 0,
        crawlerInfraHits: 0,
        crawlerSegments: { content: 0, sitemap: 0, robots: 0, asset: 0, other: 0 },
        aiUserFetchHits: 0,
        aiReferralHits: 0,
        aiReferralLandedHits: 0,
        aiReferralRedirectedHits: 0,
        sampleCount: 0,
      })
    } finally { await h.close() }
  })

  it('counts ChatGPT-User hits as aiUserFetchHits (not crawlerHits) in totals24h', async () => {
    // The defining ai-user-fetch behavior at the read path: ChatGPT-User
    // arrives via UA evidence (same channel as GPTBot) but the operator
    // wants to see it as a human-in-the-loop fetch, not bulk crawl. The
    // detail endpoint MUST surface these in their own bucket so the
    // dashboard's "AI hits" tile is meaningful.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({
        userAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
        remoteIp: '104.210.139.193',
        path: '/',
        status: 200,
        observedAt: fromBase(5),
      }),
      buildEvent({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0', path: '/pricing', status: 200, observedAt: fromBase(10) }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      const syncRes = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })
      const syncBody = JSON.parse(syncRes.payload)
      expect(syncBody.crawlerHits).toBe(1)
      expect(syncBody.aiUserFetchHits).toBe(2)
      expect(syncBody.crawlerBucketRows).toBe(1)
      expect(syncBody.aiUserFetchBucketRows).toBe(2)

      // The new table holds the ChatGPT-User rows; the crawler table only
      // sees the GPTBot row.
      expect(h.db.select().from(crawlerEventsHourly).all().length).toBe(1)
      const userFetchRows = h.db.select().from(aiUserFetchEventsHourly).all()
      expect(userFetchRows.length).toBe(2)
      expect(userFetchRows.every(r => r.botId === 'openai-chatgpt-user')).toBe(true)

      const detail = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      const body = JSON.parse(detail.payload)
      expect(body.totals24h.crawlerHits).toBe(1)
      expect(body.totals24h.aiUserFetchHits).toBe(2)
      expect(body.totals24h.aiReferralHits).toBe(0)
    } finally { await h.close() }
  })

  it('isolates latestRun per source — source A does not see source B\'s sync runs', async () => {
    // Single Cloud Run source from connect, plus a manually-inserted second source for the same project.
    const h = await buildHarness([
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200 }),
    ])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceAId = JSON.parse(connectRes.payload).id

      // Sync only against source A — this writes runs.source_id = sourceAId.
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceAId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      // Seed a second non-archived source for the same project (manual insert; the API
      // doesn't currently support multi-source connect, but DB and reads must be correct).
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      const sourceBId = 'src_b_isolation_test'
      h.db.insert(trafficSources).values({
        id: sourceBId,
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'second source',
        status: TrafficSourceStatuses.connected,
        configJson: {},
        createdAt: now,
        updatedAt: now,
      }).run()

      const detailA = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceAId}`,
      })
      const bodyA = JSON.parse(detailA.payload)
      expect(bodyA.latestRun).not.toBeNull()
      expect(bodyA.latestRun.status).toBe(RunStatuses.completed)

      // Source B has never synced — must surface null even though source A has a run on the same project.
      const detailB = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceBId}`,
      })
      const bodyB = JSON.parse(detailB.payload)
      expect(bodyB.latestRun).toBeNull()
    } finally { await h.close() }
  })
})

describe('GET /traffic/status', () => {
  it('returns an empty list when no sources are connected', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/status' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({ sources: [] })
    } finally { await h.close() }
  })

  it('returns the same per-source detail shape as /traffic/sources/:id without a fan-out', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      const statusRes = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/status',
      })
      expect(statusRes.statusCode).toBe(200)
      const status = JSON.parse(statusRes.payload)
      expect(status.sources.length).toBe(1)
      expect(status.sources[0].id).toBe(sourceId)
      expect(status.sources[0].totals24h.crawlerHits).toBe(2)
      expect(status.sources[0].totals24h.aiReferralHits).toBe(1)
      expect(status.sources[0].latestRun.status).toBe(RunStatuses.completed)

      // Same shape as /traffic/sources/:id — entries should be byte-for-byte equivalent.
      const detailRes = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(JSON.parse(detailRes.payload)).toEqual(status.sources[0])
    } finally { await h.close() }
  })

  it('omits archived sources', async () => {
    const h = await buildHarness([])
    try {
      const { projects } = await import('@ainyc/canonry-db')
      const projectRow = h.db.select().from(projects).all()[0]
      const now = new Date().toISOString()
      h.db.insert(trafficSources).values({
        id: 'src_archived',
        projectId: projectRow.id,
        sourceType: TrafficSourceTypes['cloud-run'],
        displayName: 'old',
        status: TrafficSourceStatuses.archived,
        archivedAt: now,
        configJson: {},
        createdAt: now,
        updatedAt: now,
      }).run()

      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/test-project/traffic/status' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload).sources.length).toBe(0)
    } finally { await h.close() }
  })

  it('404s for an unknown project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects/no-such/traffic/status' })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })
})

describe('GET /traffic/events', () => {
  // The class-count case below pins the clock. Restore it unconditionally so a
  // throw before that test's own `finally` cannot hand a frozen `Date` to the
  // next test; a no-op when timers were never faked.
  afterEach(() => { vi.useRealTimers() })

  async function syncedHarness() {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(30) }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
    ]

    const h = await buildHarness(events)
    const connectRes = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: { sinceMinutes: 120 },
    })
    return { h, sourceId }
  }

  it('returns crawler + AI-referral rollups within the default 24h window', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.aiUserFetchHits).toBe(0)
      expect(body.totals.aiReferralHits).toBe(1)
      expect(body.events.length).toBe(2)
      const kinds = body.events.map((e: { kind: string }) => e.kind).sort()
      expect(kinds).toEqual(['ai-referral', 'crawler'])
      const crawler = body.events.find((e: { kind: string }) => e.kind === 'crawler')
      expect(crawler.verificationManifests).toEqual([expect.objectContaining({
        manifestId: expect.any(String),
        manifest: expect.objectContaining({
          id: expect.any(String),
          source: expect.any(String),
          version: expect.any(String),
        }),
        hits: 2,
      })])
      expect(crawler.verificationUnattributedHits).toBe(0)
    } finally { await h.close() }
  })

  it('batch-loads provenance while preserving multi-manifest and legacy attribution', async () => {
    const { h } = await syncedHarness()
    try {
      const row = h.db.select().from(crawlerEventsHourly).get()
      if (!row) throw new Error('Expected crawler rollup')
      const now = new Date().toISOString()
      h.db.insert(crawlerVerificationManifestsHourly).values({
        projectId: row.projectId,
        sourceId: row.sourceId,
        tsHour: row.tsHour,
        botId: row.botId,
        verificationStatus: row.verificationStatus,
        pathNormalized: row.pathNormalized,
        status: row.status,
        manifestId: 'test-manifest-v2',
        manifestJson: {
          id: 'test-manifest-v2',
          source: 'https://example.test/bots.json',
          version: '2026-08-14T00:00:00Z',
        },
        hits: 1,
        createdAt: now,
        updatedAt: now,
      }).run()
      h.db.update(crawlerEventsHourly)
        .set({ hits: 5, updatedAt: now })
        .where(eq(crawlerEventsHourly.sourceId, row.sourceId))
        .run()

      const readEventsWithSelectCount = async () => {
        const selectSpy = vi.spyOn(h.db, 'select')
        try {
          const response = await h.app.inject({
            method: 'GET',
            url: '/api/v1/projects/test-project/traffic/events?kind=crawler',
          })
          return { response, selectCount: selectSpy.mock.calls.length }
        } finally {
          selectSpy.mockRestore()
        }
      }

      const singleRowRead = await readEventsWithSelectCount()
      expect(singleRowRead.response.statusCode).toBe(200)
      expect(singleRowRead.selectCount).toBeGreaterThan(0)

      const extraRowCount = 24
      h.db.insert(crawlerEventsHourly).values(Array.from({ length: extraRowCount }, (_, index) => ({
        ...row,
        pathNormalized: `/batch-${index}`,
        hits: 1,
        createdAt: now,
        updatedAt: now,
      }))).run()
      h.db.insert(crawlerVerificationManifestsHourly).values(Array.from(
        { length: extraRowCount },
        (_, index) => ({
          projectId: row.projectId,
          sourceId: row.sourceId,
          tsHour: row.tsHour,
          botId: row.botId,
          verificationStatus: row.verificationStatus,
          pathNormalized: `/batch-${index}`,
          status: row.status,
          manifestId: 'batch-manifest',
          manifestJson: {
            id: 'batch-manifest',
            source: 'https://example.test/batch-bots.json',
            version: '2026-08-14T00:00:00Z',
          },
          hits: 1,
          createdAt: now,
          updatedAt: now,
        }),
      )).run()

      const manyRowRead = await readEventsWithSelectCount()
      expect(manyRowRead.response.statusCode).toBe(200)
      expect(manyRowRead.selectCount).toBe(singleRowRead.selectCount)

      const events = JSON.parse(manyRowRead.response.payload).events
      expect(events).toHaveLength(extraRowCount + 1)
      const crawler = events.find((event: { pathNormalized: string }) => (
        event.pathNormalized === row.pathNormalized
      ))
      expect(crawler.verificationManifests).toHaveLength(2)
      expect(crawler.verificationManifests).toContainEqual(expect.objectContaining({
        manifestId: 'test-manifest-v2',
        hits: 1,
      }))
      expect(crawler.verificationUnattributedHits).toBe(2)
      expect(events.find((event: { pathNormalized: string }) => (
        event.pathNormalized === '/batch-0'
      ))).toMatchObject({
        verificationManifests: [expect.objectContaining({ manifestId: 'batch-manifest', hits: 1 })],
        verificationUnattributedHits: 0,
      })
    } finally { await h.close() }
  })

  it('splits AI-referral sessions into paid / organic end-to-end through sync and read', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    // Two distinct actors (distinct IPs), same engine, same landing path, same
    // hour → one hourly bucket carrying one paid and one organic session. The
    // paid one is tagged utm_medium=cpc exactly as ChatGPT ads tag it.
    const events: NormalizedTrafficRequest[] = [
      buildEvent({
        remoteIp: '198.51.100.1',
        userAgent: 'Mozilla/5.0',
        path: '/pricing',
        referer: 'https://chatgpt.com/',
        queryString: 'utm_source=chatgpt&utm_medium=cpc&utm_campaign=openai_ads',
        status: 200,
        observedAt: fromBase(5),
      }),
      buildEvent({
        remoteIp: '198.51.100.2',
        userAgent: 'Mozilla/5.0',
        path: '/pricing',
        referer: 'https://chatgpt.com/',
        queryString: 'utm_source=chatgpt',
        status: 200,
        observedAt: fromBase(9),
      }),
    ]

    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      // 1. The stored row carries the split, and the counters sum to the total.
      const aiRows = h.db.select().from(aiReferralEventsHourly).all()
      expect(aiRows.length).toBe(1)
      expect(aiRows[0].sessionsOrHits).toBe(2)
      expect(aiRows[0].paidSessionsOrHits).toBe(1)
      expect(aiRows[0].organicSessionsOrHits).toBe(1)

      // 2. The read path surfaces the split in the totals and per-row, with no
      // unclassified sessions (both were classified at ingest).
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events',
      })
      const body = JSON.parse(res.payload)
      expect(body.totals.aiReferralHits).toBe(2)
      expect(body.totals.aiReferralPaidHits).toBe(1)
      expect(body.totals.aiReferralOrganicHits).toBe(1)
      expect(body.totals.aiReferralUnknownHits).toBe(0)
      const referral = body.events.find((e: { kind: string }) => e.kind === 'ai-referral')
      expect(referral).toMatchObject({ hits: 2, paidHits: 1, organicHits: 1, unknownHits: 0 })
    } finally { await h.close() }
  })

  it('surfaces a legacy pre-classifier bucket as unclassified, never organic', async () => {
    // A row written by a build before the classifier shipped: total sessions,
    // both class counters at their DEFAULT 0. It must read as unclassified.
    const { h, sourceId } = await syncedHarness()
    try {
      const legacyRow = h.db.select().from(aiReferralEventsHourly).all()[0]
      // Simulate the legacy shape by zeroing the split on the synced row.
      h.db.update(aiReferralEventsHourly)
        .set({ paidSessionsOrHits: 0, organicSessionsOrHits: 0 })
        .run()

      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events',
      })
      const body = JSON.parse(res.payload)
      expect(body.totals.aiReferralHits).toBe(legacyRow.sessionsOrHits)
      expect(body.totals.aiReferralUnknownHits).toBe(legacyRow.sessionsOrHits)
      expect(body.totals.aiReferralOrganicHits).toBe(0)
      expect(body.totals.aiReferralPaidHits).toBe(0)
      expect(sourceId).toBeTruthy()
    } finally { await h.close() }
  })

  it('serializes ai-user-fetch entries alongside crawler + ai-referral', async () => {
    // End-to-end at the read path: when ChatGPT-User events were persisted
    // into ai_user_fetch_events_hourly, GET /traffic/events MUST return them
    // as kind=ai-user-fetch with the same crawler-shaped fields (botId,
    // operator, verificationStatus, pathNormalized, status, hits). This is
    // what an agent calling `canonry traffic events --format json` reads.
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({
        userAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
        remoteIp: '104.210.139.193',
        path: '/',
        status: 200,
        observedAt: fromBase(5),
      }),
      buildEvent({
        userAgent: 'Mozilla/5.0',
        path: '/landing',
        queryString: 'utm_source=chatgpt.com',
        status: 200,
        observedAt: fromBase(15),
      }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals).toMatchObject({ crawlerHits: 1, aiUserFetchHits: 1, aiReferralHits: 1 })
      expect(body.eventRows).toEqual({ total: 3, returned: 3, truncated: false })
      expect(body.series.granularity).toBe('hour')
      expect(
        body.series.points.reduce(
          (sum: { crawlerHits: number; aiUserFetchHits: number; aiReferralHits: number }, point: typeof sum) => ({
            crawlerHits: sum.crawlerHits + point.crawlerHits,
            aiUserFetchHits: sum.aiUserFetchHits + point.aiUserFetchHits,
            aiReferralHits: sum.aiReferralHits + point.aiReferralHits,
          }),
          { crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0 },
        ),
      ).toEqual({ crawlerHits: 1, aiUserFetchHits: 1, aiReferralHits: 1 })
      const kinds = body.events.map((e: { kind: string }) => e.kind).sort()
      expect(kinds).toEqual(['ai-referral', 'ai-user-fetch', 'crawler'])
      const userFetch = body.events.find((e: { kind: string }) => e.kind === 'ai-user-fetch')
      expect(userFetch).toMatchObject({
        kind: 'ai-user-fetch',
        botId: 'openai-chatgpt-user',
        operator: 'OpenAI',
        verificationManifests: [expect.objectContaining({
          manifestId: expect.any(String),
          manifest: expect.objectContaining({
            id: expect.any(String),
            source: expect.any(String),
            version: expect.any(String),
          }),
          hits: 1,
        })],
        verificationUnattributedHits: 0,
        pathNormalized: '/',
        hits: 1,
      })
    } finally { await h.close() }
  })

  it('filters by kind=ai-user-fetch', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()

    const events: NormalizedTrafficRequest[] = [
      buildEvent({ userAgent: 'GPTBot/1.0', path: '/blog/foo', status: 200, observedAt: fromBase(1) }),
      buildEvent({ userAgent: 'Mozilla/5.0 ChatGPT-User/1.0', path: '/', status: 200, observedAt: fromBase(5) }),
    ]
    const h = await buildHarness(events)
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=ai-user-fetch',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(0)
      expect(body.totals.aiUserFetchHits).toBe(1)
      expect(body.totals.aiReferralHits).toBe(0)
      expect(body.events.length).toBe(1)
      expect(body.events[0].kind).toBe('ai-user-fetch')
    } finally { await h.close() }
  })

  it('filters by kind=crawler', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=crawler',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.aiReferralHits).toBe(0)
      expect(body.events.length).toBe(1)
      expect(body.events[0].kind).toBe('crawler')
      expect(body.events[0].hits).toBe(2)
    } finally { await h.close() }
  })

  it('filters by kind=ai-referral', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=ai-referral',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(0)
      expect(body.totals.aiReferralHits).toBe(1)
      expect(body.events.length).toBe(1)
      expect(body.events[0].kind).toBe('ai-referral')
    } finally { await h.close() }
  })

  it('rejects invalid kind', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?kind=bogus',
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/kind/)
    } finally { await h.close() }
  })

  it('rejects invalid since/until and reversed windows', async () => {
    const { h } = await syncedHarness()
    try {
      const bad = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?since=not-a-date',
      })
      expect(bad.statusCode).toBe(400)

      const reversed = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?since=2026-05-07T00:00:00Z&until=2026-05-06T00:00:00Z',
      })
      expect(reversed.statusCode).toBe(400)

      const badGranularity = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?granularity=week',
      })
      expect(badGranularity.statusCode).toBe(400)
    } finally { await h.close() }
  })

  it('returns totals over the full window even when limit truncates the events array', async () => {
    const { h } = await syncedHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?limit=1',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // limit=1 trims the events array but totals and truncation metadata must
      // still reflect the full window.
      expect(body.events.length).toBe(1)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.aiReferralHits).toBe(1)
      expect(body.eventRows).toEqual({ total: 2, returned: 1, truncated: true })
    } finally { await h.close() }
  })

  /**
   * The events window totals must divide the same way as everything else: a
   * redirect hop's paid tags are not a paid session, or the same ad click is
   * a paid session on this surface and zero on the report.
   *
   * Pinned, and pinned at two instants on purpose. The default window is
   * [now-24h, now], so at `granularity=day` the series always spans two UTC
   * days and the bucket asserted below is `now`'s. A fixture seeded at
   * `now - 1h` silently moves into the EARLIER of those two buckets whenever
   * `now` falls inside the first hour of a UTC day, which emptied that point
   * and failed every CI job between 00:00 and 01:00 UTC. The 00:30 instant is
   * the standing guard: anything seeded relative to `now` here must survive it.
   */
  it.each([
    '2026-05-07T13:45:00.000Z',
    '2026-05-07T00:30:00.000Z',
  ])('window totals class-count only landed hits, keeping the full count beside them (clock %s)', async (pinnedNow) => {
    // Only `Date` is faked; the harness and Fastify's inject still need real
    // timers to settle their promises.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(pinnedNow))
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      const projectId = h.db.select().from(trafficSources)
        .where(eq(trafficSources.id, sourceId)).get()!.projectId
      // Top of the CURRENT hour, never an hour back: that is inside both the
      // 24h window and `now`'s UTC day at every instant of the day.
      const hourStart = new Date()
      hourStart.setUTCMinutes(0, 0, 0)
      const tsHour = hourStart.toISOString()
      const now = new Date().toISOString()
      const base = {
        projectId, sourceId, tsHour, product: 'ChatGPT', operator: 'OpenAI',
        sourceDomain: 'chatgpt.com', evidenceType: 'utm',
        usersEstimated: null, createdAt: now, updatedAt: now,
      }
      h.db.insert(aiReferralEventsHourly).values([
        { ...base, landingPathNormalized: '/landed', status: 200, sessionsOrHits: 4, paidSessionsOrHits: 1, organicSessionsOrHits: 3 },
        { ...base, landingPathNormalized: '/hop', status: 301, sessionsOrHits: 90, paidSessionsOrHits: 90, organicSessionsOrHits: 0 },
        // Subresource 200 carrying paid tags: not a session, not paid traffic.
        { ...base, landingPathNormalized: '/assets/app.js', status: 200, sessionsOrHits: 5, paidSessionsOrHits: 5, organicSessionsOrHits: 0 },
      ]).run()

      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?granularity=day',
      })
      const t = JSON.parse(res.payload).totals

      expect(t.aiReferralHits).toBe(99)
      expect(t.aiReferralLandedHits).toBe(4)
      expect(t.aiReferralRedirectedHits).toBe(90)
      // Neither the hop's 90 paid tags nor the asset fetch's 5 may appear as
      // paid sessions.
      expect(t.aiReferralPaidHits).toBe(1)
      expect(t.aiReferralOrganicHits).toBe(3)
      expect(t.aiReferralUnknownHits).toBe(0)
      // And the series charts the landed (session) figure per bucket.
      const today = JSON.parse(res.payload).series.points.at(-1)
      // Name the bucket the last point actually is, so "today" stays a fact
      // rather than an assumption about where the window happens to end.
      expect(today.bucket).toBe(pinnedNow.slice(0, 10))
      expect(today.aiReferralHits).toBe(99)
      expect(today.aiReferralLandedHits).toBe(4)
    } finally { await h.close() }
  })

  it('keeps the complete 90-day series when the detail-row limit truncates old rows', async () => {
    const { h, sourceId } = await syncedHarness()
    try {
      const source = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
      const end = new Date()
      const start = new Date(end)
      start.setUTCDate(start.getUTCDate() - 90)
      start.setUTCHours(0, 0, 0, 0)
      const middle = new Date(start)
      middle.setUTCDate(middle.getUTCDate() + 45)
      const writtenAt = end.toISOString()

      h.db.insert(crawlerEventsHourly).values([
        {
          projectId: source.projectId,
          sourceId,
          tsHour: start.toISOString(),
          botId: 'openai-gptbot',
          operator: 'OpenAI',
          verificationStatus: 'claimed_unverified',
          pathNormalized: '/oldest',
          status: 200,
          hits: 7,
          sampledUserAgent: 'GPTBot/1.0',
          createdAt: writtenAt,
          updatedAt: writtenAt,
        },
        {
          projectId: source.projectId,
          sourceId,
          tsHour: middle.toISOString(),
          botId: 'openai-gptbot',
          operator: 'OpenAI',
          verificationStatus: 'claimed_unverified',
          pathNormalized: '/middle',
          status: 200,
          hits: 11,
          sampledUserAgent: 'GPTBot/1.0',
          createdAt: writtenAt,
          updatedAt: writtenAt,
        },
      ]).run()

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/events?since=${encodeURIComponent(start.toISOString())}&until=${encodeURIComponent(end.toISOString())}&granularity=day&limit=1`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.events).toHaveLength(1)
      expect(body.eventRows).toEqual({ total: 4, returned: 1, truncated: true })
      expect(body.series.granularity).toBe('day')
      expect(body.series.points).toHaveLength(91)
      expect(body.series.points[0]).toEqual({
        bucket: start.toISOString().slice(0, 10),
        crawlerHits: 7,
        aiUserFetchHits: 0,
        aiReferralHits: 0,
        aiReferralLandedHits: 0,
        crawlerContentHits: 7,
        measured: true,
      })
      expect(body.series.points[45].crawlerHits).toBe(11)
      expect(body.series.points.reduce((sum: number, point: { crawlerHits: number }) => sum + point.crawlerHits, 0))
        .toBe(body.totals.crawlerHits)
    } finally { await h.close() }
  })

  it('returns 404 for an unknown project', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/no-such/traffic/events',
      })
      expect(res.statusCode).toBe(404)
    } finally { await h.close() }
  })
})

// Read-time crawler-hit segmentation (#719). The headline "crawler hits" total
// is unchanged, but on real sites it is dominated by sitemap/robots/asset
// polling, so the read layer now also returns a content-vs-infrastructure split
// (+ a full per-class breakdown). These tests exercise the split end-to-end
// through the sync → rollup → read path on both the source-detail and events
// surfaces.
describe('crawler-hit content/infra segmentation', () => {
  // 3 content + 6 sitemap + 4 robots + 1 asset + 1 other = 15 total crawler hits.
  // Every event is GPTBot (UA-classified crawler) so only the PATH varies the class.
  async function mixedPathHarness() {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()
    const crawl = (p: string, mins: number) =>
      buildEvent({ userAgent: 'GPTBot/1.0', path: p, status: 200, observedAt: fromBase(mins) })

    const events: NormalizedTrafficRequest[] = [
      // content (3)
      crawl('/blog/foo', 1),
      crawl('/blog/foo', 2),
      crawl('/', 3),
      // sitemap (6)
      crawl('/sitemap_index.xml', 4),
      crawl('/sitemap_index.xml', 5),
      crawl('/sitemap_index.xml', 6),
      crawl('/sitemap_index.xml', 7),
      crawl('/sitemap_index.xml', 8),
      crawl('/news-sitemap.xml', 9),
      // robots (4)
      crawl('/robots.txt', 10),
      crawl('/robots.txt', 11),
      crawl('/robots.txt', 12),
      crawl('/robots.txt', 13),
      // asset (1)
      crawl('/styles/app.css', 14),
      // other (1)
      crawl('/report.pdf', 15),
    ]

    const h = await buildHarness(events)
    const connectRes = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
      payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
    })
    const sourceId = JSON.parse(connectRes.payload).id
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: { sinceMinutes: 120 },
    })
    return { h, sourceId }
  }

  const EXPECTED_SEGMENTS = { content: 3, sitemap: 6, robots: 4, asset: 1, other: 1 }

  it('segments totals24h on GET /traffic/sources/:id and preserves the crawlerHits total', async () => {
    const { h, sourceId } = await mixedPathHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      expect(res.statusCode).toBe(200)
      const t = JSON.parse(res.payload).totals24h
      // crawlerHits is UNCHANGED — full count across all classes.
      expect(t.crawlerHits).toBe(15)
      expect(t.crawlerSegments).toEqual(EXPECTED_SEGMENTS)
      expect(t.crawlerContentHits).toBe(3)
      // infra = sitemap + robots + asset (NOT other).
      expect(t.crawlerInfraHits).toBe(6 + 4 + 1)
      // the issue's headline invariant.
      expect(t.crawlerContentHits + t.crawlerInfraHits + t.crawlerSegments.other).toBe(t.crawlerHits)
      // and the five buckets sum to the total too.
      const seg = t.crawlerSegments
      expect(seg.content + seg.sitemap + seg.robots + seg.asset + seg.other).toBe(t.crawlerHits)
    } finally { await h.close() }
  })

  it('segments totals on GET /traffic/events and tags each crawler event with its pathClass', async () => {
    const { h, sourceId } = await mixedPathHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/events?sourceId=${sourceId}&kind=crawler`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(15)
      expect(body.totals.crawlerSegments).toEqual(EXPECTED_SEGMENTS)
      expect(body.totals.crawlerContentHits).toBe(3)
      expect(body.totals.crawlerInfraHits).toBe(11)
      expect(
        body.totals.crawlerContentHits + body.totals.crawlerInfraHits + body.totals.crawlerSegments.other,
      ).toBe(body.totals.crawlerHits)

      // Every crawler event carries a pathClass consistent with its path.
      const byPath = new Map<string, string>()
      for (const e of body.events) byPath.set(e.pathNormalized, e.pathClass)
      expect(byPath.get('/blog/foo')).toBe('content')
      expect(byPath.get('/')).toBe('content')
      expect(byPath.get('/sitemap_index.xml')).toBe('sitemap')
      expect(byPath.get('/news-sitemap.xml')).toBe('sitemap')
      expect(byPath.get('/robots.txt')).toBe('robots')
      expect(byPath.get('/styles/app.css')).toBe('asset')
      expect(byPath.get('/report.pdf')).toBe('other')
    } finally { await h.close() }
  })

  /**
   * The daily series is what the Activity chart draws. `crawlerHits` is the full
   * count, so a day of sitemap re-fetches inflates it; `crawlerContentHits` is
   * the part that is a real page. Charting the former under "pages crawled"
   * reports infrastructure as reading, which is the whole reason this field
   * exists, so assert the two DISAGREE here rather than that either is non-zero.
   */
  it('splits content from infrastructure per day in the series, not just in the totals', async () => {
    const { h } = await mixedPathHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        // 24h explicitly. This previously read `sinceMinutes=1440` and only
        // worked because 1440 minutes happens to equal the ignored default.
        url: `/api/v1/projects/test-project/traffic/events?since=${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60_000).toISOString())}&granularity=day`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      const sum = (key: string) => body.series.points
        .reduce((acc: number, pt: Record<string, number>) => acc + pt[key], 0)

      const total = EXPECTED_SEGMENTS.content + EXPECTED_SEGMENTS.sitemap
        + EXPECTED_SEGMENTS.robots + EXPECTED_SEGMENTS.asset + EXPECTED_SEGMENTS.other
      expect(sum('crawlerHits')).toBe(total)
      expect(sum('crawlerContentHits')).toBe(EXPECTED_SEGMENTS.content)
      // The point of the field: the two must not be the same number here.
      expect(sum('crawlerContentHits')).toBeLessThan(sum('crawlerHits'))

      // The series must agree with the totals object on the same request.
      expect(sum('crawlerHits')).toBe(body.totals.crawlerHits)
      expect(sum('crawlerContentHits')).toBe(body.totals.crawlerContentHits)

      // Every point carries the key, including zero-filled days, and never exceeds its own total.
      for (const pt of body.series.points) {
        expect(typeof pt.crawlerContentHits).toBe('number')
        expect(pt.crawlerContentHits).toBeLessThanOrEqual(pt.crawlerHits)
      }
    } finally { await h.close() }
  })
  /**
   * Review finding: the first version grouped the series by (bucket, path), so a
   * site with many distinct paths materialized paths x buckets rows before any
   * limit applied. This pins the fix: many distinct paths across many days must
   * still return one row per bucket, with the content split intact.
   *
   * Rows are inserted directly, like the 90-day series test, because the sync
   * path time-filters anything older than its window.
   */
  /**
   * `sinceMinutes` is the sync body parameter. Sent here it used to be ignored
   * and the window quietly fell back to 24 hours, so a caller asking for 90 days
   * got a plausible answer for the wrong range. That cost real debugging time
   * while writing the test above: the data looked missing when the window was
   * simply wrong. Fail loudly instead.
   */
  /**
   * A window that reaches back before recording began must say so. Those
   * buckets read 0 because nothing was being recorded, not because nothing
   * happened, and a chart that draws them as a measured zero invents a quiet
   * period. Operator ruling: coverageStart is the EARLIEST observed event,
   * earliest across all of the project's sources.
   */
  it('marks buckets before the first observation as unmeasured', async () => {
    const { h } = await mixedPathHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        // 30 days back, well before this harness's minutes-old fixture.
        url: `/api/v1/projects/test-project/traffic/events?since=${encodeURIComponent(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())}&granularity=day`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      expect(typeof body.series.coverageStart).toBe('string')
      const points = body.series.points as Array<{ bucket: string; measured: boolean; crawlerHits: number }>

      // Both states must be present, or the test proves nothing.
      expect(points.some((pt) => !pt.measured)).toBe(true)
      expect(points.some((pt) => pt.measured)).toBe(true)

      const coverageDay = String(body.series.coverageStart).slice(0, 10)
      for (const pt of points) {
        expect(pt.measured).toBe(pt.bucket.slice(0, 10) >= coverageDay)
        // An unmeasured bucket must never carry hits: that would mean we
        // recorded something before we claim recording began.
        if (!pt.measured) expect(pt.crawlerHits).toBe(0)
      }

      // The fit must not run across the unmeasured lead-in. Asserting an exact
      // measured-day count was wall-clock dependent: the harness writes events
      // an hour back, so a run between 00:00 and ~01:00 UTC straddles midnight
      // and produces TWO measured days instead of one, failing for that hour
      // only. Assert the invariant instead of the incidental count.
      const measuredDays = points.filter((pt) => pt.measured).length
      const trend = body.series.trends.crawlerContentHits
      if (trend !== null) {
        // Whatever the fit used, it can never include an unmeasured bucket, and
        // the trailing partial bucket is excluded too.
        expect(trend.n).toBeLessThanOrEqual(measuredDays)
        expect(trend.startIndex).toBeGreaterThanOrEqual(points.findIndex((pt) => pt.measured))
      }
    } finally { await h.close() }
  })

  /**
   * Review finding: `until` defaults to now, so the newest daily bucket holds
   * only the elapsed fraction of the current UTC day. Fitting through it makes a
   * flat site read as declining, every time, for everyone. Same class of error
   * as the leading unmeasured edge, which was already guarded.
   *
   * The fixture is deliberately FLAT on the complete days with a small partial
   * today. A fit that includes today returns a negative slope; one that excludes
   * it returns ~0.
   */
  it('excludes the trailing partial bucket from the trend fit', async () => {
    const { h, sourceId } = await mixedPathHarness()
    try {
      const source = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      const writtenAt = new Date().toISOString()
      const row = (tsHour: string, pathNormalized: string, hits: number) => ({
        projectId: source.projectId, sourceId, tsHour,
        botId: 'openai-gptbot', operator: 'OpenAI', verificationStatus: 'claimed_unverified' as const,
        pathNormalized, status: 200, hits, sampledUserAgent: 'GPTBot/1.0',
        createdAt: writtenAt, updatedAt: writtenAt,
      })

      // Five complete days flat at 100, then a small slice for today.
      const rows = []
      for (let back = 5; back >= 1; back--) {
        const d = new Date(); d.setUTCDate(d.getUTCDate() - back); d.setUTCHours(12, 0, 0, 0)
        rows.push(row(d.toISOString(), `/blog/day-${back}`, 100))
      }
      const today = new Date(); today.setUTCHours(0, 30, 0, 0)
      rows.push(row(today.toISOString(), '/blog/today', 4))
      h.db.insert(crawlerEventsHourly).values(rows).run()

      const since = new Date(); since.setUTCDate(since.getUTCDate() - 7)
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/events?since=${encodeURIComponent(since.toISOString())}&granularity=day`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      const trend = body.series.trends.crawlerContentHits
      expect(trend).not.toBeNull()

      // The partial day must not be in the fit. Including it drags the slope
      // sharply negative on a series that is flat.
      const lastIndex = body.series.points.length - 1
      expect(trend.endIndex).toBeLessThan(lastIndex)
      expect(trend.slope).toBeGreaterThan(-20)
    } finally { await h.close() }
  })

  it('rejects sinceMinutes rather than silently answering for 24 hours', async () => {
    const { h } = await mixedPathHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/projects/test-project/traffic/events?sinceMinutes=14400&granularity=day',
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.payload)
      // The message must name the parameter that actually works.
      expect(body.error.message).toContain('sinceMinutes')
      expect(body.error.message).toContain('since')
    } finally { await h.close() }
  })

  it('keeps the series bounded by buckets, not paths x buckets, on a high-cardinality site', async () => {
    const { h, sourceId } = await mixedPathHarness()
    try {
      const source = h.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceId))
        .get()!
      const writtenAt = new Date().toISOString()
      const rowFor = (tsHour: string, pathNormalized: string) => ({
        projectId: source.projectId,
        sourceId,
        tsHour,
        botId: 'openai-gptbot',
        operator: 'OpenAI',
        verificationStatus: 'claimed_unverified' as const,
        pathNormalized,
        status: 200,
        hits: 1,
        sampledUserAgent: 'GPTBot/1.0',
        createdAt: writtenAt,
        updatedAt: writtenAt,
      })

      // 6 days x 20 distinct content paths, plus 2 infrastructure paths per day.
      const rows = []
      for (let day = 0; day < 6; day++) {
        const d = new Date()
        d.setUTCDate(d.getUTCDate() - (day + 1))
        d.setUTCHours(12, 0, 0, 0)
        const ts = d.toISOString()
        for (let n = 0; n < 20; n++) rows.push(rowFor(ts, `/blog/post-${day}-${n}`))
        rows.push(rowFor(ts, '/robots.txt'))
        rows.push(rowFor(ts, '/sitemap_index.xml'))
      }
      h.db.insert(crawlerEventsHourly).values(rows).run()
      // Guard the fixture before asserting on the API. When this test first
      // failed the rows looked missing, and the cause was the QUERY window, not
      // the insert. This separates those two failures so the next person does
      // not go hunting in the wrong place.
      const inserted = h.db
        .select()
        .from(crawlerEventsHourly)
        .where(eq(crawlerEventsHourly.sourceId, sourceId))
        .all()
      expect(inserted.length).toBeGreaterThanOrEqual(rows.length)

      // The events route windows on ISO `since`/`until`, NOT sinceMinutes (that
      // is a sync body param). Passing the wrong one silently falls back to 24h.
      const windowStart = new Date()
      windowStart.setUTCDate(windowStart.getUTCDate() - 10)
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/events?since=${encodeURIComponent(windowStart.toISOString())}&granularity=day`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)

      // One point per calendar day, never one per path.
      const buckets = body.series.points.map((pt: { bucket: string }) => pt.bucket)
      expect(new Set(buckets).size).toBe(buckets.length)
      expect(buckets.length).toBeLessThan(40)

      const sum = (k: string) => body.series.points
        .reduce((a: number, pt: Record<string, number>) => a + pt[k], 0)
      // 120 content rows and 12 infrastructure rows ON TOP of the harness
      // fixture, which is already inside this window. The split must survive the
      // bounded query, not just the total.
      const fixtureTotal = EXPECTED_SEGMENTS.content + EXPECTED_SEGMENTS.sitemap
        + EXPECTED_SEGMENTS.robots + EXPECTED_SEGMENTS.asset + EXPECTED_SEGMENTS.other
      expect(sum('crawlerContentHits')).toBe(120 + EXPECTED_SEGMENTS.content)
      expect(sum('crawlerHits')).toBe(132 + fixtureTotal)
      expect(sum('crawlerContentHits')).toBeLessThan(sum('crawlerHits'))
    } finally { await h.close() }
  })

  it('reads 0 content crawls for an all-infrastructure source', async () => {
    const baseTime = new Date(Date.now() - 60 * 60_000)
    baseTime.setMinutes(0, 0, 0)
    const fromBase = (mins: number) => new Date(baseTime.getTime() + mins * 60_000).toISOString()
    const crawl = (p: string, mins: number) =>
      buildEvent({ userAgent: 'GPTBot/1.0', path: p, status: 200, observedAt: fromBase(mins) })

    const h = await buildHarness([
      crawl('/sitemap_index.xml', 1),
      crawl('/sitemap_index.xml', 2),
      crawl('/robots.txt', 3),
      crawl('/assets/main.js', 4),
    ])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 120 },
      })

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}`,
      })
      const t = JSON.parse(res.payload).totals24h
      expect(t.crawlerHits).toBe(4)
      expect(t.crawlerContentHits).toBe(0)
      expect(t.crawlerInfraHits).toBe(4)
      expect(t.crawlerSegments).toEqual({ content: 0, sitemap: 2, robots: 1, asset: 1, other: 0 })
    } finally { await h.close() }
  })

  it('keeps segmented totals over the FULL window even when limit truncates the event list', async () => {
    // Segments come from a separate GROUP BY query over the whole window, not the
    // limit-truncated row slice — limit=1 must trim events but not the totals.
    const { h, sourceId } = await mixedPathHarness()
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/events?sourceId=${sourceId}&kind=crawler&limit=1`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.events.length).toBe(1)
      expect(body.totals.crawlerHits).toBe(15)
      expect(body.totals.crawlerSegments).toEqual(EXPECTED_SEGMENTS)
      expect(body.totals.crawlerContentHits).toBe(3)
      expect(body.totals.crawlerInfraHits).toBe(11)
      expect(
        body.totals.crawlerContentHits + body.totals.crawlerInfraHits + body.totals.crawlerSegments.other,
      ).toBe(body.totals.crawlerHits)
    } finally { await h.close() }
  })

  it('segments only the in-window rows for a since/until sub-window', async () => {
    // content lands in hour A, infrastructure in hour B; a window covering only
    // hour A must report content-only segments.
    const hourA = new Date(Date.now() - 3 * 60 * 60_000)
    hourA.setMinutes(0, 0, 0)
    const hourB = new Date(hourA.getTime() + 60 * 60_000)
    const at = (base: Date, mins: number) => new Date(base.getTime() + mins * 60_000).toISOString()
    const crawl = (p: string, iso: string) =>
      buildEvent({ userAgent: 'GPTBot/1.0', path: p, status: 200, observedAt: iso })

    const h = await buildHarness([
      // hour A — content
      crawl('/blog/foo', at(hourA, 1)),
      crawl('/', at(hourA, 2)),
      // hour B — infrastructure
      crawl('/sitemap_index.xml', at(hourB, 1)),
      crawl('/robots.txt', at(hourB, 2)),
    ])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/cloud-run',
        payload: { gcpProjectId: 'openclaw-nyc', keyJson: SA_KEY },
      })
      const sourceId = JSON.parse(connectRes.payload).id
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
        payload: { sinceMinutes: 240 },
      })

      // Window = hour A only (ends 1ms before hour B's top-of-hour bucket).
      const since = hourA.toISOString()
      const until = new Date(hourB.getTime() - 1).toISOString()
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects/test-project/traffic/events?sourceId=${sourceId}&kind=crawler&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.totals.crawlerHits).toBe(2)
      expect(body.totals.crawlerContentHits).toBe(2)
      expect(body.totals.crawlerInfraHits).toBe(0)
      expect(body.totals.crawlerSegments).toEqual({ content: 2, sitemap: 0, robots: 0, asset: 0, other: 0 })
    } finally { await h.close() }
  })
})

/**
 * Operator-recovery surface: `POST /traffic/sources/:id/reset` advances
 * lastSyncedAt to NOW, clears the error state, and lets the next scheduled
 * sync resume from a recent timestamp. This exists because a source whose
 * lastSyncedAt ages past the upstream's retention window (Vercel 14d, Cloud
 * Logging 30d) gets permanently stuck under the new retention-throw
 * behavior — the recovery path used to require a raw SQL UPDATE.
 */
describe('POST /traffic/sources/:id/reset', () => {
  async function connectVercel(h: Awaited<ReturnType<typeof buildHarness>>): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/vercel',
      payload: { projectId: 'prj_abc', teamId: 'team_xyz', token: 'vcp_test' },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload).id
  }

  it('advances lastSyncedAt to NOW, clears status and lastError', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      // Simulate a stuck source: aged lastSyncedAt + error state.
      backdateLastSyncedAt(h.db, sourceId, 36 * 60 * 60_000)
      h.db
        .update(trafficSources)
        .set({
          status: TrafficSourceStatuses.error,
          lastError: 'Vercel pull failed: ExceedsBillingLimitError',
        })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const before = Date.now()
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(200)
      const after = Date.now()

      const dto = JSON.parse(res.payload)
      expect(dto.id).toBe(sourceId)
      expect(dto.status).toBe(TrafficSourceStatuses.connected)
      expect(dto.lastError).toBeNull()
      const dtoMs = new Date(dto.lastSyncedAt).getTime()
      expect(dtoMs).toBeGreaterThanOrEqual(before)
      expect(dtoMs).toBeLessThanOrEqual(after)

      const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(row.status).toBe(TrafficSourceStatuses.connected)
      expect(row.lastError).toBeNull()
      expect(new Date(row.lastSyncedAt!).getTime()).toBeGreaterThanOrEqual(before)
    } finally {
      await h.close()
    }
  })

  it('clears a WordPress continuation cursor with the explicit reset watermark', async () => {
    const h = await buildHarness([])
    try {
      const connectRes = await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects/test-project/traffic/connect/wordpress',
        payload: {
          baseUrl: 'https://8.8.8.8',
          username: 'canonry-bot',
          applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
        },
      })
      expect(connectRes.statusCode).toBe(200)
      const sourceId = JSON.parse(connectRes.payload).id
      h.db.update(trafficSources)
        .set({
          lastSyncedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
          lastCursor: 'stale-continuation',
          wordpressPendingUntil: new Date(Date.now() - 23 * 60 * 60_000).toISOString(),
          status: TrafficSourceStatuses.error,
          lastError: 'previous pull failed',
        })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(200)
      const reset = JSON.parse(res.payload)
      expect(reset.lastCursor).toBeNull()
      expect(reset.skippedThroughAt).toBe(reset.lastSyncedAt)

      const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(row.lastCursor).toBeNull()
      expect(row.wordpressPendingUntil).toBeNull()
      expect(row.skippedThroughAt).toBe(row.lastSyncedAt)
      expect(row.status).toBe(TrafficSourceStatuses.connected)
      expect(row.lastError).toBeNull()
    } finally {
      await h.close()
    }
  })

  it('refuses reset when the source no longer has usable credential material', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      h.db.update(trafficSources)
        .set({ status: TrafficSourceStatuses.error, lastError: 'prior pull failed' })
        .where(eq(trafficSources.id, sourceId))
        .run()
      const credential = h.vercelCredentials.get('test-project')!
      h.vercelCredentials.set('test-project', { ...credential, token: '' })

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })

      expect(res.statusCode).toBe(400)
      expect(h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get())
        .toMatchObject({ status: TrafficSourceStatuses.error, lastError: 'prior pull failed' })
    } finally {
      await h.close()
    }
  })

  it('rejects requests missing the advanceToNow flag (no implicit reset)', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: {},
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/advanceToNow/)
    } finally {
      await h.close()
    }
  })

  it('rejects requests with advanceToNow=false (no implicit reset)', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: false },
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await h.close()
    }
  })

  it('returns 404 for an unknown source id', async () => {
    const h = await buildHarness([])
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${crypto.randomUUID()}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('writes an audit log entry', async () => {
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(200)
      const auditRows = h.db.select().from(auditLog).all()
      const resetEntry = auditRows.find((r) => r.action === 'traffic.source.reset')
      expect(resetEntry).toBeDefined()
      expect(resetEntry!.entityId).toBe(sourceId)
    } finally {
      await h.close()
    }
  })

  it('rejects reset on an archived source', async () => {
    // Archived rows are hidden from listing endpoints; allowing reset would
    // silently flip status back to `connected` and resurrect them. Force a
    // re-connect instead.
    const h = await buildHarness([])
    try {
      const sourceId = await connectVercel(h)
      h.db
        .update(trafficSources)
        .set({ status: TrafficSourceStatuses.archived, archivedAt: new Date().toISOString() })
        .where(eq(trafficSources.id, sourceId))
        .run()

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/reset`,
        payload: { advanceToNow: true },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.payload).error.message).toMatch(/archived/i)

      // Status must not have flipped back to `connected`.
      const row = h.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
      expect(row.status).toBe(TrafficSourceStatuses.archived)
    } finally {
      await h.close()
    }
  })
})
