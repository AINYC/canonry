import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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

test('uses Questions without exposing source taxonomy or assignment mechanics', () => {
  const view = renderQueries({ onCreateQueries: vi.fn() })

  expect(screen.getByRole('heading', { name: 'Questions' })).toBeTruthy()
  expect(screen.getAllByText('Add questions').find(element => element.tagName === 'SUMMARY')?.closest('details')?.open).toBe(false)
  expect(screen.queryByText('Saved project queries')).toBeNull()
  expect(screen.queryByText('Query sets')).toBeNull()
  expect(screen.queryByText('Generated drafts from templates')).toBeNull()
  expect(screen.queryByText('Assignment class')).toBeNull()
  expect(screen.queryByText('Needs classification')).toBeNull()
  expect(view.container.textContent?.toLowerCase()).not.toContain('competitor')
})

test('opens Question creation only when the library is empty', () => {
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries: vi.fn() })

  expect(screen.getAllByText('Add questions').find(element => element.tagName === 'SUMMARY')?.closest('details')?.open).toBe(true)
})

test('shows Property scope before dependent question patterns and previews cross-product impact', () => {
  const { props } = renderQueries({ onCreateQueries: vi.fn() })
  const scope = screen.getByText('2 of 2 Properties selected').closest('details')
  const creation = screen.getAllByText('Add questions').find(element => element.tagName === 'SUMMARY')?.closest('details')

  expect(scope?.compareDocumentPosition(creation!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(screen.getByText('1 question × 2 Properties = 2 assignments')).toBeTruthy()
  const apply = screen.getByRole('button', { name: 'Apply selected questions' })
  expect(apply.className).toContain('min-h-11')
  expect(apply.className).toContain('bg-accent')
  expect(screen.getByRole('button', { name: 'Continue' }).className).toContain('border')
  fireEvent.click(apply)
  expect(props.onApplySelectedQueries).toHaveBeenCalledWith({
    queryIds: ['q-saved'],
    propertyIds: ['harbor-house', 'north-hall'],
  })
})

test('clears an individual query assignment with explicit wording', () => {
  const { props } = renderQueries()

  fireEvent.click(screen.getByRole('button', { name: 'Clear question assignments for Harbor House events' }))

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

  expect(screen.getAllByText('Unavailable tracked question').length).toBeGreaterThan(0)
  expect(screen.queryByLabelText('Select question Removed event query')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear question assignments for Unavailable tracked question' }))
  expect(props.onRemoveQuery).toHaveBeenCalledWith('q-missing')
})

test('supports bulk query selection and keeps the long Property list collapsed', () => {
  const { props } = renderQueries()

  const propertyChooser = screen.getByText('2 of 2 Properties selected').closest('details')
  expect(propertyChooser?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown questions' }))
  expect(props.onSelectedQueryIdsChange).toHaveBeenCalledWith(queries.map(query => query.id))
  fireEvent.click(screen.getByRole('button', { name: 'Clear question selection' }))
  expect(props.onSelectedQueryIdsChange).toHaveBeenLastCalledWith([])
})

test('keeps a large query library searchable, capped, and explicit about bulk selection', () => {
  const view = renderQueries({ queries: manyQueries, selectedQueryIds: [] })

  expect(screen.getByText(/Showing 50 of 55 questions/)).toBeTruthy()
  expect(screen.queryByLabelText('Select question Service query 51')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown questions' }))
  expect(view.props.onSelectedQueryIdsChange).toHaveBeenCalledWith(manyQueries.slice(0, 50).map(query => query.id))

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search questions' }), { target: { value: 'Service query 55' } })
  expect(screen.getByText(/Showing 1 of 1 questions/)).toBeTruthy()
  expect(screen.getByLabelText('Select question Service query 55')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search questions' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show all questions' }))
  expect(screen.getByText(/Showing 55 of 55 questions/)).toBeTruthy()
  expect(screen.getByLabelText('Select question Service query 51')).toBeTruthy()
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

// Previously this asserted the copy "Add queries to this project first. Then
// return here to apply them to Properties." — an instruction to leave the
// wizard. On a new project that was a dead end: the step consumed questions and
// could not create them, so the only way forward was out and back. It now
// creates them in place, and the assertion moves with the behaviour.
test('lets an empty query library add questions without leaving setup', () => {
  const onCreateQueries = vi.fn()
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries,
  })

  fireEvent.change(screen.getByLabelText('New questions, one per line'), {
    target: { value: 'best apartments in dallas\nluxury apartments atlanta' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Add 2 questions/ }))

  expect(onCreateQueries).toHaveBeenCalledTimes(1)
  expect(onCreateQueries.mock.calls[0]![0]).toEqual([
    'best apartments in dallas',
    'luxury apartments atlanta',
  ])
})

// The portfolio shape. Typing one generic question and applying it to 213
// Properties measures the portfolio; a question per Property measures the
// Properties. The count is shown before the click because 213 is a surprising
// number to produce from one line of text.
test('writes one question per selected Property from a pattern, paired to it', () => {
  // Was: this handed the expanded texts to onCreateQueries and nothing carried
  // the pairing, so the caller could only cross-product them back onto every
  // Property. The pattern now emits (Property, text) pairs.
  const onCreateAndPairQuestions = vi.fn()
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    onCreateAndPairQuestions,
  })

  fireEvent.change(screen.getByLabelText('Question pattern'), {
    target: { value: 'apartments near {property}' },
  })

  // The expansion is visible before it is committed.
  expect(screen.getByText('apartments near Harbor House')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /Add \d+ questions?/ }))

  const pairs = onCreateAndPairQuestions.mock.calls[0]![0] as { propertyId: string; text: string }[]
  expect(pairs.every(pair => pair.text.startsWith('apartments near '))).toBe(true)
  // One question per Property, each naming the Property it is assigned to.
  expect(new Set(pairs.map(pair => pair.propertyId)).size).toBe(pairs.length)
  for (const pair of pairs) expect(pair.text.includes('{property}')).toBe(false)
})

