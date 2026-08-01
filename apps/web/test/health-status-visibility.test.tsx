import React from 'react'
import { beforeAll, expect, test } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

async function renderDegradedApp(pathname: string): Promise<string> {
  const fixture = createDashboardFixture({ degradedWorker: true })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

test('shows degraded worker detail inline on overview and settings', async () => {
  const [overview, settings] = await Promise.all([
    renderDegradedApp('/'),
    renderDegradedApp('/settings'),
  ])

  for (const markup of [overview, settings]) {
    const document = new DOMParser().parseFromString(markup, 'text/html')
    const detail = 'heartbeat stale · last seen 12m ago'

    expect(document.body.textContent).toContain(detail)
    expect(Array.from(document.querySelectorAll('details:not([open])'))).not.toSatisfy(
      (disclosures) => disclosures.some((disclosure) => disclosure.textContent?.includes(detail)),
    )
  }
})
