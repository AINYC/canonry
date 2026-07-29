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
  expect(screen.getByRole('columnheader', { name: /Change \/ recent history/ })).toBeTruthy()
  expect(screen.queryByRole('tab')).toBeNull()
  expect(screen.queryByText('Density')).toBeNull()
  expect(screen.queryByText('Latest run')).toBeNull()
  expect(screen.getByText('1–4 of 4 queries with evidence')).toBeTruthy()

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
  expect(screen.getByText('No change')).toBeTruthy()
  expect(screen.getByRole('button', {
    name: "No mention or citation changes when each engine's latest result was compared with its most recent result from an earlier UTC day at the same location.",
  })).toBeTruthy()
})

test('aligns engine results as table rows with passive history and one detail action', () => {
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

  const geminiRow = screen.getByRole('row', {
    name: 'Gemini result for best solar installer',
  })
  const openaiRow = screen.getByRole('row', {
    name: 'OpenAI result for best solar installer',
  })
  const geminiCells = [...geminiRow.querySelectorAll(':scope > th, :scope > td')]
  expect(geminiCells).toHaveLength(5)
  expect(geminiCells[0]?.textContent).toContain('gemini')
  expect(geminiCells[1]?.textContent).toContain('Mentioned')
  expect(geminiCells[2]?.textContent).toContain('Cited')
  expect(within(geminiRow).getByRole('img', { name: /Recent recorded days for Gemini/ })).toBeTruthy()
  expect(within(openaiRow).getByRole('img', { name: /Recent recorded days for OpenAI/ })).toBeTruthy()
  expect(within(geminiRow).queryByRole('button', { name: /recent history/i })).toBeNull()
  expect(screen.getAllByText('Citation gained on Gemini')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', {
    name: 'Review Gemini answer and history for best solar installer',
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
  const geminiRow = screen.getByRole('row', {
    name: 'Gemini result for independent signal query',
  })
  const openaiRow = screen.getByRole('row', {
    name: 'OpenAI result for independent signal query',
  })
  expect(engineStates).toHaveLength(4)
  expect(engineStates.every(state => !state.className.includes('badge'))).toBe(true)
  expect(within(geminiRow).getByText('Mention status:')).toBeTruthy()
  expect(within(openaiRow).getByText('Mention status:')).toBeTruthy()
  expect(within(geminiRow).getByText('Citation status:')).toBeTruthy()
  expect(within(openaiRow).getByText('Citation status:')).toBeTruthy()
  expect(engineStates.some(state => state.textContent?.includes('Mentioned'))).toBe(true)
  expect(engineStates.some(state => state.textContent?.includes('Not cited'))).toBe(true)
  expect([...geminiRow.querySelectorAll('.evidence-signal-value'), ...openaiRow.querySelectorAll('.evidence-signal-value')]
    .filter(state => state.textContent?.includes('No result'))).toHaveLength(2)
})

test('search and empty states explain how to recover', () => {
  render(<EvidenceTable evidence={fixture()} />)

  const search = screen.getByRole('searchbox', { name: 'Search queries, locations, or engines' })
  fireEvent.change(search, { target: { value: 'does-not-exist' } })

  expect(screen.getByText('No queries match this view')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(screen.getByText('alpha lost query')).toBeTruthy()
})

test('labels pagination as query locations when comparison expands rows', () => {
  render(<EvidenceTable
    evidence={[
      {
        ...evidenceItem({
          id: 'florida',
          query: 'local dentist',
          provider: 'gemini',
          history: [point('r1', 'cited', true)],
        }),
        location: 'Florida',
      },
      {
        ...evidenceItem({
          id: 'michigan',
          query: 'local dentist',
          provider: 'gemini',
          history: [point('r1', 'cited', true)],
        }),
        location: 'Michigan',
      },
    ]}
    compareLocations
  />)

  expect(screen.getByText('1–2 of 2 query locations with evidence')).toBeTruthy()
})

test('quick-view counts follow the search query and active view', () => {
  render(<EvidenceTable evidence={fixture()} />)

  const search = screen.getByRole('searchbox', { name: 'Search queries, locations, or engines' })
  fireEvent.change(search, { target: { value: 'delta stable' } })

  expect(screen.getByRole('button', { name: 'All, 1 query' })).toBeTruthy()
  const changedZero = screen.getByRole('button', {
    name: 'Changed vs prior recorded day, 0 queries',
  })
  const mentionLostZero = screen.getByRole('button', {
    name: 'Mention lost vs prior recorded day, 0 queries',
  })
  const citationLostZero = screen.getByRole('button', {
    name: 'Citation lost vs prior recorded day, 0 queries',
  })
  expect(changedZero.hasAttribute('disabled')).toBe(true)
  expect(mentionLostZero.hasAttribute('disabled')).toBe(true)
  expect(citationLostZero.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('delta stable query')).toBeTruthy()

  fireEvent.click(changedZero)
  expect(screen.getByText('delta stable query')).toBeTruthy()

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
