import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameTechnicalAeoRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey,
  getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey,
  getApiV1ProjectsByNameTechnicalAeoGraphQueryKey,
  getApiV1ProjectsByNameTechnicalAeoGraphQueryKey,
  getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { linkTileCount, siteHealthMetricHelp, SiteHealthSection } from '../src/components/project/SiteHealthSection.js'
import { heyClient } from '../src/api.js'

const mutationMock = vi.hoisted(() => ({ mutate: vi.fn() }))

vi.mock('../src/queries/mutations.js', () => ({
  useTriggerSiteAudit: () => ({
    isPending: false,
    mutate: mutationMock.mutate,
  }),
}))

vi.mock('@tanstack/react-router', async () => {
  const React = await import('react')
  return {
    Link: ({
      to,
      params,
      children,
      ...props
    }: {
      to: string
      params: { projectName: string }
      children?: React.ReactNode
    }) => React.createElement('a', {
      ...props,
      href: to.replace('$projectName', encodeURIComponent(params.projectName)),
    }, children),
  }
})

vi.mock('../src/components/project/TechnicalAeoSection.js', () => ({
  TechnicalAeoSection: ({ runId, integrated }: { runId?: string | null; integrated?: boolean }) => (
    <div data-integrated={integrated ? 'true' : 'false'}>Technical checks for {runId ?? 'latest'}</div>
  ),
}))

// Stable ids for the edge arrays the map is handed, so a test can assert the
// renderer was never given a NEW array (which would rebuild Sigma). Hoisted
// because the mock factory runs before this module body does.
const { edgeIdentity } = vi.hoisted(() => {
  const seen = new WeakMap<object, number>()
  let next = 0
  return {
    edgeIdentity(edges: unknown): number {
      if (!edges || typeof edges !== 'object') return -1
      const existing = seen.get(edges as object)
      if (existing !== undefined) return existing
      next += 1
      seen.set(edges as object, next)
      return next
    },
  }
})

vi.mock('../src/components/project/SiteGraphSigma.js', () => ({
  SiteGraphSigma: ({
    nodes,
    edges,
    showTemplateLinks,
    onSelectNode,
  }: {
    nodes: Array<{ nodeKey: string; path: string; x: number; y: number }>
    edges?: Array<{ edgeKey: string }>
    showTemplateLinks?: boolean
    onSelectNode?: (node: { nodeKey: string; path: string; x: number; y: number }) => void
  }) => (
    <div role="img" aria-label="Interactive site map">
      {nodes.map((node) => (
        <button key={node.nodeKey} type="button" onClick={() => onSelectNode?.(node)}>{node.path}</button>
      ))}
      {/* What the renderer was actually handed, so a test can assert which
          links are drawn and that positions never move. */}
      <span data-testid="site-map-edge-keys">{(edges ?? []).map((edge) => edge.edgeKey).join(',')}</span>
      <span data-testid="site-map-show-template">{String(showTemplateLinks)}</span>
      {/* Identity of the edge array the renderer was handed. Toggling must not
          change it, because a new array rebuilds the whole Sigma instance. */}
      <span data-testid="site-map-edges-identity">{String(edgeIdentity(edges))}</span>
      <span data-testid="site-map-node-positions">
        {nodes.map((node) => `${node.nodeKey}:${node.x},${node.y}`).join(';')}
      </span>
    </div>
  ),
}))

const projectName = 'citypoint'
const projectId = 'proj_1'

function scan(
  runId: string,
  status: 'completed' | 'partial' | 'running' | 'failed' | 'cancelled' = 'completed',
  hasCrawlData = true,
) {
  return {
    runId,
    status,
    startedAt: '2026-08-08T18:15:00.000Z',
    finishedAt: status === 'running' ? null : '2026-08-08T18:16:33.000Z',
    createdAt: '2026-08-08T18:15:00.000Z',
    hasCrawlData,
  }
}

/** The scan history is served newest first, exactly as the dropdown reads it. */
function scanHistoryKey() {
  return getApiV1ProjectsByNameTechnicalAeoRunsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { limit: 20 },
  })
}

function scanHistory(...scans: ReturnType<typeof scan>[]) {
  return { project: projectName, scans }
}

function summary(runId: string, pagesDiscovered: number, complete = true) {
  return {
    project: projectName,
    hasCrawlData: true,
    legacyAuditAvailable: true,
    runId,
    runStatus: complete ? 'completed' as const : 'partial' as const,
    requestedRootUrl: 'https://citypoint.example/',
    rootUrl: 'https://citypoint.example/',
    crawlSchemaVersion: '1',
    engineVersion: '4.6.2',
    normalizationVersion: '1',
    indexabilityVersion: '1',
    linkScoreVersion: '1',
    effectiveOptions: { checkDeadLinks: false },
    complete,
    // A real `CrawlTerminationReason` from @canonry/aeo-audit, not an invented
    // token: the plain-word copy is a closed map over that exact vocabulary.
    termination: complete ? null : 'max-pages',
    detailsAvailable: true,
    counts: {
      pagesDiscovered,
      pagesFetched: pagesDiscovered - 2,
      pagesEligible: pagesDiscovered - 5,
      edges: pagesDiscovered * 7,
      findings: 4,
    },
    deadLinks: { state: 'disabled' as const },
  }
}

const homePage = {
  nodeKey: 'page_home',
  url: 'https://citypoint.example/',
  finalUrl: 'https://citypoint.example/',
  path: '/',
  parentPath: '/',
  discoverySource: 'root',
  fetchState: 'html',
  httpStatus: 200,
  canonicalUrl: 'https://citypoint.example/',
  indexabilityState: 'indexable',
  indexabilityReasons: [],
  auditState: 'success',
  auditScore: 94,
  inventoryEligible: true,
  depth: 0,
  inboundUniqueEdges: 3,
  outboundUniqueEdges: 8,
  inboundOccurrences: 3,
  outboundOccurrences: 10,
  linkScoreRaw: 1,
  linkScoreNormalized: 1,
  healthState: 'eligible' as const,
}

const servicesPage = {
  ...homePage,
  nodeKey: 'page_services',
  url: 'https://citypoint.example/services/roof-repair',
  finalUrl: 'https://citypoint.example/services/roof-repair',
  path: '/services/roof-repair',
  parentPath: '/services',
  discoverySource: 'internal-link',
  auditScore: 61,
  depth: 3,
  inboundUniqueEdges: 1,
  outboundUniqueEdges: 2,
  inboundOccurrences: 2,
  outboundOccurrences: 2,
  linkScoreRaw: 0.4,
  linkScoreNormalized: 0.4,
}

const contactPage = {
  ...servicesPage,
  nodeKey: 'page_contact',
  url: 'https://citypoint.example/contact',
  finalUrl: 'https://citypoint.example/contact',
  path: '/contact',
  parentPath: '/',
  depth: 1,
}

const contentEdge = {
  edgeKey: 'home-services',
  sourceNodeKey: 'page_home',
  targetNodeKey: 'page_services',
  followable: true,
  occurrences: 2,
  isTemplate: false,
}

/** A nav link: the same anchor to the same page from every page on the site. */
const templateEdge = {
  edgeKey: 'nav-contact',
  sourceNodeKey: 'page_services',
  targetNodeKey: 'page_contact',
  followable: true,
  occurrences: 1,
  isTemplate: true,
}

