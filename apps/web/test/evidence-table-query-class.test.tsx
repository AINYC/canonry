import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import { createDashboardFixture } from '../src/mock-data.js'
import type { CitationInsightVm } from '../src/view-models.js'

vi.mock('../src/hooks/use-drawer.js', () => ({
  useDrawer: () => ({ openEvidence: vi.fn() }),
}))

afterEach(cleanup)

function evidence(query: string, queryClass: 'branded' | 'non-brand' | null, overrides: Partial<CitationInsightVm> = {}): CitationInsightVm {
  const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
  return { ...seed, id: query, query, queryClass, ...overrides }
}

test('labels each query class without confusing it with the mention or citation signal', () => {
  render(<EvidenceTable evidence={[
    evidence('About Northwind', 'branded'),
    evidence('Best widgets', 'non-brand'),
    evidence('Imported question', null),
  ]} />)

  const row = screen.getByText('About Northwind').closest('tr')!
  expect(within(row).getByText('Branded')).toBeTruthy()
  expect(within(screen.getByText('Best widgets').closest('tr')!).getByText('Non-brand')).toBeTruthy()
  expect(within(screen.getByText('Imported question').closest('tr')!).getByText('Unclassified')).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Query class' })).toHaveProperty('value', 'all')
  expect(screen.getByRole('tab', { name: 'Mentions' }).getAttribute('aria-selected')).toBe('true')
})

test('class filtering composes with search and both independent evidence signals', () => {
  render(<EvidenceTable evidence={[
    evidence('Northwind pricing', 'branded'),
    evidence('Best widgets', 'non-brand'),
    evidence('Local widget makers', 'non-brand'),
    evidence('Imported question', null),
  ]} />)

  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'branded' } })
  expect(screen.getByText('Northwind pricing')).toBeTruthy()
  expect(screen.queryByText('Best widgets')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  expect(screen.getByText('Northwind pricing')).toBeTruthy()
  expect(screen.queryByText('Best widgets')).toBeNull()

  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter tracked queries' }), { target: { value: 'local' } })
  expect(screen.getByText('Local widget makers')).toBeTruthy()
  expect(screen.queryByText('Best widgets')).toBeNull()
  expect(screen.queryByText('Northwind pricing')).toBeNull()
  expect(screen.queryByText('Imported question')).toBeNull()
})

test('never treats missing classification as non-brand and names an empty selected class', () => {
  render(<EvidenceTable evidence={[evidence('Imported question', null)]} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  expect(screen.queryByText('Imported question')).toBeNull()
  expect(screen.getByText('No tracked queries match this filter.')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'unclassified' } })
  expect(screen.getByText('Imported question')).toBeTruthy()
})

test('keeps distinct classes separate for the same query and location', () => {
  render(<EvidenceTable compareLocations evidence={[
    evidence('Shared question', 'branded', { id: 'a', location: 'nyc' }),
    evidence('Shared question', 'non-brand', { id: 'b', location: 'nyc' }),
  ]} />)
  expect(screen.getAllByText('Shared question')).toHaveLength(2)
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'branded' } })
  expect(screen.getAllByText('Shared question')).toHaveLength(1)
  expect(within(screen.getByText('Shared question').closest('tr')!).getByText('Branded')).toBeTruthy()
})

test('changing class resets pagination while preserving the independent signal selection', () => {
  render(<EvidenceTable evidence={[
    ...Array.from({ length: 30 }, (_, i) => evidence(`Northwind ${i}`, 'branded')),
    ...Array.from({ length: 30 }, (_, i) => evidence(`Widget category ${i}`, 'non-brand')),
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Citations' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'non-brand' } })
  expect(screen.getByText('Widget category 0')).toBeTruthy()
  expect(screen.queryByText('Widget category 29')).toBeNull()
  expect(screen.getByRole('tab', { name: 'Citations' }).getAttribute('aria-selected')).toBe('true')
})
