import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { and, asc, count, desc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  siteCrawlEdges,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
} from '@ainyc/canonry-db'
import {
  SITE_CRAWL_GRAPH_MAX_EDGES,
  SITE_CRAWL_GRAPH_MAX_NODES,
} from '@ainyc/canonry-contracts'

export const SITE_CRAWL_GRAPH_LAYOUT_VERSION = 'site-health-fa2-v1'
export const SITE_CRAWL_GRAPH_LAYOUT_TIMEOUT_MS = 15_000

export interface SiteCrawlGraphSeedNode {
  nodeKey: string
  path: string
  depth: number | null
  sampleRank: number
}

interface SeededGraphNode extends SiteCrawlGraphSeedNode {
  x: number
  y: number
}

export interface SiteCrawlGraphLayoutEdge {
  edgeKey: string
  sourceNodeKey: string
  targetNodeKey: string
  followable: boolean
  occurrences: number
}

interface PersistedGraphEdge extends SiteCrawlGraphLayoutEdge {
  sampleRank: number
}

export interface SiteCrawlGraphLayoutInput {
  rootNodeKey: string | null
  totalNodes: number
  totalEdges: number
  nodes: SiteCrawlGraphSeedNode[]
  edges: SiteCrawlGraphLayoutEdge[]
}

export interface PersistedGraphPosition {
  nodeKey: string
  sampleRank: number
  x: number
  y: number
}

export type PreparedSiteCrawlGraphLayout =
  | {
    state: 'ready'
    layoutVersion: string
    totalNodes: number
    totalEdges: number
    nodeCount: number
    edgeCount: number
    nodes: PersistedGraphPosition[]
    edges: PersistedGraphEdge[]
  }
  | {
    state: 'unavailable'
    failureCode: 'empty-crawl' | 'layout-timeout' | 'layout-error'
    totalNodes: number
    totalEdges: number
    nodeCount: 0
    edgeCount: 0
    nodes: []
    edges: []
  }

interface ComputedPosition {
  nodeKey: string
  x: number
  y: number
}

interface LayoutComputeInput {
  nodes: SeededGraphNode[]
  edges: SiteCrawlGraphLayoutEdge[]
  iterations: number
}

