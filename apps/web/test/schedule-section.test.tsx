import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ScheduleSection } from '../src/components/project/ScheduleSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

test('discovers an existing schedule through the zero-noise collection read', async () => {
  let scheduleReads = 0
  const restore = mockFetch((url) => {
    expect(url).toContain('/api/v1/projects/citypoint/schedules')
    scheduleReads += 1
    return jsonResponse([{
      id: 'schedule-1',
      projectId: 'project-1',
      kind: 'answer-visibility',
      cronExpr: '0 6 * * *',
      preset: 'daily',
      timezone: 'UTC',
      enabled: true,
      providers: [],
      nextRunAt: '2026-08-07T06:00:00.000Z',
      lastRunAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('0 6 * * *')).toBeTruthy()
  expect(screen.getByText('Active')).toBeTruthy()
  expect(scheduleReads).toBe(1)
})

test('renders no schedule from an empty collection without a 404 path', async () => {
  const restore = mockFetch((url) => {
    expect(url).toContain('/api/v1/projects/fresh-site/schedules')
    return jsonResponse([])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="fresh-site" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No schedule configured/)).toBeTruthy()
})

test('does not report schedule absence when the authoritative read fails', async () => {
  let attempts = 0
  const restore = mockFetch(() => {
    attempts += 1
    if (attempts === 1) {
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'offline' } }, 503)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="offline-site" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Canonry could not verify this schedule.')).toBeTruthy()
  expect(screen.queryByText(/No schedule configured/)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText(/No schedule configured/)).toBeTruthy()
  expect(attempts).toBe(2)
})
