import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

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
): RunHistoryPoint {
  return {
    runId,
    createdAt: `2026-07-${runId === 'r1' ? '01' : '02'}T12:00:00.000Z`,
    citationState,
    answerMentioned,
    visibilityState: answerMentioned == null
      ? 'pending'
      : answerMentioned ? 'visible' : 'not-visible',
  }
}

function evidenceItem({
  id,
  query,
  provider,
  history,
}: {
  id: string
  query: string
  provider: string
  history: RunHistoryPoint[]
}): CitationInsightVm {
  const latest = history.at(-1)!
  return {
    id,
    query,
    provider,
    model: `${provider}-model`,
    location: null,
    citationState: latest.citationState,
    answerMentioned: latest.answerMentioned,
    visibilityState: latest.visibilityState,
    changeLabel: '',
    answerSnippet: 'Answer text',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    runHistory: history,
  } as CitationInsightVm
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
      query: 'charlie never query',
      provider: 'claude',
      history: [point('r1', 'not-cited', false), point('r2', 'not-cited', false)],
    }),
    evidenceItem({
      id: 'stable',
      query: 'delta stable query',
      provider: 'perplexity',
      history: [point('r1', 'cited', true), point('r2', 'cited', true)],
    }),
  ]
}

function parentRowText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('tbody > tr.evidence-phrase-row')]
    .map(row => row.textContent ?? '')
}

test('shows mention and citation evidence together with explicit quick views', () => {
  render(<EvidenceTable evidence={fixture()} />)

  expect(screen.getByRole('columnheader', { name: /Mentioned/ })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: /Cited/ })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: /Change vs prior recorded day/ })).toBeTruthy()
  expect(screen.queryByRole('tab')).toBeNull()
  expect(screen.queryByText('Density')).toBeNull()
  expect(screen.queryByText('Latest run')).toBeNull()

  expect(screen.getByRole('button', { name: 'Changed vs prior recorded day, 2 queries' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Mention lost vs prior recorded day, 1 query' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Citation lost vs prior recorded day, 1 query' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'No recent mentions, 1 query' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'No recent citations, 1 query' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', {
    name: 'Mention lost vs prior recorded day, 1 query',
  }))

  expect(screen.getByText('alpha lost query')).toBeTruthy()
  expect(screen.queryByText('bravo gained query')).toBeNull()
  expect(screen.queryByText('charlie never query')).toBeNull()
})

test('sorts losses first by default and exposes sortable evidence columns', () => {
  const { container } = render(<EvidenceTable evidence={fixture()} />)

  expect(parentRowText(container)[0]).toContain('alpha lost query')

  fireEvent.click(screen.getByRole('button', { name: 'Sort by Query' }))
  expect(parentRowText(container).map(text => text.match(/(alpha|bravo|charlie|delta)/)?.[0])).toEqual([
    'alpha',
    'bravo',
    'charlie',
    'delta',
  ])

  fireEvent.click(screen.getByRole('button', { name: /Sort by Query, currently ascending/ }))
  expect(parentRowText(container).map(text => text.match(/(alpha|bravo|charlie|delta)/)?.[0])).toEqual([
    'delta',
    'charlie',
    'bravo',
    'alpha',
  ])
})

test('distinguishes missing prior-day history from a stable comparison', () => {
  render(<EvidenceTable evidence={[
    evidenceItem({
      id: 'first-observation',
      query: 'first observed query',
      provider: 'gemini',
      history: [point('r1', 'cited', true)],
    }),
    evidenceItem({
      id: 'stable-comparison',
      query: 'stable compared query',
      provider: 'openai',
      history: [
        point('r1', 'cited', true),
        point('r2', 'cited', true),
      ],
    }),
  ]} />)

  expect(screen.getByText('No prior-day comparison')).toBeTruthy()
  expect(screen.getByText('No change in comparable results')).toBeTruthy()
})

