import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
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
import {
  SITE_CRAWL_GRAPH_LAYOUT_VERSION,
  adaptiveForceAtlasIterations,
  layoutSiteCrawlGraphInput,
  prepareSiteCrawlGraphLayout,
  seedSiteCrawlGraphNodes,
  type SiteCrawlGraphLayoutInput,
} from '../src/site-crawl-graph-layout.js'

const input: SiteCrawlGraphLayoutInput = {
  rootNodeKey: 'home',
  totalNodes: 4,
  totalEdges: 3,
  nodes: [
    { nodeKey: 'home', path: '/', depth: 0, sampleRank: 0 },
    { nodeKey: 'services-a', path: '/services/a', depth: 2, sampleRank: 1 },
    { nodeKey: 'services-b', path: '/services/b', depth: 2, sampleRank: 2 },
    { nodeKey: 'blog-a', path: '/blog/a', depth: 2, sampleRank: 3 },
  ],
  edges: [
    { edgeKey: 'home-services', sourceNodeKey: 'home', targetNodeKey: 'services-a', followable: true, occurrences: 2 },
    { edgeKey: 'services-sibling', sourceNodeKey: 'services-a', targetNodeKey: 'services-b', followable: true, occurrences: 1 },
    { edgeKey: 'home-blog', sourceNodeKey: 'home', targetNodeKey: 'blog-a', followable: false, occurrences: 1 },
  ],
}

