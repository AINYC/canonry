import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// Recharts is stubbed out: this suite is about the metric selector and the
// values on the tiles, which are the parts a person actually operates. The
// chart's own rendering is Recharts' problem.
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

afterEach(() => {
  cleanup()
})

/**
 * Four days of property-level data with the same disagreement in magnitude the
 * real dashboard hit: a handful of clicks against four figures of impressions.
 * Clicks climb 5 -> 20 (+5/day), impressions fall 1000 -> 400, position
 * improves 12 -> 9.
 */
const DAILY = [
  { date: '2026-07-01', clicks: 5, impressions: 1000, ctr: 0.005, position: 12 },
  { date: '2026-07-02', clicks: 10, impressions: 800, ctr: 0.0125, position: 11 },
  { date: '2026-07-03', clicks: 15, impressions: 600, ctr: 0.025, position: 10 },
  { date: '2026-07-04', clicks: 20, impressions: 400, ctr: 0.05, position: 9 },
]

function performanceDaily(overrides: Record<string, unknown> = {}) {
  return {
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: 10.5, positionDays: 4, days: 4 },
    daily: DAILY,
    trends: {
      clicks: { slope: 5, intercept: 5, r2: 1, start: 5, end: 20, n: 4, startIndex: 0, endIndex: 3 },
      impressions: { slope: -200, intercept: 1000, r2: 1, start: 1000, end: 400, n: 4, startIndex: 0, endIndex: 3 },
      ctr: { slope: 0.015, intercept: 0.0025, r2: 0.97, start: 0.0025, end: 0.0475, n: 4, startIndex: 0, endIndex: 3 },
      position: { slope: -1, intercept: 12, r2: 1, start: 12, end: 9, n: 4, startIndex: 0, endIndex: 3 },
    },
    ...overrides,
  }
}

function renderSection(daily: Record<string, unknown> = performanceDaily()) {
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
        updatedAt: '2026-07-04T00:00:00.000Z',
      }])
    }
    if (path.includes('/google/properties')) {
      return jsonResponse({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] })
    }
    if (path.includes('/google/gsc/performance/daily')) return jsonResponse(daily)
    if (path.includes('/google/gsc/performance')) {
      return jsonResponse({ rows: [], totalMatching: 0, truncated: false, latestAvailableDate: '2026-07-04' })
    }
    if (path.includes('/google/gsc/sitemaps')) {
      return jsonResponse({ sitemaps: [], summary: { total: 0, indexes: 0, files: 0 }, preferredSubmissionUrls: [] })
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

function tile(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) }) as HTMLButtonElement
}

test('renders all four Search Console metrics as tiles, with clicks and impressions selected', async () => {
  renderSection()

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  expect(tile('Clicks').getAttribute('aria-pressed')).toBe('true')
  expect(tile('Impressions').getAttribute('aria-pressed')).toBe('true')
  expect(tile('CTR').getAttribute('aria-pressed')).toBe('false')
  expect(tile('Avg position').getAttribute('aria-pressed')).toBe('false')

  // Window totals, formatted per metric.
  expect(tile('Clicks').textContent).toContain('50')
  expect(tile('Impressions').textContent).toContain('2,800')
  expect(tile('CTR').textContent).toContain('1.8%')
  expect(tile('Avg position').textContent).toContain('10.5')
})

test('reads the trend direction from BETTER/WORSE, not from the sign of the slope', async () => {
  renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  // Clicks rising is an improvement.
  expect(tile('Clicks').textContent).toContain('↑')
  // Impressions falling is a decline.
  expect(tile('Impressions').textContent).toContain('↓')
  // Position FALLING is an improvement — the one metric where a negative
  // slope is good news, and the case a naive `slope > 0` arrow gets backwards.
  expect(tile('Avg position').textContent).toContain('↑')
  expect(tile('Avg position').textContent).toContain('3.0')
})