function seedRun(
  queryClient: QueryClient,
  runId: string,
  crawlSummary = summary(runId, 42),
  graphOverrides: Record<string, unknown> = {},
) {
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId },
  }), crawlSummary)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId, maxNodes: 20_000, maxEdges: 50_000 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId,
    rootNodeKey: 'page_home',
    layout: {
      state: 'ready',
      version: 'site-health-fa2-v1',
      computedAt: '2026-08-08T18:16:33.000Z',
      templateLinksExcluded: true,
    },
    templateDetection: 'applied',
    linkKind: 'all',
    totalNodes: 2,
    totalEdges: 1,
    totalTemplateEdges: 0,
    totalContentEdges: 1,
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesPage, x: 1, y: 1 },
    ],
    edges: [contentEdge],
    omittedNodes: 0,
    omittedEdges: 0,
    sampled: false,
    ...graphOverrides,
  })
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId, limit: 200, sort: 'path' },
  } as const
  const pagesResponse = {
    project: projectName,
    hasCrawlData: true,
    runId,
    total: 2,
    nextCursor: null,
    pages: [homePage, servicesPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(pagesInput), pagesResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [pagesResponse],
    pageParams: [pagesInput],
  })

  const structureInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId, parentPath: '/', limit: 100 },
  } as const
  const structureResponse = {
    project: projectName,
    hasCrawlData: true,
    runId,
    parentPath: '/',
    nextCursor: null,
    children: [{
      path: '/services',
      url: null,
      hasPage: false,
      pageCount: 14,
      inventoryEligibleCount: 12,
      fetchedCount: 14,
    }],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoStructureQueryKey(structureInput), structureResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey(structureInput), {
    pages: [structureResponse],
    pageParams: [structureInput],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId, nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId,
    nodeKey: 'page_services',
    url: servicesPage.url,
    inbound: [],
    outbound: [],
    inboundTruncated: false,
    outboundTruncated: false,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId, nodeKey: 'page_services' },
  }), {
    state: 'ready',
    project: projectName,
    runId,
    complete: crawlSummary.complete,
    termination: crawlSummary.termination,
    nodeKey: 'page_services',
    url: servicesPage.url,
    auditState: 'complete',
    auditScore: 61,
    evidenceState: 'complete',
    factors: [{
      id: 'content-depth',
      name: 'Content depth',
      weight: 12,
      score: 35,
      status: 'fail',
      applicable: true,
      findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'The page is too thin.' }],
      recommendations: ['Add complete answers to the page.'],
    }],
    criticalDefects: [],
  })
}

function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1')))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
  }), summary('run_1', 42))
  seedRun(queryClient, 'run_1')
  return queryClient
}

function renderSection(
  queryClient = makeClient(),
  props: Partial<React.ComponentProps<typeof SiteHealthSection>> = {},
) {
  render(
    <QueryClientProvider client={queryClient}>
      <SiteHealthSection projectName={projectName} projectId={projectId} {...props} />
    </QueryClientProvider>,
  )
  return queryClient
}

beforeEach(() => {
  mutationMock.mutate.mockReset()
  Reflect.deleteProperty(window, '__CANONRY_CONFIG__')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('leads with the map, truthful crawl metrics, and an explicit disabled dead-link state', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = renderSection()

  expect(screen.getByRole('heading', { name: 'Site Health', level: 2 })).not.toBeNull()
  expect(screen.getByRole('option', { name: 'Latest scan' })).not.toBeNull()
  expect(screen.getByRole('tab', { name: 'Map' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('img', { name: 'Interactive site map' })).not.toBeNull()
  expect(screen.getByText('Indexable')).not.toBeNull()
  expect(screen.getByText('37')).not.toBeNull()
  const internalLinksMetric = screen.getByText('Internal links').parentElement
  expect(internalLinksMetric).not.toBeNull()
  expect(within(internalLinksMetric as HTMLElement).getByText('1')).not.toBeNull()
  expect(within(internalLinksMetric as HTMLElement).queryByText('294')).toBeNull()
  expect(screen.getByText('Dead-link check')).not.toBeNull()
  expect(screen.getByText('Broken links: not checked')).not.toBeNull()
  expect(screen.queryByText('0 broken links')).toBeNull()

  const deadLinksKey = getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 50 },
  })
  await waitFor(() => expect(queryClient.getQueryState(deadLinksKey)?.fetchStatus).toBe('idle'))
  expect(queryClient.getQueryState(deadLinksKey)?.dataUpdatedAt).toBe(0)
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('/dead-links')
  })).toBe(false)
})

test('shows the requested and effective hosts when the site moves during a scan', () => {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', {
    ...summary('run_1', 42),
    requestedRootUrl: 'https://citypoint.example/',
    rootUrl: 'https://www.citypoint.example/',
  })

  renderSection(queryClient)

  const banner = screen.getByRole('status')
  expect(within(banner).getByText('Site address changed during this scan.')).not.toBeNull()
  expect(within(banner).getByText('citypoint.example')).not.toBeNull()
  expect(within(banner).getByText('www.citypoint.example')).not.toBeNull()
  expect(within(banner).getByText(/The map and inventory use the new address/)).not.toBeNull()
})

test('uses the server-owned health state for both the inventory badge and selected-page badge', () => {
  const queryClient = makeClient()
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' },
  } as const
  const failedPage = {
    ...servicesPage,
    // Deliberately conflicts with the legacy fields: the server health state wins.
    fetchState: 'html',
    indexabilityState: 'indexable',
    auditState: 'success',
    inventoryEligible: true,
    healthState: 'failed' as const,
  }
  const pagesResponse = {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    total: 2,
    nextCursor: null,
    pages: [homePage, failedPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(pagesInput), pagesResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [pagesResponse],
    pageParams: [pagesInput],
  })
  const graphInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
  } as const
  const graph = queryClient.getQueryData<{ nodes: Array<typeof homePage & { x: number; y: number }> }>(
    getApiV1ProjectsByNameTechnicalAeoGraphQueryKey(graphInput),
  )!
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey(graphInput), {
    ...graph,
    nodes: graph.nodes.map((page) => page.nodeKey === failedPage.nodeKey
      ? { ...page, ...failedPage }
      : page),
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  expect(screen.getAllByText('Broken')).toHaveLength(2)
})

test('connects a selected graph page score to its exact audit finding in the same run', () => {
  const queryClient = renderSection()

  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  expect(screen.getByRole('heading', { name: 'Findings and fixes' })).not.toBeNull()
  expect(screen.getByLabelText('Score 61 out of 100')).not.toBeNull()
  expect(screen.getByText('The page is too thin.')).not.toBeNull()
  expect(screen.getByText('Add complete answers to the page.')).not.toBeNull()
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services' },
  }))).not.toBeUndefined()
})

