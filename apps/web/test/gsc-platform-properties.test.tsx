import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
  }
})

import { GscSection } from '../src/components/project/GscSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

type PlatformProperty = {
  id: string
  projectId: string
  siteUrl: string
  displayName: string
  platform: string
  kind: string
  permissionLevel: string | null
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

function renderSection({
  properties = [],
  performance,
  requests,
}: {
  properties?: PlatformProperty[]
  performance?: Record<string, unknown>
  requests?: string[]
} = {}) {
  const restoreFetch = mockFetch((url) => {
    requests?.push(url)
    const path = pathOf(url)
    if (path === '/api/v1/settings') return jsonResponse({ providers: [], providerCatalog: [], google: { configured: true }, bing: { configured: false } })
    if (path.endsWith('/google/connections')) return jsonResponse([{ id: 'gsc-1', domain: 'example.com', connectionType: 'gsc', propertyId: 'sc-domain:example.com', scopes: [] }])
    if (path.includes('/google/gsc/platform-properties')) return jsonResponse({ properties })
    if (path.includes('/google/gsc/platform-performance')) return jsonResponse(performance ?? {
      properties: [], selectedPropertyId: null, window: { startDate: '2026-07-01', endDate: '2026-07-30' },
      totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, daily: [], rows: [], pagination: { limit: 25, offset: 0, hasMore: false },
    })
    if (path.includes('/google/properties')) return jsonResponse({ sites: [
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: '12345', permissionLevel: 'siteOwner' },
    ] })
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse({ totals: { clicks: 0, impressions: 0, ctr: 0 }, daily: [] })
    if (path.includes('/google/gsc/performance')) return jsonResponse([])
    if (path.includes('/google/gsc/sitemaps')) return jsonResponse({ sitemaps: [], summary: { total: 0, indexes: 0, files: 0 }, preferredSubmissionUrls: [] })
    if (path.includes('/google/gsc/inspections') || path.includes('/google/gsc/deindexed') || path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><GscSection projectName="test-project" refreshNonce={0} /></QueryClientProvider>)
}

function openPlatformWorkspace() {
  fireEvent.click(screen.getByRole('tab', { name: 'Social & video' }))
}

test('shows an inline binding empty state for authorized social and video properties', async () => {
  const requests: string[] = []
  renderSection({ requests })
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Social & video' })).not.toBeNull())
  openPlatformWorkspace()

  expect(await screen.findByText('Bind a social or video property')).not.toBeNull()
  expect(screen.getByText(/Google has not published a platform-specific API/)).not.toBeNull()
  expect(screen.getByRole('link', { name: 'Open Search Console' }).getAttribute('href')).toBe('https://search.google.com/search-console')
  expect(screen.getByLabelText('Search Console property')).not.toBeNull()
  expect(screen.queryByRole('option', { name: 'sc-domain:example.com' })).toBeNull()
  expect(screen.getByRole('option', { name: '12345' })).not.toBeNull()
  expect(screen.getByLabelText('Platform')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Bind property' })).not.toBeNull()
  const beforeRefresh = requests.filter((url) => pathOf(url).includes('/google/properties')).length
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(requests.filter((url) => pathOf(url).includes('/google/properties')).length).toBeGreaterThan(beforeRefresh))
})

test('renders bound platform performance in a table and switches dimensions', async () => {
  const requests: string[] = []
  renderSection({
    requests,
    properties: [{ id: 'instagram-1', projectId: 'project-1', siteUrl: '123', displayName: 'Canonry on Instagram', platform: 'instagram', kind: 'social-video', permissionLevel: 'siteOwner', status: 'active', lastSyncedAt: null, lastError: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }],
    performance: {
      properties: [{ id: 'instagram-1', projectId: 'project-1', siteUrl: '123', displayName: 'Canonry on Instagram', platform: 'instagram', kind: 'social-video', permissionLevel: 'siteOwner', status: 'active', lastSyncedAt: null, lastError: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }], selectedPropertyId: null, window: { startDate: '2026-07-01', endDate: '2026-07-30' },
      totals: { clicks: 41, impressions: 900, ctr: 0.0456, position: 7.8 }, daily: [{ date: '2026-07-30', clicks: 41, impressions: 900, ctr: 0.0456, position: 7.8 }],
      rows: [{ propertyId: 'instagram-1', siteUrl: '123', displayName: 'Canonry on Instagram', platform: 'instagram', dimension: 'page', value: 'https://instagram.com/canonry/reel/1', clicks: 41, impressions: 900, ctr: 0.0456, position: 7.8 }], pagination: { limit: 50, offset: 0, hasMore: true },
    },
  })
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Social & video' })).not.toBeNull())
  openPlatformWorkspace()

  expect(await screen.findByText('https://instagram.com/canonry/reel/1')).not.toBeNull()
  expect((screen.getByLabelText('Platform property') as HTMLSelectElement).value).toBe('')
  expect(screen.getByText('Bind another property')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Bind property' })).not.toBeNull()
  expect(screen.getByRole('columnheader', { name: 'Content' })).not.toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Search queries' }))
  expect(screen.getByRole('columnheader', { name: 'Query' })).not.toBeNull()
  const next = screen.getByRole('button', { name: 'Next platform results' })
  await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(next)
  await waitFor(() => expect(requests.some((url) => url.includes('offset=50'))).toBe(true))
})

test('renders server-provided platform totals without recomputing them from rows', async () => {
  renderSection({
    properties: [{ id: 'youtube-1', projectId: 'project-1', siteUrl: '456', displayName: 'Canonry on YouTube', platform: 'youtube', kind: 'social-video', permissionLevel: 'siteOwner', status: 'active', lastSyncedAt: null, lastError: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }],
    performance: {
      properties: [{ id: 'youtube-1', projectId: 'project-1', siteUrl: '456', displayName: 'Canonry on YouTube', platform: 'youtube', kind: 'social-video', permissionLevel: 'siteOwner', status: 'active', lastSyncedAt: null, lastError: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }], selectedPropertyId: null, window: { startDate: '2026-07-01', endDate: '2026-07-30' },
      totals: { clicks: 999, impressions: 12_345, ctr: 0.0809, position: 3.2 }, daily: [],
      rows: [{ propertyId: 'youtube-1', siteUrl: '456', displayName: 'Canonry on YouTube', platform: 'youtube', dimension: 'page', value: 'https://youtube.com/watch?v=1', clicks: 1, impressions: 2, ctr: 0.5, position: 99 }], pagination: { limit: 25, offset: 0, hasMore: false },
    },
  })
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Social & video' })).not.toBeNull())
  openPlatformWorkspace()

  expect(await screen.findByText('999')).not.toBeNull()
  expect(screen.getByText('12,345')).not.toBeNull()
  expect(screen.getByText('8.1%')).not.toBeNull()
  expect(screen.getByText('3.2')).not.toBeNull()
})
