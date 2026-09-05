import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueriesQueryKey } from '@ainyc/canonry-api-client/react-query'
import type { ReactNode } from 'react'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ children, to, target, rel }: { children: ReactNode; to: string; target?: string; rel?: string }) => <a href={to} target={target} rel={rel}>{children}</a>,
  }
})

afterEach(() => {
  cleanup()
  navigate.mockReset()
})

function renderProjectSetup(options: {
  onboarding: boolean
  complete?: boolean
  providerReady?: boolean
  projectProviders?: string[]
  readyProviderNames?: string[]
  cdpStatus?: { connected?: boolean; browserVersion?: string }
  cdpResponse?: () => Response | Promise<Response>
  apiKey?: ApiKeyAccess
  queryResponse?: () => Response | Promise<Response>
  providerResponse?: () => Response | Promise<Response>
  includeLocalProvider?: boolean
}) {
  const fixture = createDashboardFixture()
  // Match the key destinations published by the provider adapter catalog.
  const providerKeyUrls: Record<string, string> = {
    gemini: 'https://aistudio.google.com/apikey',
    claude: 'https://platform.claude.com/settings/keys',
  }
  fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({
    ...provider,
    keyUrl: providerKeyUrls[provider.name.toLowerCase()] ?? provider.keyUrl,
  }))
  const project = structuredClone(fixture.dashboard.projects[0]!)
  project.project.providers = options.projectProviders ?? project.project.providers
  fixture.dashboard.projects = [project]
  fixture.dashboard.runs = options.complete
    ? fixture.dashboard.runs.filter(run => run.projectId === project.project.id)
    : []

  if (!options.complete) {
    project.queryCounts = { cited: 0, total: 0 }
    project.competitors = []
  }
  if (options.providerReady === false) {
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({ ...provider, state: 'needs-config' }))
  } else if (options.readyProviderNames) {
    const ready = new Set(options.readyProviderNames.map(name => name.toLowerCase()))
    fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => ({
      ...provider,
      state: ready.has(provider.name.toLowerCase()) ? 'ready' as const : 'needs-config' as const,
    }))
  }
  if (options.includeLocalProvider) {
    fixture.dashboard.settings.providerStatuses.push({ name: 'local', state: 'needs-config', detail: 'Base URL is missing.' })
  }

  const requests: Array<{ path: string; method?: string; body?: RequestInit['body'] }> = []
  const restore = mockFetch((url, init) => {
    requests.push({ path: pathOf(url), method: init?.method, body: init?.body })
    if (pathOf(url) === '/api/v1/projects' || pathOf(url).split('?')[0] === '/api/v1/runs') return jsonResponse([])
    if (pathOf(url) === '/api/v1/settings') return jsonResponse({ providers: [] })
    if (pathOf(url) === '/api/v1/cdp/status') return options.cdpResponse?.() ?? jsonResponse(options.cdpStatus ?? {})
    if (pathOf(url).startsWith('/api/v1/settings/providers/')) return options.providerResponse?.() ?? jsonResponse({ name: 'gemini', configured: true })
    if (pathOf(url).endsWith('/queries')) {
      if (options.queryResponse) return options.queryResponse()
      return jsonResponse(options.complete ? [{ id: 'query-1', query: 'best local dentist' }] : [])
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = () => (
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={options.apiKey}>
        <DashboardProvider value={fixture}>
          <SetupPage
            visibilityProjectName={project.project.name}
            siteHealthOnboarding={options.onboarding}
          />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>
  )
  const rendered = render(content())

  return {
    projectId: project.project.id,
    projectName: project.project.name,
    domain: project.project.canonicalDomain,
    queryClient,
    requests,
    markProviderReady: (name: string) => {
      fixture.dashboard.settings.providerStatuses = fixture.dashboard.settings.providerStatuses.map(provider => (
        provider.name.toLowerCase() === name.toLowerCase() ? { ...provider, state: 'ready' } : provider
      ))
      rendered.rerender(content())
    },
  }
}

test('marks AI Visibility as the optional final onboarding stage and can skip to the project', async () => {
  const { projectName } = renderProjectSetup({ onboarding: true })

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.getByText('Step 1 of 2')).toBeTruthy()
  expect(screen.queryByText('System check')).toBeNull()
  expect(screen.queryByText('Create project')).toBeNull()
  expect(screen.queryByText('Competitors')).toBeNull()
  const progress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(progress).getByText('AI Visibility').closest('[aria-current="step"]')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Skip AI Visibility' }))

  await waitFor(() => {
    expect(navigate).toHaveBeenCalledWith({
      to: '/projects/$projectName/technical-aeo',
      params: { projectName },
      replace: true,
    })
  })
})

test('allows a project-scoped write key to configure its exact project', async () => {
  renderProjectSetup({
    onboarding: true,
    apiKey: {
      id: 'project-writer',
      scopes: ['*'],
      projectId: 'project_citypoint',
      readOnly: false,
    },
  })

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Add queries' })).toBeTruthy()
  expect(screen.queryByText(/for administrators/i)).toBeNull()
  expect(screen.getByText(/Provider settings are managed by an administrator/)).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByLabelText('Provider to connect')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open provider settings' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
})

test('keeps Gemini onboarding guidance out of administrator-only setup for a read-only key', async () => {
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    apiKey: { id: 'read-only-key', scopes: ['read'], projectId: null, readOnly: true },
  })
  expect(await screen.findByText('Set up AI Visibility is for administrators')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect(screen.queryByLabelText('API key')).toBeNull()
})

