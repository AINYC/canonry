import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { AppError } from '@ainyc/canonry-contracts'
import type { AdsLiveDeliveryDto } from '@ainyc/canonry-contracts'
import {
  createClient,
  migrate,
  projects,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
} from '@ainyc/canonry-db'
import { adsRoutes } from '../src/ads.js'
import type {
  AdsLiveDeliveryReader,
  AdsLiveProviderEntity,
  VerifiedAdsAccount,
} from '../src/ads.js'
import {
  buildFieldDeltas,
  buildMetricDeltas,
  buildLiveEntityComparison,
  summarizeLiveDrift,
} from '../src/ads-live-delivery.js'

const NOW = '2026-06-10T12:00:00.000Z'
const API_KEY = 'sk-ads-live-super-secret-key'
const WINDOW = { startDate: '2026-06-03', endDate: '2026-06-10' }

const VERIFIED: VerifiedAdsAccount = {
  id: 'adacct_aaa',
  name: 'Acme Exteriors, Inc',
  status: 'active',
  currencyCode: 'USD',
  timezone: 'America/Denver',
  reviewStatus: 'in_review',
  integrityReviewStatus: 'approved',
  integrityDecision: 'allowed',
}

function liveEntity(
  id: string,
  status: string,
  extra: Partial<AdsLiveProviderEntity> = {},
): AdsLiveProviderEntity {
  return {
    id,
    name: `${id} name`,
    status,
    reviewStatus: null,
    mode: null,
    updatedAt: 200,
    ...extra,
  }
}

function metricRow(
  date: string,
  values: { impressions?: number; clicks?: number; spend?: number; conversions?: number },
) {
  return {
    date,
    startTime: 1_760_000_000,
    endTime: 1_760_086_400,
    impressions: values.impressions ?? null,
    clicks: values.clicks ?? null,
    spend: values.spend ?? null,
    conversions: values.conversions ?? null,
    ctr: null,
    cpc: null,
    cpm: null,
  }
}

interface Overrides {
  campaigns?: AdsLiveProviderEntity[]
  adGroups?: AdsLiveProviderEntity[]
  ads?: AdsLiveProviderEntity[]
  campaignMetrics?: ReturnType<typeof metricRow>[]
  adGroupMetrics?: ReturnType<typeof metricRow>[]
  readerError?: unknown
  verifyError?: unknown
  verifiedAccountId?: string
  minIntervalMs?: number
  omitReader?: boolean
}

