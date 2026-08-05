import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createClient, migrate, gscSearchData, gscUrlInspections, gscCoverageSnapshots, projects, runs } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { writeCoverageSnapshot } from '../src/gsc-coverage-snapshot.js'

/**
 * The bug this exists for: `gsc-sync` and `inspect-sitemap` both write the same
 * `(project, date)` coverage row with a delete-then-insert, and the server
 * chains the second off the first. When they computed coverage independently,
 * the chained run overwrote the derived figures minutes after they were written
 * and reset the provenance columns to their defaults — so whole-property
 * coverage silently degraded to inspection-only coverage on the live path.
 *
 * Each writer was individually correct and individually tested. The defect only
 * appears when they run in sequence, which is exactly how they run.
 */
describe('coverage snapshot has a single writer', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  const projectId = 'proj-cov'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-cov-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId, name: 'cov', displayName: 'Cov', canonicalDomain: 'example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()

    // The snapshot's syncRunId is a real FK into runs.
    for (const id of ['seed-run', 'run-sync', 'run-sitemap', 'run-1', 'run-2', 'run-3']) {
      db.insert(runs).values({
        id, projectId, kind: 'gsc-sync', status: 'completed',
        trigger: 'manual', startedAt: now, createdAt: now,
      }).run()
    }

    const today = new Date().toISOString().split('T')[0]!
    const seedPage = (page: string, impressions: number) => {
      db.insert(gscSearchData).values({
        id: crypto.randomUUID(), projectId, date: today, query: 'q', page,
        clicks: 0, impressions, position: '5', syncedAt: now, createdAt: now, syncRunId: 'seed-run',
      }).run()
    }
    // Two pages Google actually served, one that appeared with no impressions.
    seedPage('https://example.com/a', 90)
    seedPage('https://example.com/b', 3)
    seedPage('https://example.com/quiet', 0)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function snapshot() {
    return db.select().from(gscCoverageSnapshots).where(eq(gscCoverageSnapshots.projectId, projectId)).all()
  }

  it('produces the same row whichever run writes it', () => {
    const fromSync = writeCoverageSnapshot(db, projectId, 'run-sync')
    const fromSitemap = writeCoverageSnapshot(db, projectId, 'run-sitemap')

    expect(fromSitemap).toEqual(fromSync)
  })

  it('a chained inspect-sitemap does not erase what gsc-sync derived', () => {
    // The live sequence: sync writes, then the chained sitemap run rewrites.
    writeCoverageSnapshot(db, projectId, 'run-sync')
    writeCoverageSnapshot(db, projectId, 'run-sitemap')

    const rows = snapshot()
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    // Two pages proven indexed by impressions, one unmeasured.
    expect(row.indexed).toBe(2)
    expect(row.unknownPages).toBe(1)
    expect(row.notIndexed).toBe(0)
    // The provenance columns survive the rewrite. Before the single writer,
    // the chained run reset all three to their DEFAULT 0.
    expect(row.derivedFromImpressions).toBe(2)
    expect(row.syncRunId).toBe('run-sitemap')
  })

  it('keeps derived coverage when inspections exist for only some pages', () => {
    const now = new Date().toISOString()
    db.insert(gscUrlInspections).values({
      id: crypto.randomUUID(), projectId, syncRunId: null,
      url: 'https://example.com/quiet', indexingState: 'BLOCKED_BY_ROBOTS_TXT',
      coverageState: 'Blocked by robots.txt', inspectedAt: now, createdAt: now,
    }).run()

    writeCoverageSnapshot(db, projectId, 'run-sync')
    writeCoverageSnapshot(db, projectId, 'run-sitemap')

    const row = snapshot()[0]!
    // The inspected page resolves to not-indexed; the two ranked pages stay
    // indexed from impressions alone. Nothing regressed to unknown.
    expect(row.indexed).toBe(2)
    expect(row.notIndexed).toBe(1)
    expect(row.unknownPages).toBe(0)
    expect(row.verifiedByInspection).toBe(1)
    expect(row.derivedFromImpressions).toBe(2)
  })

  it('replaces rather than accumulates rows for the same day', () => {
    writeCoverageSnapshot(db, projectId, 'run-1')
    writeCoverageSnapshot(db, projectId, 'run-2')
    writeCoverageSnapshot(db, projectId, 'run-3')

    expect(snapshot()).toHaveLength(1)
  })
})
