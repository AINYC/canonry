import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getApiV1ProjectsByNameRunsQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesQueryKey,
  getApiV1ProjectsByNameTechnicalAeoCrawlQueryKey,
  getApiV1ProjectsByNameTechnicalAeoDeadLinksQueryKey,
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

function run(id: string, status: 'completed' | 'partial' | 'running' = 'completed') {
  return {
    id,
    projectId,
    kind: 'site-audit' as const,
    status,
    trigger: 'manual' as const,
    location: null,
    startedAt: '2026-08-08T18:15:00.000Z',
    finishedAt: status === 'running' ? null : '2026-08-08T18:16:33.000Z',
    error: null,
    createdAt: '2026-08-08T18:15:00.000Z',
  }
}

function summary(runId: string, pagesDiscovered: number, complete = true) {
  return {
    project: projectName,
    hasCrawlData: true,
    legacyAuditAvailable: true,
    runId,
    runStatus: complete ? 'completed' as const : 'partial' as const,
    rootUrl: 'https://citypoint.example/',
    crawlSchemaVersion: '1',
    engineVersion: '4.6.2',
    normalizationVersion: '1',
    indexabilityVersion: '1',
    linkScoreVersion: '1',
    effectiveOptions: { checkDeadLinks: false },
    complete,
    termination: complete ? null : 'page_limit',
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
}

function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(getApiV1ProjectsByNameRunsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { kind: 'site-audit', limit: 20 },
  }), [run('run_1')])
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
  expect(screen.getByText('Technically eligible')).not.toBeNull()
  expect(screen.getByText('37')).not.toBeNull()
  const internalLinksMetric = screen.getByText('Internal links').parentElement
  expect(internalLinksMetric).not.toBeNull()
  expect(within(internalLinksMetric as HTMLElement).getByText('1')).not.toBeNull()
  expect(within(internalLinksMetric as HTMLElement).queryByText('294')).toBeNull()
  expect(screen.getByText('Dead-link check')).not.toBeNull()
  expect(screen.getByText('Check off')).not.toBeNull()
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

test('uses a labelled, roving-focus tab interface for Site Health views', () => {
  renderSection()

  const map = screen.getByRole('tab', { name: 'Map' })
  const inventory = screen.getByRole('tab', { name: 'Inventory' })
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
  queryClient.setQueryData(getApiV1ProjectsByNameRunsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { kind: 'site-audit', limit: 20 },
  }), [run('run_old', 'partial'), run('run_1')])
  seedRun(queryClient, 'run_old', summary('run_old', 18, false))
  renderSection(queryClient)

  fireEvent.change(screen.getByRole('combobox', { name: 'View a Site Health scan' }), {
    target: { value: 'run_old' },
  })

  expect(screen.getByText('Partial scan')).not.toBeNull()
  expect(screen.getByText('18')).not.toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }))
  fireEvent.click(screen.getByRole('button', { name: '/services/roof-repair' }))

  const neighborKey = getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { runId: 'run_old', nodeKey: 'page_services', limit: 100 },
  })
  expect(queryClient.getQueryState(neighborKey)).not.toBeUndefined()
  expect(screen.getAllByText('Crawl depth')).not.toHaveLength(0)
  expect(screen.getAllByText('Internal-link importance')).not.toHaveLength(0)

  fireEvent.click(screen.getByRole('tab', { name: 'Technical checks' }))
  expect(screen.getByText('Technical checks for run_old').getAttribute('data-integrated')).toBe('true')
})

test('defaults to the newest terminal run when that scan is partial', () => {
  const queryClient = makeClient()
  queryClient.setQueryData(getApiV1ProjectsByNameRunsQueryKey({
    client: heyClient,
    path: { name: projectName },
    query: { kind: 'site-audit', limit: 20 },
  }), [run('run_1'), run('run_partial', 'partial')])
  seedRun(queryClient, 'run_partial', summary('run_partial', 18, false))

  renderSection(queryClient)

  expect(screen.getByText('Partial scan')).not.toBeNull()
  expect(screen.getByText('18')).not.toBeNull()
  expect(screen.getByText(/configured page limit/i)).not.toBeNull()
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
  fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }))

  expect(screen.getByText('Loaded 2 of 3 discovered pages.')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load more pages' }))

  await waitFor(() => expect(screen.getByText('Loaded 3 of 3 discovered pages.')).not.toBeNull())
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('cursor=cursor_2')
  })).toBe(true)
  expect(screen.getByRole('button', { name: '/contact' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Load more pages' })).toBeNull()
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

  await waitFor(() => expect(screen.getByText('3 found')).not.toBeNull())
  expect(fetchMock.mock.calls.some(([input]) => {
    const url = input instanceof Request ? input.url : String(input)
    return url.includes('/technical-aeo/dead-links')
  })).toBe(true)
})

test('lets long selected paths and URLs wrap in the page inspector', () => {
  renderSection()
  fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }))
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
  fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }))

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