test('uses a labelled, roving-focus tab interface for Site Health views', () => {
  renderSection()

  const map = screen.getByRole('tab', { name: 'Map' })
  const inventory = screen.getByRole('tab', { name: 'Pages' })
  const technical = screen.getByRole('tab', { name: 'Technical checks' })
  expect(map.getAttribute('id')).toBe('site-health-map-tab')
  expect(map.getAttribute('aria-controls')).toBe('site-health-map-panel')
  expect(map.getAttribute('tabindex')).toBe('0')
  expect(inventory.getAttribute('tabindex')).toBe('-1')
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('site-health-map-tab')

  map.focus()
  fireEvent.keyDown(map, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(inventory)
  expect(inventory.getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('site-health-inventory-tab')

  fireEvent.keyDown(inventory, { key: 'End' })
  expect(document.activeElement).toBe(technical)
  expect(technical.getAttribute('aria-selected')).toBe('true')

  fireEvent.keyDown(technical, { key: 'Home' })
  expect(document.activeElement).toBe(map)
  expect(map.getAttribute('aria-selected')).toBe('true')
})

test('keeps every detail read pinned to the selected historical run', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1'), scan('run_old', 'partial')))
  seedRun(queryClient, 'run_old', summary('run_old', 18, false))
  renderSection(queryClient)

  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), {
    target: { value: 'run_old' },
  })

  expect(screen.getByText('Partial scan')).not.toBeNull()
  expect(screen.getByText('18')).not.toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const neighborKey = getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_old', nodeKey: 'page_services', limit: 100 },
  })
  expect(queryClient.getQueryState(neighborKey)).not.toBeUndefined()
  expect(screen.getAllByText('Clicks from home')).not.toHaveLength(0)
  expect(screen.getAllByText('Link importance')).not.toHaveLength(0)

  fireEvent.click(screen.getByRole('tab', { name: 'Technical checks' }))
  expect(screen.getByText('Technical checks for run_old').getAttribute('data-integrated')).toBe('true')
})

test('defaults to the newest terminal run when that scan is partial', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_partial', 'partial'), scan('run_1')))
  seedRun(queryClient, 'run_partial', summary('run_partial', 18, false))

  renderSection(queryClient)

  expect(screen.getByText('Partial scan')).not.toBeNull()
  expect(screen.getByText('18')).not.toBeNull()
  expect(screen.getByText(/stopped at the page limit/i)).not.toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Technical checks' }))
  expect(screen.getByText(/stopped at the page limit/i)).not.toBeNull()
})

test('keeps dead-link checks off by default when starting a scan', () => {
  renderSection()

  fireEvent.click(screen.getByText('Scan settings'))
  const checkbox = screen.getByRole('checkbox', { name: 'Check dead links' }) as HTMLInputElement
  expect(checkbox.checked).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))

  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: false },
  })
})

test('releases a pinned onboarding scan before the header starts its replacement', async () => {
  const queryClient = makeClient()
  const onReleaseInitialRun = vi.fn()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_1' },
  }), {
    project: projectName,
    runId: 'run_1',
    status: 'completed',
    phase: 'completed',
    attempt: null,
    layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { initialRunId: 'run_1', onReleaseInitialRun })
  const history = screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement
  expect(history.value).toBe('run_1')

  fireEvent.click(screen.getByRole('button', { name: 'Run scan' }))

  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: false },
  })
  expect(onReleaseInitialRun).toHaveBeenCalledOnce()
  expect(history.value).toBe('')

  act(() => {
    queryClient.setQueryData(
      scanHistoryKey(),
      scanHistory(scan('run_2', 'running', false), scan('run_1')),
    )
  })
  expect(await screen.findByText(/a newer scan is running/i)).not.toBeNull()

  act(() => {
    seedRun(queryClient, 'run_2', summary('run_2', 64))
    queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_2'), scan('run_1')))
  })
  await waitFor(() => expect(screen.getByText('64')).not.toBeNull())
  expect(history.value).toBe('')
})

test('uses the exact active run for a first scan instead of showing stale-map copy', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_active' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: false,
    runId: 'run_active',
    runStatus: 'running',
  })

  renderSection(queryClient)

  expect(screen.getByRole('status').textContent).toContain('Scanning site')
  expect(screen.queryByText(/latest completed results remain/i)).toBeNull()
  expect(screen.queryByText('Full-site map not available')).toBeNull()
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_active' },
  }))).not.toBeUndefined()
})

test('defers the terminal-only crawl read for an active exact run and keeps progress visible', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'discovering',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    code: 'NOT_FOUND',
    message: 'No completed crawl exists for this run.',
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, { initialRunId: 'run_active' })

  await waitFor(() => expect(screen.getByRole('status', { name: 'Current scan progress' })).not.toBeNull())
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.getByRole('status', { name: 'Current scan progress' }).textContent).toContain('Discovering pages')
})

test('uses exact stored progress when the project run list is unavailable', async () => {
  const queryClient = makeClient()
  queryClient.removeQueries({
    queryKey: scanHistoryKey(),
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'running',
    phase: 'checking',
    attempt: null,
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })
  const requestedPaths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    requestedPaths.push(new URL(url).pathname)
    return new Response('{"error":{"message":"run list unavailable"}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }))

  renderSection(queryClient, { initialRunId: 'run_handoff' })

  const progress = await screen.findByRole('status', { name: 'Current scan progress' })
  expect(progress.textContent).toContain('Checking pages')
  expect(progress.closest('[role="tabpanel"]')?.getAttribute('id')).toBe('site-health-map-panel')
  expect(requestedPaths.some((path) => path.endsWith('/technical-aeo/crawl'))).toBe(false)
})

test('releases a stale exact handoff after the stored progress route returns not found', async () => {
  const queryClient = makeClient()
  const onReleaseInitialRun = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/technical-aeo/runs/run_missing/progress')) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Run not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
  }))

  renderSection(queryClient, { initialRunId: 'run_missing', onReleaseInitialRun })

  await waitFor(() => expect(onReleaseInitialRun).toHaveBeenCalledOnce())
  expect(screen.queryByRole('status', { name: 'Current scan progress' })).toBeNull()
  expect(screen.getByRole('img', { name: 'Interactive site map' })).not.toBeNull()
})

test('releases local exact-run selection when durable handoff state is cleared', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_1' },
  }), {
    project: projectName,
    runId: 'run_1',
    status: 'completed',
    phase: 'completed',
    attempt: null,
    layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: null },
    error: null,
  })
  const view = (initialRunId?: string) => (
    <QueryClientProvider client={queryClient}>
      <SiteHealthSection projectName={projectName} projectId={projectId} initialRunId={initialRunId} />
    </QueryClientProvider>
  )
  const { rerender } = render(view('run_1'))
  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('run_1')

  rerender(view(undefined))

  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('')
})

test('pins an onboarding handoff to its exact active scan after reload', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_handoff', 'running', false), scan('run_previous')),
  )
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_handoff' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: false,
    runId: 'run_handoff',
    runStatus: 'running',
  })

  renderSection(queryClient, { initialRunId: 'run_handoff' })

  expect(screen.getByRole('status').textContent).toContain('Scanning site')
  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('run_handoff')
  expect(screen.queryByRole('img', { name: 'Interactive site map' })).toBeNull()
})

test('shows exact stored scan progress as raw stages and counts, never a fabricated percentage', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_active', 'running', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_active' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: false,
    runId: 'run_active',
    runStatus: 'running',
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_active' },
  }), {
    project: projectName,
    runId: 'run_active',
    status: 'running',
    phase: 'checking',
    attempt: {
      id: 'attempt_1',
      state: 'running',
      pagesDiscovered: 47,
      pagesFetched: 19,
      pagesEligible: 16,
      pagesErrored: 2,
      edgesDiscovered: 105,
      lastUpdatedAt: '2026-08-09T12:00:00.000Z',
      startedAt: '2026-08-09T11:58:00.000Z',
      finishedAt: null,
      error: null,
    },
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient)

  const progress = screen.getByRole('status', { name: 'Current scan progress' })
  expect(within(progress).getByText(/Checking pages/)).not.toBeNull()
  expect(within(progress).getByText('47')).not.toBeNull()
  expect(within(progress).getByText('19')).not.toBeNull()
  expect(within(progress).getByText('2')).not.toBeNull()
  expect(progress.textContent).not.toMatch(/\d+%/)
})

