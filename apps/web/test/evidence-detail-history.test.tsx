import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { EvidenceDetailModal } from '../src/components/layout/EvidenceDetailModal.js'
import { createDashboardFixture } from '../src/mock-data.js'
import * as api from '../src/api.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function run(
  runId: string,
  createdAt: string,
  citationState: string,
  answerMentioned?: boolean,
  location: string | null = null,
): RunHistoryPoint {
  return {
    runId,
    createdAt,
    citationState,
    answerMentioned,
    mentionState: answerMentioned == null
      ? undefined
      : answerMentioned ? 'mentioned' : 'not-mentioned',
    location,
  }
}

function item(
  source: CitationInsightVm,
  overrides: Partial<CitationInsightVm>,
): CitationInsightVm {
  return {
    ...source,
    ...overrides,
  }
}

function mockRunDetail(
  provider: string,
  query: string,
  runId = 'latest',
  location: string | null = null,
) {
  vi.spyOn(api, 'fetchRunDetail').mockResolvedValue({
    id: runId,
    snapshots: [{
      id: `snapshot-${runId}`,
      query,
      provider,
      model: `${provider}-model`,
      citationState: 'cited',
      answerMentioned: true,
      mentionState: 'mentioned',
      visibilityState: 'visible',
      answerText: `${provider} exact answer`,
      citedDomains: ['example.com'],
      competitorOverlap: ['competitor.com'],
      recommendedCompetitors: [],
      matchedTerms: ['Example'],
      groundingSources: [{ uri: 'https://example.com/source', title: 'Source' }],
      searchQueries: [],
      location,
    }],
  } as never)
}

test('uses one shared engine/date history to drive the full answer breakdown', async () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  const gemini = item(source, {
    id: 'gemini-evidence',
    provider: 'gemini',
    runHistory: [
      run('gemini-day-one', '2026-07-01T12:00:00Z', 'not-cited', false),
      run('gemini-latest', '2026-07-15T18:00:00Z', 'cited', true),
    ],
  })
  const openai = item(source, {
    id: 'openai-evidence',
    provider: 'openai',
    runHistory: [
      run('openai-day-one', '2026-07-01T13:00:00Z', 'cited', true),
      run('gemini-latest', '2026-07-15T19:00:00Z', 'not-cited', false),
    ],
  })
  mockRunDetail('gemini', source.query, 'gemini-latest')

  render(
    <EvidenceDetailModal
      evidence={gemini}
      evidenceGroup={[gemini, openai]}
      initialSignal="citations"
      project={project}
      onClose={vi.fn()}
    />,
  )

  const history = within(
    screen.getByRole('region', { name: 'Citation history by engine' }),
  ).getByRole('table')
  expect(within(history).getByRole('columnheader', { name: /^Jul 1UTC$/ })).toBeTruthy()
  expect(within(history).getByRole('columnheader', { name: /^Jul 15UTC$/ })).toBeTruthy()
  expect(within(history).getAllByText('Cited')).toHaveLength(2)
  expect(within(history).getAllByText('Not cited')).toHaveLength(2)
  expect(within(history).getAllByRole('button').filter(
    button => button.getAttribute('aria-pressed') === 'true',
  )).toHaveLength(1)
  expect(screen.queryByText('Recorded-day trend')).toBeNull()
  expect(screen.queryByText('Answer snapshots')).toBeNull()

  await waitFor(() => {
    expect(screen.getByText('gemini exact answer')).toBeTruthy()
  })
  expect(screen.getByText('Signal results')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Source links' }).getAttribute('aria-pressed')).toBe('true')
})