type ComputePositions = (
  input: LayoutComputeInput,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<ComputedPosition[]>

const graphSourcePage = alias(siteCrawlPages, 'layout_graph_source_page')
const graphTargetPage = alias(siteCrawlPages, 'layout_graph_target_page')

const FORCE_ATLAS_SETTINGS = Object.freeze({
  adjustSizes: false,
  barnesHutOptimize: true,
  barnesHutTheta: 0.5,
  edgeWeightInfluence: 0.5,
  gravity: 1,
  linLogMode: false,
  outboundAttractionDistribution: false,
  scalingRatio: 10,
  slowDown: 10,
  strongGravityMode: false,
})

const WORKER_SOURCE = String.raw`
const {parentPort, workerData} = require('node:worker_threads');
try {
  const graphologyModule = require(workerData.graphologyPath);
  const forceAtlasModule = require(workerData.forceAtlasPath);
  const MultiDirectedGraph = graphologyModule.MultiDirectedGraph;
  const forceAtlas2 = forceAtlasModule.default || forceAtlasModule;
  const graph = new MultiDirectedGraph({allowSelfLoops: true});
  for (const node of workerData.input.nodes) {
    graph.addNode(node.nodeKey, {x: node.x, y: node.y});
  }
  for (const edge of workerData.input.edges) {
    graph.addDirectedEdgeWithKey(edge.edgeKey, edge.sourceNodeKey, edge.targetNodeKey, {
      weight: 1 + Math.log2(Math.max(1, edge.occurrences)),
    });
  }
  if (graph.order > 1 && graph.size > 0) {
    forceAtlas2.assign(graph, {
      iterations: workerData.input.iterations,
      settings: workerData.settings,
    });
  }
  const positions = [];
  graph.forEachNode((nodeKey, attributes) => {
    positions.push({nodeKey, x: attributes.x, y: attributes.y});
  });
  parentPort.postMessage({ok: true, positions});
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error && typeof error.message === 'string' ? error.message : String(error),
  });
}
`

class GraphLayoutTimeoutError extends Error {
  override name = 'GraphLayoutTimeoutError'
}

function hashUnit(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

function pathSection(path: string): string {
  return path.split('/').filter(Boolean)[0] ?? '__root__'
}

/**
 * Stable, hierarchy-aware initial coordinates. The home node is central;
 * top-level folders get stable hash-derived cluster centers, and depth expands
 * pages within each cluster before ForceAtlas2 spatializes actual links.
 */
export function seedSiteCrawlGraphNodes(
  nodes: readonly SiteCrawlGraphSeedNode[],
  rootNodeKey: string | null,
): SeededGraphNode[] {
  return [...nodes]
    .sort((a, b) => a.sampleRank - b.sampleRank || a.nodeKey.localeCompare(b.nodeKey))
    .map((node) => {
      if (node.nodeKey === rootNodeKey) return { ...node, x: 0, y: 0 }
      const section = pathSection(node.path)
      const sectionAngle = hashUnit(`section:${section}`) * Math.PI * 2
      const sectionRadius = section === '__root__' ? 24 : 100
      const clusterX = Math.cos(sectionAngle) * sectionRadius
      const clusterY = Math.sin(sectionAngle) * sectionRadius
      const localAngle = hashUnit(`node-angle:${node.nodeKey}`) * Math.PI * 2
      const depth = Math.max(0, Math.min(12, node.depth ?? 4))
      const localRadius = 4 + depth * 2.5 + Math.sqrt(hashUnit(`node-radius:${node.nodeKey}`)) * 14
      return {
        ...node,
        x: clusterX + Math.cos(localAngle) * localRadius,
        y: clusterY + Math.sin(localAngle) * localRadius,
      }
    })
}

/** The expensive cap is deliberately tiny at 20k/50k and pinned by version. */
export function adaptiveForceAtlasIterations(nodeCount: number, edgeCount: number): number {
  if (nodeCount <= 100 && edgeCount <= 500) return 100
  if (nodeCount <= 500 && edgeCount <= 2_500) return 70
  if (nodeCount <= 2_000 && edgeCount <= 10_000) return 40
  if (nodeCount <= 5_000 && edgeCount <= 20_000) return 24
  if (nodeCount <= 10_000 && edgeCount <= 35_000) return 12
  return 6
}

async function computeForceAtlasPositions(
  input: LayoutComputeInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ComputedPosition[]> {
  if (input.nodes.length <= 1 || input.edges.length === 0) {
    return input.nodes.map(({ nodeKey, x, y }) => ({ nodeKey, x, y }))
  }
  const requireFromPackage = createRequire(import.meta.url)
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      graphologyPath: requireFromPackage.resolve('graphology'),
      forceAtlasPath: requireFromPackage.resolve('graphology-layout-forceatlas2'),
      input,
      settings: FORCE_ATLAS_SETTINGS,
    },
  })
  const timeoutMs = options.timeoutMs ?? SITE_CRAWL_GRAPH_LAYOUT_TIMEOUT_MS
  return await new Promise<ComputedPosition[]>((resolve, reject) => {
    let settled = false
    const finish = (result: { positions?: ComputedPosition[]; error?: unknown }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (result.error) reject(result.error instanceof Error
        ? result.error
        : new Error('Graph layout failed with a non-Error reason', { cause: result.error }))
      else resolve(result.positions ?? [])
    }
    const onAbort = () => finish({ error: options.signal?.reason ?? new DOMException('Layout aborted', 'AbortError') })
    const timer = setTimeout(() => finish({ error: new GraphLayoutTimeoutError(`Graph layout exceeded ${timeoutMs}ms`) }), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) return onAbort()
    worker.once('message', (message: { ok: boolean; positions?: ComputedPosition[]; error?: string }) => {
      if (!message.ok) finish({ error: new Error(message.error ?? 'Graph layout worker failed') })
      else finish({ positions: message.positions })
    })
    worker.once('error', (error) => finish({ error }))
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) finish({ error: new Error(`Graph layout worker exited with code ${code}`) })
    })
  })
}