test('keeps the exact onboarding run in arranging-map state until its terminal layout is published', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff')))
  seedRun(queryClient, 'run_handoff')
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'completed',
    phase: 'arranging-map',
    attempt: {
      id: 'attempt_1',
      state: 'completed',
      pagesDiscovered: 42,
      pagesFetched: 40,
      pagesEligible: 37,
      pagesErrored: 0,
      edgesDiscovered: 294,
      lastUpdatedAt: '2026-08-09T12:00:00.000Z',
      startedAt: '2026-08-09T11:58:00.000Z',
      finishedAt: '2026-08-09T12:00:00.000Z',
      error: null,
    },
    layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  })

  renderSection(queryClient, { initialRunId: 'run_handoff' })

  const progress = screen.getByRole('status', { name: 'Current scan progress' })
  expect(progress.textContent).toContain('Arranging map')
  expect(screen.queryByRole('img', { name: 'Interactive site map' })).toBeNull()
})

test('waits for arranging-map to finish before loading the large graph payload', async () => {
  const queryClient = makeClient()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff')))
  seedRun(queryClient, 'run_handoff')
  queryClient.removeQueries({
    queryKey: getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { runId: 'run_handoff', maxNodes: 20_000, maxEdges: 50_000 },
    }),
  })
  const progressKey = getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  })
  const arrangingProgress = {
    project: projectName,
    runId: 'run_handoff',
    status: 'completed' as const,
    phase: 'arranging-map' as const,
    attempt: null,
    layout: { state: 'pending' as const, layoutVersion: null, failureCode: null, updatedAt: null },
    error: null,
  }
  queryClient.setQueryData(progressKey, arrangingProgress)
  let layoutPublished = false
  const graphRequests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/graph')) return new Response('{}', { status: 500 })
    graphRequests.push(url)
    if (!layoutPublished) {
      return new Response('{"error":{"message":"layout pending"}}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      project: projectName,
      hasCrawlData: true,
      runId: 'run_handoff',
      layout: { state: 'ready', version: 'site-health-fa2-v1', computedAt: '2026-08-09T12:00:01.000Z' },
      totalNodes: 2,
      totalEdges: 1,
      nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }],
      edges: [],
      omittedNodes: 0,
      omittedEdges: 0,
      sampled: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))

  renderSection(queryClient, { initialRunId: 'run_handoff' })
  expect(screen.getByRole('status', { name: 'Current scan progress' }).textContent).toContain('Arranging map')

  layoutPublished = true
  act(() => {
    queryClient.setQueryData(progressKey, {
      ...arrangingProgress,
      phase: 'completed',
      layout: { state: 'ready', layoutVersion: 'site-health-fa2-v1', failureCode: null, updatedAt: '2026-08-09T12:00:01.000Z' },
    })
  })

  await screen.findByRole('img', { name: 'Interactive site map' })
  expect(graphRequests).toHaveLength(1)
})

test('offers rerun recovery when a pinned onboarding scan is cancelled before a map exists', async () => {
  const queryClient = makeClient()
  const onReleaseInitialRun = vi.fn()
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_handoff', 'cancelled', false)))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoRunsByRunIdProgressQueryKey({
    client: heyClient,
    path: { name: projectName, runId: 'run_handoff' },
  }), {
    project: projectName,
    runId: 'run_handoff',
    status: 'cancelled',
    phase: 'cancelled',
    attempt: null,
    layout: { state: 'unavailable', layoutVersion: null, failureCode: 'CANCELLED', updatedAt: null },
    error: null,
  })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    code: 'NOT_FOUND',
    message: 'No completed crawl exists for this run.',
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient, {
    initialRunId: 'run_handoff',
    onReleaseInitialRun,
  } as never)

  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const recovery = screen.getByRole('alert', { name: 'Site scan recovery' })
  expect(recovery.textContent).toContain('Scan cancelled')
  fireEvent.click(within(recovery).getByRole('button', { name: 'Run scan again' }))
  expect(mutationMock.mutate).toHaveBeenCalledWith({
    projectName,
    projectId,
    body: { checkDeadLinks: false },
  })
  expect(onReleaseInitialRun).toHaveBeenCalledOnce()
  expect((screen.getByRole('combobox', { name: 'View a Site Health scan' }) as HTMLSelectElement).value).toBe('')
})

test('offers measurement setup after a usable terminal map without claiming it inferred queries', () => {
  renderSection()

  const action = screen.getByRole('link', { name: 'Build measurement plan' })
  expect(action.getAttribute('href')).toBe('/projects/citypoint/portfolio')
  expect(screen.getByText(/review the pages and groups you want to measure/i)).not.toBeNull()
  expect(screen.queryByText(/queries were added automatically/i)).toBeNull()
})

test('offers the inventory as the direct recovery path when the graph read fails', async () => {
  const queryClient = makeClient()
  queryClient.removeQueries({
    queryKey: getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
    }),
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unavailable"}', {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })))

  renderSection(queryClient)

  await screen.findByText('The interactive map could not be loaded.')
  fireEvent.click(screen.getByRole('button', { name: 'Open page inventory' }))
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('site-health-inventory-tab')
})

test('loads the complete inventory in 200-page batches', async () => {
  const queryClient = makeClient()
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' as const },
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [{
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      total: 3,
      nextCursor: 'cursor_2',
      pages: [homePage, servicesPage],
    }],
    pageParams: [pagesInput],
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/crawl/pages')) {
      return new Response('{}', { status: 500 })
    }
    return new Response(JSON.stringify({
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      total: 3,
      nextCursor: null,
      pages: [contactPage],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))

  expect(screen.getByText('Showing 2 of 3 pages found.')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load more pages' }))

  await waitFor(() => expect(screen.getByText('Showing 3 of 3 pages found.')).not.toBeNull())
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('cursor=cursor_2')
  })).toBe(true)
  expect(screen.getByRole('button', { name: '/contact' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Load more pages' })).toBeNull()
})

test('makes loaded-window inventory search limits explicit', () => {
  const queryClient = makeClient()
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', limit: 200, sort: 'path' as const },
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(pagesInput), {
    pages: [{
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      total: 500,
      nextCursor: 'cursor_2',
      pages: [homePage, servicesPage],
    }],
    pageParams: [pagesInput],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded pages' }), {
    target: { value: '/not-loaded-yet' },
  })

  expect(screen.getByText('No matches in the 2 loaded pages. Load more pages to continue searching.')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Load more pages' })).not.toBeNull()
  expect(screen.queryByText('No pages match this search.')).toBeNull()
})

test('expands site sections lazily while preserving the selected run', () => {
  const queryClient = makeClient()
  const nestedInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', parentPath: '/services', limit: 100 },
  } as const
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey(nestedInput), {
    pages: [{
      project: projectName,
      hasCrawlData: true,
      runId: 'run_1',
      parentPath: '/services',
      nextCursor: null,
      children: [{
        path: '/services/roof-repair',
        url: servicesPage.url,
        hasPage: true,
        pageCount: 1,
        inventoryEligibleCount: 1,
        fetchedCount: 1,
      }],
    }],
    pageParams: [nestedInput],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: 'Expand /services' }))

  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  expect(within(sections).getByRole('button', { name: '/services/roof-repair' })).not.toBeNull()
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey(nestedInput))).not.toBeUndefined()
})