describe('site crawl graph layout', () => {
  it('seeds home centrally and keeps pages in the same path section clustered', () => {
    const first = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey)
    const second = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey)
    expect(second).toEqual(first)
    expect(first.find((node) => node.nodeKey === 'home')).toMatchObject({ x: 0, y: 0 })

    const byKey = new Map(first.map((node) => [node.nodeKey, node]))
    const distance = (a: string, b: string) => Math.hypot(byKey.get(a)!.x - byKey.get(b)!.x, byKey.get(a)!.y - byKey.get(b)!.y)
    expect(distance('services-a', 'services-b')).toBeLessThan(distance('services-a', 'blog-a'))
  })

  it('pins an adaptive upper bound for the 20k-node publish cap', () => {
    expect(adaptiveForceAtlasIterations(100, 200)).toBeGreaterThan(adaptiveForceAtlasIterations(20_000, 50_000))
    expect(adaptiveForceAtlasIterations(20_000, 50_000)).toBeLessThanOrEqual(8)
    expect(adaptiveForceAtlasIterations(20_000, 50_000)).toBeGreaterThan(0)
  })

  it('normalizes persisted coordinates around home and records the pinned layout version', async () => {
    const result = await layoutSiteCrawlGraphInput(input, {
      computePositions: async ({ nodes }) => nodes.map((node) => ({
        nodeKey: node.nodeKey,
        x: node.x + 50,
        y: node.y - 30,
      })),
    })
    expect(result).toMatchObject({
      state: 'ready',
      layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION,
      totalNodes: 4,
      totalEdges: 3,
      edgeCount: 3,
    })
    if (result.state !== 'ready') throw new Error('expected ready layout')
    expect(result.nodes.find((node) => node.nodeKey === 'home')).toMatchObject({ x: 0, y: 0 })
    expect(result.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  })

  it('degrades to unavailable when layout physics fails', async () => {
    const result = await layoutSiteCrawlGraphInput(input, {
      computePositions: async () => { throw new Error('worker stopped') },
    })
    expect(result).toEqual({
      state: 'unavailable',
      failureCode: 'layout-error',
      totalNodes: 4,
      totalEdges: 3,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
    })
  })

  it('samples root and depth-zero first, then link score with stable ties, and excludes dangling edges', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-graph-layout-order-'))
    onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = '2026-08-09T12:00:00.000Z'
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'layout-order', displayName: 'Layout order', canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
    }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'site-audit', status: 'running', trigger: 'manual', createdAt: now }).run()
    db.insert(siteCrawlAttempts).values({
      id: attemptId, projectId, runId, attemptNumber: 1, state: 'running', createdAt: now, updatedAt: now,
    }).run()
    const pages = [
      { nodeKey: 'root', url: 'https://example.com/', path: '/', depth: 3, linkScoreNormalized: 0.01 },
      { nodeKey: 'depth-zero', url: 'https://example.com/start', path: '/start', depth: 0, linkScoreNormalized: 0.02 },
      { nodeKey: 'alpha', url: 'https://example.com/a', path: '/a', depth: 1, linkScoreNormalized: 0.9 },
      { nodeKey: 'beta', url: 'https://example.com/b', path: '/b', depth: 1, linkScoreNormalized: 0.9 },
      { nodeKey: 'low', url: 'https://example.com/low', path: '/low', depth: 1, linkScoreNormalized: 0.1 },
    ]
    db.insert(siteCrawlPages).values(pages.map((page) => ({
      id: crypto.randomUUID(), projectId, runId, attemptId, parentPath: '/', discoverySource: 'link',
      fetchState: 'fetched', indexabilityState: 'eligible', auditState: 'complete', inventoryEligible: true,
      createdAt: now, updatedAt: now, ...page,
    }))).run()
    db.insert(siteCrawlEdges).values([
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'beta-root',
        sourceNodeKey: 'beta', sourceUrl: 'https://example.com/b', targetNodeKey: 'root', targetUrl: 'https://example.com/',
        relation: 'anchor', internal: true, followable: true, occurrences: 4, followableOccurrences: 4, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'root-alpha',
        sourceNodeKey: 'root', sourceUrl: 'https://example.com/', targetNodeKey: 'alpha', targetUrl: 'https://example.com/a',
        relation: 'anchor', internal: true, followable: true, occurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
      {
        id: crypto.randomUUID(), projectId, runId, attemptId, edgeKey: 'root-missing',
        sourceNodeKey: 'root', sourceUrl: 'https://example.com/', targetNodeKey: 'missing', targetUrl: 'https://example.com/missing',
        relation: 'anchor', internal: true, followable: true, occurrences: 99, followableOccurrences: 99, nofollowOccurrences: 0,
        anchors: [], createdAt: now, updatedAt: now,
      },
    ]).run()

    const result = await prepareSiteCrawlGraphLayout(db, {
      projectId, runId, attemptId, rootUrl: 'https://example.com/',
    })
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready layout')
    expect(result.nodes.map((node) => node.nodeKey)).toEqual(['root', 'depth-zero', 'alpha', 'beta', 'low'])
    expect(result.edges.map((edge) => edge.edgeKey)).toEqual(['beta-root', 'root-alpha'])
    expect(result.totalEdges).toBe(2)

    const queryPlan = db.all(sql`
      EXPLAIN QUERY PLAN
      WITH selected(node_key) AS (SELECT value FROM json_each(${JSON.stringify(pages.map((page) => page.nodeKey))}))
      SELECT edge.edge_key
      FROM site_crawl_edges AS edge
      INNER JOIN selected AS source ON source.node_key = edge.source_node_key
      INNER JOIN selected AS target ON target.node_key = edge.target_node_key
      WHERE edge.project_id = ${projectId}
        AND edge.run_id = ${runId}
        AND edge.attempt_id = ${attemptId}
        AND edge.internal = 1
        AND edge.relation = 'anchor'
      ORDER BY edge.occurrences DESC, edge.edge_key ASC
      LIMIT ${50_000}
    `) as Array<{ detail: string }>
    expect(queryPlan.some((step) => step.detail.includes('idx_site_crawl_edges_graph_sample'))).toBe(true)
    expect(queryPlan.some((step) => step.detail.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false)

    let checkpoints = 0
    const checkpointSignal = {
      throwIfAborted() {
        checkpoints += 1
        if (checkpoints === 4) throw new DOMException('stop before page sampling', 'AbortError')
      },
    } as AbortSignal
    await expect(prepareSiteCrawlGraphLayout(db, {
      projectId, runId, attemptId, rootUrl: 'https://example.com/',
    }, { signal: checkpointSignal })).rejects.toThrow('stop before page sampling')
    expect(checkpoints).toBe(4)
  })
})
