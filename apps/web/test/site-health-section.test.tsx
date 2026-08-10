import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  getApiV1ProjectsByNameTechnicalAeoStructureInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoStructureQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { SiteHealthSection } from '../src/components/project/SiteHealthSection.js'
import { heyClient } from '../src/api.js'

const mutationMock = vi.hoisted(() => ({ mutate: vi.fn() }))

vi.mock('../src/queries/mutations.js', () => ({
  useTriggerSiteAudit: () => ({
    isPending: false,
    mutate: mutationMock.mutate,
  }),
}))

vi.mock('../src/components/project/TechnicalAeoSection.js', () => ({
  TechnicalAeoSection: ({ runId, integrated }: { runId?: string | null; integrated?: boolean }) => (
    <div data-integrated={integrated ? 'true' : 'false'}>Technical checks for {runId ?? 'latest'}</div>
  ),
}))

vi.mock('../src/components/project/SiteGraphSigma.js', () => ({
  SiteGraphSigma: ({
    nodes,
    onSelectNode,
  }: {
    nodes: Array<{ nodeKey: string; path: string }>
    onSelectNode?: (node: { nodeKey: string; path: string }) => void
  }) => (
    <div role="img" aria-label="Interactive site map">
      {nodes.map((node) => (
        <button key={node.nodeKey} type="button" onClick={() => onSelectNode?.(node)}>{node.path}</button>
      ))}
    </div>
  ),
}))

const projectName = 'citypoint'
const projectId = 'proj_1'

function scan(
  runId: string,
  status: 'completed' | 'partial' | 'running' = 'completed',
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

function seedRun(queryClient: QueryClient, runId: string, crawlSummary = summary(runId, 42)) {
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
    },
    totalNodes: 2,
    totalEdges: 1,
    nodes: [
      { ...homePage, x: 0, y: 0 },
      { ...servicesPage, x: 1, y: 1 },
    ],
    edges: [],
    omittedNodes: 0,
    omittedEdges: 0,
    sampled: false,
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

function renderSection(queryClient = makeClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <SiteHealthSection projectName={projectName} projectId={projectId} />
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
