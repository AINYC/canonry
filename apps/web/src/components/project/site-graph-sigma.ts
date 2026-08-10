import { MultiDirectedGraph } from 'graphology'
import { deriveSiteHealthState, type SiteHealthState } from '@ainyc/canonry-contracts'

import { SITE_HEALTH_HOME_LABEL } from './site-health-paths.js'

export type SiteGraphVisualState = SiteHealthState

/**
 * Dedicated Okabe-Ito-derived colors for the WebGL graph. They stay separate
 * from Canonry's global success/warning/error tones because this four-way data
 * encoding must remain distinguishable for common color-vision deficiencies.
 */
export const SITE_GRAPH_COLOR_TOKENS = {
  eligible: { property: '--chart-site-health-eligible', fallback: '#56b4e9' },
  hidden: { property: '--chart-site-health-hidden', fallback: '#e69f00' },
  failed: { property: '--chart-site-health-failed', fallback: '#d55e00' },
  unchecked: { property: '--chart-site-health-unchecked', fallback: '#a1a1aa' },
} as const satisfies Record<SiteGraphVisualState, { property: string; fallback: string }>

/** Default links must meet the 3:1 non-text contrast threshold in both themes. */
export const SITE_GRAPH_EDGE_TOKEN = {
  property: '--chart-neutral-text-dim',
  fallback: '#71717a',
} as const

/**
 * Ring drawn around the crawl root. It is a fifth Okabe-Ito hue so it stays
 * distinguishable from the four state colors, and it clears 3:1 against both
 * graph canvases.
 */
export const SITE_GRAPH_ROOT_TOKEN = {
  property: '--chart-site-health-root',
  fallback: '#cc79a7',
} as const

/** The home page is named, not pathed, so it reads at a glance. */
export const SITE_GRAPH_ROOT_LABEL = SITE_HEALTH_HOME_LABEL

/**
 * The root must stay findable at any internal-link score, so it never shrinks
 * to the importance-derived size the way every other page does.
 */
export const SITE_GRAPH_ROOT_MIN_SIZE = 14

/**
 * Structural subset of a published Site Health graph node. Positions are
 * computed with the snapshot and are never recomputed in the browser.
 */
export interface SiteGraphHealthSource {
  indexabilityState: string
  fetchState: string
  /** Optional server-owned state. Legacy graph snapshots derive it below. */
  healthState?: SiteGraphVisualState
  /** Optional legacy canonical identity metadata. New snapshots use healthState. */
  canonicalNodeKey?: string | null
  indexabilityReasons?: readonly string[]
  nodeKey?: string
}

export interface SiteGraphSigmaNode extends SiteGraphHealthSource {
  nodeKey: string
  url: string
  path: string
  depth: number | null
  /** Page-level Technical AEO score. It does not affect graph color or size. */
  auditScore?: number | null
  linkScoreNormalized: number | null
  inventoryEligible?: boolean
  x: number
  y: number
}

export interface SiteGraphSigmaEdge {
  edgeKey: string
  sourceNodeKey: string
  targetNodeKey: string | null
  followable: boolean
  occurrences: number
}

export interface SigmaSiteGraphTheme {
  eligible: string
  hidden: string
  failed: string
  unchecked: string
  dimmedNode: string
  edge: string
  edgeDimmed: string
  edgeActive: string
  label: string
  background: string
  root: string
}

/**
 * Sigma 3 only accepts hex and comma-delimited rgb(a) colors. Keep every
 * renderer-bound color in the existing neutral graph ladder or the dedicated
 * Site Health state palette, never in CSS's space-delimited color syntax.
 */