function buildApp(overrides: Overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-live-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const logLines: string[] = []
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk))
      callback()
    },
  })

  const readerCalls: Array<{ method: string; apiKey: string; entityId?: string }> = []
  const throwIfConfigured = () => {
    if (overrides.readerError !== undefined) throw overrides.readerError
  }

  const reader: AdsLiveDeliveryReader = {
    listCampaigns: async (apiKey) => {
      readerCalls.push({ method: 'listCampaigns', apiKey })
      throwIfConfigured()
      return overrides.campaigns ?? []
    },
    listAdGroups: async (apiKey, campaignId) => {
      readerCalls.push({ method: 'listAdGroups', apiKey, entityId: campaignId })
      throwIfConfigured()
      return overrides.adGroups ?? []
    },
    listAds: async (apiKey, adGroupId) => {
      readerCalls.push({ method: 'listAds', apiKey, entityId: adGroupId })
      throwIfConfigured()
      return overrides.ads ?? []
    },
    campaignInsights: async (apiKey, campaignId) => {
      readerCalls.push({ method: 'campaignInsights', apiKey, entityId: campaignId })
      throwIfConfigured()
      return overrides.campaignMetrics ?? []
    },
    adGroupInsights: async (apiKey, adGroupId) => {
      readerCalls.push({ method: 'adGroupInsights', apiKey, entityId: adGroupId })
      throwIfConfigured()
      return overrides.adGroupMetrics ?? []
    },
  }

  const app = Fastify({ logger: { level: 'trace', stream: logStream } })
  app.decorate('db', db)
  // Mirrors the production global handler: AppError is serialized, everything
  // else is logged in full and answered with a generic message.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    app.log.error(error)
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
  })

  void app.register(adsRoutes, {
    adsCredentialStore: {
      getConnection: (projectName) => projectName === 'acme'
        ? { projectName, apiKey: API_KEY, adAccountId: 'adacct_aaa', createdAt: NOW, updatedAt: NOW }
        : undefined,
      upsertConnection: (entry) => entry,
      removeConnection: () => false,
    },
    verifyAdsAccount: async () => {
      if (overrides.verifyError !== undefined) throw overrides.verifyError
      return { ...VERIFIED, id: overrides.verifiedAccountId ?? VERIFIED.id }
    },
    adsLiveDeliveryReader: overrides.omitReader ? undefined : reader,
    adsLiveDeliveryMinIntervalMs: overrides.minIntervalMs ?? 0,
    adsReconcileSweepIntervalMs: 0,
  })

  function seedProject(name = 'acme'): string {
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    return id
  }

  function seedConnection(projectId: string): void {
    db.insert(adsConnections).values({
      id: crypto.randomUUID(), projectId, adAccountId: 'adacct_aaa',
      displayName: 'Acme Exteriors, Inc', currencyCode: 'USD', timezone: 'America/Denver',
      status: 'active', reviewStatus: 'in_review', integrityReviewStatus: 'approved',
      integrityDecision: 'allowed', conversionTrackingConfigured: true,
      lastSyncedAt: '2026-06-09T00:00:00.000Z', createdAt: NOW, updatedAt: NOW,
    }).run()
  }

  /** The observed incident: Canonry says paused / 111 impressions. */
  function seedStaleSnapshot(projectId: string): void {
    db.insert(adsCampaigns).values({
      id: 'cmpn_1', projectId, name: 'Homeowners Free Estimate', status: 'paused',
      biddingType: 'clicks', dailySpendLimitMicros: 150_000_000, syncedAt: NOW,
      conversionEventSettingIds: [], upstreamUpdatedAt: 100,
    }).run()
    db.insert(adsAdGroups).values({
      id: 'adgrp_1', projectId, campaignId: 'cmpn_1', name: 'Deck Project Planning',
      status: 'paused', billingEventType: 'click', maxBidMicros: 2_000_000,
      contextHints: [], upstreamUpdatedAt: 100, syncedAt: NOW,
    }).run()
    db.insert(adsAds).values({
      id: 'ad_1', projectId, adGroupId: 'adgrp_1', name: 'HO Deck - Materials',
      status: 'paused', reviewStatus: 'approved', upstreamUpdatedAt: 100, syncedAt: NOW,
    }).run()
    const rows = [
      { level: 'campaign', entityId: 'cmpn_1', date: '2026-06-10', impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
      // Older than the 7d window — never compared, because the provider was
      // never asked about it.
      { level: 'campaign', entityId: 'cmpn_1', date: '2026-05-01', impressions: 9_999, clicks: 99, spendMicros: 9_000_000, conversions: 9 },
    ]
    for (const row of rows) {
      db.insert(adsInsightsDaily).values({ id: crypto.randomUUID(), projectId, syncRunId: null, ...row }).run()
    }
  }

  return { app, db, tmpDir, reader, readerCalls, logLines, seedProject, seedConnection, seedStaleSnapshot }
}

