// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { parseColor } from 'sigma/utils'

import {
  buildSigmaSiteGraph,
  createSigmaSiteGraphReducers,
  findSiteGraphNodes,
  SITE_GRAPH_EDGE_TOKEN,
  SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT,
  SITE_GRAPH_ROOT_LABEL,
  SITE_GRAPH_ROOT_MIN_SIZE,
  SITE_GRAPH_ROOT_TOKEN,
  SITE_GRAPH_SIGMA_COLOR_TOKENS,
  isSigmaWebGlColor,
  isSiteGraphRootNode,
  siteGraphNodeSize,
  siteGraphStatusGlyph,
  siteGraphVisualState,
  type SigmaSiteGraphTheme,
  type SiteGraphSigmaEdge,
  type SiteGraphSigmaNode,
} from '../src/components/project/site-graph-sigma.js'

const theme: SigmaSiteGraphTheme = {
  eligible: 'rgb(1, 2, 3)',
  hidden: 'rgb(4, 5, 6)',
  failed: 'rgb(7, 8, 9)',
  unchecked: 'rgb(10, 11, 12)',
  dimmedNode: 'rgb(13, 14, 15)',
  edge: 'rgb(16, 17, 18)',
  edgeDimmed: 'rgb(19, 20, 21)',
  edgeActive: 'rgb(22, 23, 24)',
  label: 'rgb(25, 26, 27)',
  background: 'rgb(28, 29, 30)',
  root: 'rgb(31, 32, 33)',
}

function node(
  nodeKey: string,
  overrides: Partial<SiteGraphSigmaNode> = {},
): SiteGraphSigmaNode {
  return {
    nodeKey,
    url: `https://example.com/${nodeKey}`,
    path: `/${nodeKey}`,
    depth: 1,
    indexabilityState: 'indexable',
    fetchState: 'html',
    linkScoreNormalized: 0.5,
    x: 10,
    y: 20,
    ...overrides,
  }
}

function edge(
  edgeKey: string,
  sourceNodeKey: string,
  targetNodeKey: string | null,
): SiteGraphSigmaEdge {
  return {
    edgeKey,
    sourceNodeKey,
    targetNodeKey,
    followable: true,
    occurrences: 1,
  }
}