test('loads the unbounded timeline once when full history is requested', async () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  const evidence = item(source, {
    id: 'florida-evidence',
    provider: 'gemini',
    location: 'Florida',
    runHistory: [run('recent', '2026-07-20T12:00:00Z', 'cited', true, 'Florida')],
  })
  mockRunDetail('gemini', source.query, 'recent', 'Florida')
  vi.spyOn(api, 'fetchTimeline').mockResolvedValue([{
    query: source.query,
    runs: [],
    providerRuns: {
      gemini: [
        ...Array.from({ length: 13 }, (_, index) => ({
          runId: `older-${index + 1}`,
          createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
          citationState: 'not-cited',
          transition: 'new',
          answerMentioned: false,
          mentionState: 'not-mentioned',
          location: 'Florida',
        })),
        {
          runId: 'recent',
          createdAt: '2026-07-20T12:00:00Z',
          citationState: 'cited',
          transition: 'emerging',
          answerMentioned: true,
          mentionState: 'mentioned',
          location: 'Florida',
        },
      ],
    },
  }])

  render(
    <EvidenceDetailModal
      evidence={evidence}
      evidenceGroup={[evidence]}
      locationScope="Florida"
      project={project}
      onClose={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Load full history' }))

  await waitFor(() => {
    expect(api.fetchTimeline).toHaveBeenCalledWith(project.project.name, 'Florida')
    expect(screen.getByText('Full history loaded')).toBeTruthy()
  })
  expect(screen.queryByRole('columnheader', { name: /^Jan 1UTC$/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Earlier dates' }))
  expect(screen.getByRole('columnheader', { name: /^Jan 1UTC$/ })).toBeTruthy()
})

test('never substitutes another engine answer when the selected snapshot is missing', async () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  const evidence = item(source, {
    id: 'gemini-only',
    provider: 'gemini',
    runHistory: [run('selected-run', '2026-07-20T12:00:00Z', 'cited', true)],
  })
  vi.spyOn(api, 'fetchRunDetail').mockResolvedValue({
    id: 'selected-run',
    snapshots: [{
      query: source.query,
      provider: 'openai',
      answerText: 'wrong provider answer',
      citationState: 'cited',
      citedDomains: [],
      competitorOverlap: [],
      groundingSources: [],
      searchQueries: [],
    }],
  } as never)

  render(
    <EvidenceDetailModal
      evidence={evidence}
      project={project}
      onClose={vi.fn()}
    />,
  )

  await waitFor(() => {
    expect(screen.getByText('No answer recorded for this engine and run.')).toBeTruthy()
  })
  expect(screen.queryByText('wrong provider answer')).toBeNull()
})

test('shows missing mention history as Not recorded but trusts an exact fetched snapshot', async () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  const evidence = item(source, {
    id: 'legacy-evidence',
    provider: 'gemini',
    answerMentioned: undefined,
    visibilityState: undefined,
    runHistory: [run('legacy', '2026-07-20T12:00:00Z', 'cited')],
  })
  mockRunDetail('gemini', source.query, 'legacy')

  render(
    <EvidenceDetailModal
      evidence={evidence}
      initialSignal="mentions"
      project={project}
      onClose={vi.fn()}
    />,
  )

  const history = within(
    screen.getByRole('region', { name: 'Mention history by engine' }),
  ).getByRole('table')
  expect(within(history).getByText('Not recorded')).toBeTruthy()
  expect(within(history).queryByText('Pending')).toBeNull()
  await waitFor(() => {
    expect(screen.getByText('Mentioned')).toBeTruthy()
  })
})

test('partitions recent history by each run location', () => {
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!
  const source = project.visibilityEvidence[0]!
  const evidence = item(source, {
    id: 'mixed-location-evidence',
    provider: 'gemini',
    location: 'Florida',
    runHistory: [
      run('unscoped', '2026-07-01T12:00:00Z', 'not-cited', false, null),
      run('florida', '2026-07-20T12:00:00Z', 'cited', true, 'Florida'),
    ],
  })
  mockRunDetail('gemini', source.query, 'florida', 'Florida')

  render(
    <EvidenceDetailModal
      evidence={evidence}
      project={project}
      onClose={vi.fn()}
    />,
  )

  const history = within(
    screen.getByRole('region', { name: 'Citation history by engine' }),
  ).getByRole('table')
  expect(within(history).getAllByRole('rowheader')).toHaveLength(2)
  expect(within(history).getByText('Florida')).toBeTruthy()
})