test('queries dead-link details only when the summary says the check ran', async () => {
  const queryClient = makeClient()
  const enabledSummary = {
    ...summary('run_1', 42),
    effectiveOptions: { checkDeadLinks: true },
    deadLinks: { state: 'complete' as const, checked: 41, found: 3 },
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
  }), enabledSummary)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1' },
  }), enabledSummary)
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/technical-aeo/dead-links')) return new Response('{}', { status: 500 })
    return new Response(JSON.stringify({
      project: projectName,
      runId: 'run_1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 41,
      found: 3,
      total: 3,
      nextCursor: null,
      deadLinks: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)

  renderSection(queryClient)

  await waitFor(() => expect(screen.getByText('Broken links: 3 found')).not.toBeNull())
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('/technical-aeo/dead-links')
  })).toBe(true)
})

test('lets long selected paths and URLs wrap in the page inspector', () => {
  renderSection()
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const path = screen.getByRole('heading', { name: '/services/roof-repair', level: 3 })
  const url = screen.getByText(servicesPage.url)
  expect(path.className).toContain('break-words')
  expect(path.className).not.toContain('truncate')
  expect(url.className).toContain('break-all')
  expect(url.className).not.toContain('truncate')
})

test('contains selected-page link tables inside mobile-safe grid items', () => {
  const queryClient = makeClient()
  const edge = {
    edgeKey: 'home-services',
    sourceNodeKey: homePage.nodeKey,
    sourceUrl: homePage.url,
    targetNodeKey: servicesPage.nodeKey,
    targetUrl: servicesPage.url,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Roof repair'],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    inbound: [edge],
    outbound: [{ ...edge, edgeKey: 'services-home', sourceNodeKey: servicesPage.nodeKey, sourceUrl: servicesPage.url, targetNodeKey: homePage.nodeKey, targetUrl: homePage.url }],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))

  const linksIn = screen.getByRole('region', { name: 'Links in (1)' })
  const linksOut = screen.getByRole('region', { name: 'Links out (1)' })
  expect(linksIn.className).toContain('min-w-0')
  expect(linksOut.className).toContain('min-w-0')
})

test('keeps the legacy scorecard available as a subordinate technical-checks view', () => {
  renderSection()

  fireEvent.click(screen.getByRole('tab', { name: 'Technical checks' }))

  expect(screen.getByText('Technical checks for run_1')).not.toBeNull()
})

test('removes map-specific chrome from the Technical checks view', () => {
  renderSection()

  expect(screen.getByText('Explore how pages, site sections, and internal links fit together.')).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Technical checks' }))

  expect(screen.getByText('Prioritize audit findings and inspect the pages that need work.')).not.toBeNull()
  expect(screen.queryByText('Pages found')).toBeNull()
  expect(screen.queryByText('Dead-link check')).toBeNull()
  expect(screen.getByText('Technical checks for run_1')).not.toBeNull()
})

test('marks a score-only scan in the history and renders its legacy state, not an error', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  queryClient.setQueryData(
    scanHistoryKey(),
    scanHistory(scan('run_1'), scan('run_legacy', 'completed', false)),
  )
  // With the route fix a legacy run answers 200 with hasCrawlData:false rather
  // than 404, so the existing no-crawl path takes over.
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_legacy' },
  }), {
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable: true,
    runId: null,
    runStatus: null,
    requestedRootUrl: null,
    rootUrl: null,
    effectiveOptions: {},
    complete: false,
    termination: null,
    detailsAvailable: false,
    counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
    deadLinks: { state: 'unavailable' as const },
  })

  renderSection(queryClient)

  const legacyOption = screen.getByRole('option', { name: /Score only/ }) as HTMLOptionElement
  expect(legacyOption.value).toBe('run_legacy')
  const crawlOption = screen.getByRole('option', { name: /Completed$/ }) as HTMLOptionElement
  expect(crawlOption.value).toBe('run_1')

  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), {
    target: { value: 'run_legacy' },
  })

  expect(screen.getByRole('heading', { name: 'Full-site map not available' })).not.toBeNull()
  expect(screen.getByText(/Existing technical checks are preserved/)).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Site Health could not load' })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('narrows the page list to hidden pages through the server-side filter', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const hiddenPage = {
    ...contactPage,
    nodeKey: 'page_hidden',
    url: 'https://citypoint.example/thank-you',
    finalUrl: 'https://citypoint.example/thank-you',
    path: '/thank-you',
    indexabilityState: 'noindex',
    indexabilityReasons: ['meta-robots-noindex', 'x-robots-noindex', 'brand-new-crawler-reason'],
    healthState: 'hidden' as const,
  }
  const hiddenInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' },
  } as const
  const hiddenResponse = {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    total: 1,
    nextCursor: null,
    pages: [hiddenPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(hiddenInput), hiddenResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(hiddenInput), {
    pages: [hiddenResponse],
    pageParams: [hiddenInput],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_hidden', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_hidden',
    url: hiddenPage.url,
    inbound: [],
    outbound: [],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))

  const allChip = screen.getByRole('button', { name: 'All' })
  const hiddenChip = screen.getByRole('button', { name: 'Hidden pages' })
  expect(allChip.getAttribute('aria-pressed')).toBe('true')
  expect(hiddenChip.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: '/services/roof-repair' })).not.toBeNull()

  fireEvent.click(hiddenChip)

  expect(hiddenChip.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '/thank-you' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: '/services/roof-repair' })).toBeNull()

  // The reasons read in plain words, and an unknown one is shown rather than dropped.
  fireEvent.click(screen.getByRole('button', { name: '/thank-you' }))
  const reasons = screen.getByRole('list', { name: 'Why this page is hidden' })
  expect(within(reasons).getByText('Hidden by meta robots tag')).not.toBeNull()
  expect(within(reasons).getByText('Hidden by X-Robots-Tag header')).not.toBeNull()
  expect(within(reasons).getByText('brand-new-crawler-reason')).not.toBeNull()
})

test('writes same-site link targets as paths and keeps the full URL on hover', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const baseEdge = {
    edgeKey: 'home-services',
    sourceNodeKey: homePage.nodeKey,
    sourceUrl: homePage.url,
    targetNodeKey: servicesPage.nodeKey,
    targetUrl: servicesPage.url,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Roof repair'],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    inbound: [baseEdge],
    outbound: [
      {
        ...baseEdge,
        edgeKey: 'services-offsite',
        sourceNodeKey: servicesPage.nodeKey,
        sourceUrl: servicesPage.url,
        targetNodeKey: null,
        targetUrl: 'https://directory.example/citypoint',
      },
    ],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const linksIn = screen.getByRole('region', { name: 'Links in (1)' })
  const homeCell = within(linksIn).getByText('/')
  expect(homeCell.getAttribute('title')).toBe('https://citypoint.example/')
  expect(within(linksIn).queryByText('https://citypoint.example/')).toBeNull()

  // A genuinely cross-host target is never disguised as an internal path.
  const linksOut = screen.getByRole('region', { name: 'Links out (1)' })
  expect(within(linksOut).getByText('https://directory.example/citypoint')).not.toBeNull()
})