describe('buildSigmaSiteGraph', () => {
  it('uses only non-black colors accepted by Sigma 3 for every renderer binding', () => {
    for (const [binding, token] of Object.entries(SITE_GRAPH_SIGMA_COLOR_TOKENS)) {
      expect(isSigmaWebGlColor(token.fallback), `${binding} must use Sigma's supported color syntax`).toBe(true)
      const parsed = parseColor(token.fallback)
      expect([parsed.r, parsed.g, parsed.b], `${binding} must not render black`).not.toEqual([0, 0, 0])
    }

    expect(isSigmaWebGlColor('rgb(255 255 255 / 0.06)')).toBe(false)
  })

  it('prefers the server-published health state and uses an exact legacy fallback only when absent', () => {
    expect(siteGraphVisualState(node('server-owned', {
      healthState: 'hidden',
      fetchState: 'html',
      indexabilityState: 'indexable',
    }))).toBe('hidden')
    expect(siteGraphVisualState(node('legacy', {
      fetchState: 'fetch-error',
    }))).toBe('failed')
    expect(siteGraphVisualState(node('legacy-redirect', {
      fetchState: 'redirect',
      indexabilityState: 'indexable',
    }))).toBe('hidden')
    expect(siteGraphVisualState(node('legacy-canonical-source', {
      canonicalNodeKey: 'legacy-canonical-target',
      fetchState: 'html',
      indexabilityState: 'indexable',
    }))).toBe('hidden')
    expect(siteGraphVisualState(node('legacy-pending', {
      fetchState: 'discovered',
      indexabilityState: 'unknown',
    }))).toBe('unchecked')
    expect(siteGraphVisualState(node('legacy-unrecognized', {
      fetchState: 'fetch-error-but-not-a-crawler-state',
      indexabilityState: 'indexable',
    }))).toBe('unchecked')
  })

  it('adds a distinct status glyph to labels so color is never the only visual cue', () => {
    const result = buildSigmaSiteGraph(
      [
        node('eligible'),
        node('hidden', { indexabilityState: 'noindex' }),
        node('failed', { fetchState: 'fetch-error' }),
        node('unchecked', { fetchState: 'discovered', indexabilityState: 'unknown' }),
      ],
      [],
      theme,
    )

    expect(siteGraphStatusGlyph('eligible')).toBe('●')
    expect(siteGraphStatusGlyph('hidden')).toBe('◆')
    expect(siteGraphStatusGlyph('failed')).toBe('×')
    expect(siteGraphStatusGlyph('unchecked')).toBe('○')
    expect(result.graph.getNodeAttribute('eligible', 'label')).toBe('● /eligible')
    expect(result.graph.getNodeAttribute('hidden', 'label')).toBe('◆ /hidden')
    expect(result.graph.getNodeAttribute('failed', 'label')).toBe('× /failed')
    expect(result.graph.getNodeAttribute('unchecked', 'label')).toBe('○ /unchecked')
    expect(result.graph.getNodeAttribute('eligible', 'color')).toBe(theme.eligible)
    expect(result.graph.getNodeAttribute('hidden', 'color')).toBe(theme.hidden)
    expect(result.graph.getNodeAttribute('failed', 'color')).toBe(theme.failed)
    expect(result.graph.getNodeAttribute('unchecked', 'color')).toBe(theme.unchecked)
    expect(new Set(result.graph.mapNodes((_key, attributes) => attributes.size))).toEqual(
      new Set([siteGraphNodeSize(node('same-size'))]),
    )
    expect(SITE_GRAPH_EDGE_TOKEN).toEqual({
      property: '--chart-neutral-text-dim',
      fallback: '#71717a',
    })
    expect(SITE_GRAPH_ROOT_TOKEN).toEqual({
      property: '--chart-site-health-root',
      fallback: '#cc79a7',
    })
  })

  it('uses the server-published positions without running a browser layout', () => {
    const result = buildSigmaSiteGraph(
      [
        node('home', { path: '/', depth: 0, x: -91.25, y: 43.5, linkScoreNormalized: 1 }),
        node('pricing', { x: 122.75, y: -8.25, indexabilityState: 'noindex' }),
      ],
      [edge('home-pricing', 'home', 'pricing')],
      theme,
    )

    expect(result.layoutAvailable).toBe(true)
    expect(result.graph.type).toBe('directed')
    expect(result.graph.multi).toBe(true)
    expect(result.graph.getNodeAttributes('home')).toMatchObject({
      x: -91.25,
      y: 43.5,
      size: siteGraphNodeSize(node('home', { path: '/', depth: 0, linkScoreNormalized: 1 })),
      status: 'eligible',
    })
    expect(result.graph.getNodeAttributes('pricing')).toMatchObject({
      x: 122.75,
      y: -8.25,
      color: theme.hidden,
      status: 'hidden',
    })
    expect(result.graph.extremities('home-pricing')).toEqual(['home', 'pricing'])
  })

  it('drops invalid positions, dangling edges, and duplicate keys deterministically', () => {
    const result = buildSigmaSiteGraph(
      [
        node('home', { x: 0, y: 0 }),
        node('home', { x: 100, y: 100 }),
        node('missing-position', { x: Number.NaN }),
      ],
      [
        edge('valid', 'home', 'home'),
        edge('dangling', 'home', 'missing-position'),
        edge('unresolved', 'home', null),
        edge('valid', 'home', 'home'),
      ],
      theme,
    )

    expect(result.graph.order).toBe(1)
    expect(result.graph.size).toBe(1)
    expect(result.graph.getNodeAttribute('home', 'x')).toBe(0)
    expect(result.omittedNodes).toBe(2)
    expect(result.omittedEdges).toBe(3)
  })

  it('reports an unavailable layout when pages exist but none have finite positions', () => {
    const result = buildSigmaSiteGraph(
      [node('one', { x: Number.NaN }), node('two', { y: Number.POSITIVE_INFINITY })],
      [],
      theme,
    )

    expect(result.layoutAvailable).toBe(false)
    expect(result.graph.order).toBe(0)
  })

  it('dims non-neighbors and hides unrelated edges in the zoomed-out overview', () => {
    const result = buildSigmaSiteGraph(
      [node('home'), node('pricing'), node('unrelated', { healthState: 'failed' })],
      [edge('home-pricing', 'home', 'pricing'), edge('pricing-unrelated', 'pricing', 'unrelated')],
      theme,
    )
    const reducers = createSigmaSiteGraphReducers(result.graph, 'home', 2, theme)

    expect(reducers.nodeReducer('pricing', result.graph.getNodeAttributes('pricing')).color).toBe(theme.eligible)
    expect(reducers.nodeReducer('unrelated', result.graph.getNodeAttributes('unrelated'))).toMatchObject({
      color: theme.dimmedNode,
      label: '',
      status: 'failed',
      glyph: '×',
    })
    expect(reducers.edgeReducer('home-pricing', result.graph.getEdgeAttributes('home-pricing'))).toMatchObject({
      color: theme.edgeActive,
      zIndex: 2,
    })
    expect(reducers.edgeReducer('pricing-unrelated', result.graph.getEdgeAttributes('pricing-unrelated'))).toMatchObject({
      hidden: true,
    })
  })

  it('limits overview labels to home and top-level nodes without hiding a focused neighborhood', () => {
    const result = buildSigmaSiteGraph(
      [
        node('home', { path: '/', depth: 0 }),
        node('services', { path: '/services', depth: 1 }),
        node('roof-repair', { path: '/services/roof-repair', depth: 2 }),
        node('gutter-repair', { path: '/services/gutter-repair', depth: 2 }),
        node('unrelated', { path: '/blog/guides/article', depth: 3 }),
      ],
      [
        edge('home-services', 'home', 'services'),
        edge('services-roof', 'services', 'roof-repair'),
        edge('roof-gutter', 'roof-repair', 'gutter-repair'),
      ],
      theme,
    )
    const overview = createSigmaSiteGraphReducers(result.graph, null, 2, theme)
    const home = result.graph.getNodeAttributes('home')
    const services = result.graph.getNodeAttributes('services')
    const roofRepair = result.graph.getNodeAttributes('roof-repair')

    expect(overview.nodeReducer('home', home)).toMatchObject({ label: '● /', forceLabel: true })
    expect(overview.nodeReducer('services', services)).toMatchObject({ label: '● /services', forceLabel: true })
    expect(overview.nodeReducer('roof-repair', roofRepair)).toMatchObject({ label: '', forceLabel: false })

    // Sigma's fitted camera starts at ratio 1. The first paint is the
    // overview, so it must already suppress deep labels before any input.
    const fittedOverview = createSigmaSiteGraphReducers(result.graph, null, 1, theme)
    expect(fittedOverview.nodeReducer('roof-repair', roofRepair)).toMatchObject({ label: '', forceLabel: false })

    const focusedOverview = createSigmaSiteGraphReducers(result.graph, 'roof-repair', 2, theme)
    expect(focusedOverview.nodeReducer('roof-repair', roofRepair)).toMatchObject({
      label: '● /services/roof-repair',
      forceLabel: true,
    })
    expect(focusedOverview.nodeReducer('gutter-repair', result.graph.getNodeAttributes('gutter-repair'))).toMatchObject({
      label: '● /services/gutter-repair',
      forceLabel: false,
    })

    const zoomedIn = createSigmaSiteGraphReducers(result.graph, null, 0.5, theme)
    expect(zoomedIn.nodeReducer('roof-repair', roofRepair)).toEqual(roofRepair)
  })

  it('bounds collision-safe label candidates around a high-degree focused page by link importance', () => {
    const neighbors = Array.from({ length: 24 }, (_, index) => node(`article-${String(index).padStart(2, '0')}`, {
      path: `/blog/article-${String(index).padStart(2, '0')}`,
      depth: 2,
      linkScoreNormalized: index / 23,
    }))
    const result = buildSigmaSiteGraph(
      [node('blog', { path: '/blog', depth: 1, linkScoreNormalized: 1 }), ...neighbors],
      [
        edge('blog-self', 'blog', 'blog'),
        ...neighbors.map((neighbor) => edge(`blog-${neighbor.nodeKey}`, 'blog', neighbor.nodeKey)),
      ],
      theme,
    )
    const reducers = createSigmaSiteGraphReducers(result.graph, 'blog', 2, theme)
    const candidateNeighbors = neighbors.filter((neighbor) => {
      const reduced = reducers.nodeReducer(
        neighbor.nodeKey,
        result.graph.getNodeAttributes(neighbor.nodeKey),
      )
      return reduced.label !== ''
    })
    const suppressedNeighbors = neighbors.filter((neighbor) => !candidateNeighbors.includes(neighbor))

    expect(SITE_GRAPH_FOCUSED_NEIGHBOR_LABEL_LIMIT).toBe(8)
    expect(candidateNeighbors.map((neighbor) => neighbor.nodeKey)).toEqual([
      'article-16',
      'article-17',
      'article-18',
      'article-19',
      'article-20',
      'article-21',
      'article-22',
      'article-23',
    ])
    for (const neighbor of candidateNeighbors) {
      expect(reducers.nodeReducer(
        neighbor.nodeKey,
        result.graph.getNodeAttributes(neighbor.nodeKey),
      )).toMatchObject({ forceLabel: false })
    }
    expect(suppressedNeighbors).toHaveLength(16)
    for (const neighbor of suppressedNeighbors) {
      expect(reducers.nodeReducer(
        neighbor.nodeKey,
        result.graph.getNodeAttributes(neighbor.nodeKey),
      )).toMatchObject({ color: theme.eligible, forceLabel: false, label: '' })
    }
    expect(reducers.nodeReducer('blog', result.graph.getNodeAttributes('blog'))).toMatchObject({
      label: '● /blog',
      forceLabel: true,
    })

    const reversed = buildSigmaSiteGraph(
      [...neighbors].reverse().concat(node('blog', { path: '/blog', depth: 1, linkScoreNormalized: 1 })),
      [
        edge('blog-self', 'blog', 'blog'),
        ...[...neighbors].reverse().map((neighbor) => edge(`blog-${neighbor.nodeKey}`, 'blog', neighbor.nodeKey)),
      ],
      theme,
    )
    const reversedReducers = createSigmaSiteGraphReducers(reversed.graph, 'blog', 2, theme)
    expect(neighbors.filter((neighbor) => reversedReducers.nodeReducer(
      neighbor.nodeKey,
      reversed.graph.getNodeAttributes(neighbor.nodeKey),
    ).label !== '').map((neighbor) => neighbor.nodeKey)).toEqual(
      candidateNeighbors.map((neighbor) => neighbor.nodeKey),
    )

    const zoomedIn = createSigmaSiteGraphReducers(result.graph, 'blog', 0.5, theme)
    expect(zoomedIn.nodeReducer(
      'article-00',
      result.graph.getNodeAttributes('article-00'),
    )).toEqual(result.graph.getNodeAttributes('article-00'))
  })
})