function normalizePositions(
  seededNodes: readonly SeededGraphNode[],
  computed: readonly ComputedPosition[],
  rootNodeKey: string | null,
): PersistedGraphPosition[] {
  const byKey = new Map(computed.map((position) => [position.nodeKey, position]))
  if (byKey.size !== seededNodes.length) throw new Error('Graph layout returned an incomplete node set')
  const root = rootNodeKey ? byKey.get(rootNodeKey) : null
  const centerX = root?.x ?? computed.reduce((sum, position) => sum + position.x, 0) / Math.max(1, computed.length)
  const centerY = root?.y ?? computed.reduce((sum, position) => sum + position.y, 0) / Math.max(1, computed.length)
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new Error('Graph layout returned a non-finite center')
  let scale = 0
  for (const position of computed) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Graph layout returned non-finite coordinates')
    scale = Math.max(scale, Math.abs(position.x - centerX), Math.abs(position.y - centerY))
  }
  scale = scale > 0 ? scale : 1
  return seededNodes.map((node) => {
    const position = byKey.get(node.nodeKey)
    if (!position) throw new Error(`Graph layout omitted ${node.nodeKey}`)
    return {
      nodeKey: node.nodeKey,
      sampleRank: node.sampleRank,
      x: Math.round(((position.x - centerX) / scale) * 1_000_000) / 1_000_000,
      y: Math.round(((position.y - centerY) / scale) * 1_000_000) / 1_000_000,
    }
  })
}

