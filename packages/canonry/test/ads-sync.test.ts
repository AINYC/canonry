import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  runs,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
} from '@ainyc/canonry-db'
import {
  executeAdsSync,
  liveAdsInsightHourRange,
  trailingAdsInsightHourRange,
} from '../src/ads-sync.js'
import type { CanonryConfig } from '../src/config.js'

const NOW = '2026-06-10T00:00:00.000Z'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-sync-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seed(db: ReturnType<typeof createTempDb>) {
  db.insert(projects).values({
    id: 'proj_1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme-exteriors.example',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(adsConnections).values({
    id: 'conn_1', projectId: 'proj_1', adAccountId: 'adacct_aaa', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'run_1', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
  }).run()
}

function testConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:3000',
    database: ':memory:',
    apiKey: 'cnry_test',
    openaiAds: {
      connections: [
        { projectName: 'acme', apiKey: 'sk-ads-test', adAccountId: 'adacct_aaa', createdAt: NOW, updatedAt: NOW },
      ],
    },
  }
}

// Response shapes mirror real captured Advertiser API responses (sanitized).
const ACCOUNT = {
  id: 'adacct_aaa', status: 'active', name: 'Acme Exteriors, Inc',
  currency_code: 'USD', timezone: 'America/Denver', url: 'https://acme-exteriors.example/',
  review: { status: 'in_review' },
  account_integrity_review: {
    review: { status: 'approved' },
    details: { decision: 'allowed', reason: 'Low risk', status_updated_at: '2026-06-03T18:57:34.397908+00:00' },
  },
}
const CAMPAIGN = {
  id: 'cmpn_bbb', created_at: 1780770653, status: 'active', bidding_type: 'clicks',
  budget: { daily_spend_limit_micros: 150_000_000 }, conversion_event_setting_ids: [],
  description: null, end_time: null, landing_page_configuration: null, mode: null,
  name: 'Homeowners Free Estimate', start_time: 1780770127,
  targeting: { locations: { include: [] } }, updated_at: 1780868842,
}
const AD_GROUP = {
  id: 'adgrp_ddd', created_at: 1780770657, status: 'active',
  bidding_config: { billing_event_type: 'click', max_bid_micros: 2_000_000 },
  context_hints: ['how much does a new deck cost\nmeasure my yard'],
  description: null, name: 'Deck Project Planning', product_set: null, updated_at: 1780864410,
}
const AD = {
  id: 'ad_eee', created_at: 1780770662, status: 'active',
  creative: { type: 'chat_card', title: 'Free Estimate', body: 'b', file_id: 'file_1', target_url: 'https://lp.example/' },
  name: 'HO Deck - Materials', review: { status: 'approved' }, review_status: 'approved', updated_at: 1781139491,
}
const CAMPAIGN_INSIGHTS = [
  { id: 'r1', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326, clicks: 40, spend: 90.45 },
  { id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 1736, clicks: 23, spend: 39.28 },
]
const AD_GROUP_INSIGHTS = [
  { id: 'r3', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 64, clicks: 1, spend: 0.57 },
]

