import { expect, onTestFinished, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

const V134 = 134

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-crawl-live-preview-index-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

test('v134 adds an index after the v133 template-link reclassification and serves the bounded live Page Health preview without a sort', () => {
  const db = freshDb()
  migrate(db, MIGRATION_VERSIONS.filter((migration) => migration.version < V134))

  const preceding = db.all(sql`SELECT version, name FROM _migrations WHERE version = 133`) as Array<{ version: number; name: string }>
  expect(preceding).toEqual([{ version: 133, name: 'site-crawl-reclassify-template-links-per-anchor' }])

  const before = db.all(sql.raw("PRAGMA index_list('site_crawl_pages')")) as Array<{ name: string }>
  expect(before.map((index) => index.name)).not.toContain('idx_site_crawl_pages_live_preview')

  migrate(db)
  migrate(db)

  const columns = db.all(sql.raw("PRAGMA index_info('idx_site_crawl_pages_live_preview')")) as Array<{ name: string; seqno: number }>
  expect(columns.sort((left, right) => left.seqno - right.seqno).map((column) => column.name)).toEqual([
    'project_id',
    'run_id',
    'attempt_id',
    'audit_state',
    'audit_score',
    'node_key',
  ])

  // Exact shape used by the in-progress Page Health preview: only completed
  // page audits below the threshold, stable worst-first ordering, and a hard
  // cap. The new index must avoid sorting an expanding crawl in a temp b-tree.
  const plan = db.all(sql`
    EXPLAIN QUERY PLAN
    SELECT node_key, audit_score
    FROM site_crawl_pages
    WHERE project_id = ${'project-a'}
      AND run_id = ${'run-a'}
      AND attempt_id = ${'attempt-a'}
      AND audit_state = 'success'
      AND audit_score < 70
    ORDER BY audit_score ASC, node_key ASC
    LIMIT 48
  `) as Array<{ detail: string }>
  const detail = plan.map((row) => row.detail).join(' | ')

  expect(detail).toContain('idx_site_crawl_pages_live_preview')
  expect(detail).not.toContain('TEMP B-TREE')
  expect(detail).not.toContain('SCAN site_crawl_pages')

  const recorded = db.all(sql`SELECT version FROM _migrations WHERE version = ${V134}`) as Array<{ version: number }>
  expect(recorded).toEqual([{ version: V134 }])
})