test('uses a named disclosure and query-specific answer actions instead of an interactive row', () => {
  const items = [
    evidenceItem({
      id: 'gemini-evidence',
      query: 'best solar installer',
      provider: 'gemini',
      history: [point('r1', 'not-cited', false), point('r2', 'cited', true)],
    }),
    evidenceItem({
      id: 'openai-evidence',
      query: 'best solar installer',
      provider: 'openai',
      history: [point('r1', 'cited', true), point('r2', 'cited', true)],
    }),
  ]
  const { container } = render(<EvidenceTable evidence={items} />)

  const parentRow = container.querySelector('tbody > tr.evidence-phrase-row')
  expect(parentRow?.getAttribute('role')).toBeNull()
  expect(parentRow?.getAttribute('tabindex')).toBeNull()
  expect(screen.getByRole('rowheader', { name: /best solar installer/ })).toBeTruthy()

  const disclosure = screen.getByRole('button', { name: 'Review engines for best solar installer' })
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(disclosure)
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')

  const engines = screen.getByRole('list', { name: 'Engine results for best solar installer' })
  expect(within(engines).getByText('gemini')).toBeTruthy()
  expect(within(engines).getByText('openai')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', {
    name: 'Review Gemini answer for best solar installer',
  }))
  expect(drawer.openEvidence).toHaveBeenCalledWith('gemini-evidence')
})

test('uses plain text quick views and engine states instead of pill indicators', () => {
  const items = [
    evidenceItem({
      id: 'independent-signals',
      query: 'independent signal query',
      provider: 'gemini',
      history: [point('r1', 'not-cited', true), point('r2', 'not-cited', true)],
    }),
    evidenceItem({
      id: 'pending-signals',
      query: 'independent signal query',
      provider: 'openai',
      history: [point('r2', 'pending', undefined)],
    }),
  ]
  const { container } = render(<EvidenceTable evidence={items} />)

  const allView = screen.getByRole('button', { name: 'All, 1 query' })
  expect(allView.className).toContain('evidence-quick-view')
  expect(allView.className).not.toContain('filter-chip')

  fireEvent.click(screen.getByRole('button', {
    name: 'Review engines for independent signal query',
  }))

  const engineStates = [...container.querySelectorAll('.evidence-signal-value')]
  const engines = screen.getByRole('list', { name: 'Engine results for independent signal query' })
  expect(engineStates).toHaveLength(4)
  expect(engineStates.every(state => !state.className.includes('badge'))).toBe(true)
  expect(within(engines).getAllByText('Mention status:')).toHaveLength(2)
  expect(within(engines).getAllByText('Citation status:')).toHaveLength(2)
  expect(within(engines).getByText('Mentioned')).toBeTruthy()
  expect(within(engines).getByText('Not cited')).toBeTruthy()
  expect(within(engines).getAllByText('No result')).toHaveLength(2)
})

test('search and empty states explain how to recover', () => {
  render(<EvidenceTable evidence={fixture()} />)

  const search = screen.getByRole('searchbox', { name: 'Search queries, locations, or engines' })
  fireEvent.change(search, { target: { value: 'does-not-exist' } })

  expect(screen.getByText('No queries match this view')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(screen.getByText('alpha lost query')).toBeTruthy()
})

test('quick-view counts follow the search query and active view', () => {
  render(<EvidenceTable evidence={fixture()} />)

  const search = screen.getByRole('searchbox', { name: 'Search queries, locations, or engines' })
  fireEvent.change(search, { target: { value: 'delta stable' } })

  expect(screen.getByRole('button', { name: 'All, 1 query' })).toBeTruthy()
  expect(screen.getByRole('button', {
    name: 'Changed vs prior recorded day, 0 queries',
  })).toBeTruthy()
  expect(screen.getByRole('button', {
    name: 'Mention lost vs prior recorded day, 0 queries',
  })).toBeTruthy()
  expect(screen.getByRole('button', {
    name: 'Citation lost vs prior recorded day, 0 queries',
  })).toBeTruthy()
  expect(screen.getByText('delta stable query')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', {
    name: 'Changed vs prior recorded day, 0 queries',
  }))
  expect(screen.getByText('No queries match this view')).toBeTruthy()

  fireEvent.change(search, { target: { value: 'alpha lost' } })
  expect(screen.getByRole('button', { name: 'All, 1 query' })).toBeTruthy()
  expect(screen.getByRole('button', {
    name: 'Changed vs prior recorded day, 1 query',
  })).toBeTruthy()
  expect(screen.getByText('alpha lost query')).toBeTruthy()
})

test('shows an instructive state before any queries are tracked', () => {
  render(<EvidenceTable evidence={[]} />)

  expect(screen.getByText('No queries tracked yet')).toBeTruthy()
  expect(screen.getByText(/Manage queries/)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

test('distinguishes externally filtered evidence from an unconfigured project', () => {
  render(<EvidenceTable evidence={[]} hasTrackedQueries />)

  expect(screen.getByText('No query evidence matches these filters')).toBeTruthy()
  expect(screen.queryByText('No queries tracked yet')).toBeNull()
  expect(screen.getByText(/Choose another location/)).toBeTruthy()
})
