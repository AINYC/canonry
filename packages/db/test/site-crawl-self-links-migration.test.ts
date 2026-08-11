import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createClient, migrate, projects, runs, siteCrawlAttempts, siteCrawlEdges } from '../src/index.js'
import { dropSiteCrawlSelfLinks } from '../src/migrate.js'

// v132 clears stored self-links. The crawl engine already leaves them out of a
// page's inbound and outbound metrics, so keeping them made the edge tables
// disagree with the page rows built by the same crawl: a self-loop landed in
// BOTH neighbour lists, and every self-linking page read one link higher in
// each direction than its own tiles.

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-self-links-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedEdges(db: ReturnType<typeof createClient>) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, displayName: 'p',
    canonicalDomain: 'example.com', country: 'US', language: 'en',
    createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'site-audit', status: 'completed',
    trigger: 'manual', createdAt: now,
  }).run()
  db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed',
    createdAt: now, updatedAt: now,
  }).run()
  const edge = (edgeKey: string, from: string, to: string) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey,
    sourceNodeKey: from, sourceUrl: `https://example.com/${from}`,
    targetNodeKey: to, targetUrl: `https://example.com/${to}`,
    relation: 'anchor', internal: true, followable: true,
    occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
    anchors: [], createdAt: now, updatedAt: now,
  })
  db.insert(siteCrawlEdges).values([
    edge('a-b', 'a', 'b'),
    edge('b-a', 'b', 'a'),
    // The page links to itself, with no anchor text. This is the row that made
    // /aeo-vs-seo-for-nyc-businesses read 4 inbound against a page row of 3.
    edge('a-a', 'a', 'a'),
  ]).run()
  return { runId }
}

test('clears stored self-links and leaves every real link alone', () => {
  const db = freshDb()
  seedEdges(db)
  expect(db.select().from(siteCrawlEdges).all()).toHaveLength(3)

  dropSiteCrawlSelfLinks(db)

  const remaining = db.select().from(siteCrawlEdges).all()
  expect(remaining.map((row) => row.edgeKey).sort()).toEqual(['a-b', 'b-a'])
  expect(remaining.every((row) => row.sourceUrl !== row.targetUrl)).toBe(true)
})

test('is idempotent, so a re-run removes nothing further', () => {
  const db = freshDb()
  seedEdges(db)
  dropSiteCrawlSelfLinks(db)
  const afterFirst = db.select().from(siteCrawlEdges).all().map((row) => row.edgeKey).sort()

  expect(() => dropSiteCrawlSelfLinks(db)).not.toThrow()
  expect(db.select().from(siteCrawlEdges).all().map((row) => row.edgeKey).sort()).toEqual(afterFirst)
})

test('leaves no self-link behind after a full migrate', () => {
  const db = freshDb()
  seedEdges(db)
  dropSiteCrawlSelfLinks(db)
  migrate(db)

  const selfLinks = db.all(sql`SELECT count(*) AS n FROM site_crawl_edges WHERE source_url = target_url`) as Array<{ n: number }>
  expect(selfLinks[0]!.n).toBe(0)
})
