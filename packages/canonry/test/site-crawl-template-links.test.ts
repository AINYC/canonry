import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlPages,
} from '@ainyc/canonry-db'
import { TEMPLATE_LINK_MIN_FETCHED_PAGES } from '@ainyc/canonry-contracts'
import { prepareSiteCrawlGraphLayout } from '../src/site-crawl-graph-layout.js'
import { classifySiteCrawlTemplateLinks } from '../src/site-crawl-template-links.js'

const NAV_TARGETS = ['services', 'pricing', 'about', 'contact'] as const

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-template-links-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

/**
 * A crawl shaped like a real site: a nav block on every page, one editorial
 * link per page, and one page (`orphan`) that nothing links to except the nav.
 */
function seedCrawl(db: ReturnType<typeof createClient>, pageCount: number) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, displayName: 'p',
    canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: now,
  }).run()
  db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed',
    pagesFetched: pageCount, createdAt: now, updatedAt: now,
  }).run()

  const sources = Array.from({ length: pageCount }, (_, index) => `page-${String(index).padStart(2, '0')}`)
  const nodeKeys = [...new Set([...sources, ...NAV_TARGETS, 'orphan', ...sources.map((s) => `guide-${s}`)])]
  db.insert(siteCrawlPages).values(nodeKeys.map((nodeKey, index) => ({
    id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey,
    url: nodeKey === 'page-00' ? 'https://example.com/' : `https://example.com/${nodeKey}`,
    path: nodeKey === 'page-00' ? '/' : `/${nodeKey}`,
    parentPath: '/', discoverySource: 'link', fetchState: 'html',
    indexabilityState: 'indexable', healthState: 'eligible', auditState: 'complete',
    inventoryEligible: true, depth: nodeKey === 'page-00' ? 0 : 2,
    linkScoreNormalized: 1 - index / 1_000,
    createdAt: now, updatedAt: now,
  }))).run()

  const edges = []
  for (const source of sources) {
    for (const target of [...NAV_TARGETS, 'orphan']) {
      if (target === source) continue
      edges.push({
        id: crypto.randomUUID(), projectId, runId, attemptId,
        edgeKey: `nav:${source}->${target}`,
        sourceNodeKey: source, sourceUrl: `https://example.com/${source}`,
        targetNodeKey: target, targetUrl: `https://example.com/${target}`,
        relation: 'anchor', internal: true, followable: true,
        occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: [target === 'services' ? 'Our  Services' : target],
        createdAt: now, updatedAt: now,
      })
    }
    edges.push({
      id: crypto.randomUUID(), projectId, runId, attemptId,
      edgeKey: `body:${source}->guide`,
      sourceNodeKey: source, sourceUrl: `https://example.com/${source}`,
      targetNodeKey: `guide-${source}`, targetUrl: `https://example.com/guide-${source}`,
      relation: 'anchor', internal: true, followable: true,
      occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
      anchors: [`read the ${source} guide`],
      createdAt: now, updatedAt: now,
    })
  }
  db.insert(siteCrawlEdges).values(edges).run()
  return { projectId, runId, attemptId, sources }
}

function edgeRows(db: ReturnType<typeof createClient>, attemptId: string) {
  return db.select().from(siteCrawlEdges)
    .where(eq(siteCrawlEdges.attemptId, attemptId))
    .orderBy(asc(siteCrawlEdges.edgeKey))
    .all()
}

