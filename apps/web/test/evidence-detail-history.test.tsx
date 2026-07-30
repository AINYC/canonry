import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

import { EvidenceDetailModal } from '../src/components/layout/EvidenceDetailModal.js'
import { createDashboardFixture } from '../src/mock-data.js'
import * as api from '../src/api.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('separates the recorded-day trend from exact answer snapshots in one detail view', () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  const evidence = {
    ...source,
    answerMentioned: true,
    visibilityState: 'visible' as const,
    runHistory: [
      {
        runId: 'day-one',
        createdAt: '2026-07-01T12:00:00.000Z',
        citationState: 'cited',
        answerMentioned: true,
        visibilityState: 'visible' as const,
      },
      {
        runId: 'day-two-early',
        createdAt: '2026-07-15T12:00:00.000Z',
        citationState: 'not-cited',
        answerMentioned: false,
        visibilityState: 'not-visible' as const,
      },
      {
        runId: 'day-two-latest',
        createdAt: '2026-07-15T18:00:00.000Z',
        citationState: 'cited',
        answerMentioned: true,
        visibilityState: 'visible' as const,
      },
    ],
  }

  render(
    <EvidenceDetailModal
      evidence={evidence}
      project={project}
      onClose={vi.fn()}
    />,
  )

  const trend = screen.getByRole('table', {
    name: 'Recorded-day trend for gemini',
  })
  expect(within(trend).getByRole('columnheader', { name: /July 1, 2026 UTC/ })).toBeTruthy()
  expect(within(trend).getByRole('columnheader', { name: /July 15, 2026 UTC/ })).toBeTruthy()
  expect(within(trend).getByText(/2 results/)).toBeTruthy()
  expect(trend.querySelector('svg')).toBeNull()
  expect(screen.getByText('Answer snapshots')).toBeTruthy()
  expect(screen.getByText('Select a run to inspect the exact answer.')).toBeTruthy()
})

test('loads the same location-scoped timeline used by a filtered evidence row', async () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  vi.spyOn(api, 'fetchTimeline').mockResolvedValue([{
    query: source.query,
    runs: [],
    providerRuns: {
      [source.provider]: [
        {
          runId: 'florida-one',
          createdAt: '2026-07-20T12:00:00.000Z',
          citationState: 'not-cited',
          transition: 'new',
          answerMentioned: false,
          location: 'Florida',
        },
        {
          runId: 'florida-two',
          createdAt: '2026-07-27T12:00:00.000Z',
          citationState: 'cited',
          transition: 'emerging',
          answerMentioned: true,
          location: 'Florida',
        },
      ],
    },
  }])

  render(
    <EvidenceDetailModal
      evidence={{
        ...source,
        location: 'Florida',
        runHistory: [{
          runId: 'stale-command-center-run',
          createdAt: '2026-06-01T12:00:00.000Z',
          citationState: 'not-cited',
          answerMentioned: false,
          location: 'Florida',
        }],
      }}
      project={project}
      onClose={vi.fn()}
    />,
  )

  await waitFor(() => {
    expect(api.fetchTimeline).toHaveBeenCalledWith(project.project.name, 'Florida', 20)
    expect(screen.getByRole('columnheader', { name: /July 27, 2026 UTC/ })).toBeTruthy()
  })
  expect(screen.queryByRole('columnheader', { name: /June 1, 2026 UTC/ })).toBeNull()
})
