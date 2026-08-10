import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { getRunTrackerState, resetRunTracker } from '../src/lib/run-tracker-store.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  resetRunTracker()
  resetToasts()
  delete window.__CANONRY_CONFIG__
})

async function renderSetup(pathname = '/setup') {
  const fixture = createDashboardFixture({ emptyPortfolio: true })
  // `emptyPortfolio` controls only the overview fixture. The established
  // wizard derives its resume state from the durable project/run collections.
  fixture.dashboard.projects = []
  fixture.dashboard.runs = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  return router
}

test('keeps the five-step setup when the runtime launchpad flag is absent', async () => {
  await renderSetup()

  expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Start with your public site' })).toBeNull()
})

test('the legacy rescue query wins over an enabled platform flag', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  await renderSetup('/setup?experience=legacy')

  expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
})

test('lets an operator cancel the launchpad before any project is created', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const router = await renderSetup()

  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/projects')
  })
})

test('keeps the auto launchpad in an accessible loading state until the project list resolves', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let resolveProjects: ((response: Response) => void) | undefined
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) {
      return new Promise<Response>((resolve) => { resolveProjects = resolve })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect((await screen.findByRole('status')).textContent).toContain('Loading projects')
  resolveProjects?.(jsonResponse([]))
  expect(await screen.findByRole('heading', { name: 'Start with your public site' })).toBeTruthy()
})

test('auto waits for a successful authoritative empty project list before showing the launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: 'Start with your public site' })).toBeTruthy()
  expect(screen.getByLabelText('Website address')).toHaveProperty('required', true)
})

test('auto shows a retry shell when the authoritative project-list read fails', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let failed = true
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) {
      return failed
        ? jsonResponse({ error: { message: 'temporary outage' } }, 503)
        : jsonResponse([])
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: /load projects/i })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Start with your public site' })).toBeNull()

  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry project check' }))
  expect(await screen.findByRole('heading', { name: 'Start with your public site' })).toBeTruthy()
})

test('creates once, queues the canonical Site Health run, and hands off with exact URL state', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const requests: Array<{ path: string; method: string; body: string }> = []
  const restore = mockFetch(async (url, init) => {
    const path = pathOf(url)
    const method = init?.method ?? 'GET'
    requests.push({ path, method, body: String(init?.body ?? '') })
    if (path === '/api/v1/projects' && method === 'POST') {
      return jsonResponse({
        id: 'project-example',
        name: 'example-com',
        displayName: 'example.com',
        canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {},
        providers: [], providerModels: {}, locations: [], defaultLocation: null,
        measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }, 201)
    }
    if (path === '/api/v1/projects/example-com/technical-aeo/runs' && method === 'POST') {
      return jsonResponse({ runId: 'site-audit-1', status: 'queued' }, 202)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  const router = await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website address'), { target: { value: 'https://www.example.com/pricing' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: /Create project and map site/i }))

  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/projects/example-com/technical-aeo')
  })

  expect(router.state.location.search).toMatchObject({ siteHealthRunId: 'site-audit-1', onboarding: 'site-health' })
  expect(router.state.location.search).not.toHaveProperty('runId')
  expect(getRunTrackerState().runs['site-audit-1']).toMatchObject({
    projectId: 'project-example',
    kind: 'site-audit',
    sourceAction: 'site-audit',
  })
  const create = requests.find((request) => request.path === '/api/v1/projects')
  expect(create).toMatchObject({ method: 'POST' })
  expect(JSON.parse(create?.body ?? '{}')).toMatchObject({
    name: 'example-com',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
  })
  expect(requests.some((request) => request.path.endsWith('/technical-aeo/runs') && request.method === 'POST')).toBe(true)
})

test('preserves a created project with retry and open-project recovery when dispatch fails', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      return jsonResponse({
        id: 'project-example', name: 'example-com', displayName: 'example.com', canonicalDomain: 'example.com',
        ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {},
        locations: [], defaultLocation: null, measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
        autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
      }, 201)
    }
    if (path.endsWith('/technical-aeo/runs') && init?.method === 'POST') {
      return jsonResponse({ error: { message: 'worker unavailable' } }, 503)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website address'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: /Create project and map site/i }))

  expect(await screen.findByRole('heading', { name: 'Project created' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry Site Health scan' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open project' })).toBeTruthy()
  expect(getToasts().filter((toast) => toast.tone === 'negative')).toHaveLength(0)
})

test('keeps auto mode on project-created recovery after the project list becomes non-empty', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let created = false
  const project = {
    id: 'project-example', name: 'example-com', displayName: 'example.com', canonicalDomain: 'example.com',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {},
    locations: [], defaultLocation: null, measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
    autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      created = true
      return jsonResponse(project, 201)
    }
    if (path === '/api/v1/projects' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(created ? [project] : [])
    }
    if (path.endsWith('/technical-aeo/runs') && init?.method === 'POST') {
      return jsonResponse({ error: { message: 'worker unavailable' } }, 503)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website address'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: /Create project and map site/i }))

  expect(await screen.findByRole('heading', { name: 'Project created' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
})

test('surfaces a create-only name collision and never starts a scan', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const requests: string[] = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      return jsonResponse({ error: { message: 'Project already exists', code: 'ALREADY_EXISTS' } }, 409)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website address'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: /Create project and map site/i }))

  expect(await screen.findByText(/project with this name or site already exists/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'View projects' })).toBeTruthy()
  expect(requests.some((request) => request.includes('technical-aeo/runs'))).toBe(false)
})

test('keeps auto mode on actionable conflict recovery after the project list becomes non-empty', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let conflictReturned = false
  const existingProject = {
    id: 'project-existing', name: 'example-com', displayName: 'Example', canonicalDomain: 'example.com',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: {}, providers: [], providerModels: {},
    locations: [], defaultLocation: null, measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
    autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      conflictReturned = true
      return jsonResponse({ error: { message: 'Project already exists', code: 'ALREADY_EXISTS' } }, 409)
    }
    if (path === '/api/v1/projects') return jsonResponse(conflictReturned ? [existingProject] : [])
    return jsonResponse([])
  })
  onTestFinished(restore)

  await renderSetup()
  fireEvent.change(await screen.findByLabelText('Website address'), { target: { value: 'example.com' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve Canonry/i }))
  fireEvent.click(screen.getByRole('button', { name: /Create project and map site/i }))

  expect(await screen.findByRole('button', { name: 'View projects' })).toBeTruthy()
  expect(screen.queryByText('Step 2 of 5')).toBeNull()
})