describe('site crawl template links', () => {
  it('marks the nav mesh, leaves editorial links alone, and persists the share', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)

    const result = classifySiteCrawlTemplateLinks(db, scope, 20)
    expect(result.detection).toBe('applied')
    expect(result.templateEdgeCount).toBeGreaterThan(0)

    const rows = edgeRows(db, scope.attemptId)
    const template = rows.filter((row) => row.isTemplate)
    expect(template).toHaveLength(result.templateEdgeCount)
    expect(template.every((row) => row.edgeKey.startsWith('nav:'))).toBe(true)
    expect(rows.filter((row) => row.edgeKey.startsWith('body:')).every((row) => row.isTemplate === false)).toBe(true)
    // Never NULL after classification: NULL is reserved for a scan that was
    // never classified at all, which reads report as a legacy scan.
    expect(rows.every((row) => row.isTemplate !== null)).toBe(true)
    // Every one of the 20 fetched pages carries the nav item, and `Our
    // Services` written with one space or two is the same anchor.
    expect(rows.find((row) => row.edgeKey === 'nav:page-01->services')?.templateRatio).toBe(1)
    expect(rows.find((row) => row.edgeKey === 'body:page-01->guide')?.templateRatio).toBe(0.05)
  })

  it('marks nothing below the small-site floor, and says so rather than returning an empty set', () => {
    const db = freshDb()
    const scope = seedCrawl(db, TEMPLATE_LINK_MIN_FETCHED_PAGES - 1)

    const result = classifySiteCrawlTemplateLinks(db, scope, TEMPLATE_LINK_MIN_FETCHED_PAGES - 1)
    expect(result.detection).toBe('unavailable-too-few-pages')
    expect(result.templateEdgeCount).toBe(0)

    const rows = edgeRows(db, scope.attemptId)
    expect(rows.length).toBeGreaterThan(0)
    // Explicitly classified as "not a template link", with no invented ratio,
    // so the state on the snapshot is the only thing saying we could not tell.
    expect(rows.every((row) => row.isTemplate === false)).toBe(true)
    expect(rows.every((row) => row.templateRatio === null)).toBe(true)
  })

  it('is deterministic and idempotent across repeated publishes', () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)

    const first = classifySiteCrawlTemplateLinks(db, scope, 20)
    const firstRows = edgeRows(db, scope.attemptId).map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])
    const second = classifySiteCrawlTemplateLinks(db, scope, 20)
    const secondRows = edgeRows(db, scope.attemptId).map((row) => [row.edgeKey, row.isTemplate, row.templateRatio])

    expect(second).toEqual(first)
    expect(secondRows).toEqual(firstRows)
  })

  it('keeps template links out of the layout but in the published sample', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    classifySiteCrawlTemplateLinks(db, scope, 20)

    const layout = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    expect(layout.state).toBe('ready')
    if (layout.state !== 'ready') throw new Error('expected ready layout')

    const templateEdges = layout.edges.filter((edge) => edge.isTemplate)
    const contentEdges = layout.edges.filter((edge) => !edge.isTemplate)
    // Published so a viewer can switch them on without a refetch...
    expect(templateEdges.length).toBeGreaterThan(0)
    expect(contentEdges.length).toBeGreaterThan(0)
    expect(layout.edgeCount).toBe(layout.edges.length)
    // ...and counted, so the split never has to be inferred from the payload.
    expect(layout.totalTemplateEdges).toBe(templateEdges.length)
    expect(layout.totalEdges).toBe(layout.edges.length)
    expect(layout.templateLinksExcluded).toBe(true)
  })

  it('places a page whose only inbound links are template links', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)
    classifySiteCrawlTemplateLinks(db, scope, 20)

    const layout = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (layout.state !== 'ready') throw new Error('expected ready layout')

    // `orphan` is reachable only through the nav, so excluding template links
    // makes it a genuine singleton component. It must still land somewhere
    // finite and distinct rather than being stacked on another node.
    const orphan = layout.nodes.find((node) => node.nodeKey === 'orphan')
    expect(orphan).toBeDefined()
    expect(Number.isFinite(orphan!.x) && Number.isFinite(orphan!.y)).toBe(true)
    const collisions = layout.nodes.filter((node) => node.x === orphan!.x && node.y === orphan!.y)
    expect(collisions).toHaveLength(1)

    // Same crawl, same coordinates: the layout is a pure function of the
    // classified graph.
    const again = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (again.state !== 'ready') throw new Error('expected ready layout')
    expect(again.nodes).toEqual(layout.nodes)
  })

  it('excluding the nav mesh changes the spatialization it used to dominate', async () => {
    const db = freshDb()
    const scope = seedCrawl(db, 20)

    const withNavMesh = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    classifySiteCrawlTemplateLinks(db, scope, 20)
    const contentOnly = await prepareSiteCrawlGraphLayout(db, { ...scope, rootUrl: 'https://example.com/' })
    if (withNavMesh.state !== 'ready' || contentOnly.state !== 'ready') throw new Error('expected ready layouts')

    // Unclassified links are all content, so the first run is the old
    // behavior. The same node set with the mesh removed must not land in the
    // same places, or the exclusion did nothing.
    expect(withNavMesh.totalTemplateEdges).toBe(0)
    expect(contentOnly.totalTemplateEdges).toBeGreaterThan(0)
    expect(contentOnly.nodes.map((node) => node.nodeKey)).toEqual(withNavMesh.nodes.map((node) => node.nodeKey))
    expect(contentOnly.nodes).not.toEqual(withNavMesh.nodes)
  })
})
