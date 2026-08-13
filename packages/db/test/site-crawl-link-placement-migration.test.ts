import { expect, onTestFinished, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

const V138 = 138

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-crawl-link-placement-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

function columnNames(db: ReturnType<typeof createClient>, table: string): string[] {
  return (db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string }>).map((column) => column.name)
}

test('v138 adds the link-placement columns, and adds only columns', () => {
  const db = freshDb()
  migrate(db, MIGRATION_VERSIONS.filter((migration) => migration.version < V138))

  const edgesBefore = columnNames(db, 'site_crawl_edges')
  const snapshotsBefore = columnNames(db, 'site_crawl_snapshots')
  expect(edgesBefore).not.toContain('placement_navigation_occurrences')
  expect(snapshotsBefore).not.toContain('link_placement_ruleset_version')

  migrate(db)

  const edgesAfter = columnNames(db, 'site_crawl_edges')
  const snapshotsAfter = columnNames(db, 'site_crawl_snapshots')
  expect(edgesAfter).toEqual([
    ...edgesBefore,
    'placement_navigation_occurrences',
    'placement_content_occurrences',
    'placement_unknown_occurrences',
  ])
  expect(snapshotsAfter).toEqual([...snapshotsBefore, 'link_placement_ruleset_version'])

  // Additive means additive: nothing already stored is dropped, renamed, or
  // retyped, so a rollback to the previous engine image still reads every row.
  expect(edgesAfter.slice(0, edgesBefore.length)).toEqual(edgesBefore)
  expect(snapshotsAfter.slice(0, snapshotsBefore.length)).toEqual(snapshotsBefore)

  const recorded = db.all(sql`SELECT version, name FROM _migrations WHERE version = ${V138}`)
  expect(recorded).toEqual([{ version: V138, name: 'site-crawl-link-placement' }])
})

test('v138 is idempotent: re-running changes nothing', () => {
  const db = freshDb()
  migrate(db)
  const afterFirst = columnNames(db, 'site_crawl_edges')

  // The runner swallows the duplicate-column error, and the version is already
  // recorded, so the statements are not even reached a second time.
  migrate(db)
  migrate(db)

  expect(columnNames(db, 'site_crawl_edges')).toEqual(afterFirst)
  const recorded = db.all(sql`SELECT count(*) AS total FROM _migrations WHERE version = ${V138}`)
  expect(recorded).toEqual([{ total: 1 }])
})

test('v138 backfills nothing, because a pre-4.7.0 crawl never observed placement', () => {
  // The point of the whole state model: a stored scan keeps the ubiquity
  // classification it already has and reports it as such. Writing a value into
  // these columns for an old crawl would be inventing evidence.
  const db = freshDb()
  migrate(db, MIGRATION_VERSIONS.filter((migration) => migration.version < V138))

  const now = new Date().toISOString()
  db.run(sql`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES ('project-a', 'p', 'p', 'example.com', 'US', 'en', ${now}, ${now})`)
  db.run(sql`INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
    VALUES ('run-a', 'project-a', 'site-audit', 'completed', 'manual', ${now})`)
  db.run(sql`INSERT INTO site_crawl_attempts (id, project_id, run_id, attempt_number, state, pages_fetched, created_at, updated_at)
    VALUES ('attempt-a', 'project-a', 'run-a', 1, 'completed', 20, ${now}, ${now})`)
  db.run(sql`INSERT INTO site_crawl_snapshots (id, project_id, run_id, attempt_id, root_url, template_detection, created_at, updated_at)
    VALUES ('snapshot-a', 'project-a', 'run-a', 'attempt-a', 'https://example.com/', 'applied', ${now}, ${now})`)
  db.run(sql`INSERT INTO site_crawl_edges
      (id, project_id, run_id, attempt_id, edge_key, source_node_key, source_url, target_node_key, target_url,
       is_template, template_ratio, created_at, updated_at)
    VALUES ('edge-a', 'project-a', 'run-a', 'attempt-a', 'nav:a->b', 'a', 'https://example.com/a', 'b',
       'https://example.com/b', 1, 0.95, ${now}, ${now})`)

  migrate(db)

  const edge = db.all(sql`SELECT is_template, template_ratio, placement_navigation_occurrences,
      placement_content_occurrences, placement_unknown_occurrences
    FROM site_crawl_edges WHERE id = 'edge-a'`)
  expect(edge).toEqual([{
    is_template: 1,
    template_ratio: 0.95,
    placement_navigation_occurrences: null,
    placement_content_occurrences: null,
    placement_unknown_occurrences: null,
  }])

  const snapshot = db.all(sql`SELECT template_detection, link_placement_ruleset_version
    FROM site_crawl_snapshots WHERE id = 'snapshot-a'`)
  expect(snapshot).toEqual([{ template_detection: 'applied', link_placement_ruleset_version: null }])
})