test('introduces Gemini free-tier setup before the API key field with its limits and official links', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })
  const heading = await screen.findByRole('heading', { name: 'Start with Gemini’s free tier' })
  const keyInput = screen.getByLabelText('API key')
  expect(heading.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const keyLink = screen.getByRole('link', { name: 'Get a free Gemini API key ↗' })
  expect(keyLink.getAttribute('href')).toBe('https://aistudio.google.com/apikey')
  expect(keyLink.getAttribute('target')).toBe('_blank')
  expect(keyLink.getAttribute('rel')).toContain('noopener')
  expect(screen.getByText('Get a key in Google AI Studio, then paste it below. Free usage has model and rate limits; paid usage is billed by Google.')).toBeTruthy()
  const pricingLink = screen.getByRole('link', { name: 'Pricing and limits' })
  expect(pricingLink.getAttribute('href')).toBe('https://ai.google.dev/gemini-api/docs/pricing')
  expect(pricingLink.getAttribute('target')).toBe('_blank')
  expect(screen.queryByRole('link', { name: 'Get API key ↗' })).toBeNull()
})

test('switches Gemini free-tier guidance with the selected provider and preserves other key links', async () => {
  const { requests } = renderProjectSetup({ onboarding: true, providerReady: false })
  expect(await screen.findByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeTruthy()
  const provider = screen.getByLabelText('Provider to connect')
  fireEvent.change(provider, { target: { value: 'Claude' } })
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Pricing and limits' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Get API key ↗' }).getAttribute('href')).toBe('https://platform.claude.com/settings/keys')

  fireEvent.change(screen.getByLabelText('Provider to connect'), { target: { value: 'Gemini' } })
  expect(screen.getByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Get API key ↗' })).toBeNull()
  expect(requests.filter(request => request.method === 'PUT')).toEqual([])
})

test('keeps a stale project-list handoff scoped to the exact onboarding project', async () => {
  const fixture = createDashboardFixture()
  fixture.dashboard.projects = []
  fixture.dashboard.runs = []
  const projectName = 'newly-created-project'
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={fixture}>
        <SetupPage visibilityProjectName={projectName} siteHealthOnboarding />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Skip AI Visibility' }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName/technical-aeo',
    params: { projectName },
    replace: true,
  })
})

test('finishing the project-scoped onboarding replaces the wizard with the project', async () => {
  const { projectName } = renderProjectSetup({ onboarding: true, complete: true })

  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Finish and open project' }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName/technical-aeo',
    params: { projectName },
    replace: true,
  })
})