/** Best-effort layout boundary: physics failure is data unavailability, not crawl failure. */
export async function layoutSiteCrawlGraphInput(
  input: SiteCrawlGraphLayoutInput,
  options: {
    computePositions?: ComputePositions
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<PreparedSiteCrawlGraphLayout> {
  options.signal?.throwIfAborted()
  if (input.nodes.length === 0) {
    return {
      state: 'unavailable', failureCode: 'empty-crawl',
      totalNodes: input.totalNodes, totalEdges: input.totalEdges,
      nodeCount: 0, edgeCount: 0, nodes: [],
      edges: [],
    }
  }
  const seeded = seedSiteCrawlGraphNodes(input.nodes, input.rootNodeKey)
  try {
    const compute = options.computePositions ?? computeForceAtlasPositions
    const positions = await compute({
      nodes: seeded,
      edges: input.edges,
      iterations: adaptiveForceAtlasIterations(input.nodes.length, input.edges.length),
    }, { signal: options.signal, timeoutMs: options.timeoutMs })
    options.signal?.throwIfAborted()
    return {
      state: 'ready',
      layoutVersion: SITE_CRAWL_GRAPH_LAYOUT_VERSION,
      totalNodes: input.totalNodes,
      totalEdges: input.totalEdges,
      nodeCount: input.nodes.length,
      edgeCount: input.edges.length,
      nodes: normalizePositions(seeded, positions, input.rootNodeKey),
      edges: input.edges.map((edge, sampleRank) => ({ ...edge, sampleRank })),
    }
  } catch (error) {
    // Cancellation is control flow owned by the crawl executor, not a layout
    // availability failure. Preserve the signal's exact reason so its typed
    // cancellation guard can update the run and attempt correctly.
    if (options.signal?.aborted) options.signal.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      state: 'unavailable',
      failureCode: error instanceof GraphLayoutTimeoutError ? 'layout-timeout' : 'layout-error',
      totalNodes: input.totalNodes,
      totalEdges: input.totalEdges,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
    }
  }
}

/**
 * Read only the bounded publish sample. The JSON CTE uses one bound parameter
 * for retained keys, avoiding SQLite's variable cap and any 1m-edge scan into
 * JavaScript memory.
 */
export async function prepareSiteCrawlGraphLayout(
  db: DatabaseClient,
  scope: { projectId: string; runId: string; attemptId: string; rootUrl: string },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PreparedSiteCrawlGraphLayout> {
  try {
    const assertNotAborted = () => options.signal?.throwIfAborted()
    assertNotAborted()
    const pageScope = [
      eq(siteCrawlPages.projectId, scope.projectId),
      eq(siteCrawlPages.runId, scope.runId),
      eq(siteCrawlPages.attemptId, scope.attemptId),
    ]
    const edgeScope = [
      eq(siteCrawlEdges.projectId, scope.projectId),
      eq(siteCrawlEdges.runId, scope.runId),
      eq(siteCrawlEdges.attemptId, scope.attemptId),
      eq(siteCrawlEdges.internal, true),
      eq(siteCrawlEdges.relation, 'anchor'),
    ]
    const totalNodes = db.select({ value: count() }).from(siteCrawlPages).where(and(...pageScope)).get()?.value ?? 0
    assertNotAborted()
    const totalEdges = db
      .select({ value: count() })
      .from(siteCrawlEdges)
      .innerJoin(graphSourcePage, and(
        eq(graphSourcePage.projectId, scope.projectId),
        eq(graphSourcePage.runId, scope.runId),
        eq(graphSourcePage.attemptId, scope.attemptId),
        eq(graphSourcePage.nodeKey, siteCrawlEdges.sourceNodeKey),
      ))
      .innerJoin(graphTargetPage, and(
        eq(graphTargetPage.projectId, scope.projectId),
        eq(graphTargetPage.runId, scope.runId),
        eq(graphTargetPage.attemptId, scope.attemptId),
        eq(graphTargetPage.nodeKey, siteCrawlEdges.targetNodeKey),
      ))
      .where(and(...edgeScope))
      .get()?.value ?? 0
    assertNotAborted()

    const graphSeedColumns = {
      nodeKey: siteCrawlPages.nodeKey,
      path: siteCrawlPages.path,
      depth: siteCrawlPages.depth,
    }
    const rootRows = db.select(graphSeedColumns).from(siteCrawlPages)
      .where(and(...pageScope, eq(siteCrawlPages.url, scope.rootUrl)))
      .orderBy(asc(siteCrawlPages.nodeKey)).limit(1).all()
    assertNotAborted()
    const retainedRows = [...rootRows]
    if (retainedRows.length < SITE_CRAWL_GRAPH_MAX_NODES) {
      retainedRows.push(...db.select(graphSeedColumns).from(siteCrawlPages)
        .where(and(...pageScope, eq(siteCrawlPages.depth, 0), ne(siteCrawlPages.url, scope.rootUrl)))
        .orderBy(asc(siteCrawlPages.nodeKey))
        .limit(SITE_CRAWL_GRAPH_MAX_NODES - retainedRows.length).all())
    }
    assertNotAborted()
    if (retainedRows.length < SITE_CRAWL_GRAPH_MAX_NODES) {
      retainedRows.push(...db.select(graphSeedColumns).from(siteCrawlPages)
        .where(and(
          ...pageScope,
          or(isNull(siteCrawlPages.depth), ne(siteCrawlPages.depth, 0)),
          ne(siteCrawlPages.url, scope.rootUrl),
        ))
        .orderBy(desc(siteCrawlPages.linkScoreNormalized), asc(siteCrawlPages.nodeKey))
        .limit(SITE_CRAWL_GRAPH_MAX_NODES - retainedRows.length).all())
    }
    assertNotAborted()

    const nodes = retainedRows.map((row, sampleRank) => ({
      nodeKey: row.nodeKey,
      path: row.path,
      depth: row.depth,
      sampleRank,
    }))
    const rootNodeKey = rootRows[0]?.nodeKey ?? null
    const selectedKeys = JSON.stringify(nodes.map((node) => node.nodeKey))
    const edgeRows = nodes.length === 0 ? [] : db.all(sql`
      WITH selected(node_key) AS (SELECT value FROM json_each(${selectedKeys}))
      SELECT
        edge.edge_key AS edgeKey,
        edge.source_node_key AS sourceNodeKey,
        edge.target_node_key AS targetNodeKey,
        edge.followable AS followable,
        edge.occurrences AS occurrences
      FROM site_crawl_edges AS edge
      INNER JOIN selected AS source ON source.node_key = edge.source_node_key
      INNER JOIN selected AS target ON target.node_key = edge.target_node_key
      WHERE edge.project_id = ${scope.projectId}
        AND edge.run_id = ${scope.runId}
        AND edge.attempt_id = ${scope.attemptId}
        AND edge.internal = 1
        AND edge.relation = 'anchor'
      ORDER BY edge.occurrences DESC, edge.edge_key ASC
      LIMIT ${SITE_CRAWL_GRAPH_MAX_EDGES}
    `) as Array<{
      edgeKey: string
      sourceNodeKey: string
      targetNodeKey: string
      followable: boolean
      occurrences: number
    }>
    assertNotAborted()
    return await layoutSiteCrawlGraphInput({ totalNodes, totalEdges, nodes, edges: edgeRows, rootNodeKey }, options)
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted()
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      state: 'unavailable', failureCode: 'layout-error',
      totalNodes: 0, totalEdges: 0, nodeCount: 0, edgeCount: 0, nodes: [],
      edges: [],
    }
  }
}

/** Idempotent derived-data write, intentionally separate from crawl publication. */
export function persistSiteCrawlGraphLayout(
  db: DatabaseClient,
  scope: { projectId: string; runId: string; attemptId: string },
  layout: PreparedSiteCrawlGraphLayout,
  now = new Date().toISOString(),
): void {
  db.transaction((tx) => {
    tx.delete(siteCrawlGraphLayouts).where(and(
      eq(siteCrawlGraphLayouts.projectId, scope.projectId),
      eq(siteCrawlGraphLayouts.runId, scope.runId),
      eq(siteCrawlGraphLayouts.attemptId, scope.attemptId),
    )).run()
    tx.insert(siteCrawlGraphLayouts).values({
      id: crypto.randomUUID(),
      projectId: scope.projectId,
      runId: scope.runId,
      attemptId: scope.attemptId,
      state: layout.state,
      layoutVersion: layout.state === 'ready' ? layout.layoutVersion : null,
      failureCode: layout.state === 'unavailable' ? layout.failureCode : null,
      totalNodes: layout.totalNodes,
      totalEdges: layout.totalEdges,
      nodeCount: layout.nodeCount,
      edgeCount: layout.edgeCount,
      createdAt: now,
      updatedAt: now,
    }).run()
    if (layout.state !== 'ready') return
    const batchSize = 250
    for (let offset = 0; offset < layout.nodes.length; offset += batchSize) {
      tx.insert(siteCrawlGraphNodes).values(layout.nodes.slice(offset, offset + batchSize).map((node) => ({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        runId: scope.runId,
        attemptId: scope.attemptId,
        nodeKey: node.nodeKey,
        sampleRank: node.sampleRank,
        x: node.x,
        y: node.y,
        createdAt: now,
      }))).run()
    }
    for (let offset = 0; offset < layout.edges.length; offset += batchSize) {
      tx.insert(siteCrawlGraphEdges).values(layout.edges.slice(offset, offset + batchSize).map((edge) => ({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        runId: scope.runId,
        attemptId: scope.attemptId,
        edgeKey: edge.edgeKey,
        sampleRank: edge.sampleRank,
        sourceNodeKey: edge.sourceNodeKey,
        targetNodeKey: edge.targetNodeKey,
        followable: edge.followable,
        occurrences: edge.occurrences,
        createdAt: now,
      }))).run()
    }
  })
}

/** Remove unpublished derived rows when terminal publication loses its CAS. */
export function deleteSiteCrawlGraphLayout(
  db: DatabaseClient,
  scope: { projectId: string; runId: string; attemptId: string },
): void {
  db.delete(siteCrawlGraphLayouts).where(and(
    eq(siteCrawlGraphLayouts.projectId, scope.projectId),
    eq(siteCrawlGraphLayouts.runId, scope.runId),
    eq(siteCrawlGraphLayouts.attemptId, scope.attemptId),
  )).run()
}
