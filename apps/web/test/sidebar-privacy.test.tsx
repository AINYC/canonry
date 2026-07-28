import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
const storedValues = new Map<string, string>()
const localStorageMock: Storage = {
  get length() {
    return storedValues.size
  },
  clear() {
    storedValues.clear()
  },
  getItem(key) {
    return storedValues.get(key) ?? null
  },
  key(index) {
    return [...storedValues.keys()][index] ?? null
  },
  removeItem(key) {
    storedValues.delete(key)
  },
  setItem(key, value) {
    storedValues.set(key, value)
  },
}

function installLocalStorage(storage: Storage) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

beforeEach(() => {
  installLocalStorage(localStorageMock)
})

afterEach(() => {
  cleanup()
  storedValues.clear()
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor)
  } else {
    Reflect.deleteProperty(window, 'localStorage')
  }
})

async function renderRoute(pathname: string, options: Parameters<typeof createDashboardFixture>[0] = {}) {
  const fixture = createDashboardFixture(options)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

test('sidebar can be hidden and restored from the desktop topbar', async () => {
  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' }).getAttribute('aria-controls')).toBe('desktop-sidebar')

  fireEvent.click(getByRole('button', { name: 'Hide sidebar' }))

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(window.localStorage.getItem('canonry:sidebarHidden')).toBe('true')
  expect(getByRole('button', { name: 'Show sidebar' }).getAttribute('aria-controls')).toBeNull()

  fireEvent.click(getByRole('button', { name: 'Show sidebar' }))

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).toBeNull()
  expect(window.localStorage.getItem('canonry:sidebarHidden')).toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' }).getAttribute('aria-controls')).toBe('desktop-sidebar')
})

test('hidden sidebar preference survives a reload', async () => {
  window.localStorage.setItem('canonry:sidebarHidden', 'true')

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(getByRole('button', { name: 'Show sidebar' })).toBeDefined()
})

test('falls back to a visible sidebar when stored preference cannot be read', async () => {
  installLocalStorage({
    ...localStorageMock,
    getItem() {
      throw new Error('storage unavailable')
    },
  })

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' })).toBeDefined()
})

test('still hides the sidebar when the preference cannot be written', async () => {
  installLocalStorage({
    ...localStorageMock,
    setItem() {
      throw new Error('storage unavailable')
    },
  })

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  fireEvent.click(getByRole('button', { name: 'Hide sidebar' }))

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(getByRole('button', { name: 'Show sidebar' }).getAttribute('aria-controls')).toBeNull()
})

test('does not render the sidebar toggle during first-run setup', async () => {
  const { container, queryByRole } = await renderRoute('/setup', { emptyPortfolio: true })

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(queryByRole('button', { name: /sidebar/i })).toBeNull()
})