test('keeps the existing project-scoped setup destination outside Site Health onboarding', async () => {
  const { projectName } = renderProjectSetup({ onboarding: false, complete: true })

  expect(screen.queryByRole('list', { name: 'Onboarding progress' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Skip AI Visibility' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: /Open project dashboard/ }))

  expect(navigate).toHaveBeenCalledWith({
    to: '/projects/$projectName',
    params: { projectName },
    replace: true,
  })
})

test('lets an existing query list be refined with researched queries before continuing', async () => {
  const { projectName, requests } = renderProjectSetup({ onboarding: true, complete: true })
  expect(await screen.findByText('best local dentist')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit queries' }))
  const input = screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement
  expect(input.value).toBe('best local dentist')
  fireEvent.change(input, { target: { value: 'best local dentist\nresearched dental query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 2 queries' }))
  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(requests.find(request => request.method === 'PUT' && request.path === `/api/v1/projects/${encodeURIComponent(projectName)}/queries`)).toMatchObject({
    body: JSON.stringify({ queries: ['best local dentist', 'researched dental query'] }),
  })
})

test('lets a project save queries before a provider is configured', async () => {
  renderProjectSetup({ onboarding: true, providerReady: false })

  const queries = await screen.findByLabelText('Queries (one per line)')
  fireEvent.change(queries, { target: { value: 'best local dentist' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Connect a provider' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('heading', { name: 'System check' })).toBeNull()
})

test('offers provider setup before queries and keeps the draft after saving and refreshing readiness', async () => {
  const { requests, markProviderReady } = renderProjectSetup({ onboarding: true, providerReady: false })
  const providerHeading = await screen.findByRole('heading', { name: 'Connect a provider' })
  const queryHeading = screen.getByRole('heading', { name: 'Add queries' })
  expect(providerHeading.compareDocumentPosition(queryHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const saveConnection = screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement
  expect(saveConnection.disabled).toBe(true)
  expect(saveConnection.parentElement).toBe(screen.getByRole('button', { name: 'Check again' }).parentElement)
  expect(screen.getByRole('region', { name: 'Add queries' }).tagName).toBe('SECTION')
  expect(screen.getByRole('list', { name: 'Onboarding progress' })).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull()
  expect(screen.getByText('Advanced provider settings').closest('details')?.open).toBe(false)
  // This is a provider secret, not the dashboard login password.
  const apiKeyField = screen.getByLabelText('API key')
  expect(apiKeyField.getAttribute('autocomplete')).toBe('new-password')
  expect(apiKeyField.getAttribute('autocapitalize')).toBe('none')
  expect(apiKeyField.getAttribute('spellcheck')).toBe('false')

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'unsubmitted customer question' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))

  expect(await screen.findByText('Provider updated.')).toBeTruthy()
  expect(requests.find(request => request.path === '/api/v1/settings/providers/gemini')).toMatchObject({
    method: 'PUT', body: JSON.stringify({ apiKey: 'synthetic-test-key' }),
  })
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('unsubmitted customer question')
  expect(requests.some(request => request.path === '/api/v1/settings')).toBe(true)
  expect(screen.getByRole('heading', { name: 'Connect a provider' })).toBeTruthy()

  // Readiness comes from refreshed settings, not an optimistic key-save result.
  markProviderReady('gemini')
  expect(await screen.findByText('Configured')).toBeTruthy()
  expect(screen.queryByLabelText('API key')).toBeNull()
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('unsubmitted customer question')
  expect(navigate).not.toHaveBeenCalled()
  expect(requests.filter(request => request.method === 'POST' && /\/(?:runs|generate)$/.test(request.path))).toEqual([])
})

test('keeps failed provider setup retryable without losing queries', async () => {
  let attempt = 0
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    providerResponse: () => ++attempt === 1
      ? jsonResponse({ error: { message: 'Key could not be saved', code: 'VALIDATION_ERROR' } }, 400)
      : jsonResponse({ name: 'gemini', configured: true }),
  })
  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), { target: { value: 'keep this query' } })
  const keyInput = await screen.findByLabelText('API key')
  fireEvent.change(keyInput, { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Key could not be saved')).toBeTruthy()
  expect((screen.getByLabelText('Queries (one per line)') as HTMLTextAreaElement).value).toBe('keep this query')
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Provider updated.')).toBeTruthy()
})

test('requires the local endpoint, not an API key, when Local is selected', async () => {
  const { requests } = renderProjectSetup({ onboarding: true, providerReady: false, projectProviders: ['local'], includeLocalProvider: true })
  const baseUrl = await screen.findByLabelText('Base URL')
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect(screen.getByLabelText('API key (optional)')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(baseUrl, { target: { value: 'http://localhost:11434/v1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
  expect(await screen.findByText('Provider updated.')).toBeTruthy()
  expect(requests.find(request => request.path === '/api/v1/settings/providers/local')).toMatchObject({
    method: 'PUT', body: JSON.stringify({ baseUrl: 'http://localhost:11434/v1' }),
  })
})

test('keeps unknown browser readiness distinct from missing configuration', async () => {
  let resolveCdp: ((response: Response) => void) | undefined
  renderProjectSetup({
    onboarding: true, providerReady: false,
    cdpResponse: () => new Promise<Response>(resolve => { resolveCdp = resolve }),
  })
  expect(await screen.findByText('Checking available providers. You can choose queries while this finishes.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Connect a provider' })).toBeNull()
  expect(screen.queryByText('Not connected')).toBeNull()
  await waitFor(() => expect(resolveCdp).toBeTypeOf('function'))
  resolveCdp?.(jsonResponse({}))
  expect(await screen.findByRole('heading', { name: 'Connect a provider' })).toBeTruthy()
})

test('copies a project-specific Research request without starting provider work or changing tracking', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  const { projectName, domain, requests } = renderProjectSetup({ onboarding: true, providerReady: false })
  fireEvent.click(await screen.findByRole('button', { name: 'Copy research prompt' }))
  expect(await screen.findByRole('button', { name: 'Research prompt copied' })).toBeTruthy()
  const prompt = writeText.mock.calls[0]?.[0] as string
  expect(prompt).toContain(projectName)
  expect(prompt).toContain(domain)
  expect(prompt).toContain("Canonry's Research flow")
  expect(prompt).toContain('saved answers and any available sources')
  expect(prompt).toContain('unavailable citation evidence is not a "not cited" result')
  expect(prompt).toContain('Text-only routes can inform query research but cannot establish an AI Visibility baseline')
  expect(prompt).toContain('Research does not add queries to tracking')
  expect(prompt).toContain("configured connection's capabilities")
  expect(prompt).toContain('preserve existing queries')
  expect(prompt).toContain('Do not change tracked queries or launch a visibility sweep')
  expect(prompt).toContain('for me to paste into setup')
  expect(requests.filter(request => request.method === 'POST' && /\/(?:runs|queries|generate)$/.test(request.path))).toEqual([])
})

test('offers a selectable research prompt if clipboard access fails', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  renderProjectSetup({ onboarding: true })
  fireEvent.click(screen.getByRole('button', { name: 'Copy research prompt' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not copy. Select and copy the prompt above.')
  expect(screen.getByLabelText('Agent query research prompt').closest('details')?.open).toBe(true)
})

test('blocks launch when the ready provider is outside the project allowlist', async () => {
  renderProjectSetup({
    onboarding: true,
    projectProviders: ['claude'],
    readyProviderNames: ['gemini'],
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  expect(screen.getByText(/provider allowed by this project/i)).toBeTruthy()
  expect((screen.getByLabelText('Provider to connect') as HTMLSelectElement).value).toBe('Claude')
  expect(within(screen.getByLabelText('Provider to connect')).queryByRole('option', { name: 'Gemini' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Start with Gemini’s free tier' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Get a free Gemini API key ↗' })).toBeNull()
  expect((screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement).disabled).toBe(true)
})

test('treats a registered project-selected CDP provider as runnable', async () => {
  renderProjectSetup({
    onboarding: true,
    providerReady: false,
    projectProviders: ['cdp:chatgpt'],
    cdpStatus: { connected: false, browserVersion: 'Chrome/140' },
  })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  expect(await screen.findByText('Step 2 of 2')).toBeTruthy()
  const launch = screen.getByRole('button', { name: 'Launch visibility sweep' }) as HTMLButtonElement
  expect(launch.disabled).toBe(false)
  expect(screen.queryByRole('link', { name: 'Configure a provider' })).toBeNull()
})

test('invalidates project query and dashboard caches after project-scoped query setup', async () => {
  const { projectId, projectName, queryClient } = renderProjectSetup({
    onboarding: true,
    providerReady: false,
  })
  const queriesKey = getApiV1ProjectsByNameQueriesQueryKey({
    client: heyClient,
    path: { name: projectName },
  })
  const dashboardKey = ['project-dashboard-full', projectId, 'none'] as const
  queryClient.setQueryData(queriesKey, [])
  queryClient.setQueryData(dashboardKey, { queries: [] })

  fireEvent.change(await screen.findByLabelText('Queries (one per line)'), {
    target: { value: 'best local dentist' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 query' }))

  await waitFor(() => {
    expect(queryClient.getQueryState(queriesKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(dashboardKey)?.isInvalidated).toBe(true)
  })
})

test('keeps project-scoped query controls blocked until the canonical query read settles', async () => {
  let resolveQueries: ((response: Response) => void) | undefined
  renderProjectSetup({
    onboarding: true,
    queryResponse: () => new Promise<Response>((resolve) => { resolveQueries = resolve }),
  })

  expect(await screen.findByRole('heading', { name: 'Add queries' })).toBeTruthy()
  await waitFor(() => expect(resolveQueries).toBeTypeOf('function'))
  expect(screen.getByText('Loading saved queries…').closest('[role="status"]')).toBeTruthy()
  expect(screen.queryByLabelText('Queries (one per line)')).toBeNull()
  expect(screen.queryByRole('button', { name: /Save .*quer/i })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Finish without AI Visibility' })).toBeNull()

  resolveQueries?.(jsonResponse([{ id: 'query-saved', query: 'saved canonical query' }]))

  expect(await screen.findByText('saved canonical query')).toBeTruthy()
  expect(screen.queryByText('Loading saved queries…')).toBeNull()
  expect(screen.queryByLabelText('Queries (one per line)')).toBeNull()
})
