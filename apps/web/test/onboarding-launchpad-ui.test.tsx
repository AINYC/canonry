import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { getApiV1ProjectsQueryKey } from '@ainyc/canonry-api-client/react-query'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { getRunTrackerState, resetRunTracker } from '../src/lib/run-tracker-store.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const AGENT_SETUP_REQUEST = 'Help me set up Canonry for my public site. Ask for my site address first. Keep private sign-ins and keys out of this chat. Before creating a project or starting a scan, show me the plan and wait for my approval. Then create the project, map the site, and help me decide what to measure next.'
const AGENT_SETUP_GUIDE_URL = 'https://github.com/Canonry/canonry/blob/main/docs/plugins.md'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
  resetRunTracker()
  resetToasts()
  delete window.__CANONRY_CONFIG__
})

async function renderSetup(
  pathname = '/setup',
  options: { seedEmptyProjectsCache?: boolean; mappedProjectName?: string } = {},
) {
  const fixture = createDashboardFixture({ emptyPortfolio: true })
  const mappedProject = options.mappedProjectName
    ? structuredClone(fixture.dashboard.projects[0])
    : undefined
  // `emptyPortfolio` controls only the overview fixture. The established
  // wizard derives its resume state from the durable project/run collections.
  fixture.dashboard.projects = mappedProject
    ? [{
        ...mappedProject,
        project: {
          ...mappedProject.project,
          name: options.mappedProjectName ?? mappedProject.project.name,
        },
        queryCounts: { cited: 0, total: 0 },
        competitors: [],
      }]
    : []
  fixture.dashboard.runs = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (options.seedEmptyProjectsCache) {
    queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), [])
  }
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  const renderTree = (dashboard: typeof fixture.dashboard) => (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>
  )
  const rendered = render(renderTree(fixture.dashboard))

  return {
    queryClient,
    router,
    resolveMappedProject(projectName: string) {
      const nextDashboard = structuredClone(fixture.dashboard)
      const project = nextDashboard.projects[0]
      if (!project) throw new Error('A mapped project fixture is required')
      nextDashboard.projects = [{
        ...project,
        project: { ...project.project, name: projectName },
      }]
      rendered.rerender(renderTree(nextDashboard))
    },
  }
}

test('keeps the five-step setup when the runtime launchpad flag is absent', async () => {
  await renderSetup()

  expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeNull()
  expect(screen.queryByText('Want to set up Canonry with your agent?')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy setup request' })).toBeNull()
})

test('the legacy rescue query wins over an enabled platform flag', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  await renderSetup('/setup?experience=legacy')

  expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
})

test('continues a mapped project into the original AI Visibility setup flow', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects/example-com/queries') return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)
  await renderSetup('/setup?experience=legacy&setupProject=example-com', {
    mappedProjectName: 'example-com',
  })

  const heading = await screen.findByRole('heading', { name: 'Set up AI Visibility' })
  expect(heading).toBeTruthy()
  expect(document.activeElement).toBe(heading)
  expect(screen.getByText('Step 3 of 5')).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).toContain('Queries')
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).toContain('Competitors')
  expect(screen.getByRole('list', { name: 'Setup progress' }).textContent).toContain('Launch')
  expect(screen.queryByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeNull()
})

