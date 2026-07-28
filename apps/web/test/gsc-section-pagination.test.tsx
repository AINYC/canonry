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
import type { ApiGscPerformanceRow } from '../src/api.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
})

function performanceRows(count: number, start = 0): ApiGscPerformanceRow[] {
  return Array.from({ length: count }, (_, index) => {
    const row = start + index
    return {
      date: '2026-07-25',
      query: `search query ${String(row).padStart(3, '0')}`,
      page: `https://example.com/page-${String(row).padStart(3, '0')}`,
      clicks: count - index,
      impressions: count * 10 - index,
      ctr: 0.1,
      position: 2.5,
    }
  })
}

function renderSection() {
  const expandedRows = performanceRows(60)
  const pagedRows = performanceRows(31)
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/settings') {
      return jsonResponse({
        providers: [],
        providerCatalog: [],
        google: { configured: true },
        bing: { configured: false },
      })
    }
    if (path.endsWith('/google/connections')) {
      return jsonResponse([{
        id: 'gsc-1',
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        sitemapUrl: 'https://example.com/sitemap.xml',
        scopes: [],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      }])
    }
    if (path.includes('/google/properties')) {
      return jsonResponse([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }])
    }
    if (path.includes('/google/gsc/performance/daily')) {
      return jsonResponse({
        totals: { clicks: 0, impressions: 0, ctr: 0 },
        daily: [],
      })
    }
    if (path.includes('/google/gsc/performance')) {
      const query = new URL(url).searchParams
      if (query.get('limit') === '500') return jsonResponse(expandedRows)
      const offset = Number(query.get('offset') ?? 0)
      return jsonResponse(pagedRows.slice(offset, offset + 26))
    }
    if (path.includes('/google/gsc/sitemaps')) {
      return jsonResponse({
        sitemaps: [],
        summary: { total: 0, indexes: 0, files: 0 },
        preferredSubmissionUrls: [],
      })
    }
    if (path.includes('/google/gsc/inspections')) return jsonResponse([])
    if (path.includes('/google/gsc/deindexed')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage/history')) return jsonResponse([])
    if (path.includes('/google/gsc/coverage')) return jsonResponse(null)
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GscSection projectName="test-project" refreshNonce={0} />
    </QueryClientProvider>,
  )
}

test('uses server pagination when unfiltered and client pagination for expanded results', async () => {
  renderSection()

  await waitFor(() => expect(screen.getByText('1–25+ rows')).not.toBeNull())
  expect(screen.getByText('search query 000')).not.toBeNull()
  expect(screen.queryByText('search query 025')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByText('26–31 rows')).not.toBeNull())
  expect(screen.getByText('search query 025')).not.toBeNull()
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter search queries' }), {
    target: { value: 'search' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

  await waitFor(() => expect(screen.getByText('1–25 of 60 matches')).not.toBeNull())
  expect(screen.getByText('search query 024')).not.toBeNull()
  expect(screen.queryByText('search query 025')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.getByText('26–50 of 60 matches')).not.toBeNull())
  expect(screen.getByText('search query 025')).not.toBeNull()
  expect(screen.queryByText('search query 024')).toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: '7d' }))
  await waitFor(() => expect(screen.getByText('1–25 of 60 matches')).not.toBeNull())
  expect(screen.getByText('search query 000')).not.toBeNull()
  expect(screen.queryByText('search query 025')).toBeNull()
})