test('states how many assignments the pattern will create', () => {
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    onCreateAndPairQuestions: vi.fn(),
  })

  fireEvent.change(screen.getByLabelText('Question pattern'), {
    target: { value: 'apartments near {property}' },
  })

  // The number nobody saw before a plan was published with 45,369 of them.
  expect(screen.getByText(/adds \d+ assignments?/)).toBeTruthy()
})

test('previews only unambiguous whole-name recovery matches before assigning them', () => {
  const onApplyPairedQuestions = vi.fn()
  renderQueries({ onApplyPairedQuestions })

  const disclosure = screen.getByText('Review 1 suggested question-to-Property match')
  fireEvent.click(disclosure)
  const preview = screen.getByRole('table', { name: 'Suggested question-to-Property matches' })
  expect(preview.textContent).toContain('Harbor House private events')
  expect(preview.textContent).toContain('Harbor House')

  fireEvent.click(screen.getByRole('button', { name: 'Assign 1 suggested match' }))
  expect(onApplyPairedQuestions).toHaveBeenCalledWith([
    { targetKey: 'harbor-house', queryId: 'q-draft' },
  ])
})

test('requires every large recovery mapping to be revealed before bulk assignment', () => {
  const recoveryProperties = Array.from({ length: 12 }, (_, index) => ({
    id: `property-${index + 1}`,
    label: `Property ${index + 1}`,
    urlCount: 1,
  }))
  const recoveryQueries = recoveryProperties.map((property, index) => ({
    id: `recovery-${index + 1}`,
    text: `events at ${property.label}`,
    source: 'saved-project-queries' as const,
  }))
  const onApplyPairedQuestions = vi.fn()
  renderQueries({
    properties: recoveryProperties,
    queries: recoveryQueries,
    selectedPropertyIds: [],
    selectedQueryIds: [],
    onApplyPairedQuestions,
  })

  fireEvent.click(screen.getByText('Review 12 suggested question-to-Property matches'))
  const assign = screen.getByRole('button', { name: 'Assign 12 suggested matches' })
  expect(assign).toHaveProperty('disabled', true)
  expect(screen.getByText('Showing 10 of 12 suggested matches')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Review all 12 matches' }))
  expect(screen.getByText('Showing 12 of 12 suggested matches')).toBeTruthy()
  expect(screen.getByRole('table', { name: 'Suggested question-to-Property matches' }).textContent).toContain('events at Property 12')
  expect(assign).toHaveProperty('disabled', false)
  fireEvent.click(assign)
  expect(onApplyPairedQuestions).toHaveBeenCalledWith(expect.arrayContaining([
    { targetKey: 'property-12', queryId: 'recovery-12' },
  ]))
  expect(onApplyPairedQuestions.mock.calls[0]![0]).toHaveLength(12)
})

test('does not show a no-op pagination action for a fully shown unapplied filter', () => {
  const mostlyApplied = manyQueries.map((query, index) => ({
    ...query,
    propertyIds: index < 50 ? ['harbor-house'] : [],
  }))
  renderQueries({ queries: mostlyApplied, selectedQueryIds: [] })

  fireEvent.click(screen.getByRole('button', { name: 'Show the 5 not applied' }))
  expect(screen.getAllByRole('button', { name: 'Show all questions' })).toHaveLength(1)
  expect(screen.getByText(/Showing 5 of 5 questions/)).toBeTruthy()
})

test('does not guess recovery matches for partial or overlapping Property names', () => {
  renderQueries({
    properties: [
      { id: 'harbor', label: 'Harbor', urlCount: 1 },
      { id: 'park', label: 'Park', urlCount: 1 },
      { id: 'park-place', label: 'Park Place', urlCount: 1 },
    ],
    queries: [
      { id: 'partial', text: 'Harborview events', source: 'saved-project-queries' },
      { id: 'overlap', text: 'events at Park Place', source: 'saved-project-queries' },
    ],
    selectedPropertyIds: [],
    selectedQueryIds: [],
    onApplyPairedQuestions: vi.fn(),
  })

  expect(screen.queryByText(/suggested question-to-Property match/)).toBeNull()
})

test('blocks writes and navigation while another setup change is saving', () => {
  const onCreateQueries = vi.fn()
  const onContinue = vi.fn()
  renderQueries({ queries: [], selectedQueryIds: [], isBusy: true, onCreateQueries, onContinue })

  fireEvent.change(screen.getByLabelText('New questions, one per line'), {
    target: { value: 'best apartments in dallas' },
  })
  const add = screen.getByRole('button', { name: 'Add 1 question' })
  expect(add).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  fireEvent.click(add)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onCreateQueries).not.toHaveBeenCalled()
  expect(onContinue).not.toHaveBeenCalled()
})

