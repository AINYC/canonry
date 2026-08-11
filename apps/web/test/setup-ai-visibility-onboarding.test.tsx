import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { SetupPage } from '../src/pages/SetupPage.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
  }
})

afterEach(() => {
  cleanup()
  navigate.mockReset()
})

function renderProjectSetup(options: { onboarding: boolean; complete?: boolean }) {
  const fixture = createDashboardFixture()
  const project = structuredClone(fixture.dashboard.projects[0]!)
  fixture.dashboard.projects = [project]
  fixture.dashboard.runs = options.complete
    ? fixture.dashboard.runs.filter(run => run.projectId === project.project.id)
    : []

  if (!options.complete) {
    project.queryCounts = { cited: 0, total: 0 }
    project.competitors = []
  }

  const restore = mockFetch((url) => {
    if (pathOf(url).endsWith('/queries')) {
      return jsonResponse(options.complete ? [{ id: 'query-1', query: 'best local dentist' }] : [])
    }
    return jsonResponse({})
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={fixture}>
        <SetupPage
          visibilityProjectName={project.project.name}
          siteHealthOnboarding={options.onboarding}
        />
      </DashboardProvider>
    </QueryClientProvider>,
  )

  return project.project.name
}

test('marks AI Visibility as the optional final onboarding stage and can skip to Home', async () => {
  renderProjectSetup({ onboarding: true })

  expect(await screen.findByRole('heading', { name: 'Set up AI Visibility' })).toBeTruthy()
  const progress = screen.getByRole('list', { name: 'Onboarding progress' })
  expect(within(progress).getByText('AI Visibility').closest('[aria-current="step"]')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Skip AI Visibility' }))

  await waitFor(() => {
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })
})

test('finishing the project-scoped onboarding replaces the wizard with Home', async () => {
  renderProjectSetup({ onboarding: true, complete: true })

  fireEvent.click(await screen.findByRole('button', { name: 'Finish and go Home' }))

  expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
})

test('keeps the existing project-scoped setup destination outside Site Health onboarding', async () => {
  const projectName = renderProjectSetup({ onboarding: false, complete: true })

  expect(screen.queryByRole('list', { name: 'Onboarding progress' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Skip AI Visibility' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /Open project dashboard/ }))

  expect(navigate).toHaveBeenCalledWith({
    to: `/projects/${encodeURIComponent(projectName)}`,
    replace: true,
  })
})
