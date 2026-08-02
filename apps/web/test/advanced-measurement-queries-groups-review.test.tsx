import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  AdvancedMeasurementGroupsStep,
  AdvancedMeasurementQueriesStep,
  AdvancedMeasurementReviewStep,
  type AdvancedMeasurementGroup,
  type AdvancedMeasurementGroupDraft,
  type AdvancedMeasurementProperty,
  type AdvancedMeasurementQuery,
} from '../src/components/project/advanced-measurement/SetupQueriesGroupsReview.js'

afterEach(cleanup)

const properties: AdvancedMeasurementProperty[] = [
  { id: 'harbor-house', label: 'Harbor House', urlCount: 4 },
  { id: 'north-hall', label: 'North Hall', urlCount: 2 },
]

const manyProperties: AdvancedMeasurementProperty[] = Array.from({ length: 55 }, (_, index) => ({
  id: `property-${index + 1}`,
  label: `Property ${index + 1}`,
  urlCount: 1,
}))

const manyQueries: AdvancedMeasurementQuery[] = Array.from({ length: 55 }, (_, index) => ({
  id: `query-${index + 1}`,
  text: `Service query ${index + 1}`,
  source: 'saved-project-queries',
}))

const queries: AdvancedMeasurementQuery[] = [
  {
    id: 'q-saved',
    text: 'Harbor House events',
    source: 'saved-project-queries',
    assignmentClass: 'branded',
    propertyIds: ['harbor-house'],
  },
  {
    id: 'q-set',
    text: 'event spaces near me',
    source: 'query-sets',
    assignmentClass: 'non-brand',
    sourceDetail: 'Event planning',
    propertyIds: ['north-hall'],
  },
  {
    id: 'q-draft',
    text: 'Harbor House private events',
    source: 'generated-drafts-from-templates',
    assignmentClass: 'branded',
    sourceDetail: 'Private event template',
  },
  {
    id: 'q-unclassified',
    text: 'private event venue',
    source: 'saved-project-queries',
  },
]

const groupDraft: AdvancedMeasurementGroupDraft = {
  name: 'Waterfront venues',
  propertyIds: ['harbor-house'],
  competitorDomains: 'rival.example',
}

const emptyGroupDraft: AdvancedMeasurementGroupDraft = {
  name: '',
  propertyIds: [],
  competitorDomains: '',
}

const groups: AdvancedMeasurementGroup[] = [{
  id: 'waterfront-venues',
  name: 'Waterfront venues',
  propertyIds: ['harbor-house'],
  competitors: ['rival.example'],
}]

function renderQueries(overrides: Partial<ComponentProps<typeof AdvancedMeasurementQueriesStep>> = {}) {
  const props = {
    properties,
    queries,
    selectedPropertyIds: ['harbor-house', 'north-hall'],
    selectedQueryIds: ['q-saved'],
    onSelectedPropertyIdsChange: vi.fn(),
    onSelectedQueryIdsChange: vi.fn(),
    onApplySelectedQueries: vi.fn(),
    onRemoveQuery: vi.fn(),
    onBack: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementQueriesStep {...props} />), props }
}

function renderGroups(overrides: Partial<ComponentProps<typeof AdvancedMeasurementGroupsStep>> = {}) {
  const props = {
    properties,
    groups,
    groupDraft,
    onGroupDraftChange: vi.fn(),
    onSaveGroup: vi.fn(),
    onBack: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementGroupsStep {...props} />), props }
}

function renderReview(overrides: Partial<ComponentProps<typeof AdvancedMeasurementReviewStep>> = {}) {
  const props = {
    counts: { properties: 2, queries: 3, groups: 1 },
    flaggedExceptions: [{ id: 'missing-url', title: 'A URL needs review', detail: 'Harbor House has one unmatched URL.' }],
    canPublish: true,
    onBack: vi.fn(),
    onPublish: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementReviewStep {...props} />), props }
}