test('inspects a map page that is outside the loaded inventory window', async () => {
  // The map holds every node while the inventory pages 200 at a time. This
  // selects a node that is ONLY on the map, so the by-key read is the only
  // thing that can supply its reasons.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const offWindowPage = {
    ...contactPage,
    nodeKey: 'page_far',
    url: 'https://citypoint.example/far',
    path: '/far',
    indexabilityState: 'noindex',
    indexabilityReasons: ['x-robots-noindex'],
    healthState: 'hidden' as const,
  }
  // On the map, absent from the loaded inventory page.
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', rootNodeKey: 'page_home',
    layout: { state: 'ready', version: 'site-health-fa2-v2', computedAt: '2026-08-08T18:16:33.000Z' },
    totalNodes: 3, totalEdges: 1,
    nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }, { ...offWindowPage, x: 2, y: 2 }],
    edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
  })
  const byKeyInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_far', limit: 1 },
  } as const
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(byKeyInput), {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 1, nextCursor: null,
    healthStateFilter: null, pages: [offWindowPage],
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_far', limit: 100 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', nodeKey: 'page_far',
    url: offWindowPage.url, inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
  })

  renderSection(queryClient)
  // Select it from the MAP, which is the only place it appears.
  fireEvent.click(screen.getByRole('button', { name: '/far' }))

  // The by-key read is what supplies its reasons; without it this page would
  // render as though the crawler gave no reason at all.
  await waitFor(() => expect(
    within(screen.getByRole('list', { name: 'Why this page is hidden' }))
      .getByText('Hidden by X-Robots-Tag header'),
  ).not.toBeNull())
  expect(queryClient.getQueryState(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(byKeyInput)))
    .not.toBeUndefined()
})

test('says the reasons are unknown when the single-page read fails', async () => {
  // A failed read is not "this page has no reasons". Rendering it as such is
  // indistinguishable from a page that genuinely has none.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(scanHistoryKey(), scanHistory(scan('run_1')))
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey({
    client: heyClient, path: { name: projectName },
  }), summary('run_1', 42))
  seedRun(queryClient, 'run_1')
  const offWindowPage = {
    ...contactPage, nodeKey: 'page_far', url: 'https://citypoint.example/far', path: '/far',
    indexabilityState: 'noindex', indexabilityReasons: ['x-robots-noindex'], healthState: 'hidden' as const,
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoGraphQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', maxNodes: 20_000, maxEdges: 50_000 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', rootNodeKey: 'page_home',
    layout: { state: 'ready', version: 'site-health-fa2-v2', computedAt: '2026-08-08T18:16:33.000Z' },
    totalNodes: 3, totalEdges: 1,
    nodes: [{ ...homePage, x: 0, y: 0 }, { ...servicesPage, x: 1, y: 1 }, { ...offWindowPage, x: 2, y: 2 }],
    edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/far' }))

  // The by-key read is left to fail against the stubbed 500.
  await waitFor(() => expect(
    screen.getByText(/any reason this page is hidden is unknown/i),
  ).not.toBeNull())
  expect(screen.queryByRole('list', { name: 'Why this page is hidden' })).toBeNull()
})

test('keeps a filtered selection until the server says it does not match', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const hiddenPage = {
    ...contactPage,
    nodeKey: 'page_hidden_far',
    url: 'https://citypoint.example/thanks',
    path: '/thanks',
    indexabilityState: 'noindex',
    indexabilityReasons: ['meta-robots-noindex'],
    healthState: 'hidden' as const,
  }
  const hiddenListInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' },
  } as const
  const hiddenListResponse = {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 1, nextCursor: null,
    healthStateFilter: 'applied' as const, pages: [hiddenPage],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(hiddenListInput), hiddenListResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(hiddenListInput), {
    pages: [hiddenListResponse], pageParams: [hiddenListInput],
  })
  // The server confirms this page is NOT in the filtered set.
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', nodeKey: 'page_services', limit: 1 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 0, nextCursor: null,
    healthStateFilter: 'applied' as const, pages: [],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hidden pages' }))

  // The selection is dropped because the SERVER answered, not because the
  // page was missing from the loaded window.
  await waitFor(() => expect(screen.getByRole('button', { name: '/thanks' })).not.toBeNull())
  expect(screen.getByText('Select a page to inspect its internal links and crawl signals.')).not.toBeNull()
})

test('says so when a scan is too old to filter, instead of showing an empty list', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  const legacyInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', healthState: 'hidden', limit: 200, sort: 'path' },
  } as const
  const legacyResponse = {
    project: projectName, hasCrawlData: true, runId: 'run_1', total: 0, nextCursor: null,
    healthStateFilter: 'unavailable-legacy-scan' as const, pages: [],
  }
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey(legacyInput), legacyResponse)
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey(legacyInput), {
    pages: [legacyResponse], pageParams: [legacyInput],
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('tab', { name: 'Pages' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hidden pages' }))

  expect(screen.getByText('This scan cannot be filtered. Run a new scan to filter its pages.')).not.toBeNull()
})

test('leads the site sections list with the root page, which is in no folder', async () => {
  // The sections list shows folders, and the home page belongs to none of
  // them, so it used to be the one page with nowhere to click.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = makeClient()
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_home', limit: 100 },
  }), {
    project: projectName, hasCrawlData: true, runId: 'run_1', nodeKey: 'page_home',
    url: homePage.url, inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
  })

  renderSection(queryClient)

  const sections = screen.getByRole('complementary', { name: 'Site sections' })
  const rows = within(sections).getAllByRole('listitem')
  // The root leads the list, written as the path it is.
  expect(within(rows[0]!).getByRole('button', { name: '/' })).not.toBeNull()
  expect(within(rows[1]!).getByRole('button', { name: '/services' })).not.toBeNull()

  // And it selects the root page rather than a folder path.
  fireEvent.click(within(rows[0]!).getByRole('button', { name: '/' }))
  await waitFor(() => expect(
    screen.getByRole('heading', { name: '/', level: 3 }),
  ).not.toBeNull())
})

/** A map with both kinds of link, and a page reachable only through the nav. */
function seedTemplateLinkGraph(overrides: Record<string, unknown> = {}) {
  const queryClient = makeClient()
  seedRun(queryClient, 'run_1', summary('run_1', 42), {
    totalEdges: 2,
    totalTemplateEdges: 1,
    totalContentEdges: 1,
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesPage, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
    edges: [contentEdge, templateEdge],
    ...overrides,
  })
  return queryClient
}

test('the map opens on content links only and says what it is hiding', () => {
  renderSection(seedTemplateLinkGraph())

  const toggle = screen.getByRole('checkbox', { name: 'Show nav and footer links' }) as HTMLInputElement
  expect(toggle.checked).toBe(false)
  expect(toggle.disabled).toBe(false)
  // Real numbers from the response, and the hidden links are named rather
  // than silently dropped.
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toContain('Showing 1 content link. 1 nav and footer link hidden.')

  // The renderer holds EVERY edge and is told to hide the template ones.
  // Handing it a shorter list instead would rebuild the renderer on a
  // checkbox, which is what used to kill the map.
  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
  expect(screen.getByTestId('site-map-show-template').textContent).toBe('false')
})

