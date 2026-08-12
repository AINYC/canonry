import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects, runs, gscSearchData, gscDailyTotals } from '@ainyc/canonry-db'

import { readLatestGscDataDate, resolveGscWindowDays, resolveGscWindowRange } from '../src/gsc-totals.js'

/**
 * Reproduces the real canonry.ai disagreement that motivated the change.
 *
 * On 2026-08-12 the property had published through 2026-08-09 (a 3-day lag).
 * Canonry's now-anchored `30d` covered 07-13..08-09 and reported 1,174
 * impressions; Search Console's `28 days` covered 07-14..08-10 and reported
 * 1,360. Neither range contains the other, so the WIDER window reported FEWER
 * impressions — which is indistinguishable from a real decline.
 */
const TODAY = '2026-08-12'
const LATEST = '2026-08-09'

describe('resolveGscWindowRange', () => {
  it('anchors the range on the last published day, not on today', () => {
    expect(resolveGscWindowRange('30d', LATEST, TODAY)).toEqual({
      startDate: '2026-07-11',
      endDate: '2026-08-09',
      latestDataDate: '2026-08-09',
      reportingLagDays: 3,
    })
  })

  it('covers exactly as many calendar days as its label promises', () => {
    // The inclusive range is the bug's whole surface: a now-anchored 30d
    // delivered 28 days of data under a label that said 30.
    for (const [window, days] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const range = resolveGscWindowRange(window, LATEST, TODAY)
      const spanDays =
        (Date.parse(`${range.endDate!}T00:00:00Z`) - Date.parse(`${range.startDate!}T00:00:00Z`))
        / 86_400_000 + 1
      expect(spanDays).toBe(days)
    }
  })

  it('is monotonic: a wider label always contains a narrower one', () => {
    // This is the property the now-anchored window broke. It has to hold for
    // ANY lag, including a lag longer than the shortest window.
    for (const lagDays of [0, 1, 2, 3, 7, 30]) {
      const latest = new Date(Date.parse(`${TODAY}T00:00:00Z`) - lagDays * 86_400_000)
        .toISOString().slice(0, 10)
      const week = resolveGscWindowRange('7d', latest, TODAY)
      const month = resolveGscWindowRange('30d', latest, TODAY)
      const quarter = resolveGscWindowRange('90d', latest, TODAY)
      expect(month.startDate! <= week.startDate!).toBe(true)
      expect(quarter.startDate! <= month.startDate!).toBe(true)
      // All three end on the same published day, so each is a strict superset.
      expect(week.endDate).toBe(latest)
      expect(month.endDate).toBe(latest)
      expect(quarter.endDate).toBe(latest)
    }
  })

  it('reports the lag it measured', () => {
    expect(resolveGscWindowRange('7d', '2026-08-12', TODAY).reportingLagDays).toBe(0)
    expect(resolveGscWindowRange('7d', '2026-08-10', TODAY).reportingLagDays).toBe(2)
    // A property that somehow published ahead of today is clamped, not negative.
    expect(resolveGscWindowRange('7d', '2026-08-20', TODAY).reportingLagDays).toBe(0)
  })

  it('steps calendar dates, so a month boundary does not lose a day', () => {
    // 7 inclusive days ending 2026-03-02 is 2026-02-24 — only correct if the
    // step is calendar arithmetic rather than a fixed 24h subtraction.
    expect(resolveGscWindowRange('7d', '2026-03-02', '2026-03-04').startDate).toBe('2026-02-24')
    // Across a leap day.
    expect(resolveGscWindowRange('7d', '2028-03-02', '2028-03-04').startDate).toBe('2028-02-25')
  })

  it('leaves `all` unbounded below but still stops at the published day', () => {
    expect(resolveGscWindowRange('all', LATEST, TODAY)).toEqual({
      startDate: null,
      endDate: '2026-08-09',
      latestDataDate: '2026-08-09',
      reportingLagDays: 3,
    })
  })

  it('falls back to a now-anchored cutoff when the project has no data at all', () => {
    // With no anchor there is nothing to anchor ON. Returning an unbounded
    // range instead would turn an empty project into a full-history scan.
    expect(resolveGscWindowRange('30d', null, TODAY)).toEqual({
      startDate: '2026-07-13',
      endDate: null,
      latestDataDate: null,
      reportingLagDays: null,
    })
  })
})

describe('readLatestGscDataDate', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-window-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    const now = '2026-08-12T00:00:00.000Z'
    db.insert(projects).values({
      id: projectId, name: 'perf', displayName: 'Perf', canonicalDomain: 'perf.example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedDimensioned(date: string) {
    const syncRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: syncRunId, projectId, kind: 'gsc-sync', status: 'completed', trigger: 'manual',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId, date, query: 'q', page: '/p',
      country: 'usa', device: 'DESKTOP', impressions: 10, clicks: 1, ctr: '0.1', position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  function seedProperty(date: string) {
    db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, clicks: 1, impressions: 10, position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  it('returns null for a project with no GSC data', () => {
    expect(readLatestGscDataDate(db, projectId)).toBeNull()
  })

  it('reads the property table when it is the only source', () => {
    seedProperty('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')
  })

  it('reads the dimensioned table for a project that predates property totals', () => {
    seedDimensioned('2026-08-08')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-08')
  })

  it('takes the later of the two, so the anchor never sits behind returned data', () => {
    // The two tables sync independently. Anchoring on the property table alone
    // would cut off dimensioned dates the endpoint is about to serve.
    seedProperty('2026-08-05')
    seedDimensioned('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')

    seedProperty('2026-08-11')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-11')
  })
})

describe('resolveGscWindowDays', () => {
  it('anchors a bare day count the same way a label does', () => {
    // The suggested-queries basket hard-codes 28 days to mirror Google's
    // default. Under a 3-day lag the now-anchored version delivered 25.
    expect(resolveGscWindowDays(28, LATEST, TODAY)).toEqual({
      startDate: '2026-07-13',
      endDate: '2026-08-09',
      latestDataDate: '2026-08-09',
      reportingLagDays: 3,
    })
  })

  it('agrees with the labelled resolver on the same span', () => {
    expect(resolveGscWindowDays(30, LATEST, TODAY)).toEqual(resolveGscWindowRange('30d', LATEST, TODAY))
    expect(resolveGscWindowDays(7, LATEST, TODAY)).toEqual(resolveGscWindowRange('7d', LATEST, TODAY))
  })

  it('covers exactly the requested number of inclusive days', () => {
    const range = resolveGscWindowDays(28, LATEST, TODAY)
    const spanDays =
      (Date.parse(`${range.endDate!}T00:00:00Z`) - Date.parse(`${range.startDate!}T00:00:00Z`))
      / 86_400_000 + 1
    expect(spanDays).toBe(28)
  })

  it('falls back to a now-anchored cutoff with no data', () => {
    expect(resolveGscWindowDays(28, null, TODAY)).toEqual({
      startDate: '2026-07-15',
      endDate: null,
      latestDataDate: null,
      reportingLagDays: null,
    })
  })
})