test('queries explain their project-library origin without exposing assignment mechanics', () => {
  const view = renderQueries()

  expect(screen.getByText(/already tracked for this project/i)).toBeTruthy()
  expect(screen.getByText('Where these queries come from').closest('details')?.open).toBe(false)
  expect(screen.getAllByText('Saved project queries').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Query sets').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Generated drafts from templates').length).toBeGreaterThan(0)
  expect(screen.queryByText('Assignment class')).toBeNull()
  expect(screen.queryByText('Needs classification')).toBeNull()
  expect(view.container.textContent?.toLowerCase()).not.toContain('competitor')
})

test('clears an individual query assignment with explicit wording', () => {
  const { props } = renderQueries()

  fireEvent.click(screen.getByRole('button', { name: 'Clear assignments for Harbor House events' }))

  expect(props.onRemoveQuery).toHaveBeenCalledWith('q-saved')
})

test('keeps a missing tracked query visible only for clearing its assignments', () => {
  const missingQuery: AdvancedMeasurementQuery = {
    id: 'q-missing',
    text: 'Removed event query',
    source: 'unavailable-tracked-query',
    state: 'missing',
    propertyIds: ['harbor-house'],
  }
  const { props } = renderQueries({
    queries: [missingQuery],
    selectedQueryIds: [],
  })

  expect(screen.getAllByText('Unavailable tracked query').length).toBeGreaterThan(0)
  expect(screen.queryByLabelText('Select query Removed event query')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear assignments for Unavailable tracked query' }))
  expect(props.onRemoveQuery).toHaveBeenCalledWith('q-missing')
})

test('supports bulk query selection and keeps the long Property list collapsed', () => {
  const { props } = renderQueries()

  const propertyChooser = screen.getByText('2 of 2 Properties selected').closest('details')
  expect(propertyChooser?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown queries' }))
  expect(props.onSelectedQueryIdsChange).toHaveBeenCalledWith(queries.map(query => query.id))
  fireEvent.click(screen.getByRole('button', { name: 'Clear query selection' }))
  expect(props.onSelectedQueryIdsChange).toHaveBeenLastCalledWith([])
})

test('keeps a large query library searchable, capped, and explicit about bulk selection', () => {
  const view = renderQueries({ queries: manyQueries, selectedQueryIds: [] })

  expect(screen.getByText('Showing 50 of 55 queries')).toBeTruthy()
  expect(screen.queryByLabelText('Select query Service query 51')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown queries' }))
  expect(view.props.onSelectedQueryIdsChange).toHaveBeenCalledWith(manyQueries.slice(0, 50).map(query => query.id))

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'Service query 55' } })
  expect(screen.getByText('Showing 1 of 1 queries')).toBeTruthy()
  expect(screen.getByLabelText('Select query Service query 55')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show all queries' }))
  expect(screen.getByText('Showing 55 of 55 queries')).toBeTruthy()
  expect(screen.getByLabelText('Select query Service query 51')).toBeTruthy()
})

test('makes the query Property picker searchable and bounded for large portfolios', () => {
  const view = renderQueries({
    properties: manyProperties,
    selectedPropertyIds: [],
    selectedQueryIds: [],
  })

  fireEvent.click(screen.getByText('0 of 55 Properties selected'))
  expect(screen.getByText('Showing 50 of 55 Properties')).toBeTruthy()
  expect(screen.queryByLabelText('Select Property 51')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
  expect(view.props.onSelectedPropertyIdsChange).toHaveBeenCalledWith(manyProperties.slice(0, 50).map(property => property.id))

  fireEvent.click(screen.getByRole('button', { name: 'Show all Properties' }))
  expect(screen.getByText('Showing 55 of 55 Properties')).toBeTruthy()
  expect(screen.getByLabelText('Select Property 51')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Properties' }), { target: { value: 'Property 55' } })
  expect(screen.getByText('Showing 1 of 1 Properties')).toBeTruthy()
  expect(screen.getByLabelText('Select Property 55')).toBeTruthy()

  view.unmount()
  const selectedView = renderQueries({
    properties: manyProperties,
    selectedPropertyIds: manyProperties.slice(0, 50).map(property => property.id),
    selectedQueryIds: [],
  })
  fireEvent.click(screen.getByText('50 of 55 Properties selected'))
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
  expect(selectedView.props.onSelectedPropertyIdsChange).toHaveBeenCalledWith([])
})

test('shares the bounded, searchable Property picker with group setup', () => {
  renderGroups({
    properties: manyProperties,
    groups: [],
    groupDraft: emptyGroupDraft,
  })

  fireEvent.click(screen.getByText('0 of 55 Properties selected'))
  expect(screen.getByText('Showing 50 of 55 Properties')).toBeTruthy()
  expect(screen.queryByLabelText('Select Property 51')).toBeNull()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Properties' }), { target: { value: 'Property 55' } })
  expect(screen.getByText('Showing 1 of 1 Properties')).toBeTruthy()
})

test('gives an empty query library a clear way to manage project queries', () => {
  const onManageProjectQueries = vi.fn()
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onManageProjectQueries,
  })

  expect(screen.getByText('Add queries to this project first. Then return here to apply them to Properties.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Manage project queries' }))
  expect(onManageProjectQueries).toHaveBeenCalledTimes(1)
})