describe('ads live delivery comparison (pure)', () => {
  it('reports only the fields that differ, and nothing when one side is absent', () => {
    const live = { name: 'A', status: 'active', reviewStatus: 'approved', mode: 'standard', updatedAt: 5 }
    const stored = { name: 'A', status: 'paused', reviewStatus: 'approved', upstreamUpdatedAt: 4, syncedAt: NOW }

    expect(buildFieldDeltas(live, stored)).toEqual([
      { field: 'status', live: 'active', stored: 'paused' },
    ])
    expect(buildFieldDeltas(live, { ...stored, status: 'active' })).toEqual([])
    expect(buildFieldDeltas(live, null)).toEqual([])
    expect(buildFieldDeltas(null, stored)).toEqual([])
  })

  it('compares metrics per date, converts provider dollars to micros, and ignores pre-window stored dates', () => {
    const deltas = buildMetricDeltas(
      [metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 })],
      [
        { date: '2026-06-10', impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
        { date: '2026-05-01', impressions: 9_999, clicks: 99, spendMicros: 9_000_000, conversions: 9 },
      ],
      WINDOW,
    )

    expect(deltas).toEqual([
      {
        date: '2026-06-10',
        live: { impressions: 162, clicks: 5, spendMicros: 1_500_000, conversions: 0 },
        stored: { impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
        drifted: true,
      },
    ])
  })

  it('sums the provider\'s disjoint buckets within one date and calls an exact match undrifted', () => {
    const deltas = buildMetricDeltas(
      [
        metricRow('2026-06-09', { impressions: 60, clicks: 2, spend: 0.25, conversions: 1 }),
        metricRow('2026-06-09', { impressions: 40, clicks: 1, spend: 0.75, conversions: 0 }),
      ],
      [{ date: '2026-06-09', impressions: 100, clicks: 3, spendMicros: 1_000_000, conversions: 1 }],
      WINDOW,
    )

    expect(deltas).toEqual([
      {
        date: '2026-06-09',
        live: { impressions: 100, clicks: 3, spendMicros: 1_000_000, conversions: 1 },
        stored: { impressions: 100, clicks: 3, spendMicros: 1_000_000, conversions: 1 },
        drifted: false,
      },
    ])
  })

  it('flags a date only one side reports, and claims nothing when neither side was read', () => {
    const liveOnly = buildMetricDeltas(
      [metricRow('2026-06-08', { impressions: 12 })],
      [],
      WINDOW,
    )
    expect(liveOnly).toEqual([
      {
        date: '2026-06-08',
        live: { impressions: 12, clicks: 0, spendMicros: 0, conversions: 0 },
        stored: null,
        drifted: true,
      },
    ])

    const storedOnly = buildMetricDeltas(
      [],
      [{ date: '2026-06-08', impressions: 12, clicks: 0, spendMicros: 0, conversions: 0 }],
      WINDOW,
    )
    expect(storedOnly[0]).toMatchObject({ date: '2026-06-08', live: null, drifted: true })

    expect(buildMetricDeltas(null, null, WINDOW)).toBeNull()
  })

  it('summarizes drift across entities without conflating status and metric drift', () => {
    const statusOnly = buildLiveEntityComparison({
      entityType: 'campaign',
      id: 'cmpn_1',
      parentId: null,
      live: { name: 'A', status: 'active', reviewStatus: null, mode: null, updatedAt: 5 },
      stored: { name: 'A', status: 'paused', reviewStatus: null, upstreamUpdatedAt: 4, syncedAt: NOW },
      liveMetrics: [],
      storedMetrics: [],
    }, WINDOW)
    const metricsOnly = buildLiveEntityComparison({
      entityType: 'ad_group',
      id: 'adgrp_1',
      parentId: 'cmpn_1',
      live: { name: 'B', status: 'paused', reviewStatus: null, mode: null, updatedAt: 5 },
      stored: { name: 'B', status: 'paused', reviewStatus: null, upstreamUpdatedAt: 4, syncedAt: NOW },
      liveMetrics: [metricRow('2026-06-10', { impressions: 5 })],
      storedMetrics: [],
    }, WINDOW)
    const clean = buildLiveEntityComparison({
      entityType: 'ad',
      id: 'ad_1',
      parentId: 'adgrp_1',
      live: { name: 'C', status: 'paused', reviewStatus: 'approved', mode: null, updatedAt: 5 },
      stored: { name: 'C', status: 'paused', reviewStatus: 'approved', upstreamUpdatedAt: 4, syncedAt: NOW },
      liveMetrics: null,
      storedMetrics: null,
    }, WINDOW)

    expect(statusOnly.drifted).toBe(true)
    expect(metricsOnly.drifted).toBe(true)
    expect(clean.drifted).toBe(false)
    expect(clean.metricDeltas).toBeNull()
    expect(summarizeLiveDrift([statusOnly, metricsOnly, clean])).toEqual({
      entitiesCompared: 3,
      driftedEntities: 2,
      statusDrifted: 1,
      metricsDrifted: 1,
    })
  })
})