export const SITE_GRAPH_SIGMA_COLOR_TOKENS = {
  eligible: SITE_GRAPH_COLOR_TOKENS.eligible,
  hidden: SITE_GRAPH_COLOR_TOKENS.hidden,
  failed: SITE_GRAPH_COLOR_TOKENS.failed,
  unchecked: SITE_GRAPH_COLOR_TOKENS.unchecked,
  dimmedNode: { property: '--chart-neutral-text-dim', fallback: '#71717a' },
  edge: SITE_GRAPH_EDGE_TOKEN,
  edgeDimmed: { property: '--chart-neutral-text-faint', fallback: '#52525b' },
  edgeActive: { property: '--chart-neutral-text', fallback: '#a1a1aa' },
  label: { property: '--chart-tooltip-label', fallback: '#e4e4e7' },
  background: { property: '--chart-tooltip-bg', fallback: '#18181b' },
  root: SITE_GRAPH_ROOT_TOKEN,
} as const satisfies Record<keyof SigmaSiteGraphTheme, { property: string; fallback: string }>

const SIGMA_HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i
const SIGMA_LEGACY_RGB_COLOR = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/

/** Reject CSS Color 4 values that Sigma 3 would silently render as black. */
export function isSigmaWebGlColor(color: string): boolean {
  return SIGMA_HEX_COLOR.test(color) || SIGMA_LEGACY_RGB_COLOR.test(color)
}

export interface SigmaSiteGraphNodeAttributes extends Record<string, unknown> {
  x: number
  y: number
  size: number
  color: string
  baseColor: string
  label: string
  nodeKey: string
  url: string
  path: string
  depth: number | null
  status: SiteGraphVisualState
  glyph: string
  forceLabel: boolean
  zIndex: number
  /** True only for the server-identified crawl root. */
  isRoot: boolean
  /** Ring color painted around the root node; null for every other page. */
  ringColor: string | null
}

export interface SigmaSiteGraphEdgeAttributes extends Record<string, unknown> {
  size: number
  color: string
  baseColor: string
  followable: boolean
  occurrences: number
  type: 'line'
  zIndex: number
}

export type SigmaSiteGraph = MultiDirectedGraph<
  SigmaSiteGraphNodeAttributes,
  SigmaSiteGraphEdgeAttributes
>

export interface BuiltSigmaSiteGraph {
  graph: SigmaSiteGraph
  layoutAvailable: boolean
  omittedNodes: number
  omittedEdges: number
}

const SEARCH_RESULT_LIMIT = 50
/** Keep high-degree page focus useful without flooding the canvas with labels. */
export const SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT = 8
/** Sigma's fitted first paint is ratio 1; deeper labels appear after a real zoom-in. */
export const SITE_GRAPH_OVERVIEW_CAMERA_RATIO = 0.75

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedScore(node: SiteGraphSigmaNode): number {
  return Math.max(0, Math.min(1, node.linkScoreNormalized ?? 0))
}

/**
 * Server snapshots own health state. The exact-contract derivation is only a
 * compatibility path for historical snapshots that predate that field.
 */
export function siteGraphVisualState(node: SiteGraphHealthSource): SiteGraphVisualState {
  if (node.healthState) return node.healthState
  return deriveSiteHealthState(node)
}

export function siteGraphStatusLabel(state: SiteGraphVisualState): string {
  switch (state) {
    case 'eligible': return 'Technically eligible'
    case 'hidden': return 'Hidden or points elsewhere'
    case 'failed': return 'Fetch failed'
    case 'unchecked': return 'Not checked'
  }
}

/** Redundant non-color cue used in canvas labels, search results, and legend. */
export function siteGraphStatusGlyph(state: SiteGraphVisualState): string {
  switch (state) {
    case 'eligible': return '●'
    case 'hidden': return '◆'
    case 'failed': return '×'
    case 'unchecked': return '○'
  }
}

/**
 * Root identity is server-owned (`rootNodeKey` on the graph read). There is no
 * path or depth fallback on purpose: renaming the wrong page "Home" on a guess
 * would be worse than leaving the map unlabeled.
 */
export function isSiteGraphRootNode(
  node: SiteGraphHealthSource & { nodeKey: string },
  rootNodeKey: string | null | undefined,
): boolean {
  return Boolean(rootNodeKey) && node.nodeKey === rootNodeKey
}

export function siteGraphNodeSize(node: SiteGraphSigmaNode, isRoot = false): number {
  const importanceSize = 3 + Math.sqrt(normalizedScore(node)) * 7
  if (isRoot) return Math.max(SITE_GRAPH_ROOT_MIN_SIZE, importanceSize)
  return node.depth === 0 || node.path.trim() === '/' ? Math.max(9, importanceSize) : importanceSize
}