test('keeps the empty-library action hidden from viewers', () => {
  renderQueries({
    access: 'viewer',
    queries: [],
    selectedQueryIds: [],
    onManageProjectQueries: vi.fn(),
  })

  expect(screen.getByText('Add queries to this project first. Then return here to apply them to Properties.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Manage project queries' })).toBeNull()
})

test('uses an accessible hit target for each table query checkbox', () => {
  renderQueries()

  expect(screen.getByLabelText('Select query Harbor House events').className).toContain('size-6')
})

test('places competitors only in groups and uses one clear continuation action', () => {
  const queryView = renderQueries()
  expect(queryView.queryByText('rival.example')).toBeNull()
  queryView.unmount()

  const { props } = renderGroups({ groupDraft: emptyGroupDraft })
  expect(screen.getByText('rival.example')).toBeTruthy()
  expect(screen.getByText(/used only in this group's competitor report/i)).toBeTruthy()

  expect(screen.queryByRole('button', { name: 'Skip groups' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(props.onContinue).toHaveBeenCalledTimes(1)

  cleanup()
  renderGroups({ groups: [], groupDraft: emptyGroupDraft })
  expect(screen.getByRole('button', { name: 'Continue without groups' })).toBeTruthy()
})

test('collapses group Properties and exposes optional actions for saved groups', () => {
  const onEditGroup = vi.fn()
  const onRemoveGroup = vi.fn()
  renderGroups({ onEditGroup, onRemoveGroup })

  const propertyChooser = screen.getByText('1 of 2 Properties selected').closest('details')
  expect(propertyChooser?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Edit Waterfront venues' }))
  expect(onEditGroup).toHaveBeenCalledWith(groups[0])
  fireEvent.click(screen.getByRole('button', { name: 'Remove Waterfront venues' }))
  expect(onRemoveGroup).toHaveBeenCalledWith('waterfront-venues')
})

test('requires a partially entered group to be saved or cleared before continuing', () => {
  const onClearGroupDraft = vi.fn()
  const { props } = renderGroups({
    groups: [],
    onClearGroupDraft,
    groupDraft: { name: 'Waterfront venues', propertyIds: [], competitorDomains: '' },
  })

  expect(screen.getByText('Save this group or clear the form before continuing.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Clear form' }))
  expect(onClearGroupDraft).toHaveBeenCalledTimes(1)
  expect(props.onContinue).not.toHaveBeenCalled()
})

test('provides a predictable Back action on every step after Properties', () => {
  const queryView = renderQueries()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(queryView.props.onBack).toHaveBeenCalledTimes(1)
  queryView.unmount()

  const groupView = renderGroups()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(groupView.props.onBack).toHaveBeenCalledTimes(1)
  groupView.unmount()

  const reviewView = renderReview()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(reviewView.props.onBack).toHaveBeenCalledTimes(1)
})

test('blocks query continuation until an applied query is available', () => {
  renderQueries({ canContinue: false })

  expect(screen.getByText('Apply at least one query to a Property before continuing.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
})

test('uses publish wording without showing a result or implying work starts', () => {
  const { container, props } = renderReview()

  fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

  expect(props.onPublish).toHaveBeenCalledTimes(1)
  expect(container.textContent?.toLowerCase()).not.toContain('result')
  expect(container.textContent?.toLowerCase()).not.toContain('start a run')
})

test('requires a human-readable change review before publishing when preflight is configured', () => {
  const onReviewChanges = vi.fn()
  const waitingForReview = renderReview({
    onReviewChanges,
    reviewedChanges: null,
  })

  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  expect(onReviewChanges).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Publish setup' })).toBeNull()
  waitingForReview.unmount()

  const { props } = renderReview({
    onReviewChanges,
    reviewedChanges: {
      title: '2 Properties, 3 queries, and 1 group are ready to publish.',
      items: ['Harbor House and North Hall have selected URLs.', 'One group compares Waterfront venues with rival.example.'],
    },
  })

  expect(screen.getByText('2 Properties, 3 queries, and 1 group are ready to publish.')).toBeTruthy()
  expect(screen.getByText('Harbor House and North Hall have selected URLs.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))
  expect(props.onPublish).toHaveBeenCalledTimes(1)
})

test('announces flagged exceptions when publishing cannot continue', () => {
  renderReview()

  const announcement = screen.getByRole('alert')
  expect(announcement.textContent).toContain('A URL needs review')
  expect(announcement.getAttribute('aria-atomic')).toBe('true')
})

test('shows reviewed sitemap URLs behind a concise disclosure before confirming them', () => {
  const onResolve = vi.fn()
  renderReview({
    sitemapReview: {
      exceptionCount: 1,
      coverageReviewCount: 0,
      coverageResolution: 'keep-existing',
      items: [{ url: 'https://example.com/blog', reason: 'Shared page, not a single Property' }],
      onCoverageResolutionChange: vi.fn(),
      onResolve,
    },
    canPublish: false,
  })

  expect(screen.getByText('URLs not added to Properties (1)').closest('details')?.open).toBe(false)
  expect(screen.getByText('https://example.com/blog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sitemap changes' }))
  expect(onResolve).toHaveBeenCalledTimes(1)
})

test('leaves the single unpublished-changes banner to the surrounding setup shell', () => {
  renderReview()

  expect(screen.queryByText('Unpublished changes')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
})

test('viewer access is inspect-only across the three steps', () => {
  const queryView = renderQueries({ access: 'viewer' })
  expect(screen.getByText('Viewer access')).toBeTruthy()
  expect(queryView.container.querySelectorAll('button, select, textarea, input:not([type="search"])')).toHaveLength(0)
  expect(screen.getByRole('searchbox', { name: 'Search queries' })).toBeTruthy()
  queryView.unmount()

  const groupView = renderGroups({ access: 'viewer' })
  expect(screen.getByText('Viewer access')).toBeTruthy()
  expect(groupView.container.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
  groupView.unmount()

  const reviewView = renderReview({ access: 'viewer' })
  expect(screen.getByText('Viewer access')).toBeTruthy()
  expect(reviewView.container.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
})

test('never renders implementation vocabulary that belongs outside the browser', () => {
  const queryView = renderQueries()
  const queryText = queryView.container.textContent?.toLowerCase() ?? ''
  queryView.unmount()
  const groupView = renderGroups()
  const groupText = groupView.container.textContent?.toLowerCase() ?? ''
  groupView.unmount()
  const reviewView = renderReview()
  const reviewText = reviewView.container.textContent?.toLowerCase() ?? ''

  const renderedText = `${queryText} ${groupText} ${reviewText}`
  for (const term of ['target', 'edge', 'node', 'manifest', 'revision', 'checksum', 'stablekey']) {
    expect(renderedText).not.toContain(term)
  }
})

test('renders an unavailable state without controls', () => {
  const { container } = renderReview({
    availability: { status: 'unavailable', message: 'Properties are not ready for setup.' },
  })

  expect(screen.getByText('Measurement setup unavailable')).toBeTruthy()
  expect(screen.getByText('Properties are not ready for setup.')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Review and publish' })).toBeTruthy()
  expect(container.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
})