function list(data: unknown[]) {
  return { object: 'list', data, first_id: null, last_id: null, has_more: false }
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const u = String(url)
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
    if (u.endsWith('/ad_account')) return respond(ACCOUNT)
    if (u.includes('/campaigns/cmpn_bbb/insights')) return respond(list(CAMPAIGN_INSIGHTS))
    if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(AD_GROUP_INSIGHTS))
    if (u.includes('/campaigns')) return respond(list([CAMPAIGN]))
    if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
    if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
    throw new Error(`unexpected URL in test: ${u}`)
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('executeAdsSync', () => {
  it('runs the trailing range through the END of the account current local day', () => {
    // 17:37 UTC is 13:37 in New York. The upper edge used to be that same
    // local hour, which leaves the current day's own end boundary (the next
    // local midnight) outside the range. The provider only reports a daily
    // bucket its range fully covers, so today was omitted from every sync and
    // the stored totals ran a whole day behind the provider's own UI.
    expect(trailingAdsInsightHourRange(
      new Date('2026-07-21T17:37:00.000Z'),
      'America/New_York',
    )).toEqual({
      type: 'hour_range',
      // Unchanged: only the upper edge moves, so the 90-day backfill window is
      // exactly the window it always was.
      since: '2026-04-22T13',
      until: '2026-07-22T00',
      timezone: 'America/New_York',
    })
  })

  it('closes the day at the first hour the NEXT local day actually has', () => {
    // America/Santiago springs forward AT midnight into 2026-09-06: the clock
    // goes 23:59:59 -> 01:00:00, so that day has no hour 00 and the edge that
    // closes 09-05 is 09-06 at 01:00. Naming "2026-09-06T00" would ask the
    // provider about a wall-clock hour its own calendar never had.
    const at = new Date('2026-09-05T20:00:00.000Z') // 16:00 local on 09-05
    expect(trailingAdsInsightHourRange(at, 'America/Santiago').until).toBe('2026-09-06T01')
    expect(liveAdsInsightHourRange({
      startDate: '2026-09-05',
      fetchedAtMs: at.getTime(),
      timezone: 'America/Santiago',
    })).toEqual({
      type: 'hour_range',
      since: '2026-09-05T00',
      until: '2026-09-06T01',
      timezone: 'America/Santiago',
    })
  })

  it('closes a 25-hour fall-back day on the next date, not 24 hours later', () => {
    // America/New_York repeats 01:00 on 2026-11-01, so that local day is 25
    // hours long. Adding a fixed 24 hours to its start lands back INSIDE
    // 11-01, which would close the day on itself and drop it again.
    const at = new Date('2026-11-01T18:00:00.000Z') // 13:00 local on 11-01
    expect(trailingAdsInsightHourRange(at, 'America/New_York').until).toBe('2026-11-02T00')
    expect(liveAdsInsightHourRange({
      startDate: '2026-10-30',
      fetchedAtMs: at.getTime(),
      timezone: 'America/New_York',
    }).until).toBe('2026-11-02T00')
    // The 23-hour spring-forward day at the other end of the same zone.
    expect(trailingAdsInsightHourRange(
      new Date('2026-03-08T17:00:00.000Z'),
      'America/New_York',
    ).until).toBe('2026-03-09T00')
  })

  it('builds a live insight range from the request only, never from the clock', () => {
    const request = {
      startDate: '2026-07-14',
      fetchedAtMs: Date.parse('2026-07-21T17:37:00.000Z'),
      timezone: 'America/New_York',
    }
    const expected = {
      type: 'hour_range',
      // The start of the window's first local day: that day is a WHOLE day
      // upstream, so it is comparable with the whole-day stored rollup.
      since: '2026-07-14T00',
      // And the end of the window's LAST local day, so the day in progress is
      // a whole bucket upstream too and comes back at all.
      until: '2026-07-22T00',
      timezone: 'America/New_York',
    }

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-21T17:37:00.000Z'))
      expect(liveAdsInsightHourRange(request)).toEqual(expected)
      // A walk that crosses an account-local hour still measures the same
      // range: the anchor is the frozen instant the route issued the read at,
      // and the reported `fetchedAt` therefore describes every call in it.
      vi.setSystemTime(new Date('2026-07-21T18:41:00.000Z'))
      expect(liveAdsInsightHourRange(request)).toEqual(expected)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the live range at the first local hour the account timezone actually has', () => {
    // America/Santiago springs forward AT midnight on 2026-09-06: the clock
    // goes 23:59:59 -> 01:00:00, so local hour 00 does not exist that day and
    // "2026-09-06T00" would name a wall-clock hour the account never had.
    expect(liveAdsInsightHourRange({
      startDate: '2026-09-06',
      fetchedAtMs: Date.parse('2026-09-08T12:00:00.000Z'),
      timezone: 'America/Santiago',
    }).since).toBe('2026-09-06T01')

    // Same day, an ordinary account: nothing moves. The fix must not shift the
    // window for the accounts that were always fine.
    expect(liveAdsInsightHourRange({
      startDate: '2026-09-06',
      fetchedAtMs: Date.parse('2026-09-08T12:00:00.000Z'),
      timezone: 'America/New_York',
    }).since).toBe('2026-09-06T00')

    // And a normal account on ITS OWN spring-forward day, where the gap is at
    // 02:00 local: midnight is intact, so the window still starts at hour 00.
    expect(liveAdsInsightHourRange({
      startDate: '2026-03-08',
      fetchedAtMs: Date.parse('2026-03-10T12:00:00.000Z'),
      timezone: 'America/New_York',
    }).since).toBe('2026-03-08T00')
  })

  it('snapshots entities, normalizes insights spend to micros, and completes the run', async () => {
    const db = createTempDb()
    seed(db)

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })

    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('completed')

    const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(campaign?.name).toBe('Homeowners Free Estimate')
    expect(campaign?.dailySpendLimitMicros).toBe(150_000_000)
    expect(campaign?.conversionEventSettingIds).toEqual([])

    const group = db.select().from(adsAdGroups).where(eq(adsAdGroups.id, 'adgrp_ddd')).get()
    expect(group?.campaignId).toBe('cmpn_bbb')
    expect(group?.contextHints).toEqual(['how much does a new deck cost\nmeasure my yard'])
    expect(group?.maxBidMicros).toBe(2_000_000)

    const ad = db.select().from(adsAds).where(eq(adsAds.id, 'ad_eee')).get()
    expect(ad?.adGroupId).toBe('adgrp_ddd')
    expect(ad?.reviewStatus).toBe('approved')

    const insightRows = db.select().from(adsInsightsDaily).all()
    // 2 campaign-level days + 1 ad-group-level day
    expect(insightRows.length).toBe(3)
    const campaignDay = insightRows.find((r) => r.level === 'campaign' && r.date === '2026-06-10')
    // decimal dollars from the API → integer micros in the rollup
    expect(campaignDay?.spendMicros).toBe(39_280_000)
    expect(campaignDay?.impressions).toBe(1736)
    expect(campaignDay?.clicks).toBe(23)
    // No conversions field on the insight rows → defaults to 0 (the API omits
    // it when the account has no conversion tracking).
    expect(campaignDay?.conversions).toBe(0)
    const groupDay = insightRows.find((r) => r.level === 'ad_group')
    expect(groupDay?.entityId).toBe('adgrp_ddd')
    expect(groupDay?.spendMicros).toBe(570_000)

    const conn = db.select().from(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).get()
    expect(conn?.displayName).toBe('Acme Exteriors, Inc')
    expect(conn?.currencyCode).toBe('USD')
    expect(conn?.status).toBe('active')
    expect(conn?.reviewStatus).toBe('in_review')
    expect(conn?.integrityReviewStatus).toBe('approved')
    expect(conn?.integrityDecision).toBe('allowed')
    expect(conn?.lastSyncedAt).toBeTruthy()
    // CAMPAIGN carries an empty conversion_event_setting_ids → tracking off.
    expect(conn?.conversionTrackingConfigured).toBe(false)
  })

  it('captures conversion counts and flags the connection when conversion tracking is configured', async () => {
    const db = createTempDb()
    seed(db)

    // A conversion-tracking account: the campaign carries a configured event id
    // and the insight rows return a conversions metric (fractional attribution
    // figures round to the integer column).
    const trackedCampaign = { ...CAMPAIGN, conversion_event_setting_ids: ['cevent_1111'] }
    const trackedCampaignInsights = [
      { id: 'r1', start_time: 1, end_time: 2, readable_time: '2026-06-09', impressions: 3326, clicks: 40, spend: 90.45, conversions: 5 },
      { id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 1736, clicks: 23, spend: 39.28, conversions: 2.6 },
    ]
    const trackedGroupInsights = [
      { id: 'r3', start_time: 2, end_time: 3, readable_time: '2026-06-10', impressions: 64, clicks: 1, spend: 0.57, conversions: 1 },
    ]
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      if (u.includes('/campaigns/cmpn_bbb/insights')) return respond(list(trackedCampaignInsights))
      if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(trackedGroupInsights))
      if (u.includes('/campaigns')) return respond(list([trackedCampaign]))
      if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
      if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
      throw new Error(`unexpected URL in test: ${u}`)
    }

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })

    const insightRows = db.select().from(adsInsightsDaily).all()
    const campaignJun9 = insightRows.find((r) => r.level === 'campaign' && r.date === '2026-06-09')
    expect(campaignJun9?.conversions).toBe(5)
    const campaignJun10 = insightRows.find((r) => r.level === 'campaign' && r.date === '2026-06-10')
    // 2.6 attribution figure → rounds to 3 in the integer column.
    expect(campaignJun10?.conversions).toBe(3)
    const groupDay = insightRows.find((r) => r.level === 'ad_group')
    expect(groupDay?.conversions).toBe(1)

    const conn = db.select().from(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).get()
    expect(conn?.conversionTrackingConfigured).toBe(true)
    const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
    expect(campaign?.conversionEventSettingIds).toEqual(['cevent_1111'])
  })

  it('is idempotent: a re-sync replaces snapshots and upserts insights without duplicating', async () => {
    const db = createTempDb()
    seed(db)

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })
    db.insert(runs).values({
      id: 'run_2', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
    }).run()
    await executeAdsSync(db, 'run_2', 'proj_1', { config: testConfig() })

    expect(db.select().from(adsCampaigns).all().length).toBe(1)
    expect(db.select().from(adsAdGroups).all().length).toBe(1)
    expect(db.select().from(adsAds).all().length).toBe(1)
    expect(db.select().from(adsInsightsDaily).all().length).toBe(3)
  })

  it('overwrites the in-progress day on the next sync rather than duplicating or sticking', async () => {
    const db = createTempDb()
    seed(db)

    // The sync now asks through the end of the account's current local day, so
    // the provider returns that day while it is still filling. The SAME date
    // therefore comes back with bigger numbers on every read, and the rollup
    // row for it has to track them: it is keyed (project, level, entity, date),
    // so a second sync must UPSERT rather than insert a second row or leave the
    // first read's partial figure in place forever.
    let partialDay = {
      id: 'r2', start_time: 2, end_time: 3, readable_time: '2026-06-10',
      impressions: 1736, clicks: 23, spend: 39.28,
    }
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
      if (u.endsWith('/ad_account')) return respond(ACCOUNT)
      if (u.includes('/campaigns/cmpn_bbb/insights')) return respond(list([CAMPAIGN_INSIGHTS[0], partialDay]))
      if (u.includes('/ad_groups/adgrp_ddd/insights')) return respond(list(AD_GROUP_INSIGHTS))
      if (u.includes('/campaigns')) return respond(list([CAMPAIGN]))
      if (u.includes('/ad_groups?campaign_id=cmpn_bbb')) return respond(list([AD_GROUP]))
      if (u.includes('/ads?ad_group_id=adgrp_ddd')) return respond(list([AD]))
      throw new Error(`unexpected URL in test: ${u}`)
    }

    const inProgressRows = () => db.select().from(adsInsightsDaily).all()
      .filter((row) => row.level === 'campaign' && row.date === '2026-06-10')

    await executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })
    expect(inProgressRows()).toHaveLength(1)
    expect(inProgressRows()[0]?.impressions).toBe(1736)
    const firstRowId = inProgressRows()[0]?.id

    // Later the same local day: more delivery has landed on that same date.
    partialDay = { ...partialDay, impressions: 2061, clicks: 31, spend: 55.1 }
    db.insert(runs).values({
      id: 'run_2', projectId: 'proj_1', kind: 'ads-sync', status: 'queued', trigger: 'manual', createdAt: NOW,
    }).run()
    await executeAdsSync(db, 'run_2', 'proj_1', { config: testConfig() })

    const after = inProgressRows()
    // Not duplicated: still exactly one row for the day, and the same row.
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(firstRowId)
    // Not stuck: every metric moved to the newer partial reading, and the row
    // now points at the sync that last wrote it.
    expect(after[0]?.impressions).toBe(2061)
    expect(after[0]?.clicks).toBe(31)
    expect(after[0]?.spendMicros).toBe(55_100_000)
    expect(after[0]?.syncRunId).toBe('run_2')

    // The completed day beside it is untouched by the overwrite.
    const completedDay = db.select().from(adsInsightsDaily).all()
      .find((row) => row.level === 'campaign' && row.date === '2026-06-09')
    expect(completedDay?.impressions).toBe(3326)
  })

  it('fails the run when no config credential exists for the project', async () => {
    const db = createTempDb()
    seed(db)
    const config = testConfig()
    config.openaiAds = undefined

    await expect(executeAdsSync(db, 'run_1', 'proj_1', { config })).rejects.toThrow(/connect/i)
    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('failed')
  })

  it('fails the run when no connection row exists', async () => {
    const db = createTempDb()
    seed(db)
    db.delete(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).run()

    await expect(executeAdsSync(db, 'run_1', 'proj_1', { config: testConfig() })).rejects.toThrow(/connect/i)
    const run = db.select().from(runs).where(eq(runs.id, 'run_1')).get()
    expect(run?.status).toBe('failed')
  })
})