test('asks for a placeholder rather than writing the same question repeatedly', () => {
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries: vi.fn() })

  fireEvent.change(screen.getByLabelText('Question pattern'), {
    target: { value: 'best apartments' },
  })

  expect(screen.getByText(/Add \{property\} to the pattern/)).toBeTruthy()
})

// Clearing the box on failure means retyping every question to retry, which is
// worst for the pattern case where the operator may have written one line that
// expanded to two hundred.
test('keeps what was typed when creation fails', async () => {
  const onCreateQueries = vi.fn().mockRejectedValue(new Error('Query is already tracked.'))
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries })

  const box = screen.getByLabelText('New questions, one per line')
  fireEvent.change(box, { target: { value: 'best apartments in dallas' } })
  fireEvent.click(screen.getByRole('button', { name: /Add 1 question/ }))

  await waitFor(() => expect(onCreateQueries).toHaveBeenCalled())
  expect((box as HTMLTextAreaElement).value).toBe('best apartments in dallas')
})

test('clears the box only once creation succeeds', async () => {
  const onCreateQueries = vi.fn().mockResolvedValue(undefined)
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries })

  const box = screen.getByLabelText('New questions, one per line')
  fireEvent.change(box, { target: { value: 'best apartments in dallas' } })
  fireEvent.click(screen.getByRole('button', { name: /Add 1 question/ }))

  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))
})