describe('GET /projects/:name/ads/live-delivery', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (ctx) {
      await ctx.app.close()
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    }
  })

  async function start(overrides: Overrides = {}) {
    ctx = buildApp(overrides)
    await ctx.app.ready()
    return ctx
  }

  it('surfaces the live-vs-stored status and metric drift that made the snapshot wrong', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate', mode: 'standard' })],
      adGroups: [liveEntity('adgrp_1', 'serving', { name: 'Deck Project Planning' })],
      ads: [liveEntity('ad_1', 'active', { name: 'HO Deck - Materials', reviewStatus: 'approved' })],
      campaignMetrics: [metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 })],
      adGroupMetrics: [metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 })],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto
    expect(body.basis).toBe('live-provider-read')
    expect(body.fetchedAt).toBe(NOW)
    expect(body.adAccountId).toBe('adacct_aaa')
    expect(body.storedSnapshotSyncedAt).toBe('2026-06-09T00:00:00.000Z')
    expect(body.metricsWindow).toEqual({ lookbackDays: 7 })
    expect(body.errors).toEqual([])
    expect(body.bounds.truncated).toBe(false)

    const campaign = body.entities.find((entity) => entity.id === 'cmpn_1')!
    expect(campaign.presence).toBe('both')
    expect(campaign.live).toEqual({
      name: 'Homeowners Free Estimate',
      status: 'active',
      reviewStatus: null,
      mode: 'standard',
      updatedAt: 200,
    })
    expect(campaign.stored).toMatchObject({ status: 'paused', upstreamUpdatedAt: 100 })
    expect(campaign.fieldDeltas).toEqual([{ field: 'status', live: 'active', stored: 'paused' }])
    // Provider rows are returned exactly as given: spend stays in the
    // provider's decimal units and is never folded into a total here.
    expect(campaign.liveMetrics).toEqual([
      metricRow('2026-06-10', { impressions: 162, clicks: 5, spend: 1.5, conversions: 0 }),
    ])
    expect(campaign.metricDeltas).toEqual([{
      date: '2026-06-10',
      live: { impressions: 162, clicks: 5, spendMicros: 1_500_000, conversions: 0 },
      stored: { impressions: 111, clicks: 3, spendMicros: 1_000_000, conversions: 0 },
      drifted: true,
    }])
    expect(campaign.drifted).toBe(true)

    const adGroup = body.entities.find((entity) => entity.id === 'adgrp_1')!
    expect(adGroup.parentId).toBe('cmpn_1')
    expect(adGroup.fieldDeltas).toEqual([{ field: 'status', live: 'serving', stored: 'paused' }])

    const ad = body.entities.find((entity) => entity.id === 'ad_1')!
    expect(ad.liveMetrics).toBeNull()
    expect(ad.metricDeltas).toBeNull()
    expect(ad.fieldDeltas).toEqual([{ field: 'status', live: 'active', stored: 'paused' }])

    expect(body.drift).toEqual({
      entitiesCompared: 3,
      driftedEntities: 3,
      statusDrifted: 3,
      metricsDrifted: 2,
    })
  })

  it('never mutates provider or local state: only read methods are called and stored rows are untouched', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      adGroups: [liveEntity('adgrp_1', 'active')],
      ads: [liveEntity('ad_1', 'active')],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    expect([...new Set(ctx.readerCalls.map((call) => call.method))].sort()).toEqual([
      'adGroupInsights', 'campaignInsights', 'listAdGroups', 'listAds', 'listCampaigns',
    ])
    // The stale snapshot is evidence, not something the diagnostic repairs.
    const storedCampaign = ctx.db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_1')).get()
    expect(storedCampaign?.status).toBe('paused')
    const storedRollup = ctx.db.select().from(adsInsightsDaily)
      .where(eq(adsInsightsDaily.date, '2026-06-10')).get()
    expect(storedRollup?.impressions).toBe(111)
  })

  it('marks a stored entity absent upstream only when the walk was complete', async () => {
    await start({ campaigns: [], adGroups: [], ads: [] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(body.bounds.truncated).toBe(false)
    expect(body.entities.map((entity) => entity.presence)).toEqual([
      'stored-only', 'stored-only', 'stored-only',
    ])
    expect(body.entities.every((entity) => entity.drifted)).toBe(true)
    // No metric claim is made for an entity the provider does not have.
    expect(body.entities.every((entity) => entity.metricDeltas === null)).toBe(true)
  })

  it('caps the walk and suppresses stored-only rows once the result is truncated', async () => {
    const campaigns = Array.from({ length: 7 }, (_, index) => liveEntity(`cmpn_x${index}`, 'active'))
    await start({ campaigns, adGroups: [], ads: [] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(body.bounds.truncated).toBe(true)
    expect(body.bounds.maxCampaigns).toBe(5)
    expect(body.entities).toHaveLength(5)
    expect(body.entities.every((entity) => entity.presence === 'live-only')).toBe(true)
    // cmpn_1 / adgrp_1 / ad_1 exist locally but were never walked, so the
    // response must not imply the provider deleted them.
    expect(body.entities.some((entity) => entity.id === 'cmpn_1')).toBe(false)
  })

  it('scopes the walk to one campaign and honors the metrics window', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active'), liveEntity('cmpn_2', 'active')],
      adGroups: [],
      ads: [],
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/live-delivery?campaignId=cmpn_1&lookbackDays=1',
    })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    expect(body.metricsWindow).toEqual({ lookbackDays: 1 })
    // cmpn_2 is out of scope entirely; the scoped campaign's stored children
    // are still compared, and the provider reporting none makes them
    // stored-only.
    expect(body.entities.map((entity) => entity.id)).toEqual(['cmpn_1', 'adgrp_1', 'ad_1'])
    expect(body.entities.map((entity) => entity.presence)).toEqual([
      'both', 'stored-only', 'stored-only',
    ])
    expect(ctx.readerCalls.filter((call) => call.method === 'campaignInsights'))
      .toEqual([{ method: 'campaignInsights', apiKey: API_KEY, entityId: 'cmpn_1' }])
  })

  it('rejects an invalid lookback window', async () => {
    await start()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/live-delivery?lookbackDays=90',
    })

    expect(res.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])
  })

  it('throttles a second live read for the same project and reports the wait', async () => {
    await start({ campaigns: [], minIntervalMs: 60_000 })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const first = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(first.statusCode).toBe(200)

    vi.setSystemTime(new Date(Date.parse(NOW) + 20_000))
    const second = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(second.statusCode).toBe(429)
    const body = JSON.parse(second.body) as { error: { code: string; details?: Record<string, number> } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')
    expect(body.error.details).toMatchObject({ minIntervalMs: 60_000, retryAfterMs: 40_000 })
    expect(ctx.readerCalls.filter((call) => call.method === 'listCampaigns')).toHaveLength(1)

    vi.setSystemTime(new Date(Date.parse(NOW) + 60_001))
    const third = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    expect(third.statusCode).toBe(200)
  })

  it('400s a project with no ads connection without calling the provider', async () => {
    await start()
    ctx.seedProject()

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])
  })

  it('refuses to label live rows with the wrong account when the key moved', async () => {
    await start({ verifiedAccountId: 'adacct_other', campaigns: [liveEntity('cmpn_1', 'active')] })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(400)
    expect(ctx.readerCalls).toEqual([])
  })

  it('records a failed sub-read without its provider message and keeps the rest of the walk', async () => {
    await start({
      campaigns: [liveEntity('cmpn_1', 'active')],
      readerError: undefined,
    })
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    // Fail only the ad-group listing; everything else still resolves.
    ctx.reader.listAdGroups = async () => {
      throw Object.assign(new Error(`upstream rejected Authorization: Bearer ${API_KEY}`), { status: 503 })
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto

    expect(res.statusCode).toBe(200)
    expect(body.errors).toEqual([
      { surface: 'ad group list', entityId: 'cmpn_1', upstreamStatus: 503 },
    ])
    expect(body.entities.map((entity) => entity.id)).toEqual(['cmpn_1'])
    expect(res.body).not.toContain(API_KEY)
  })
})

