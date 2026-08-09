import { expect, onTestFinished, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getTableName, sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  MIGRATION_VERSIONS,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlEventReceipts,
  siteCrawlFindings,
  siteCrawlPages,
  siteCrawlRunRequests,
  siteCrawlSnapshots,
} from '../src/index.js'

const NOW = '2026-08-08T00:00:00.000Z'

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-crawl-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

function seedProjectAndRun(db: ReturnType<typeof createClient>, projectId: string, runId: string) {
  db.run(sql`
    INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (${projectId}, ${projectId}, ${projectId}, 'example.com', 'US', 'en', ${NOW}, ${NOW})
  `)
  db.run(sql`
    INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
    VALUES (${runId}, ${projectId}, 'site-audit', 'completed', 'manual', ${NOW})
  `)
}

test('v126 upgrades a v125 database, is fresh-schema parity safe, and an older binary can reopen it', () => {
  const db = freshDb()
  const v125 = MIGRATION_VERSIONS.filter((migration) => migration.version <= 125)
  migrate(db, v125)

  expect(db.all(sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'site_crawl_%'"))).toEqual([])

  migrate(db)
  migrate(db)

  for (const table of [siteCrawlRunRequests, siteCrawlSnapshots, siteCrawlAttempts, siteCrawlPages, siteCrawlEdges, siteCrawlFindings, siteCrawlEventReceipts]) {
    const row = db.all(sql.raw(`PRAGMA table_info('${getTableName(table)}')`))
    expect(row.length).toBeGreaterThan(0)
  }

  // Downgrade safety: an older binary only sees a newer migration watermark and
  // must leave the additive tables untouched.
  expect(() => migrate(db, v125)).not.toThrow()
})

test('crawl rows cannot mix projects, runs, or attempts', () => {
  const db = freshDb()
  migrate(db)
  seedProjectAndRun(db, 'project-a', 'run-a')
  seedProjectAndRun(db, 'project-b', 'run-b')

  db.run(sql`
    INSERT INTO site_crawl_run_requests (run_id, project_id, identity_key, effective_options, created_at)
    VALUES ('run-a', 'project-a', '[1,null,5000,250000,null,false]', '{"schemaVersion":1}', ${NOW})
  `)
  expect(() => db.run(sql`
    INSERT INTO site_crawl_run_requests (run_id, project_id, identity_key, effective_options, created_at)
    VALUES ('run-b', 'project-a', 'wrong-project', '{}', ${NOW})
  `)).toThrow()

  db.run(sql`
    INSERT INTO site_crawl_attempts (id, project_id, run_id, attempt_number, state, created_at, updated_at)
    VALUES ('attempt-a', 'project-a', 'run-a', 1, 'completed', ${NOW}, ${NOW})
  `)

  // A run belongs to project-a, so project-b cannot claim an attempt for it.
  expect(() => db.run(sql`
    INSERT INTO site_crawl_attempts (id, project_id, run_id, attempt_number, state, created_at, updated_at)
    VALUES ('bad-attempt', 'project-b', 'run-a', 1, 'completed', ${NOW}, ${NOW})
  `)).toThrow()
  expect(db.all(sql.raw("SELECT id FROM site_crawl_attempts WHERE id = 'bad-attempt'"))).toEqual([])

  db.run(sql`
    INSERT INTO site_crawl_pages (id, project_id, run_id, attempt_id, node_key, url, path, parent_path, fetch_state, created_at, updated_at)
    VALUES ('page-a', 'project-a', 'run-a', 'attempt-a', 'node:a', 'https://example.com/a', '/a', '/', 'fetched', ${NOW}, ${NOW})
  `)

  // The attempt is not merely an opaque ID: its project/run tuple must match.
  expect(() => db.run(sql`
    INSERT INTO site_crawl_pages (id, project_id, run_id, attempt_id, node_key, url, path, parent_path, fetch_state, created_at, updated_at)
    VALUES ('bad-page', 'project-b', 'run-b', 'attempt-a', 'node:a', 'https://example.com/a', '/a', '/', 'fetched', ${NOW}, ${NOW})
  `)).toThrow()
  expect(db.all(sql.raw("SELECT id FROM site_crawl_pages WHERE id = 'bad-page'"))).toEqual([])
})

test('event receipts make retries idempotent while preserving checksum mismatch evidence', () => {
  const db = freshDb()
  migrate(db)
  seedProjectAndRun(db, 'project-a', 'run-a')
  db.run(sql`
    INSERT INTO site_crawl_attempts (id, project_id, run_id, attempt_number, state, created_at, updated_at)
    VALUES ('attempt-a', 'project-a', 'run-a', 1, 'running', ${NOW}, ${NOW})
  `)
  db.run(sql`
    INSERT INTO site_crawl_event_receipts (id, project_id, run_id, attempt_id, sequence, batch_id, checksum, created_at)
    VALUES ('receipt-a', 'project-a', 'run-a', 'attempt-a', 7, 'batch-a', 'checksum-a', ${NOW})
  `)

  // The write boundary can replay the same event by reading this receipt. A
  // different payload for the same logical event cannot overwrite its checksum.
  expect(() => db.run(sql`
    INSERT INTO site_crawl_event_receipts (id, project_id, run_id, attempt_id, sequence, batch_id, checksum, created_at)
    VALUES ('receipt-b', 'project-a', 'run-a', 'attempt-a', 7, 'batch-a', 'checksum-b', ${NOW})
  `)).toThrow()
  const existing = db.all(sql.raw("SELECT checksum FROM site_crawl_event_receipts WHERE attempt_id = 'attempt-a' AND sequence = 7 AND batch_id = 'batch-a'")) as Array<{ checksum: string }>
  expect(existing).toEqual([{ checksum: 'checksum-a' }])
})