test('surfaces the server reason when adding questions fails', () => {
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    createQueriesError: 'Query "best apartments in dallas" is already tracked.',
  })

  expect(screen.getByRole('alert').textContent)
    .toContain('Query "best apartments in dallas" is already tracked.')
})

test('keeps question creation away from viewers', () => {
  renderQueries({
    access: 'viewer',
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    onManageProjectQueries: vi.fn(),
  })

  expect(screen.queryByLabelText('New questions, one per line')).toBeNull()
  expect(screen.queryByRole('button', { name: /Add .* question/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Manage project questions' })).toBeNull()
})

test('uses an accessible hit target for each table query checkbox', () => {
  renderQueries()

  expect(screen.getByLabelText('Select question Harbor House events').className).toContain('size-6')
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

  expect(screen.getByText('Apply at least one question to a Property before continuing.')).toBeTruthy()
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

test('keeps flagged exceptions labelled without treating static review items as an alert', () => {
  renderReview()

  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('region', { name: 'Flagged exceptions' }).textContent).toContain('A URL needs review')
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

test('keeps large review lists bounded and reveals them fifty at a time', () => {
  const count = 75
  renderReview({
    flaggedExceptions: Array.from({ length: count }, (_, index) => ({
      id: `flag-${index + 1}`,
      title: `Flag ${index + 1}`,
      detail: `Flag detail ${index + 1}`,
    })),
    sitemapReview: {
      exceptionCount: count,
      coverageReviewCount: count,
      coverageResolution: 'keep-existing',
      items: Array.from({ length: count }, (_, index) => ({
        url: `https://example.com/unmatched/${index + 1}`,
        reason: `Reason ${index + 1}`,
      })),
      coverageItems: Array.from({ length: count }, (_, index) => ({
        property: `Property ${index + 1}`,
        savedUrls: [`https://example.com/saved/${index + 1}`],
        currentSitemapUrls: [`https://example.com/current/${index + 1}`],
      })),
      onCoverageResolutionChange: vi.fn(),
      onResolve: vi.fn(),
    },
  })

  expect(screen.getAllByText('Showing 20 of 75')).toHaveLength(3)
  expect(screen.getByText('https://example.com/unmatched/20')).toBeTruthy()
  expect(screen.queryByText('https://example.com/unmatched/21')).toBeNull()
  expect(screen.getByText('Property 20')).toBeTruthy()
  expect(screen.queryByText('Property 21')).toBeNull()
  expect(screen.getByText('Flag 20')).toBeTruthy()
  expect(screen.queryByText('Flag 21')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URLs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URL changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 exceptions' }))

  expect(screen.getAllByText('Showing 70 of 75')).toHaveLength(3)
  expect(screen.getByText('https://example.com/unmatched/70')).toBeTruthy()
  expect(screen.getByText('Property 70')).toBeTruthy()
  expect(screen.getByText('Flag 70')).toBeTruthy()
  expect(screen.queryByText('Flag 71')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URLs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URL changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 exceptions' }))

  expect(screen.getAllByText('Showing 75 of 75')).toHaveLength(3)
  expect(screen.getByText('https://example.com/unmatched/75')).toBeTruthy()
  expect(screen.getByText('Property 75')).toBeTruthy()
  expect(screen.getByText('Flag 75')).toBeTruthy()
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
  expect(screen.getByRole('searchbox', { name: 'Search questions' })).toBeTruthy()
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