test('switching nav and footer links on draws them without moving a page', () => {
  renderSection(seedTemplateLinkGraph())

  const positionsBefore = screen.getByTestId('site-map-node-positions').textContent
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show nav and footer links' }))

  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
  expect(screen.getByTestId('site-map-show-template').textContent).toBe('true')
  expect(screen.getByTestId('site-map-link-counts').textContent)
    .toContain('Showing 1 content link and 1 nav and footer link.')
  // The layout was published without template links, so drawing them is a
  // rendering change only: nothing re-runs and no page moves.
  expect(screen.getByTestId('site-map-node-positions').textContent).toBe(positionsBefore)
})

test('disables the toggle in plain words when a scan is too small to classify', () => {
  renderSection(seedTemplateLinkGraph({
    templateDetection: 'unavailable-too-few-pages',
    totalTemplateEdges: 0,
    totalContentEdges: 2,
  }))

  const toggle = screen.getByRole('checkbox', { name: 'Show nav and footer links' }) as HTMLInputElement
  expect(toggle.disabled).toBe(true)
  expect(screen.getByText(/This scan found fewer than 15 pages/)).not.toBeNull()
  // It must not claim a split it could not make, so every link is drawn.
  expect(screen.getByTestId('site-map-link-counts').textContent).toContain('Showing all 2 links on this map.')
  expect(screen.getByTestId('site-map-edge-keys').textContent).toBe('home-services,nav-contact')
})

