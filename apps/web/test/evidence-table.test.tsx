import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const drawer = vi.hoisted(() => ({
  openEvidence: vi.fn(),
}))

vi.mock('../src/hooks/use-drawer.js', () => ({
  useDrawer: () => ({
    openEvidence: drawer.openEvidence,
  }),
}))

import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'

afterEach(() => {
  cleanup()
  drawer.openEvidence.mockReset()
})

function point(
  runId: string,
  citationState: RunHistoryPoint['citationState'],
  answerMentioned: boolean | undefined,
  createdAt = `2026-07-${runId === 'r1' ? '01' : '02'}T12:00:00.000Z`,
): RunHistoryPoint {
  return {
    runId,
    createdAt,
    citationState,
    answerMentioned,
    mentionState: answerMentioned == null
      ? 'pending'
      : answerMentioned ? 'mentioned' : 'not-mentioned',
  }
}

function evidenceItem({
  id,
  query,
  provider,
  history,
  location = null,
}: {
  id: string
  query: string
  provider: string
  history: RunHistoryPoint[]
  location?: string | null
}): CitationInsightVm {
  const latest = history.at(-1)
  return {
    id,
    query,
    provider,
    model: provider ? `${provider}-model` : null,
    location,
    citationState: (latest?.citationState ?? 'pending') as CitationInsightVm['citationState'],
    answerMentioned: latest?.answerMentioned,
    visibilityState: latest?.answerMentioned == null
      ? 'pending'
      : latest.answerMentioned ? 'visible' : 'not-visible',
    changeLabel: '',
    answerSnippet: 'Answer text',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    runHistory: history,
  }
}

function fixture(): CitationInsightVm[] {
  return [
    evidenceItem({
      id: 'lost',
      query: 'alpha lost query',
      provider: 'gemini',
      history: [point('r1', 'cited', true), point('r2', 'not-cited', false)],
    }),
    evidenceItem({
      id: 'gained',
      query: 'bravo gained query',
      provider: 'openai',
      history: [point('r1', 'not-cited', false), point('r2', 'cited', true)],
    }),
    evidenceItem({
      id: 'never',
      query: 'charlie stable query',
      provider: 'claude',
      history: [point('r1', 'not-cited', false), point('r2', 'not-cited', false)],
    }),
    evidenceItem({
      id: 'first',
      query: 'delta first query',
      provider: 'perplexity',
      history: [point('r2', 'cited', true)],
    }),
  ]
}

function rowText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tbody > tr.query-change-row')]
    .map(row => row.textContent ?? '')
}

test('renders a flat query-change inbox without duplicate current-coverage columns', () => {
  const { container } = render(<EvidenceTable evidence={fixture()} />)

  expect(screen.getByRole('columnheader', { name: 'Query' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'What changed' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Latest result' })).toBeTruthy()
  expect(screen.queryByRole('columnheader', { name: /Mentioned/ })).toBeNull()
  expect(screen.queryByRole('columnheader', { name: /Cited/ })).toBeNull()
  expect(container.querySelectorAll('tbody > tr')).toHaveLength(4)
  expect(container.querySelector('.evidence-engine-row')).toBeNull()
  expect(screen.getByText('1–4 of 4 queries with evidence')).toBeTruthy()
})

test('uses natural change copy and only shows non-empty views', () => {
  render(<EvidenceTable evidence={fixture()} />)

  expect(screen.getByText('Gemini no longer cites your site')).toBeTruthy()
  expect(screen.getByText('OpenAI now cites your site')).toBeTruthy()
  expect(screen.getByText('No change from previous result')).toBeTruthy()
  expect(screen.getByText('First recorded result')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Changed, 2 queries' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Mention/citation losses, 1 query' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /0 queries/ })).toBeNull()
})

test('sorts by latest result by default instead of promoting losses', () => {
  const items = [
    evidenceItem({
      id: 'older-loss',
      query: 'alpha older loss',
      provider: 'gemini',
      history: [
        point('old-1', 'cited', true, '2026-07-01T12:00:00Z'),
        point('old-2', 'not-cited', false, '2026-07-02T12:00:00Z'),
      ],
    }),
    evidenceItem({
      id: 'newer-stable',
      query: 'zulu newer stable',
      provider: 'openai',
      history: [
        point('new-1', 'cited', true, '2026-07-03T12:00:00Z'),
        point('new-2', 'cited', true, '2026-07-04T12:00:00Z'),
      ],
    }),
  ]
  const { container } = render(<EvidenceTable evidence={items} />)

  expect(rowText(container)[0]).toContain('zulu newer stable')
  fireEvent.click(screen.getByRole('button', { name: 'Sort by Query' }))
  expect(rowText(container)[0]).toContain('alpha older loss')
  fireEvent.click(screen.getByRole('button', { name: /Sort by Query, currently ascending/ }))
  expect(rowText(container)[0]).toContain('zulu newer stable')
})

test('opens one query-level evidence view with the triggering signal', () => {
  render(<EvidenceTable evidence={fixture()} />)

  fireEvent.click(screen.getByRole('button', {
    name: 'Review evidence for alpha lost query',
  }))

  expect(drawer.openEvidence).toHaveBeenCalledWith('lost', 'citations')
})

test('search updates visible filter counts and omits dead filters', () => {
  render(<EvidenceTable evidence={fixture()} />)

  const search = screen.getByRole('searchbox', { name: 'Search queries, locations, or engines' })
  fireEvent.change(search, { target: { value: 'charlie stable' } })

  expect(screen.getByRole('button', { name: 'All, 1 query' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Changed/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Mention\/citation losses/ })).toBeNull()
  expect(screen.getByText('charlie stable query')).toBeTruthy()

  fireEvent.change(search, { target: { value: 'does-not-exist' } })
  expect(screen.getByText('No queries match this view')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(screen.getByText('alpha lost query')).toBeTruthy()
})

test('labels pagination as query locations when comparison expands rows', () => {
  render(<EvidenceTable
    evidence={[
      evidenceItem({
        id: 'florida',
        query: 'local dentist',
        provider: 'gemini',
        location: 'Florida',
        history: [point('r1', 'cited', true)],
      }),
      evidenceItem({
        id: 'michigan',
        query: 'local dentist',
        provider: 'gemini',
        location: 'Michigan',
        history: [point('r1', 'cited', true)],
      }),
    ]}
    compareLocations
  />)

  expect(screen.getByText('1–2 of 2 query locations with evidence')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Review evidence for local dentist' })[0]!)
  expect(drawer.openEvidence).toHaveBeenCalledWith('florida', 'citations', 'Florida')
})

test('shows an instructive state before any queries are tracked', () => {
  render(<EvidenceTable evidence={[]} />)

  expect(screen.getByText('No queries tracked yet')).toBeTruthy()
  expect(screen.getByText(/Manage queries/)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

test('distinguishes externally filtered evidence from an unconfigured project', () => {
  render(<EvidenceTable evidence={[]} hasTrackedQueries isFiltered />)

  expect(screen.getByText('No query evidence matches these filters')).toBeTruthy()
  expect(screen.queryByText('No queries tracked yet')).toBeNull()
  expect(screen.getByText(/Choose another location/)).toBeTruthy()
})

test('distinguishes tracked queries awaiting their first sweep', () => {
  render(<EvidenceTable evidence={[]} hasTrackedQueries />)

  expect(screen.getByText('Waiting for the first query results')).toBeTruthy()
  expect(screen.getByText(/Run a sweep/)).toBeTruthy()
})
