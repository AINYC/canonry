import { expect, onTestFinished, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

const V140 = 140

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-dead-links-unverified-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

function columnNames(db: ReturnType<typeof createClient>, table: string): string[] {
  return (db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string }>).map((column) => column.name)
}

function upTo(version: number) {
  return MIGRATION_VERSIONS.filter((migration) => migration.version <= version)
}

test('v140 adds dead_links_unverified, and adds only that column', () => {
  const db = freshDb()
  migrate(db, upTo(V140 - 1))

  const before = columnNames(db, 'site_crawl_snapshots')
  expect(before).not.toContain('dead_links_unverified')

  migrate(db, upTo(V140))

  const after = columnNames(db, 'site_crawl_snapshots')
  expect(after).toEqual([...before, 'dead_links_unverified'])
  // Additive means additive: nothing stored is dropped, renamed, or retyped.
  expect(after.slice(0, before.length)).toEqual(before)

  const recorded = db.all(sql`SELECT version, name FROM _migrations WHERE version = ${V140}`)
  expect(recorded).toEqual([{ version: V140, name: 'site-crawl-dead-links-unverified' }])
})

test('v140 is idempotent: re-running changes nothing', () => {
  const db = freshDb()
  migrate(db)
  const afterFirst = columnNames(db, 'site_crawl_snapshots')

  migrate(db)
  migrate(db)

  expect(columnNames(db, 'site_crawl_snapshots')).toEqual(afterFirst)
  const recorded = db.all(sql`SELECT count(*) AS total FROM _migrations WHERE version = ${V140}`)
  expect(recorded).toEqual([{ total: 1 }])
})

/**
 * Seeds one snapshot plus its findings. `findings` is a list of
 * `[targetUrl, statusCode]`; a null status is a fabricated row — the crawler
 * never reached that URL, so it was never evidence of a broken link.
 */
function seedScan(
  db: ReturnType<typeof createClient>,
  findings: Array<[string, number | null]>,
  counts: { checked: number; found: number },
): void {
  const now = new Date().toISOString()
  db.run(sql`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES ('project-a', 'p', 'p', 'example.com', 'US', 'en', ${now}, ${now})`)
  db.run(sql`INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
    VALUES ('run-a', 'project-a', 'site-audit', 'completed', 'manual', ${now})`)
  db.run(sql`INSERT INTO site_crawl_attempts (id, project_id, run_id, attempt_number, state, pages_fetched, created_at, updated_at)
    VALUES ('attempt-a', 'project-a', 'run-a', 1, 'completed', 228, ${now}, ${now})`)
  db.run(sql`INSERT INTO site_crawl_snapshots
      (id, project_id, run_id, attempt_id, root_url, check_dead_links, dead_link_state,
       dead_links_checked, dead_links_found, findings_count, created_at, updated_at)
    VALUES ('snapshot-a', 'project-a', 'run-a', 'attempt-a', 'https://example.com/', 1, 'complete',
       ${counts.checked}, ${counts.found}, ${counts.found}, ${now}, ${now})`)
  findings.forEach(([target, statusCode], index) => {
    const evidence = JSON.stringify({ statusCode, reason: statusCode === null ? 'fetch-error' : 'http-error' })
    db.run(sql`INSERT INTO site_crawl_findings
        (id, project_id, run_id, attempt_id, finding_key, finding_type, severity,
         source_url, target_url, evidence, created_at, updated_at)
      VALUES (${'finding-' + index}, 'project-a', 'run-a', 'attempt-a', ${'key-' + index}, 'dead-link', 'error',
         ${'https://example.com/page-' + index}, ${target}, ${evidence}, ${now}, ${now})`)
  })
}

function snapshotCounts(db: ReturnType<typeof createClient>) {
  return db.all(sql`SELECT dead_links_checked, dead_links_found, dead_links_unverified, findings_count
    FROM site_crawl_snapshots WHERE id = 'snapshot-a'`)
}

test('v140 reclassifies fabricated findings that are already stored', () => {
  // The evidence to split a historical scan survives on the rows themselves:
  // every finding carries its own `evidence.statusCode`, so a fabricated row is
  // identifiable one row at a time. Leaving them would keep the bug live on
  // every past scan, because the read path serves stored findings — rescanning
  // one project would fix only that project.
  //
  // The reported shape: 15 findings over 6 unreachable URLs, plus one real 404.
  const db = freshDb()
  migrate(db, upTo(V140 - 1))

  const fabricated: Array<[string, number | null]> = []
  for (let target = 0; target < 6; target += 1) {
    // Each unreachable URL is linked from between one and three pages, which is
    // why the row count (15) and the target count (6) differ at all.
    for (let edge = 0; edge <= target % 3; edge += 1) {
      fabricated.push([`https://example.com/unreachable-${target}`, null])
    }
  }
  seedScan(db, [...fabricated, ['https://example.com/gone', 404]], {
    checked: 199,
    found: fabricated.length + 1,
  })

  migrate(db, upTo(V140))

  expect(snapshotCounts(db)).toEqual([{
    dead_links_checked: 193,   // 199 minus the 6 targets that were never reached
    dead_links_found: 1,       // only the real 404 survives
    dead_links_unverified: 6,  // per TARGET, not per row
    findings_count: 1,
  }])

  // The fabricated rows are gone, so the read path cannot serve them.
  const remaining = db.all(sql`SELECT target_url FROM site_crawl_findings ORDER BY target_url`)
  expect(remaining).toEqual([{ target_url: 'https://example.com/gone' }])
})

test('v140 leaves a scan that never had a fabricated row untouched', () => {
  const db = freshDb()
  migrate(db, upTo(V140 - 1))
  seedScan(db, [['https://example.com/gone', 404], ['https://example.com/boom', 503]], { checked: 40, found: 2 })

  migrate(db, upTo(V140))

  expect(snapshotCounts(db)).toEqual([{
    dead_links_checked: 40, dead_links_found: 2, dead_links_unverified: 0, findings_count: 2,
  }])
})

test('v140 data pass is idempotent: a second run does not subtract twice', () => {
  // The counts are derived from rows the same migration then deletes, so a
  // re-run must match nothing. If the guards were dropped, `checked` would be
  // reduced again and `unverified` would be recomputed to 0.
  const db = freshDb()
  migrate(db, upTo(V140 - 1))
  seedScan(db, [
    ['https://example.com/unreachable', null],
    ['https://example.com/unreachable', null],
    ['https://example.com/gone', 404],
  ], { checked: 50, found: 3 })

  migrate(db, upTo(V140))
  const afterFirst = snapshotCounts(db)
  expect(afterFirst).toEqual([{
    dead_links_checked: 49, dead_links_found: 1, dead_links_unverified: 1, findings_count: 1,
  }])

  migrate(db)
  migrate(db)

  expect(snapshotCounts(db)).toEqual(afterFirst)
})