describe('live delivery credential safety', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  /** An upstream failure that embeds the credential everywhere it could. */
  function hostileError(): Error {
    const error = new Error(`401 unauthorized for Authorization: Bearer ${API_KEY}`)
    return Object.assign(error, {
      status: 401,
      code: API_KEY,
      body: { requestUrl: `https://api.ads.openai.com/v1/campaigns?api_key=${API_KEY}` },
      response: { headers: { authorization: `Bearer ${API_KEY}` } },
    })
  }

  it('never serializes the credential on the success path', async () => {
    ctx = buildApp({
      campaigns: [liveEntity('cmpn_1', 'active', { name: 'Homeowners Free Estimate' })],
      adGroups: [liveEntity('adgrp_1', 'active')],
      ads: [liveEntity('ad_1', 'active')],
      campaignMetrics: [metricRow('2026-06-10', { impressions: 1, spend: 0.5 })],
      adGroupMetrics: [metricRow('2026-06-10', { impressions: 1, spend: 0.5 })],
    })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedStaleSnapshot(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    // The reader DOES receive the key — that is the whole point of a
    // server-side passthrough — but nothing it touches reaches the caller.
    expect(ctx.readerCalls.every((call) => call.apiKey === API_KEY)).toBe(true)
    expect(res.body).not.toContain(API_KEY)
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })

  it('never serializes or logs the credential when the provider read fails', async () => {
    ctx = buildApp({ readerError: hostileError() })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body) as { error: { code: string; message: string; details?: unknown } }
    expect(body.error.code).toBe('PROVIDER_ERROR')
    expect(body.error.message).toBe('OpenAI Ads API campaign list read failed')
    expect(body.error.details).toEqual({ upstreamStatus: 401 })
    expect(res.body).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })

  it('never serializes or logs the credential when account verification fails', async () => {
    ctx = buildApp({ verifyError: hostileError() })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body) as { error: { message: string } }
    expect(body.error.message).toBe('OpenAI Ads API account identity read failed')
    expect(res.body).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })

  it('never serializes or logs the credential when a per-entity read fails', async () => {
    ctx = buildApp({ campaigns: [liveEntity('cmpn_1', 'active')] })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.reader.campaignInsights = async () => {
      throw hostileError()
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/live-delivery' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as AdsLiveDeliveryDto
    expect(body.errors).toEqual([
      { surface: 'campaign insights', entityId: 'cmpn_1', upstreamStatus: 401 },
    ])
    expect(res.body).not.toContain(API_KEY)
    expect(ctx.logLines.join('\n')).not.toContain(API_KEY)
  })
})