describe('findSiteGraphNodes', () => {
  it('returns a stable, bounded search result instead of rendering every node', () => {
    const nodes = [
      ...Array.from({ length: 80 }, (_, index) => node(`page-${String(index).padStart(2, '0')}`)),
      node('missing-layout', { x: Number.NaN }),
    ]

    expect(findSiteGraphNodes(nodes, '', 50)).toHaveLength(50)
    expect(findSiteGraphNodes(nodes, 'page-77', 50).map((item) => item.nodeKey)).toEqual(['page-77'])
    expect(findSiteGraphNodes([...nodes].reverse(), 'page', 3).map((item) => item.nodeKey)).toEqual([
      'page-00',
      'page-01',
      'page-02',
    ])
  })
})

describe('the crawl root', () => {
  const graphWithRoot = () => buildSigmaSiteGraph(
    [
      node('home', { path: '/', depth: 0, linkScoreNormalized: 0 }),
      node('services', { path: '/services', depth: 1, linkScoreNormalized: 1 }),
      node('deep', { path: '/blog/guides/article', depth: 3 }),
    ],
    [edge('home-services', 'home', 'services'), edge('services-deep', 'services', 'deep')],
    theme,
    'home',
  )

  it('takes its identity from the server and never guesses from a path or a depth', () => {
    expect(isSiteGraphRootNode(node('home', { path: '/', depth: 0 }), 'home')).toBe(true)
    expect(isSiteGraphRootNode(node('home', { path: '/', depth: 0 }), null)).toBe(false)
    expect(isSiteGraphRootNode(node('home', { path: '/', depth: 0 }), 'other')).toBe(false)

    const unidentified = buildSigmaSiteGraph([node('home', { path: '/', depth: 0 })], [], theme)
    expect(unidentified.graph.getNodeAttribute('home', 'isRoot')).toBe(false)
    expect(unidentified.graph.getNodeAttribute('home', 'label')).toBe('● /')
    expect(unidentified.graph.getNodeAttribute('home', 'ringColor')).toBeNull()
  })

  it('is named, always labeled, oversized, and ringed regardless of link score', () => {
    const root = graphWithRoot().graph.getNodeAttributes('home')

    expect(root.label).toBe(`● ${SITE_GRAPH_ROOT_LABEL}`)
    expect(root.label).not.toContain('/')
    expect(root.forceLabel).toBe(true)
    expect(root.isRoot).toBe(true)
    expect(root.ringColor).toBe(theme.root)
    // The lowest possible internal-link score must not shrink it.
    expect(root.size).toBe(SITE_GRAPH_ROOT_MIN_SIZE)
    expect(root.size).toBeGreaterThan(
      graphWithRoot().graph.getNodeAttribute('services', 'size'),
    )
    expect(root.zIndex).toBeGreaterThan(graphWithRoot().graph.getNodeAttribute('services', 'zIndex'))
  })

  it('keeps its label and ring in the overview and while another page has focus', () => {
    const built = graphWithRoot()
    const root = built.graph.getNodeAttributes('home')

    const overview = createSigmaSiteGraphReducers(built.graph, null, 2, theme)
    expect(overview.nodeReducer('home', root)).toMatchObject({
      label: `● ${SITE_GRAPH_ROOT_LABEL}`,
      forceLabel: true,
      ringColor: theme.root,
    })

    // Focused elsewhere, and not even a neighbor of the focus.
    const focusedElsewhere = createSigmaSiteGraphReducers(built.graph, 'deep', 2, theme)
    expect(focusedElsewhere.nodeReducer('home', root)).toMatchObject({
      label: `● ${SITE_GRAPH_ROOT_LABEL}`,
      forceLabel: true,
      ringColor: theme.root,
    })
    expect(focusedElsewhere.nodeReducer('home', root).color).toBe(theme.eligible)

    const focusedOnRoot = createSigmaSiteGraphReducers(built.graph, 'home', 2, theme)
    expect(focusedOnRoot.nodeReducer('home', root)).toMatchObject({
      forceLabel: true,
      zIndex: 3,
      size: root.size * 1.35,
    })
  })
})