function nodeColor(state: SiteGraphVisualState, theme: SigmaSiteGraphTheme): string {
  switch (state) {
    case 'eligible': return theme.eligible
    case 'hidden': return theme.hidden
    case 'failed': return theme.failed
    case 'unchecked': return theme.unchecked
  }
}

function edgeSize(occurrences: number): number {
  return 0.35 + Math.min(1.65, Math.log2(Math.max(1, occurrences) + 1) * 0.28)
}

function hasFinitePosition(node: SiteGraphSigmaNode): boolean {
  return Number.isFinite(node.x) && Number.isFinite(node.y)
}

/** Build a directed multigraph from already-positioned snapshot data. */
export function buildSigmaSiteGraph(
  inputNodes: readonly SiteGraphSigmaNode[],
  inputEdges: readonly SiteGraphSigmaEdge[],
  theme: SigmaSiteGraphTheme,
  rootNodeKey: string | null = null,
): BuiltSigmaSiteGraph {
  const graph = new MultiDirectedGraph<
    SigmaSiteGraphNodeAttributes,
    SigmaSiteGraphEdgeAttributes
  >({ allowSelfLoops: true })
  const nodesByKey = new Map<string, SiteGraphSigmaNode>()

  for (const node of inputNodes) {
    if (!nodesByKey.has(node.nodeKey)) nodesByKey.set(node.nodeKey, node)
  }

  for (const node of [...nodesByKey.values()].sort((left, right) => lexical(left.nodeKey, right.nodeKey))) {
    if (!hasFinitePosition(node)) continue
    const status = siteGraphVisualState(node)
    const color = nodeColor(status, theme)
    const glyph = siteGraphStatusGlyph(status)
    const isRoot = isSiteGraphRootNode(node, rootNodeKey)
    graph.addNode(node.nodeKey, {
      x: node.x,
      y: node.y,
      size: siteGraphNodeSize(node, isRoot),
      color,
      baseColor: color,
      label: `${glyph} ${isRoot ? SITE_GRAPH_ROOT_LABEL : node.path || '/'}`,
      nodeKey: node.nodeKey,
      url: node.url,
      path: node.path,
      depth: node.depth,
      status,
      glyph,
      forceLabel: isRoot || node.depth === 0 || node.path.trim() === '/',
      zIndex: isRoot ? 2 : node.depth === 0 ? 1 : 0,
      isRoot,
      ringColor: isRoot ? theme.root : null,
    })
  }

  const seenEdgeKeys = new Set<string>()
  for (const edge of [...inputEdges].sort((left, right) => lexical(left.edgeKey, right.edgeKey))) {
    if (
      seenEdgeKeys.has(edge.edgeKey)
      || !edge.targetNodeKey
      || !graph.hasNode(edge.sourceNodeKey)
      || !graph.hasNode(edge.targetNodeKey)
    ) continue
    seenEdgeKeys.add(edge.edgeKey)
    graph.addDirectedEdgeWithKey(edge.edgeKey, edge.sourceNodeKey, edge.targetNodeKey, {
      size: edgeSize(edge.occurrences),
      color: theme.edge,
      baseColor: theme.edge,
      followable: edge.followable,
      occurrences: edge.occurrences,
      type: 'line',
      zIndex: 0,
    })
  }

  return {
    graph,
    layoutAvailable: inputNodes.length === 0 || graph.order > 0,
    omittedNodes: Math.max(0, inputNodes.length - graph.order),
    omittedEdges: Math.max(0, inputEdges.length - graph.size),
  }
}

export function findSiteGraphNodes(
  nodes: readonly SiteGraphSigmaNode[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): SiteGraphSigmaNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const boundedLimit = Math.max(0, Math.min(SEARCH_RESULT_LIMIT, Math.floor(limit)))
  return [...nodes]
    .sort((left, right) => lexical(left.path || left.url, right.path || right.url) || lexical(left.nodeKey, right.nodeKey))
    .filter((node) => {
      if (!hasFinitePosition(node)) return false
      if (!normalizedQuery) return true
      return `${node.path}\n${node.url}\n${node.nodeKey}`.toLocaleLowerCase().includes(normalizedQuery)
    })
    .slice(0, boundedLimit)
}

