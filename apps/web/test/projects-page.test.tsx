import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
})

test('a newly added project continues into its exact AI Visibility setup flow', async () => {
  const fixture = createDashboardFixture({})
  const createdProject = {
    ...fixture.dashboard.projects[0]!.project,
    id: 'project_new',
    name: 'new-project',
    displayName: 'New Project',
    canonicalDomain: 'new.example',
  }
  const refreshedDashboard = structuredClone(fixture.dashboard)
  refreshedDashboard.projects.push({
    ...structuredClone(fixture.dashboard.projects[0]!),
    project: createdProject,
    queryCounts: { cited: 0, total: 0 },
    competitors: [],
    recentRuns: [],
  })
  let createMethod: string | undefined
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/projects'] })
  await router.load()
  const renderTree = (dashboard: typeof fixture.dashboard) => (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>
  )
  const rendered = render(renderTree(fixture.dashboard))
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects' && init?.method === 'POST') {
      createMethod = init.method
      return jsonResponse(createdProject, 201)
    }
    if (path === '/api/v1/projects' && init?.method === 'GET') {
      rendered.rerender(renderTree(refreshedDashboard))
      return jsonResponse(refreshedDashboard.projects.map(project => project.project))
    }
    if (path === '/api/v1/runs?kind=answer-visibility') return jsonResponse([])
    if (path.endsWith('/queries')) return jsonResponse([])
    if (path === '/api/v1/settings') return jsonResponse({})
    return jsonResponse({ code: 'NOT_FOUND', message: 'not found' }, 404)
  })
  onTestFinished(restore)

  fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New Project' } })
  fireEvent.change(screen.getByLabelText('Canonical domain'), { target: { value: 'new.example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

  await waitFor(() => expect(router.state.location.pathname).toBe('/setup'))
  expect(router.state.location.search).toMatchObject({
    experience: 'legacy',
    setupProject: 'new-project',
  })
  expect(createMethod).toBe('POST')
  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  expect(await screen.findByRole('heading', { name: 'Add queries' })).toBeTruthy()
})