test('disables the toggle and explains a scan that predates the split', () => {
  renderSection(seedTemplateLinkGraph({ templateDetection: 'unavailable-legacy-scan' }))

  expect((screen.getByRole('checkbox', { name: 'Show nav and footer links' }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText(/ran before nav and footer links were separated/)).not.toBeNull()
})

test('says when a map\'s page positions still include the nav mesh', () => {
  renderSection(seedTemplateLinkGraph({
    layout: {
      state: 'ready',
      version: 'site-health-fa2-v2',
      computedAt: '2026-08-08T18:16:33.000Z',
      templateLinksExcluded: false,
    },
  }))

  expect(screen.getByText(/Page positions on this map were set before nav and footer links were separated/)).not.toBeNull()
})

test('reads an empty content-link set as a finding, with the real hidden counts', async () => {
  // canonry.ai: the homepage has 49 inbound / 30 outbound links but only 1
  // inbound / 5 outbound CONTENT links. With nav and footer hidden (the
  // default) a page whose only connections are chrome drew nothing and said
  // nothing, so a correct and interesting result looked like a broken map.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = seedTemplateLinkGraph()
  const templateEdge = (edgeKey: string, sourceNodeKey: string, targetNodeKey: string) => ({
    edgeKey,
    sourceNodeKey,
    sourceUrl: `https://citypoint.example/${sourceNodeKey}`,
    targetNodeKey,
    targetUrl: `https://citypoint.example/${targetNodeKey}`,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Home'],
    isTemplate: true,
    templateRatio: 0.9,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    // Only nav links point here, which is the whole finding.
    inbound: [templateEdge('t1', 'page_home', 'page_services'), templateEdge('t2', 'page_contact', 'page_services')],
    outbound: [],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  // Named counts, not an apology and not silence.
  expect(await screen.findByText('No content links to this page. 2 nav and footer links hidden.')).toBeTruthy()
  // Zero of ANY kind is a different fact and says so.
  expect(screen.getByText('This page links to nothing.')).toBeTruthy()

  // Switching nav links on shows them rather than the finding.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show nav and footer links' }))
  expect(screen.queryByText('No content links to this page. 2 nav and footer links hidden.')).toBeNull()
})

test('the link tiles count exactly what the tables list, in both toggle states', async () => {
  // Reported on canonry.ai: the tiles read "Links in 48 / Links out 26" while
  // the tables directly beneath read "(1)" and "(2)". Both were right, and
  // side by side with no labels the pair read as a broken table.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  // The crawl's own totals for this page must match the links seeded below,
  // the way a real crawl's do: 5 unique inbound edges, 2 outbound.
  const servicesWithLinks = { ...servicesPage, inboundUniqueEdges: 5, outboundUniqueEdges: 2 }
  const queryClient = seedTemplateLinkGraph({
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesWithLinks, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
  })

  const link = (edgeKey: string, isTemplate: boolean) => ({
    edgeKey,
    sourceNodeKey: 'page_home',
    sourceUrl: 'https://citypoint.example/',
    targetNodeKey: 'page_services',
    targetUrl: servicesPage.url,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: ['Roof repair'],
    isTemplate,
    templateRatio: isTemplate ? 0.9 : 0.1,
  })
  // One content link in among four nav links in; two content links out.
  const inbound = [link('in-content', false), ...Array.from({ length: 4 }, (_, i) => link(`in-nav-${i}`, true))]
  const outbound = [link('out-a', false), link('out-b', false)]
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    inbound,
    outbound,
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const tile = (label: string) => {
    const term = screen.getByText(label)
    return term.parentElement as HTMLElement
  }

  // Filter ON (the default): tile and table agree on the content-only count,
  // and the hidden amount is named rather than silently dropped.
  await waitFor(() => expect(within(tile('Links in')).getByText('1')).toBeTruthy())
  expect(within(tile('Links in')).getByText('4 nav and footer hidden')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (1)' })).toBeTruthy()
  // The hidden count is exactly the difference between the two states.
  expect(within(tile('Links out')).getByText('2')).toBeTruthy()
  expect(within(tile('Links out')).queryByText(/nav and footer hidden/)).toBeNull()
  expect(screen.getByRole('region', { name: 'Links out (2)' })).toBeTruthy()

  // Depth and importance are full-graph values, and the panel says so rather
  // than letting them look filtered.
  expect(screen.getByText('Clicks from home and link importance always count every link, including nav and footer.')).toBeTruthy()

  // Filter OFF: both show totals and the secondary line disappears.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show nav and footer links' }))
  expect(within(tile('Links in')).getByText('5')).toBeTruthy()
  expect(within(tile('Links in')).queryByText(/nav and footer hidden/)).toBeNull()
  expect(screen.getByRole('region', { name: 'Links in (5)' })).toBeTruthy()
  expect(screen.queryByText('Clicks from home and link importance always count every link, including nav and footer.')).toBeNull()
})

test('a link tile never presents a bounded count as a total', () => {
  // The neighbour read is capped, so a truncated list proves only a lower
  // bound. Rounding that into a flat number would be a quiet lie.
  expect(linkTileCount({ total: 48, visible: 1, hidden: 47, truncated: false, showTemplateLinks: false, known: true }))
    .toEqual({ value: '1', hiddenNote: '47 nav and footer hidden', filtered: true })

  expect(linkTileCount({ total: 500, visible: 100, hidden: 400, truncated: true, showTemplateLinks: false, known: true }))
    .toEqual({ value: '100+', hiddenNote: 'At least 400 nav and footer hidden', filtered: true })

  // Filter off: the crawl's own total, and no secondary line.
  expect(linkTileCount({ total: 48, visible: 1, hidden: 47, truncated: false, showTemplateLinks: true, known: true }))
    .toEqual({ value: '48', hiddenNote: null, filtered: false })

  // Nothing hidden is not a note worth showing.
  // Nothing hidden, but the filter IS in force: no note to show, yet the tile
  // is still a content-only count and the tooltip must say so.
  expect(linkTileCount({ total: 3, visible: 3, hidden: 0, truncated: false, showTemplateLinks: false, known: true }))
    .toEqual({ value: '3', hiddenNote: null, filtered: true })

  // Before the neighbour read lands there is no per-kind answer, so the tile
  // shows the total rather than flashing a zero.
  // A legacy scan cannot tell nav from content, so the tile is NOT filtered:
  // claiming "content links only" there would be a lie.
  expect(linkTileCount({ total: 48, visible: 0, hidden: 0, truncated: false, showTemplateLinks: false, known: false }))
    .toEqual({ value: '48', hiddenNote: null, filtered: false })
})

test('both count fixes hold at once: filtered tiles and no self-link anywhere', async () => {
  // The two bugs on this panel were independent and had to be true together:
  // the tiles must follow the toggle, and neither surface may count a page's
  // link to itself. This is a page with template inbound AND a self-link.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  // 2 real inbound (1 content, 1 nav) and 1 real outbound, as the crawl's own
  // page metrics count them: the self-link is in neither, at either layer.
  const servicesWithLinks = { ...servicesPage, inboundUniqueEdges: 2, outboundUniqueEdges: 1 }
  const queryClient = seedTemplateLinkGraph({
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesWithLinks, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
  })
  const link = (edgeKey: string, from: string, to: string, isTemplate: boolean) => ({
    edgeKey,
    sourceNodeKey: from,
    sourceUrl: `https://citypoint.example/${from}`,
    targetNodeKey: to,
    targetUrl: `https://citypoint.example/${to}`,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: isTemplate ? [] : ['Roof repair'],
    isTemplate,
    templateRatio: isTemplate ? 0.9 : 0.1,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    // The API no longer returns the self-link in either direction: the writer
    // drops it and the migration cleared the stored ones.
    inbound: [link('in-content', 'page_home', 'page_services', false), link('in-nav', 'page_contact', 'page_services', true)],
    outbound: [link('out-content', 'page_services', 'page_home', false)],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement
  const selfLinkRows = () => screen.queryAllByText('/page_services')

  // Filter on: tiles match the tables, and no self-link is listed anywhere.
  await waitFor(() => expect(within(tile('Links in')).getByText('1')).toBeTruthy())
  expect(within(tile('Links in')).getByText('1 nav and footer hidden')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (1)' })).toBeTruthy()
  expect(within(tile('Links out')).getByText('1')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links out (1)' })).toBeTruthy()
  expect(selfLinkRows()).toHaveLength(0)

  // Filter off: tiles show the crawl's totals, which also exclude the
  // self-link, and the tables agree with them.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show nav and footer links' }))
  expect(within(tile('Links in')).getByText('2')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links in (2)' })).toBeTruthy()
  expect(within(tile('Links out')).getByText('1')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Links out (1)' })).toBeTruthy()
  expect(selfLinkRows()).toHaveLength(0)
})

test('metric help text tells the truth about what the nav and footer filter changes', () => {
  // Depth and link score are computed by the crawl over the FULL link graph,
  // before nav links are told apart, so the filter cannot move them. Sitting
  // beside two filtered tiles, they have to say so or they read as filtered.
  expect(siteHealthMetricHelp('clicksFromHome', false)).toBe(
    'How many clicks it takes to reach this page from the home page, following links. This always counts every link, including nav and footer.',
  )
  expect(siteHealthMetricHelp('linkImportance', false)).toBe(
    'How much link value flows to this page, based on how many pages link to it and how important those pages are. Shown relative to the highest page on this site, which is 100%. This always counts every link, including nav and footer.',
  )
  // A full-graph metric ignores the argument entirely: there is no state in
  // which it is a filtered number, so no caller can make it claim otherwise.
  expect(siteHealthMetricHelp('clicksFromHome', true)).toBe(siteHealthMetricHelp('clicksFromHome', false))
  expect(siteHealthMetricHelp('linkImportance', true)).toBe(siteHealthMetricHelp('linkImportance', false))

  // The two counts that DO follow the toggle describe whichever number is on
  // screen right now.
  expect(siteHealthMetricHelp('linksIn', true)).toBe(
    'How many other pages link to this page. Right now this counts content links only. Nav and footer links are hidden.',
  )
  expect(siteHealthMetricHelp('linksIn', false)).toBe(
    'How many other pages link to this page. This counts every link, including nav and footer.',
  )
  expect(siteHealthMetricHelp('linksOut', true)).toBe(
    'How many other pages this page links to. Right now this counts content links only. Nav and footer links are hidden.',
  )
  expect(siteHealthMetricHelp('linksOut', false)).toBe(
    'How many other pages this page links to. This counts every link, including nav and footer.',
  )

  // Metrics with nothing to qualify are left alone rather than padded with a
  // sentence about a filter that does not apply to them.
  expect(siteHealthMetricHelp('technicalScore', true)).toBe(siteHealthMetricHelp('technicalScore', false))
  expect(siteHealthMetricHelp('linkTimes', true)).toBe(siteHealthMetricHelp('linkTimes', false))
})

test('the tile tooltips are keyboard reachable and follow the nav and footer toggle', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  const servicesWithLinks = { ...servicesPage, inboundUniqueEdges: 2, outboundUniqueEdges: 1 }
  const queryClient = seedTemplateLinkGraph({
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesWithLinks, x: 1, y: 1 },
      { ...contactPage, x: -1, y: 1 },
    ],
  })
  const link = (edgeKey: string, from: string, to: string, isTemplate: boolean) => ({
    edgeKey,
    sourceNodeKey: from,
    sourceUrl: `https://citypoint.example/${from}`,
    targetNodeKey: to,
    targetUrl: `https://citypoint.example/${to}`,
    relation: 'anchor',
    internal: true,
    followable: true,
    occurrences: 1,
    followableOccurrences: 1,
    nofollowOccurrences: 0,
    anchors: isTemplate ? [] : ['Roof repair'],
    isTemplate,
    templateRatio: isTemplate ? 0.9 : 0.1,
  })
  queryClient.setQueryData(getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_1', nodeKey: 'page_services', limit: 100 },
  }), {
    project: projectName,
    hasCrawlData: true,
    runId: 'run_1',
    nodeKey: 'page_services',
    url: servicesPage.url,
    templateDetection: 'applied',
    linkKind: 'all',
    inbound: [link('in-content', 'page_home', 'page_services', false), link('in-nav', 'page_contact', 'page_services', true)],
    outbound: [link('out-content', 'page_services', 'page_home', false)],
    inboundTruncated: false,
    outboundTruncated: false,
  })

  renderSection(queryClient)
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  // The explanation is the trigger's accessible name, so a screen reader gets
  // it without a hover ever happening.
  await waitFor(() => expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksIn', true) })).toBeTruthy())
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksOut', true) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('clicksFromHome', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linkImportance', false) })).toBeTruthy()

  // Focus alone reveals the bubble, so the copy is not hover-only.
  const trigger = screen.getByRole('button', { name: siteHealthMetricHelp('linksIn', true) })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.focus(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')

  // Toggle off the filter and the two filterable tiles stop claiming to be
  // content-only, while the two full-graph tiles are untouched.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show nav and footer links' }))
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksIn', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linksOut', false) })).toBeTruthy()
  expect(screen.queryByRole('button', { name: siteHealthMetricHelp('linksIn', true) })).toBeNull()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('clicksFromHome', false) })).toBeTruthy()
  expect(screen.getByRole('button', { name: siteHealthMetricHelp('linkImportance', false) })).toBeTruthy()
})
