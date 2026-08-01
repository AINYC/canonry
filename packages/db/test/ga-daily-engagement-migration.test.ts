import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  gaDailyTotals,
  MIGRATION_VERSIONS,
} from '../src/index.js'

/**
 * v116 widens `ga_daily_totals` with the GA4 engagement + returning-user
 * metrics. Both columns are NULLABLE on purpose: every row written before this
 * migration has no reading for them, and a NOT NULL DEFAULT 0 would turn that
 * absence into a real "0% engaged, 0 returning users" day on a client report.
 */
const V116 = 116

type Db = ReturnType<typeof createClient>

function tempDbPath(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return path.join(tmpDir, 'test.db')
}

function columnNames(dbPath: string, table: string): string[] {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return (raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map(row => row.name)
  } finally {
    raw.close()
  }
}

function appliedVersions(dbPath: string): number[] {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return (raw.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{ version: number }>)
      .map(row => row.version)
  } finally {
    raw.close()
  }
}

function seedProject(db: Db): void {
  db.$client.prepare(
    `INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
     VALUES ('p1','proj','Proj','example.com','US','en','2026-07-20T00:00:00Z','2026-07-20T00:00:00Z')`,
  ).run()
}

/**
 * Inserts naming ONLY the pre-v116 columns. Drizzle's `gaDailyTotals` already
 * declares the new columns, so it cannot write into the table shape a real
 * upgrade starts from.
 */
function seedPreV116Total(db: Db, id: string, date: string, sessions: number, users: number): void {
  db.$client.prepare(
    `INSERT INTO ga_daily_totals (id, project_id, date, sessions, users, synced_at, created_at)
     VALUES (?, 'p1', ?, ?, ?, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')`,
  ).run(id, date, sessions, users)
}

test('a fresh database creates ga_daily_totals with the engagement columns', () => {
  const dbPath = tempDbPath('canonry-ga-engagement-fresh-')
  const db = createClient(dbPath)
  migrate(db)

  expect(columnNames(dbPath, 'ga_daily_totals')).toEqual(
    expect.arrayContaining(['engagement_rate', 'new_users']),
  )
  expect(appliedVersions(dbPath)).toContain(V116)
})

test('upgrading a database that predates the columns adds them and leaves old rows NULL', () => {
  const dbPath = tempDbPath('canonry-ga-engagement-upgrade-')
  const db = createClient(dbPath)

  // The documented downgrade/upgrade seam: a truncated version list is exactly
  // what the previous release's binary would have applied.
  migrate(db, MIGRATION_VERSIONS.filter(mv => mv.version < V116))
  expect(columnNames(dbPath, 'ga_daily_totals')).not.toContain('engagement_rate')

  seedProject(db)
  seedPreV116Total(db, 'r1', '2026-07-20', 1420, 500)

  migrate(db)

  expect(columnNames(dbPath, 'ga_daily_totals')).toEqual(
    expect.arrayContaining(['engagement_rate', 'new_users']),
  )

  const [row] = db.select().from(gaDailyTotals).where(eq(gaDailyTotals.id, 'r1')).all()
  // The historical row survives the ALTER untouched...
  expect(row!.sessions).toBe(1420)
  expect(row!.users).toBe(500)
  // ...and reports the new metrics as unavailable, not as zero.
  expect(row!.engagementRate).toBeNull()
  expect(row!.newUsers).toBeNull()
})

test('running migrate twice is a no-op on an already-migrated database', () => {
  const dbPath = tempDbPath('canonry-ga-engagement-idempotent-')
  const db = createClient(dbPath)
  migrate(db)
  seedProject(db)

  db.insert(gaDailyTotals).values({
    id: 'r1',
    projectId: 'p1',
    date: '2026-07-20',
    sessions: 1420,
    users: 500,
    engagementRate: 0.6234,
    newUsers: 180,
    syncedAt: '2026-07-21T00:00:00Z',
    createdAt: '2026-07-21T00:00:00Z',
  }).run()

  const versionsBefore = appliedVersions(dbPath)

  // A second boot of the same binary must not re-run or duplicate anything.
  expect(() => migrate(db)).not.toThrow()
  migrate(db)

  expect(appliedVersions(dbPath)).toEqual(versionsBefore)
  expect(columnNames(dbPath, 'ga_daily_totals').filter(name => name === 'engagement_rate')).toHaveLength(1)

  const [row] = db.select().from(gaDailyTotals).where(eq(gaDailyTotals.id, 'r1')).all()
  expect(row!.engagementRate).toBeCloseTo(0.6234, 6)
  expect(row!.newUsers).toBe(180)
})

test('ga_daily_totals stores zero distinctly from an unavailable reading', () => {
  const dbPath = tempDbPath('canonry-ga-engagement-zero-')
  const db = createClient(dbPath)
  migrate(db)
  seedProject(db)

  db.insert(gaDailyTotals).values({
    id: 'zero',
    projectId: 'p1',
    date: '2026-07-20',
    sessions: 3,
    users: 2,
    engagementRate: 0,
    newUsers: 0,
    syncedAt: '2026-07-21T00:00:00Z',
    createdAt: '2026-07-21T00:00:00Z',
  }).run()
  db.insert(gaDailyTotals).values({
    id: 'unavailable',
    projectId: 'p1',
    date: '2026-07-19',
    sessions: 3,
    users: 2,
    syncedAt: '2026-07-21T00:00:00Z',
    createdAt: '2026-07-21T00:00:00Z',
  }).run()

  const rows = Object.fromEntries(
    db.select().from(gaDailyTotals).all().map(row => [row.id, row]),
  )
  expect(rows.zero!.engagementRate).toBe(0)
  expect(rows.zero!.newUsers).toBe(0)
  expect(rows.unavailable!.engagementRate).toBeNull()
  expect(rows.unavailable!.newUsers).toBeNull()
})
