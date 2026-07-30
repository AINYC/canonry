import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { createClient, migrate } from '../src/index.js'

function tempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gsc-platform-properties-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.$client.prepare(`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES ('p1', 'project', 'Project', 'example.com', 'US', 'en', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()
  db.$client.prepare(`INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
    VALUES ('run1', 'p1', 'gsc-sync', 'completed', 'manual', '2026-07-30T00:00:00Z')`).run()
  return { db, tmpDir }
}

describe('GSC platform-property migration', () => {
  test('creates isolated platform tables and rejects duplicate project + site URL properties', () => {
    const { db, tmpDir } = tempDb()
    try {
      db.$client.prepare(`INSERT INTO gsc_platform_properties (id, project_id, site_url, platform, kind, status, created_at, updated_at)
        VALUES ('property1', 'p1', '123456789', 'youtube', 'social-video', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()
      expect(() => db.$client.prepare(`INSERT INTO gsc_platform_properties (id, project_id, site_url, platform, kind, status, created_at, updated_at)
        VALUES ('property2', 'p1', '123456789', 'youtube', 'social-video', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()).toThrow(/UNIQUE/i)

      for (const table of ['gsc_platform_search_data', 'gsc_platform_daily_totals', 'gsc_platform_query_daily_totals']) {
        expect(db.$client.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)).toBeTruthy()
      }
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('enforces property, project, and run foreign keys with cascade deletes', () => {
    const { db, tmpDir } = tempDb()
    try {
      db.$client.prepare(`INSERT INTO gsc_platform_properties (id, project_id, site_url, platform, kind, status, created_at, updated_at)
        VALUES ('property1', 'p1', '123456789', 'youtube', 'social-video', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()
      db.$client.prepare(`INSERT INTO gsc_platform_search_data (id, property_id, project_id, sync_run_id, date, query, page, clicks, impressions, ctr, position, created_at)
        VALUES ('search1', 'property1', 'p1', 'run1', '2026-07-30', 'canonry', 'https://youtube.com/watch?v=x', 1, 10, '0.1', '4', '2026-07-30T00:00:00Z')`).run()
      db.$client.prepare(`INSERT INTO gsc_platform_daily_totals (id, property_id, project_id, sync_run_id, date, clicks, impressions, position, created_at)
        VALUES ('daily1', 'property1', 'p1', 'run1', '2026-07-30', 1, 10, '4', '2026-07-30T00:00:00Z')`).run()
      db.$client.prepare(`INSERT INTO gsc_platform_query_daily_totals (id, property_id, project_id, sync_run_id, date, query, clicks, impressions, position, synced_at, created_at)
        VALUES ('query1', 'property1', 'p1', 'run1', '2026-07-30', 'canonry', 1, 10, '4', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()

      db.$client.prepare(`DELETE FROM runs WHERE id = 'run1'`).run()
      for (const table of ['gsc_platform_search_data', 'gsc_platform_daily_totals', 'gsc_platform_query_daily_totals']) {
        expect(db.$client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
      }

      const fks = db.$client.prepare(`PRAGMA foreign_key_list(gsc_platform_daily_totals)`).all() as Array<{ from: string; table: string; on_delete: string }>
      expect(Object.fromEntries(fks.map((fk) => [fk.from, fk]))).toMatchObject({
        property_id: { table: 'gsc_platform_properties', on_delete: 'CASCADE' },
        project_id: { table: 'projects', on_delete: 'CASCADE' },
        sync_run_id: { table: 'runs', on_delete: 'CASCADE' },
      })
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('rejects child rows whose property or run belongs to another project', () => {
    const { db, tmpDir } = tempDb()
    try {
      db.$client.prepare(`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
        VALUES ('p2', 'other', 'Other', 'other.example.com', 'US', 'en', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()
      db.$client.prepare(`INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
        VALUES ('run2', 'p2', 'gsc-sync', 'completed', 'manual', '2026-07-30T00:00:00Z')`).run()
      db.$client.prepare(`INSERT INTO gsc_platform_properties (id, project_id, site_url, platform, kind, status, created_at, updated_at)
        VALUES ('property1', 'p1', '123456789', 'youtube', 'social-video', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`).run()

      expect(() => db.$client.prepare(`INSERT INTO gsc_platform_daily_totals
        (id, property_id, project_id, sync_run_id, date, clicks, impressions, position, created_at)
        VALUES ('wrong-project', 'property1', 'p2', 'run2', '2026-07-30', 1, 10, '4', '2026-07-30T00:00:00Z')`).run()).toThrow(/FOREIGN KEY/i)
      expect(() => db.$client.prepare(`INSERT INTO gsc_platform_daily_totals
        (id, property_id, project_id, sync_run_id, date, clicks, impressions, position, created_at)
        VALUES ('wrong-run', 'property1', 'p1', 'run2', '2026-07-30', 1, 10, '4', '2026-07-30T00:00:00Z')`).run()).toThrow(/FOREIGN KEY/i)
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
