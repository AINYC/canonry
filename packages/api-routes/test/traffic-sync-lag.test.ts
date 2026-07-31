import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, trafficSources, crawlerEventsHourly } from '@ainyc/canonry-db'
import { TRAFFIC_SOURCE_CHECKS } from '../src/doctor/checks/traffic-source.js'
import {
  resolveVercelSyncDeadlineMs,
  DEFAULT_VERCEL_SYNC_DEADLINE_MS,
  VERCEL_MAX_SYNC_WINDOW_MS,
  TRAFFIC_SOURCE_MAX_CATCHUP_MS,
} from '../src/traffic-limits.js'
import type { DoctorContext } from '../src/doctor/types.js'

// Both Vercel traffic sources silently fell ~24h behind: every sync completed,
// `status` stayed `connected`, `lastError` stayed empty, and once the watermark
// passed the 24h single-sync reach each sync began discarding the oldest traffic
// instead of ingesting it. Nothing surfaced it. These tests pin the signal that
// makes that condition visible while the data is still recoverable.

const syncLagCheck = TRAFFIC_SOURCE_CHECKS.find(c => c.id === 'traffic.source.sync-lag')!
const recentDataCheck = TRAFFIC_SOURCE_CHECKS.find(c => c.id === 'traffic.source.recent-data')!

function seed(opts: { lagMs: number | null; sourceType?: string; withRecentEvents?: boolean }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-lag-'))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date()
  const projectId = crypto.randomUUID()
  const sourceId = crypto.randomUUID()
  const iso = now.toISOString()

  db.insert(projects).values({
    id: projectId, name: 'lagproj', displayName: 'Lag', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: [], createdAt: iso, updatedAt: iso,
  }).run()

  db.insert(trafficSources).values({
    id: sourceId, projectId,
    sourceType: opts.sourceType ?? 'vercel',
    displayName: 'Vercel (example.com)',
    status: 'connected',
    lastSyncedAt: opts.lagMs === null ? null : new Date(now.getTime() - opts.lagMs).toISOString(),
    lastError: null,
    createdAt: iso, updatedAt: iso,
  }).run()

  if (opts.withRecentEvents) {
    // A full week of healthy-looking event data, exactly as the real sources had.
    for (let hoursAgo = 24; hoursAgo < 24 * 7; hoursAgo += 6) {
      db.insert(crawlerEventsHourly).values({
        projectId, sourceId,
        tsHour: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
        botId: 'gptbot', operator: 'openai', verificationStatus: 'verified',
        pathNormalized: '/', status: 200, hits: 40,
        createdAt: iso, updatedAt: iso,
      }).run()
    }
  }

  const ctx = { db, project: { id: projectId, name: 'lagproj' } } as unknown as DoctorContext
  return { ctx, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

describe('traffic sync lag', () => {
  it('fails once a source is further behind than one sync can reach, because data is being discarded', async () => {
    const { ctx, cleanup } = seed({ lagMs: VERCEL_MAX_SYNC_WINDOW_MS + 30 * 60_000 })
    try {
      const out = await syncLagCheck.run(ctx)
      expect(out.status).toBe('fail')
      expect(out.code).toBe('traffic.sync-lag.discarding')
      expect(out.remediation).toMatch(/backfill/i)
      const first = (out.details as { sources: { discardingOlderTraffic: boolean }[] }).sources[0]!
      expect(first.discardingOlderTraffic).toBe(true)
    } finally { cleanup() }
  })

  it('warns while the source is still behind but recoverable', async () => {
    const { ctx, cleanup } = seed({ lagMs: 5 * 3_600_000 })
    try {
      const out = await syncLagCheck.run(ctx)
      expect(out.status).toBe('warn')
      expect(out.code).toBe('traffic.sync-lag.behind')
      const first = (out.details as { sources: { discardingOlderTraffic: boolean }[] }).sources[0]!
      expect(first.discardingOlderTraffic).toBe(false)
    } finally { cleanup() }
  })

  it('passes a source that is keeping up', async () => {
    const { ctx, cleanup } = seed({ lagMs: 8 * 60_000 })
    try {
      const out = await syncLagCheck.run(ctx)
      expect(out.status).toBe('ok')
      expect(out.code).toBe('traffic.sync-lag.current')
    } finally { cleanup() }
  })

  it('does not claim a cursor-resumable adapter is discarding, however far behind it is', async () => {
    // cloud-run resumes from its cursor, so lag is staleness, never data loss.
    const { ctx, cleanup } = seed({ lagMs: VERCEL_MAX_SYNC_WINDOW_MS * 3, sourceType: 'cloud-run' })
    try {
      const out = await syncLagCheck.run(ctx)
      expect(out.status).toBe('warn')
      expect(out.code).toBe('traffic.sync-lag.behind')
      expect(TRAFFIC_SOURCE_MAX_CATCHUP_MS['cloud-run' as never]).toBeUndefined()
    } finally { cleanup() }
  })

  it('catches the case the existing recent-data check reports healthy', async () => {
    // The real incident: 24h behind and discarding, with a full week of older
    // events. recent-data sums a 7-day window, so it sees data and says ok.
    const { ctx, cleanup } = seed({
      lagMs: VERCEL_MAX_SYNC_WINDOW_MS + 60 * 60_000,
      withRecentEvents: true,
    })
    try {
      const recent = await recentDataCheck.run(ctx)
      expect(recent.status).toBe('ok')
      expect(recent.code).toBe('traffic.recent-data.fresh')

      const lag = await syncLagCheck.run(ctx)
      expect(lag.status).toBe('fail')
    } finally { cleanup() }
  })
})

describe('vercel sync deadline override', () => {
  it('is unset by default so the built-in budget applies', () => {
    expect(resolveVercelSyncDeadlineMs({})).toBeUndefined()
    expect(resolveVercelSyncDeadlineMs({ CANONRY_VERCEL_SYNC_DEADLINE_MS: '' })).toBeUndefined()
    expect(DEFAULT_VERCEL_SYNC_DEADLINE_MS).toBe(4 * 60_000)
  })

  it('accepts a raise, which is the whole point of the knob', () => {
    expect(resolveVercelSyncDeadlineMs({ CANONRY_VERCEL_SYNC_DEADLINE_MS: '600000' })).toBe(600_000)
  })

  it('clamps rather than rejects, so a bad value cannot remove the bound', () => {
    expect(resolveVercelSyncDeadlineMs({ CANONRY_VERCEL_SYNC_DEADLINE_MS: '1' })).toBe(30_000)
    expect(resolveVercelSyncDeadlineMs({ CANONRY_VERCEL_SYNC_DEADLINE_MS: '99999999' })).toBe(15 * 60_000)
    expect(resolveVercelSyncDeadlineMs({ CANONRY_VERCEL_SYNC_DEADLINE_MS: 'abc' })).toBeUndefined()
    expect(resolveVercelSyncDeadlineMs({ CANONRY_VERCEL_SYNC_DEADLINE_MS: '-5' })).toBeUndefined()
  })
})