test('does not resume another project when the Site Health handoff is stale', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const restore = mockFetch(() => jsonResponse([]))
  onTestFinished(restore)
  const { resolveMappedProject } = await renderSetup('/setup?experience=legacy&setupProject=missing-project', {
    mappedProjectName: 'different-project',
  })

  const heading = await screen.findByRole('heading', { name: 'Set up AI Visibility' })
  expect(heading).toBeTruthy()
  expect(document.activeElement).toBe(heading)
  expect(screen.getByRole('heading', { name: 'Project not found' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  expect(screen.getByRole('link', { name: 'View projects' }).getAttribute('href')).toBe('/projects')

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  resolveMappedProject('missing-project')

  const resolvedHeading = await screen.findByRole('heading', { name: 'Set up AI Visibility' })
  expect(resolvedHeading).not.toBe(heading)
  expect(document.activeElement).toBe(resolvedHeading)
  expect(screen.getByText('Step 3 of 5')).toBeTruthy()
})

test('lets an operator cancel the launchpad before any project is created', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const { router } = await renderSetup()

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
  expect(await screen.findByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeTruthy()
})

test('auto waits for a successful authoritative empty project list before showing the launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  const restore = mockFetch((url) => {
    if (pathOf(url).startsWith('/api/v1/projects')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup()

  expect(await screen.findByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeTruthy()
  expect(screen.getByText('Want to set up Canonry with your agent?')).toBeTruthy()
  expect(screen.getByText('Once connected, it can create the project, map your public site, and help choose what to measure.')).toBeTruthy()
  const agentGuide = screen.getByRole('link', { name: /Connect a supported agent/i })
  expect(agentGuide.getAttribute('href')).toBe(AGENT_SETUP_GUIDE_URL)
  expect(agentGuide.getAttribute('target')).toBe('_blank')
  expect(agentGuide.getAttribute('rel')).toContain('noopener')
  expect(agentGuide.getAttribute('rel')).toContain('noreferrer')
  expect(screen.getByLabelText('Website address')).toHaveProperty('required', true)
  expect(screen.getByRole('checkbox', { name: 'I approve Canonry to crawl this public site and its internal links.' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Create project and map site' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy setup request' }).getAttribute('type')).toBe('button')
  expect(screen.queryByText(/The crawl does not call answer providers/i)).toBeNull()
  expect(screen.queryByText(/Aero is enabled/i)).toBeNull()
  expect(screen.queryByText(/configured agent provider/i)).toBeNull()
})

test('gives an agent a copyable setup request', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const writeText = vi.fn(async () => {})
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  onTestFinished(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  await renderSetup()
  fireEvent.click(await screen.findByRole('button', { name: 'Copy setup request' }))

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith(AGENT_SETUP_REQUEST)
  })
  expect(screen.getByRole('button', { name: 'Copied setup request' })).toBeTruthy()
})

test('offers the agent guide when the Clipboard API is unavailable', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'platform' } }
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
  onTestFinished(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  await renderSetup()
  fireEvent.click(await screen.findByRole('button', { name: 'Copy setup request' }))

  await waitFor(() => {
    expect(getToasts()).toContainEqual(expect.objectContaining({
      tone: 'negative',
      title: 'Could not copy setup request',
      detail: 'Open the agent setup guide to connect a supported agent instead.',
    }))
  })
  expect(screen.queryByRole('button', { name: 'Copied setup request' })).toBeNull()
  expect(screen.getByRole('link', { name: /Connect a supported agent/i })).toBeTruthy()
})

test('auto confirms a cached empty project list after mount before showing the launchpad', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let resolveProjects: ((response: Response) => void) | undefined
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects') {
      return new Promise<Response>((resolve) => { resolveProjects = resolve })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  await renderSetup('/setup', { seedEmptyProjectsCache: true })

  expect((await screen.findByRole('status')).textContent).toContain('Loading projects')
  expect(screen.queryByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeNull()

  resolveProjects?.(jsonResponse([]))
  expect(await screen.findByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeTruthy()
})

test('keeps typed launchpad input mounted through an in-flight shared project refetch', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { onboardingMode: 'auto' } }
  let projectListReads = 0
  let resolveBackgroundRefetch: ((response: Response) => void) | undefined
  const restore = mockFetch((url) => {
    if (pathOf(url) === '/api/v1/projects') {
      projectListReads += 1
      if (projectListReads === 1) return jsonResponse([])
      return new Promise<Response>((resolve) => {
        resolveBackgroundRefetch = resolve
      })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  const { queryClient } = await renderSetup()
  const domain = await screen.findByLabelText('Website address') as HTMLInputElement
  fireEvent.change(domain, { target: { value: 'example.com' } })
  const approval = screen.getByRole('checkbox', { name: /I approve Canonry/i }) as HTMLInputElement
  fireEvent.click(approval)
  domain.focus()

  const refetch = queryClient.invalidateQueries({
    queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
  })
  await waitFor(() => {
    expect(resolveBackgroundRefetch).toBeTypeOf('function')
  })

  expect((screen.getByLabelText('Website address') as HTMLInputElement).value).toBe('example.com')
  expect((screen.getByRole('checkbox', { name: /I approve Canonry/i }) as HTMLInputElement).checked).toBe(true)
  expect(document.activeElement).toBe(screen.getByLabelText('Website address'))
  expect(screen.queryByText('Loading projects…')).toBeNull()

  resolveBackgroundRefetch?.(jsonResponse([]))
  await refetch
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
  expect(screen.queryByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeNull()

  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry project check' }))
  expect(await screen.findByRole('heading', { name: 'Start with a publicly reachable site.' })).toBeTruthy()
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

  const { router } = await renderSetup()
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