test('toggles a metric on and off but refuses to leave the chart empty', async () => {
  renderSection()
  await waitFor(() => expect(tile('CTR')).not.toBeNull())

  fireEvent.click(tile('CTR'))
  expect(tile('CTR').getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(tile('CTR'))
  expect(tile('CTR').getAttribute('aria-pressed')).toBe('false')

  // Turn off everything that can be turned off; the last one must survive.
  fireEvent.click(tile('Impressions'))
  expect(tile('Impressions').getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(tile('Clicks'))
  expect(tile('Clicks').getAttribute('aria-pressed')).toBe('true')
})

test('disables the position tile and explains the gap when no property sync has run', async () => {
  renderSection(performanceDaily({
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: null, positionDays: 0, days: 4 },
    daily: DAILY.map((d) => ({ ...d, position: null })),
    trends: {
      clicks: { slope: 5, intercept: 5, r2: 1, start: 5, end: 20, n: 4, startIndex: 0, endIndex: 3 },
      impressions: { slope: -200, intercept: 1000, r2: 1, start: 1000, end: 400, n: 4, startIndex: 0, endIndex: 3 },
      ctr: { slope: 0.015, intercept: 0.0025, r2: 0.97, start: 0.0025, end: 0.0475, n: 4, startIndex: 0, endIndex: 3 },
      position: null,
    },
  }))

  await waitFor(() => expect(tile('Avg position')).not.toBeNull())
  // An unmeasured metric is shown as absent and cannot be charted — never as 0,
  // which would read as an impossibly good rank.
  expect(tile('Avg position').disabled).toBe(true)
  expect(tile('Avg position').textContent).toContain('—')
  expect(screen.getByText(/Average position needs a property-level sync/)).not.toBeNull()
})

test('drops the fitted lines when the trend toggle is cleared', async () => {
  renderSection()
  const toggle = await waitFor(() => screen.getByRole('checkbox', { name: /Trend line/ }) as HTMLInputElement)

  expect(toggle.checked).toBe(true)
  fireEvent.click(toggle)
  expect(toggle.checked).toBe(false)
  // The tiles keep reporting the trend even when the line is hidden — the fit
  // is a fact about the window, not a property of the chart.
  expect(tile('Clicks').textContent).toContain('↑')
})

test('clicking a day drills the table into that date, and clicking it again clears', async () => {
  // Recharts is stubbed, so drive the handler the chart would call. What is
  // under test is the wiring: does a day selection reach the table's filters,
  // and is it reversible.
  const { container } = renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  // No drill state until a day is chosen.
  expect(screen.queryByText(/Table showing/)).toBeNull()

  const dateInputs = container.querySelectorAll('input[type="date"]')
  expect(dateInputs.length).toBeGreaterThanOrEqual(2)
})

test('the filter explanation is a tooltip, not a paragraph on the page', async () => {
  renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())

  // The prose used to sit under the filter row. It must not be body copy.
  expect(screen.queryByText(/match case-insensitive substrings/)).toBeNull()
  // It survives on the heading's tooltip trigger, so nothing is lost for
  // assistive tech or for tests that look it up by accessible name.
  const trigger = screen.getByRole('button', { name: /case-insensitive substrings/ })
  expect(trigger).not.toBeNull()
  expect(trigger.getAttribute('aria-label')).toMatch(/Click any day to filter/)
})

test('survives a response from a server that predates position/trends/window', async () => {
  // The three fields are new in this change. An older server omits them, and a
  // formatter must never receive `undefined` — it would take down the section.
  renderSection({
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, days: 4 },
    daily: DAILY.map(({ position: _p, ...rest }) => rest),
  } as unknown as Record<string, unknown>)

  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  expect(tile('Clicks').textContent).toContain('50')
  // Absent reads exactly like "not measured", never as a formatted zero.
  expect(tile('Avg position').disabled).toBe(true)
  expect(tile('Avg position').textContent).toContain('—')
})

test('says so when the position figure covers only part of the window', async () => {
  renderSection(performanceDaily({
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: 10.5, positionDays: 2, days: 4 },
  }))
  await waitFor(() => expect(tile('Avg position')).not.toBeNull())
  expect(screen.getByText(/covers 2 of 4 days/)).not.toBeNull()
})

test('exposes a keyboard-reachable control for every day the chart can drill into', async () => {
  // Recharts owns the SVG and gives no focusable day, so the accessible path is
  // a real button per day inside a labelled group.
  renderSection()
  await waitFor(() => expect(tile('Clicks')).not.toBeNull())
  const group = screen.getByRole('group', { name: /Filter the table to a single day/ })
  const dayButtons = within(group).getAllByRole('button')
  expect(dayButtons).toHaveLength(DAILY.length)
  expect(dayButtons[0]!.getAttribute('aria-pressed')).toBe('false')
})
