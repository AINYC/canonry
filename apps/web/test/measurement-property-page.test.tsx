import { afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { heyClient } from '../src/api.js'
import {
  getApiV1ProjectsByNameMeasurementOverviewQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const TARGET_KEY = 'harbor-house'
const RUN_ID = 'run-synthetic'

type Metric =
  | { state: 'available'; value: number; numerator: number; denominator: number }
  | { state: 'unavailable'; reason: string }

const available = (numerator: number, denominator: number): Metric => ({
  state: 'available',
  value: numerator / denominator,
  numerator,
  denominator,
})
const unavailable = (reason: string): Metric => ({ state: 'unavailable', reason })

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(cleanup)

function planResponse() {
  return {
    active: {
      revision: 7,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-01T12:00:00.000Z',
      plan: {
        schemaVersion: 2 as const,
        identities: {
          projectBrand: {
            canonicalHost: 'locations.example',
            ownedHosts: ['locations.example'],
            names: ['Locations'],
          },
        },
        targets: [{
          stableKey: TARGET_KEY,
          label: 'Harbor House',
          aliases: ['Harbor House'],
          urlMatchers: [{ kind: 'prefix' as const, host: 'locations.example', pathPrefix: '/harbor-house', pathCase: 'insensitive' as const }],
          mentionNotApplicable: false,
          discoveryIdentity: 'sitemap:harbor-house',
        }],
        groups: [{ stableKey: 'north', label: 'North', targetKeys: [TARGET_KEY], competitors: [] }],
        querySnapshots: [{
          queryId: 'query-nearby',
          queryText: 'boutique hotels near the harbor',
          provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-08-01T12:00:00.000Z' },
        }],
        assignments: [{ targetKey: TARGET_KEY, queryId: 'query-nearby', queryClass: 'non-brand' as const, executionNodeKey: 'node-nearby' }],
        executionNodes: [{
          stableKey: 'node-nearby',
          queryId: 'query-nearby',
          queryText: 'boutique hotels near the harbor',
          context: { providers: ['openai' as const], models: {}, location: null },
          expectedSnapshots: 1,
        }],
        usageEdges: [{ executionNodeKey: 'node-nearby', targetKey: TARGET_KEY, queryId: 'query-nearby' }],
        compiledChecksum: 'b'.repeat(64),
      },
    },
  }
}

function legacyPlanResponse() {
  return {
    active: {
      revision: 6,
      checksum: 'c'.repeat(64),
      createdAt: '2026-08-01T12:00:00.000Z',
      plan: {
        schemaVersion: 1 as const,
        defaultContext: null,
        effectiveOwnedHosts: ['locations.example'],
        projectCanonicalHost: 'locations.example',
        projectBrandNames: ['Locations'],
        targets: [],
        groups: [],
        targetQuerySelections: [],
        querySnapshots: [],
        executionNodes: [],
        usageEdges: [],
        warnings: [],
      },
    },
  }
}

function overviewResponse(queryClass: 'branded' | 'non-brand', row: {
  mentionCoverage: Metric
  citationCoverage: Metric
  providers?: Array<{ provider: string; mentionCoverage: Metric; citationCoverage: Metric }>
}, options: { measurementState?: 'complete' | 'not_measured'; nextAction?: 'none' | 'run_measurement' } = {}) {
  return {
    mode: 'active-v2' as const,
    scope: { kind: 'property' as const, key: TARGET_KEY, label: 'Harbor House' },
    queryClass,
    measurement: {
      state: options.measurementState ?? 'complete',
      displayedRunId: RUN_ID,
      completed: 2,
      expected: 2,
      completedAt: '2026-08-02T12:05:00.000Z',
    },
    nextAction: { kind: options.nextAction ?? 'none' },
    metrics: {
      propertiesMentioned: row.mentionCoverage,
      mentionCoverage: row.mentionCoverage,
      citationCoverage: row.citationCoverage,
      brandPresence: row.mentionCoverage,
      sov: row.mentionCoverage,
    },
    properties: {
      items: [{
        targetKey: TARGET_KEY,
        label: 'Harbor House',
        mentionCoverage: row.mentionCoverage,
        citationCoverage: row.citationCoverage,
        providers: row.providers ?? [],
        flags: 0,
      }],
      nextCursor: null,
      totalEstimate: 1,
    },
    flags: { total: 0 },
  }
}

function evidenceResponse() {
  return {
    property: { targetKey: TARGET_KEY, label: 'Harbor House' },
    queryClass: 'non-brand' as const,
    measurement: { state: 'complete' as const, displayedRunId: RUN_ID },
    evidence: {
      items: [{
        observationId: 'obs-1',
        expectedSlotId: 'slot:node-nearby:openai',
        executionId: 'node-nearby',
        usageEdgeId: `target:${TARGET_KEY}:query-nearby:node-nearby`,
        usageEdgeType: 'target' as const,
        provider: 'openai',
        queryText: 'boutique hotels near the harbor',
        location: null,
        sourceUrl: 'https://locations.example/harbor-house',
        bridged: false,
        historical: false,
        evidenceComplete: true,
        classification: 'assigned' as const,
        normalizedUrl: 'https://locations.example/harbor-house',
        matchedTargetIds: [TARGET_KEY],
        matchedUrlIds: [`${TARGET_KEY}:url:0`],
      }],
      nextCursor: null,
      totalEstimate: 1,
    },
  }
}

async function renderPropertyPage(options: {
  branded: ReturnType<typeof overviewResponse>
  nonBrand: ReturnType<typeof overviewResponse>
  plan?: ReturnType<typeof planResponse> | ReturnType<typeof legacyPlanResponse>
}): Promise<void> {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
    options.plan ?? planResponse(),
  )
  for (const [queryClass, response] of [['branded', options.branded], ['non-brand', options.nonBrand]] as const) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementOverviewQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: { scope: 'property', targetKey: TARGET_KEY, queryClass },
      }),
      response,
    )
  }
  const evidenceQuery = { targetKey: TARGET_KEY, queryClass: 'non-brand' as const, limit: 50, runId: RUN_ID }
  queryClient.setQueryData(
    getApiV1ProjectsByNameMeasurementPropertyEvidenceInfiniteQueryKey({
      client: heyClient,
      path: { name: projectName },
      query: evidenceQuery,
    }),
    {
      pages: [evidenceResponse()],
      pageParams: [{ path: { name: projectName }, query: evidenceQuery }],
    },
  )

  const router = createAppRouter(queryClient, {
    initialEntries: [`/projects/${projectName}/properties/${TARGET_KEY}`],
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

async function renderPropertyPageFromApi(handler: (url: string) => Response | Promise<Response>) {
  const fixture = createDashboardFixture({})
  const projectName = fixture.dashboard.projects.find(project => project.project.id === 'project_citypoint')!.project.name
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const restoreFetch = mockFetch(url => handler(url))
  onTestFinished(restoreFetch)
  const router = createAppRouter(queryClient, {
    initialEntries: [`/projects/${projectName}/properties/${TARGET_KEY}`],
  })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
  return { projectName, queryClient }
}

function propertyPageResponses({
  branded = overviewResponse('branded', { mentionCoverage: available(1, 2), citationCoverage: available(1, 2) }),
  nonBrand = overviewResponse('non-brand', { mentionCoverage: available(3, 4), citationCoverage: available(2, 4) }),
  evidence = evidenceResponse(),
}: {
  branded?: ReturnType<typeof overviewResponse>
  nonBrand?: ReturnType<typeof overviewResponse>
  evidence?: ReturnType<typeof evidenceResponse>
} = {}) {
  return (url: string) => {
    const path = pathOf(url)
    if (path.endsWith('/measurement-plan')) return jsonResponse(planResponse())
    if (path.includes('/measurement-overview')) {
      return new URL(url).searchParams.get('queryClass') === 'branded'
        ? jsonResponse(branded)
        : jsonResponse(nonBrand)
    }
    if (path.includes('/measurement-property-evidence')) return jsonResponse(evidence)
    throw new Error(`Unexpected fetch: ${path}`)
  }
}

describe('Property page', () => {
  it('keeps the compact loading skeleton inside a readable status', async () => {
    await renderPropertyPageFromApi(() => new Promise<Response>(() => {}))

    expect((await screen.findByRole('status')).textContent).toContain('Loading Property')
  })

  it('keeps a successful class visible when the other class fails and retries only that class', async () => {
    let brandedAttempts = 0
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('queryClass') === 'branded') {
        brandedAttempts += 1
        return brandedAttempts === 1
          ? new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
          : jsonResponse(overviewResponse('branded', { mentionCoverage: available(2, 2), citationCoverage: available(2, 2) }))
      }
      return propertyPageResponses()(url)
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by question class',
    })
    const nonBrand = within(contrast).getByText('When they don\'t').closest('tr')!
    expect(within(nonBrand).getByText('75%')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Could not load branded questions.')

    fireEvent.click(screen.getByRole('button', { name: 'Retry branded questions' }))
    await waitFor(() => expect(within(contrast).getAllByText('100%')).toHaveLength(2))
    expect(brandedAttempts).toBe(2)
  })

  it('keeps cached class metrics and evidence visible when a background refresh fails', async () => {
    let brandedAttempts = 0
    const { projectName, queryClient } = await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-overview') && new URL(url).searchParams.get('queryClass') === 'branded') {
        brandedAttempts += 1
        if (brandedAttempts === 2) {
          return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
        }
        return jsonResponse(overviewResponse('branded', {
          mentionCoverage: available(brandedAttempts === 1 ? 1 : 2, 2),
          citationCoverage: available(brandedAttempts === 1 ? 1 : 2, 2),
        }))
      }
      return propertyPageResponses()(url)
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by question class',
    })
    const branded = within(contrast).getByText('When they know your name').closest('tr')!
    expect(within(branded).getAllByText('50%')).toHaveLength(2)
    const evidence = await screen.findByRole('table', { name: 'Source evidence for this Property' })

    await queryClient.refetchQueries({
      exact: true,
      queryKey: getApiV1ProjectsByNameMeasurementOverviewQueryKey({
        client: heyClient,
        path: { name: projectName },
        query: { scope: 'property', targetKey: TARGET_KEY, queryClass: 'branded' },
      }),
    })

    await screen.findByText('Refresh failed.')
    expect(within(branded).getAllByText('50%')).toHaveLength(2)
    expect(within(evidence).getByText('https://locations.example/harbor-house')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry branded questions' }))
    await waitFor(() => expect(within(branded).getAllByText('100%')).toHaveLength(2))
    expect(brandedAttempts).toBe(3)
  })

  it('keeps the complete cached Property page when every report refresh fails', async () => {
    let failRefresh = false
    const responses = propertyPageResponses()
    const { projectName, queryClient } = await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (failRefresh && (path.endsWith('/measurement-plan') || path.includes('/measurement-overview'))) {
        return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return responses(url)
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by question class',
    })
    const evidence = await screen.findByRole('table', { name: 'Source evidence for this Property' })
    failRefresh = true
    await Promise.all([
      queryClient.refetchQueries({
        exact: true,
        queryKey: getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
      }),
      ...(['branded', 'non-brand'] as const).map(queryClass => queryClient.refetchQueries({
        exact: true,
        queryKey: getApiV1ProjectsByNameMeasurementOverviewQueryKey({
          client: heyClient,
          path: { name: projectName },
          query: { scope: 'property', targetKey: TARGET_KEY, queryClass },
        }),
      })),
    ])

    expect(screen.queryByText('Could not load this Property.')).toBeNull()
    expect(contrast).toBeTruthy()
    expect(within(evidence).getByText('https://locations.example/harbor-house')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('Refresh failed.')).toHaveLength(2))
  })

  it('keeps loaded evidence on a next-page failure and retries that page from one alert', async () => {
    let nextPageAttempts = 0
    await renderPropertyPageFromApi(url => {
      const path = pathOf(url)
      if (path.includes('/measurement-property-evidence')) {
        if (new URL(url).searchParams.get('cursor') === 'next') {
          nextPageAttempts += 1
          if (nextPageAttempts === 1) {
            return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500, headers: { 'content-type': 'application/json' } })
          }
          return jsonResponse({
            ...evidenceResponse(),
            evidence: {
              ...evidenceResponse().evidence,
              items: [{ ...evidenceResponse().evidence.items[0], observationId: 'obs-2', sourceUrl: 'https://locations.example/harbor-house/dining' }],
              nextCursor: null,
              totalEstimate: 2,
            },
          })
        }
        return jsonResponse({
          ...evidenceResponse(),
          evidence: { ...evidenceResponse().evidence, nextCursor: 'next', totalEstimate: 2 },
        })
      }
      return propertyPageResponses()(url)
    })

    const evidence = await screen.findByRole('table', { name: 'Source evidence for this Property' })
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load more evidence.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(evidence).getByText('https://locations.example/harbor-house')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry more evidence' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry more evidence' }))
    await waitFor(() => expect(within(evidence).getByText('https://locations.example/harbor-house/dining')).toBeTruthy())
    expect(nextPageAttempts).toBe(2)
  })

  it('offers a contextual measurement link when this Property has not been measured', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      }, { measurementState: 'not_measured', nextAction: 'run_measurement' }),
    })

    const link = await screen.findByRole('link', { name: 'Go to measurement overview' })
    expect(link.getAttribute('href')).toMatch(/\/projects\/[^/]+$/)
  })

  it('directs a legacy measurement plan to republish setup', async () => {
    await renderPropertyPage({
      plan: legacyPlanResponse(),
      branded: overviewResponse('branded', { mentionCoverage: unavailable('plan_v1'), citationCoverage: unavailable('plan_v1') }),
      nonBrand: overviewResponse('non-brand', { mentionCoverage: unavailable('plan_v1'), citationCoverage: unavailable('plan_v1') }),
    })

    expect(await screen.findByRole('link', { name: 'Republish setup' })).toBeTruthy()
  })

  it('leads with the branded versus non-brand contrast for one Property', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: available(12, 12),
        citationCoverage: available(12, 12),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(0, 12),
        citationCoverage: available(0, 12),
      }),
    })

    expect(await screen.findByRole('heading', { name: 'Harbor House' })).toBeTruthy()
    const contrast = screen.getByRole('table', {
      name: 'Mention and citation coverage for this Property, split by question class',
    })
    const branded = within(contrast).getByText('When they know your name').closest('tr')!
    const nonBrand = within(contrast).getByText('When they don\'t').closest('tr')!

    expect(within(branded).getAllByText('100%')).toHaveLength(2)
    expect(within(branded).getAllByText('12 of 12')).toHaveLength(2)
    // A measured zero is a real reading and must render as one, so the two
    // rows are legible against each other.
    expect(within(nonBrand).getAllByText('0%')).toHaveLength(2)
    expect(within(nonBrand).getAllByText('0 of 12')).toHaveLength(2)
  })

  it('renders a Property with no branded question as not measured, never as 0%', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
      }),
    })

    const contrast = await screen.findByRole('table', {
      name: 'Mention and citation coverage for this Property, split by question class',
    })
    const branded = within(contrast).getByText('When they know your name').closest('tr')!

    expect(within(branded).getAllByText('Not measured')).toHaveLength(2)
    expect(within(branded).getAllByText('No questions of this type are assigned')).toHaveLength(2)
    expect(within(branded).queryByText(/%$/)).toBeNull()
    for (const reason of within(branded).getAllByText('No questions of this type are assigned')) {
      expect(reason.className).toContain('text-sm')
      expect(reason.className).toContain('text-secondary')
    }
  })

  it('breaks the selected class down by answer engine', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
        providers: [
          { provider: 'gemini', mentionCoverage: available(1, 2), citationCoverage: available(0, 2) },
          { provider: 'openai', mentionCoverage: available(2, 2), citationCoverage: available(2, 2) },
        ],
      }),
    })

    const providers = await screen.findByRole('table', { name: 'Per-engine mention and citation coverage' })
    const gemini = within(providers).getByText('gemini').closest('tr')!
    const openai = within(providers).getByText('openai').closest('tr')!

    expect(within(gemini).getByText('50%')).toBeTruthy()
    expect(within(gemini).getByText('0%')).toBeTruthy()
    expect(within(openai).getAllByText('100%')).toHaveLength(2)
  })

  it('lists the assigned questions, URLs, and scoped evidence for the selected class', async () => {
    await renderPropertyPage({
      branded: overviewResponse('branded', {
        mentionCoverage: unavailable('no_population'),
        citationCoverage: unavailable('no_population'),
      }),
      nonBrand: overviewResponse('non-brand', {
        mentionCoverage: available(3, 4),
        citationCoverage: available(2, 4),
      }),
    })

    const questions = await screen.findByRole('table', { name: 'Questions assigned to this Property' })
    expect(within(questions).getByText('boutique hotels near the harbor')).toBeTruthy()

    const urls = screen.getByRole('table', { name: 'URL matchers configured for this Property' })
    expect(within(urls).getByText('https://locations.example/harbor-house/*')).toBeTruthy()

    const evidence = await screen.findByRole('table', { name: 'Source evidence for this Property' })
    expect(within(evidence).getByText('Matches this Property')).toBeTruthy()
    expect(within(evidence).getByText('https://locations.example/harbor-house')).toBeTruthy()
    expect(screen.queryByText(/revision \d+/i)).toBeNull()
    expect(screen.getByLabelText('Question type').className).toContain('h-11')
  })
})