export interface SigmaSiteGraphReducers {
  nodeReducer: (
    nodeKey: string,
    attributes: SigmaSiteGraphNodeAttributes,
  ) => Partial<SigmaSiteGraphNodeAttributes>
  edgeReducer: (
    edgeKey: string,
    attributes: SigmaSiteGraphEdgeAttributes,
  ) => Partial<SigmaSiteGraphEdgeAttributes> & { hidden?: boolean }
}

/**
 * Reducers provide focus-on-neighborhood interaction without mutating the
 * graph. A zoomed-out overview keeps only the root and top-level labels while
 * hiding unrelated edges to protect legibility.
 */
export function createSigmaSiteGraphReducers(
  graph: SigmaSiteGraph,
  focusNodeKey: string | null,
  cameraRatio: number,
  theme: SigmaSiteGraphTheme,
): SigmaSiteGraphReducers {
  const hasFocus = Boolean(focusNodeKey && graph.hasNode(focusNodeKey))
  const focused = hasFocus ? focusNodeKey : null
  const overview = cameraRatio > SITE_GRAPH_OVERVIEW_CAMERA_RATIO
  const focusedNeighborLabelCandidates = new Set(
    focused && overview
      ? graph.neighbors(focused)
        .filter((nodeKey) => nodeKey !== focused)
        .sort((leftKey, rightKey) => {
          const left = graph.getNodeAttributes(leftKey)
          const right = graph.getNodeAttributes(rightKey)
          return right.size - left.size
            || (left.depth ?? Number.MAX_SAFE_INTEGER) - (right.depth ?? Number.MAX_SAFE_INTEGER)
            || lexical(left.path, right.path)
            || lexical(leftKey, rightKey)
        })
        .slice(0, SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT)
      : [],
  )

  return {
    nodeReducer: (nodeKey, attributes) => {
      // The crawl root anchors the whole map, so it keeps its label and its
      // marker in every view: zoomed out, and while another neighborhood has
      // focus. Nothing about its internal-link score can hide it.
      if (attributes.isRoot) {
        return nodeKey === focused
          ? { ...attributes, size: attributes.size * 1.35, forceLabel: true, zIndex: 3 }
          : { ...attributes, forceLabel: true }
      }
      if (focused) {
        if (nodeKey === focused) {
          return {
            ...attributes,
            size: attributes.size * 1.35,
            forceLabel: true,
            zIndex: 3,
          }
        }
        if (graph.areNeighbors(nodeKey, focused)) {
          if (!overview) return attributes
          return focusedNeighborLabelCandidates.has(nodeKey)
            ? { ...attributes, forceLabel: false }
            : { ...attributes, forceLabel: false, label: '' }
        }
        return {
          ...attributes,
          color: theme.dimmedNode,
          forceLabel: false,
          label: '',
          zIndex: 0,
        }
      }
      if (!overview) return attributes
      if (attributes.depth === 0 || attributes.depth === 1) {
        return { ...attributes, forceLabel: true }
      }
      return { ...attributes, forceLabel: false, label: '' }
    },
    edgeReducer: (edgeKey, attributes) => {
      const [sourceNodeKey, targetNodeKey] = graph.extremities(edgeKey)
      const highlighted = Boolean(
        focused && (sourceNodeKey === focused || targetNodeKey === focused),
      )
      if (highlighted) {
        return {
          ...attributes,
          color: theme.edgeActive,
          size: Math.max(1.4, attributes.size),
          zIndex: 2,
        }
      }
      if (overview) return { ...attributes, hidden: true }
      if (focused) {
        return {
          ...attributes,
          color: theme.edgeDimmed,
          size: Math.min(0.45, attributes.size),
          zIndex: 0,
        }
      }
      return attributes
    },
  }
}
