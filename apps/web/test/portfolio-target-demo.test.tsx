import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'

import { PortfolioSection } from '../src/components/project/PortfolioSection.js'

type Props = ComponentProps<typeof PortfolioSection>

const queries = [
  { id: 'query-nearby', query: 'best service near me' },
  { id: 'query-reviews', query: 'trusted service reviews' },
]

const locations = [
  { label: 'North District', city: 'Northbridge', region: 'WA', country: 'US' },
]

function candidates(count = 213) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, '0')
    return {
      classification: 'proposed' as const,
      reason: 'primary-match' as const,
      stableKey: `location-${number}`,
      slug: `location-${number}`,
      label: `Location ${number}`,
      primaryUrl: `https://locations.example/places/location-${number}`,
      aliasCoverageUrls: index === 0 ? [`https://directory.example/location-${number}`] : [],
    }
  })
}

function discovery(count = 213) {
  return {
    proposed: candidates(count),
    aliases: count > 0 ? [{
      classification: 'alias' as const,
      reason: 'exact-slug-match' as const,
      slug: 'location-001',
      url: 'https://directory.example/location-001',
      targetStableKey: 'location-001',
    }] : [],
    shared: [{
      classification: 'shared' as const,
      reason: 'shared-path' as const,
      url: 'https://locations.example/places/region',
      canonicalUrl: 'https://locations.example/places/region',
    }],
    unmatched: [],
    excluded: [],
    diagnostics: [],
  }
}

function activePlanFixture(revision: number, label = 'Location 001'): NonNullable<Props['activePlan']> {
  return {
    revision,
    checksum: String(revision).padStart(64, 'a').slice(-64),
    createdAt: '2026-08-01T10:00:00.000Z',
    plan: {
      schemaVersion: 1,
      defaultContext: locations[0]!,
      effectiveOwnedHosts: ['locations.example'],
      projectCanonicalHost: 'locations.example',
      projectBrandNames: ['Example'],
      targets: [{ stableKey: 'location-001', label, urls: [{ kind: 'prefix', host: 'locations.example', pathPrefix: '/places/location-001', pathCase: 'insensitive' }], aliases: [label], mentionNotApplicable: false }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'location-001', queryIds: ['query-nearby'] }],
      querySnapshots: [{ queryId: 'query-nearby', queryText: 'best service near me' }],
      executionNodes: [{ stableKey: 'execution-1', queryText: 'best service near me', context: locations[0]!, expectedSnapshots: 1 }],
      usageEdges: [{ kind: 'target', executionNodeKey: 'execution-1', queryId: 'query-nearby', targetKey: 'location-001' }],
      warnings: [],
    },
  }
}

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    projectName: 'synthetic-portfolio',
    locations,
    queries,
    isQueryLoading: false,
    isQueryError: false,
    activePlan: null,
    isPlanLoading: false,
    isPlanError: false,
    report: null,
    isReportLoading: false,
    isReportError: false,
    onDiscover: vi.fn(async () => discovery()),
    onCreateQueries: vi.fn(async (texts) => texts.map((query, index) => ({ id: `created-${index + 1}`, query }))),
    onCompilePlan: vi.fn(async () => ({
      ok: true,
      checks: [],
      executionNodes: [],
      dedupSaved: 0,
      usageEdges: { baseline: 2, target: 0 },
      estCostUsd: null,
      plan: {} as never,
    })),
    onDiffPlan: vi.fn(async () => ({
      ok: true,
      checks: [],
      executionNodes: [],
      dedupSaved: 0,
      usageEdges: { baseline: 2, target: 0 },
      estCostUsd: null,
      plan: {} as never,
      diff: null,
    })),
    onPublishPlan: vi.fn(async () => ({ active: null })),
    ...overrides,
  }
  return { ...render(<PortfolioSection {...props} />), props }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

test('imports a synthetic sitemap and reviews 213 Targets without per-URL work', async () => {
  const { getByRole, getByLabelText, getByText, queryByText, props } = setup()

  expect(getByRole('navigation', { name: 'Portfolio setup steps' }).textContent).toContain('ImportTargetsQueriesReview & publishReport')
  fireEvent.change(getByLabelText('Sitemap URL'), { target: { value: 'https://locations.example/sitemap.xml' } })
  fireEvent.change(getByLabelText('Primary host'), { target: { value: 'locations.example' } })
  fireEvent.change(getByLabelText('Target path pattern'), { target: { value: '/places/{slug}' } })
  fireEvent.change(getByLabelText('Excluded slugs (optional)'), { target: { value: 'region-page, archive-page\nshared-page' } })
  fireEvent.click(getByRole('button', { name: 'Import sitemap' }))

  await waitFor(() => expect(props.onDiscover).toHaveBeenCalledTimes(1))
  expect(props.onDiscover).toHaveBeenCalledWith(expect.objectContaining({ rule: expect.objectContaining({
    excludedSlugPatterns: [
      { kind: 'exact', value: 'region-page' },
      { kind: 'exact', value: 'archive-page' },
      { kind: 'exact', value: 'shared-page' },
    ],
  }) }))
  expect(getByText('213 proposed Targets')).toBeTruthy()
  expect(getByText('1 shared URL needs review')).toBeTruthy()

  fireEvent.click(getByRole('button', { name: 'Continue to Targets' }))
  expect(getByText('Showing 50 of 213 matching Targets (213 total)')).toBeTruthy()
  fireEvent.change(getByLabelText('Search Targets'), { target: { value: 'Location 001' } })
  expect(getByText('Showing 1 of 1 matching Target (213 total)')).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(getByRole('button', { name: 'Confirm selected Targets' }))
  expect(getByText('Confirmed')).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'Show URLs for Location 001' }))
  expect(getByText('https://directory.example/location-001')).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'Remove https://directory.example/location-001 from Location 001' }))
  expect(queryByText('https://directory.example/location-001')).toBeNull()
  expect(queryByText(/stableKey|execution node|usage edge|manifest/i)).toBeNull()
})

test('resolves imported URL churn in bulk without silently replacing saved coverage', async () => {
  const refreshed = discovery(2)
  refreshed.proposed = [{
    ...refreshed.proposed[0]!,
    primaryUrl: 'https://locations.example/places/location-001-new',
  }]
  refreshed.aliases = []
  const onDiscover = vi.fn()
    .mockResolvedValueOnce(discovery(2))
    .mockResolvedValueOnce(refreshed)
  const screen = setup({ projectName: 'synthetic-coverage-refresh', onDiscover })

  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://locations.example/sitemap.xml' } })
  fireEvent.change(screen.getByLabelText('Primary host'), { target: { value: 'locations.example' } })
  fireEvent.change(screen.getByLabelText('Target path pattern'), { target: { value: '/places/{slug}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Import sitemap' }))
  await waitFor(() => screen.getByText('2 proposed Targets'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected Targets' }))
  fireEvent.click(screen.getByText('1 URL needs review'))
  fireEvent.click(screen.getByRole('button', { name: 'Mark all 1 URL review items complete' }))

  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Import sitemap' }))
  await waitFor(() => expect(screen.getByText(/2 with URL changes/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Targets' }))

  expect(screen.getByText('2 Targets have URL coverage changes.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Keep existing coverage for selected' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Replace selected with imported coverage' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Select all URL changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Keep existing coverage for selected' }))

  expect(screen.queryByText('2 Targets have URL coverage changes.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  expect(screen.getByRole('button', { name: 'Check plan' })).toBeTruthy()
})

test('query actions ignore a stale selection that contains only proposed Targets', async () => {
  const screen = setup({ projectName: 'synthetic-selection-guard', onDiscover: vi.fn(async () => discovery(2)) })

  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://locations.example/sitemap.xml' } })
  fireEvent.change(screen.getByLabelText('Primary host'), { target: { value: 'locations.example' } })
  fireEvent.change(screen.getByLabelText('Target path pattern'), { target: { value: '/places/{slug}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Import sitemap' }))
  await waitFor(() => screen.getByText('2 proposed Targets'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Targets' }))
  fireEvent.change(screen.getByLabelText('Search Targets'), { target: { value: 'Location 001' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected Targets' }))
  fireEvent.change(screen.getByLabelText('Search Targets'), { target: { value: 'Location 002' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Queries' }))
  fireEvent.change(screen.getByLabelText('Query set name'), { target: { value: 'Guarded set' } })
  fireEvent.click(screen.getByLabelText('best service near me'))
  fireEvent.click(screen.getByRole('button', { name: 'Save query set' }))

  expect(screen.getByText('0 confirmed selected')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Apply Guarded set' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('Query template'), { target: { value: 'reviews for {target.label}' } })
  expect(screen.getByRole('button', { name: 'Preview query drafts' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Review group' } })
  expect(screen.getByRole('button', { name: 'Save reporting group' })).toHaveProperty('disabled', true)
})

test('blocks setup when active-plan readiness cannot be established', () => {
  const onRetryPlan = vi.fn()
  const screen = setup({ projectName: 'synthetic-plan-error', isPlanError: true, onRetryPlan })

  expect(screen.getByText(/Could not load measurement setup/i)).toBeTruthy()
  expect(screen.queryByLabelText('Sitemap URL')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetryPlan).toHaveBeenCalledTimes(1)
})

test('uses saved query sets and creates template drafts only after explicit approval', async () => {
  const onCreateQueries = vi.fn(async (texts: readonly string[]) => [
    ...queries,
    ...texts.map((query, index) => ({ id: `new-${index}`, query })),
  ])
  const screen = setup({ projectName: 'synthetic-query-sets', onDiscover: vi.fn(async () => discovery(2)), onCreateQueries })

  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://locations.example/sitemap.xml' } })
  fireEvent.change(screen.getByLabelText('Primary host'), { target: { value: 'locations.example' } })
  fireEvent.change(screen.getByLabelText('Target path pattern'), { target: { value: '/places/{slug}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Import sitemap' }))
  await waitFor(() => screen.getByText('2 proposed Targets'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected Targets' }))
  fireEvent.click(screen.getByText('1 URL needs review'))
  fireEvent.click(screen.getByRole('button', { name: 'Mark all 1 URL review items complete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Queries' }))

  fireEvent.click(screen.getByRole('button', { name: 'Select all confirmed Targets' }))
  fireEvent.change(screen.getByLabelText('Query set name'), { target: { value: 'Local intent' } })
  fireEvent.click(screen.getByLabelText('best service near me'))
  fireEvent.click(screen.getByRole('button', { name: 'Save query set' }))
  fireEvent.click(screen.getByRole('button', { name: 'Apply Local intent' }))
  expect(screen.getByText('2 Targets use this set')).toBeTruthy()
  expect(screen.getByText(/This only changes the draft/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear selected query assignments' }))
  expect(screen.queryByText('2 Targets use this set')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Apply Local intent' }))

  fireEvent.change(screen.getByLabelText('Query set name'), { target: { value: 'No geo' } })
  fireEvent.click(screen.getByLabelText('trusted service reviews'))
  fireEvent.change(screen.getByLabelText('Query set location'), { target: { value: '__no_location__' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save query set' }))
  fireEvent.click(screen.getByRole('button', { name: 'Apply No geo' }))
  expect(screen.getAllByText('No location').length).toBeGreaterThan(0)

  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'North region' } })
  fireEvent.change(screen.getByLabelText('Competitor domains (optional)'), { target: { value: 'competitor.example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save reporting group' }))
  expect(screen.getByText('North region')).toBeTruthy()
  expect(screen.getByText('competitor.example')).toBeTruthy()

  fireEvent.change(screen.getByLabelText('Query template'), { target: { value: 'reviews for {target.label}' } })
  fireEvent.change(screen.getByLabelText('Template location'), { target: { value: 'North District' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview query drafts' }))
  expect(screen.getByText('reviews for Location 001')).toBeTruthy()
  expect(onCreateQueries).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Create 2 tracked queries' }))
  await waitFor(() => expect(onCreateQueries).toHaveBeenCalledWith([
    'reviews for Location 001',
    'reviews for Location 002',
  ]))
  expect(screen.getByText(/Groups organize reporting and competitors only/i)).toBeTruthy()
})

test('preserves inherited project location when an active revision becomes an editable draft', async () => {
  const onCompilePlan = vi.fn(async (input: Parameters<Props['onCompilePlan']>[0]) => ({
    ok: true as const,
    checks: [],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 1, target: 1 },
    estCostUsd: null,
    plan: input as never,
  }))
  const activePlan: NonNullable<Props['activePlan']> = {
    revision: 3,
    checksum: 'b'.repeat(64),
    createdAt: '2026-08-01T10:00:00.000Z',
    plan: {
      schemaVersion: 1,
      defaultContext: locations[0]!,
      effectiveOwnedHosts: ['locations.example'],
      projectCanonicalHost: 'locations.example',
      projectBrandNames: ['Example'],
      targets: [{ stableKey: 'location-001', label: 'Location 001', urls: [{ kind: 'prefix', host: 'locations.example', pathPrefix: '/places/location-001', pathCase: 'insensitive' }], aliases: ['Location 001'], mentionNotApplicable: false }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'location-001', queryIds: ['query-nearby'] }],
      querySnapshots: [{ queryId: 'query-nearby', queryText: 'best service near me' }],
      executionNodes: [{ stableKey: 'execution-1', queryText: 'best service near me', context: locations[0]!, expectedSnapshots: 1 }],
      usageEdges: [{ kind: 'target', executionNodeKey: 'execution-1', queryId: 'query-nearby', targetKey: 'location-001' }],
      warnings: [],
    },
  }
  const screen = setup({ projectName: 'synthetic-context-roundtrip', activePlan, onCompilePlan })

  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  expect(screen.getByText('Project default')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))

  await waitFor(() => expect(onCompilePlan).toHaveBeenCalledTimes(1))
  const selection = onCompilePlan.mock.calls[0]![0].targetQuerySelections?.[0]
  expect(selection && Object.hasOwn(selection, 'context')).toBe(false)
})

test('waits for the forced active-plan read before seeding or saving a draft', async () => {
  const revision7 = activePlanFixture(7, 'Cached label')
  const revision8 = activePlanFixture(8, 'Fresh label')
  const onCompilePlan = vi.fn(async (input: Parameters<Props['onCompilePlan']>[0]) => ({
    ok: true as const,
    checks: [],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 1, target: 1 },
    estCostUsd: null,
    plan: input as never,
  }))
  const screen = setup({
    projectName: 'synthetic-fresh-seed',
    activePlan: revision7,
    isPlanLoading: true,
    onCompilePlan,
  })

  expect(screen.getByLabelText('Loading measurement setup')).toBeTruthy()
  expect(window.localStorage.getItem('canonry:portfolio-draft:synthetic-fresh-seed')).toBeNull()

  screen.rerender(<PortfolioSection {...screen.props} activePlan={revision8} isPlanLoading={false} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review & publish' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))

  await waitFor(() => expect(onCompilePlan).toHaveBeenCalledTimes(1))
  expect(onCompilePlan.mock.calls[0]![0].targets[0]?.label).toBe('Fresh label')
  expect(window.localStorage.getItem('canonry:portfolio-draft:synthetic-fresh-seed')).toBeNull()
})

test('discards a completed plan check when the active revision changes in flight', async () => {
  type CompileResult = Awaited<ReturnType<Props['onCompilePlan']>>
  type DiffResult = Awaited<ReturnType<Props['onDiffPlan']>>
  let resolveCompile!: (value: CompileResult) => void
  let resolveDiff!: (value: DiffResult) => void
  const onCompilePlan = vi.fn(() => new Promise<CompileResult>(resolve => { resolveCompile = resolve }))
  const onDiffPlan = vi.fn(() => new Promise<DiffResult>(resolve => { resolveDiff = resolve }))
  const onPublishPlan = vi.fn(async () => ({ active: null }))
  const screen = setup({
    projectName: 'synthetic-stale-check',
    activePlan: activePlanFixture(7, 'Before change'),
    onCompilePlan,
    onDiffPlan,
    onPublishPlan,
  })

  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))
  expect(screen.getByRole('button', { name: 'Targets' })).toHaveProperty('disabled', true)

  screen.rerender(<PortfolioSection {...screen.props} activePlan={activePlanFixture(8, 'After change')} />)
  resolveCompile({
    ok: true,
    checks: [],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 1, target: 1 },
    estCostUsd: null,
    plan: {} as never,
  })
  resolveDiff({
    ok: true,
    checks: [],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 1, target: 1 },
    estCostUsd: null,
    plan: {} as never,
    diff: null,
  })

  await waitFor(() => expect(screen.getByText('Active revision 8')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  expect(screen.getByRole('button', { name: 'Check plan' })).toHaveProperty('disabled', false)
  expect(screen.queryByText('No blocking checks.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Publish plan' })).toHaveProperty('disabled', true)
  expect(onPublishPlan).not.toHaveBeenCalled()
})

test('binds publication to the reviewed candidate and active revision', async () => {
  const published = activePlanFixture(8, 'Location 001')
  const onPublishPlan = vi.fn(async () => ({ active: published }))
  const screen = setup({
    projectName: 'synthetic-publish-cas',
    activePlan: activePlanFixture(7, 'Location 001'),
    onPublishPlan,
  })

  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Publish plan' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Publish plan' }))

  await waitFor(() => expect(onPublishPlan).toHaveBeenCalledTimes(1))
  expect(onPublishPlan.mock.calls[0]![1]).toBe(7)
  expect(onPublishPlan.mock.calls[0]![0].targets[0]?.stableKey).toBe('location-001')
})

// A published plan is the saved state; the local draft that produced it is
// spent. Keeping it meant a reload resumed setup on a project that was already
// configured, which is the same "configured project looks unconfigured"
// failure the landing behaviour exists to prevent.
test('discards the local draft once the plan is published', async () => {
  const published = activePlanFixture(8, 'Location 001')
  const onPublishPlan = vi.fn(async () => ({ active: published }))
  const screen = setup({
    projectName: 'synthetic-publish-draft',
    activePlan: activePlanFixture(7, 'Location 001'),
    onPublishPlan,
  })

  // A published plan opens on its report, so setup has to be entered first.
  fireEvent.click(screen.getByRole('button', { name: 'Targets' }))
  // An edit is what makes the draft local and therefore persisted; a draft
  // merely seeded from the active plan is deliberately never written.
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected Targets' }))
  await waitFor(() => {
    expect(window.localStorage.getItem('canonry:portfolio-draft:synthetic-publish-draft')).not.toBeNull()
  })

  fireEvent.click(screen.getByRole('button', { name: 'Review & publish' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Publish plan' })).toHaveProperty('disabled', false))

  fireEvent.click(screen.getByRole('button', { name: 'Publish plan' }))

  await waitFor(() => expect(onPublishPlan).toHaveBeenCalledTimes(1))
  await waitFor(() => {
    expect(window.localStorage.getItem('canonry:portfolio-draft:synthetic-publish-draft')).toBeNull()
  })
})

test('names portfolio-scale setup blockers and requires explicit bulk resolution', async () => {
  const onCompilePlan = vi.fn(async (input: Parameters<Props['onCompilePlan']>[0]) => ({
    ok: true as const,
    checks: [],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 1, target: 1 },
    estCostUsd: null,
    plan: input as never,
  }))
  const screen = setup({ projectName: 'synthetic-bulk-resolution', onCompilePlan })

  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://locations.example/sitemap.xml' } })
  fireEvent.change(screen.getByLabelText('Primary host'), { target: { value: 'locations.example' } })
  fireEvent.change(screen.getByLabelText('Target path pattern'), { target: { value: '/places/{slug}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Import sitemap' }))
  await waitFor(() => screen.getByText('213 proposed Targets'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Targets' }))
  fireEvent.change(screen.getByLabelText('Search Targets'), { target: { value: 'Location 001' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select all confirmed Targets' }))
  fireEvent.change(screen.getByLabelText('Query set name'), { target: { value: 'Core intent' } })
  fireEvent.click(screen.getByLabelText('best service near me'))
  fireEvent.click(screen.getByRole('button', { name: 'Save query set' }))
  fireEvent.click(screen.getByRole('button', { name: 'Apply Core intent' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Review & publish' }))

  expect(screen.getByText('212 Targets still need confirmation or rejection.')).toBeTruthy()
  expect(screen.getByText('1 URL still needs review.')).toBeTruthy()
  expect(onCompilePlan).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Return to Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reject remaining proposed Targets (212)' }))
  fireEvent.click(screen.getByText('1 URL needs review'))
  fireEvent.click(screen.getByRole('button', { name: 'Mark all 1 URL review items complete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Review & publish' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))

  await waitFor(() => expect(onCompilePlan).toHaveBeenCalledTimes(1))
  expect(onCompilePlan.mock.calls[0]![0].targets).toHaveLength(1)
  expect(onCompilePlan.mock.calls[0]![0].targetQuerySelections?.[0]?.queryIds).toEqual(['query-nearby'])
})

test('names a failed check and blocks publication', async () => {
  const onPublishPlan = vi.fn(async () => ({ active: null }))
  const onCompilePlan = vi.fn(async () => ({
    ok: true,
    checks: [{
      id: 'target-url-ownership-tie' as const,
      severity: 'fail' as const,
      message: 'Two Targets claim the same URL.',
      path: ['targets'],
    }],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 2, target: 0 },
    estCostUsd: null,
    plan: {} as never,
  }))
  const onDiffPlan = vi.fn(async () => ({
    ok: true,
    checks: [],
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 2, target: 0 },
    estCostUsd: null,
    plan: {} as never,
    warnings: [],
    counts: { targets: 1, groups: 0, queries: 2, executionNodes: 0, usageEdges: 0, baselineEdges: 2, targetEdges: 0, dedupSavings: 0 },
    diff: {
      activeRevision: null,
      targets: { added: [{} as never], removed: [], changed: [], unchanged: [] },
      groups: { added: [], removed: [], changed: [], unchanged: [] },
      querySelections: { added: [], removed: [], changed: [], unchanged: [] },
      execution: { addedNodeKeys: [], removedNodeKeys: [], addedUsageEdges: [], removedUsageEdges: [], counts: { before: null, after: { targets: 1, groups: 0, queries: 2, executionNodes: 0, usageEdges: 0, baselineEdges: 2, targetEdges: 0, dedupSavings: 0 }, delta: null } },
    },
  } as Awaited<ReturnType<Props['onDiffPlan']>>))
  const screen = setup({ projectName: 'synthetic-checks', onDiscover: vi.fn(async () => discovery(1)), onCompilePlan, onDiffPlan, onPublishPlan })

  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://locations.example/sitemap.xml' } })
  fireEvent.change(screen.getByLabelText('Primary host'), { target: { value: 'locations.example' } })
  fireEvent.change(screen.getByLabelText('Target path pattern'), { target: { value: '/places/{slug}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Import sitemap' }))
  await waitFor(() => screen.getByText('1 proposed Target'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select all matching Targets' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm selected Targets' }))
  fireEvent.click(screen.getByText('1 URL needs review'))
  fireEvent.click(screen.getByRole('button', { name: 'Mark all 1 URL review items complete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Queries' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Review & publish' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check plan' }))

  await waitFor(() => expect(screen.getByText('Target URL conflict')).toBeTruthy())
  expect(screen.getByText('Two Targets claim the same URL.')).toBeTruthy()
  expect(screen.getByText('Estimated cost is unavailable')).toBeTruthy()
  expect(screen.getByText('Compared with a new setup')).toBeTruthy()
  expect(within(screen.getByLabelText('Plan change summary')).getByRole('row', { name: /Targets/ }).textContent).toContain('+1−0~0')
  expect(screen.getByRole('button', { name: 'Publish plan' })).toHaveProperty('disabled', true)
  expect(onPublishPlan).not.toHaveBeenCalled()
})

test('shows live target evidence honestly for incomplete, aliasless, sibling, and ambiguous states', () => {
  const report: NonNullable<Props['report']> = {
    revision: 7,
    run: { id: 'run-7', status: 'partial', createdAt: '2026-08-01T12:00:00.000Z', startedAt: null, finishedAt: null },
    groups: [{
      id: 'north-region',
      label: 'North region',
      targetIds: ['location-001'],
      completeness: { executed: 1, expected: 2, complete: false, sourceComplete: false, answerComplete: true },
      answerCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' },
      targetCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' },
      sov: {
        domains: [{ domain: 'competitor.example', own: false, presentIn: null, of: null, reason: 'incomplete' }],
        providers: [],
      },
      providers: [],
    }],
    targets: [{
      id: 'location-001',
      label: 'Location 001',
      completeness: { executed: 1, expected: 2, complete: false, sourceComplete: false, answerComplete: true },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1, reason: 'incomplete' },
      mentionCoverage: { numerator: null, denominator: null, rate: null, reason: 'aliasless' },
      providers: [],
    }],
    evidence: [
      { observationId: 'obs-sibling', expectedSlotId: 'slot-1', executionId: 'exec-1', usageEdgeId: 'use-1', usageEdgeType: 'target', provider: 'openai', queryText: 'best service near me', location: null, sourceUrl: 'https://locations.example/places/location-002', bridged: false, historical: false, evidenceComplete: true, classification: 'sibling', normalizedUrl: 'https://locations.example/places/location-002', matchedTargetIds: ['location-002'], matchedUrlIds: ['url-2'] },
      { observationId: 'obs-ambiguous', expectedSlotId: 'slot-1', executionId: 'exec-1', usageEdgeId: 'use-1', usageEdgeType: 'target', provider: 'openai', queryText: 'best service near me', location: null, sourceUrl: 'https://locations.example/shared', bridged: false, historical: false, evidenceComplete: true, classification: 'ambiguous', normalizedUrl: 'https://locations.example/shared', matchedTargetIds: ['location-001', 'location-002'], matchedUrlIds: ['url-1', 'url-2'] },
    ],
    diagnostics: { bridgedObservationIds: [], historicalObservationIds: [], evidenceIncompleteObservationIds: [], ambiguousObservationIds: ['obs-ambiguous'], unmatchedObservationIds: [] },
  }
  const screen = setup({ projectName: 'synthetic-report', report, activePlan: {
    revision: 7,
    checksum: 'a'.repeat(64),
    createdAt: '2026-08-01T11:00:00.000Z',
    plan: {
      schemaVersion: 1,
      defaultContext: null,
      effectiveOwnedHosts: ['locations.example'],
      projectCanonicalHost: 'locations.example',
      projectBrandNames: ['Example'],
      targets: [{ stableKey: 'location-001', label: 'Location 001', urls: [{ kind: 'prefix', host: 'locations.example', pathPrefix: '/places/location-001', pathCase: 'insensitive' }], aliases: [], mentionNotApplicable: true }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'location-001', queryIds: ['query-nearby'], context: null }],
      querySnapshots: [{ queryId: 'query-nearby', queryText: 'best service near me' }],
      executionNodes: [{ stableKey: 'execution-1', queryText: 'best service near me', context: null, expectedSnapshots: 2 }],
      usageEdges: [{ kind: 'target', executionNodeKey: 'execution-1', queryId: 'query-nearby', targetKey: 'location-001' }],
      warnings: [],
    },
  } })

  fireEvent.click(screen.getByRole('button', { name: 'Report' }))
  const row = screen.getByRole('row', { name: /Location 001/i })
  expect(within(row).getAllByText('Incomplete: 1/2')).toHaveLength(3)
  expect(within(row).queryByText(/100%/)).toBeNull()
  expect(screen.getByText('Sibling')).toBeTruthy()
  expect(screen.getByText('Ambiguous')).toBeTruthy()
  expect(screen.getByText('North region')).toBeTruthy()
  expect(screen.getByText('competitor.example N/A')).toBeTruthy()
  expect(screen.getByText(/Ambiguous evidence is not credited to a Target/i)).toBeTruthy()
})

test('distinguishes an unpublished result from a plan with no tracked queries', () => {
  const report: NonNullable<Props['report']> = {
    revision: 7,
    run: null,
    groups: [{
      id: 'north-region',
      label: 'North region',
      targetIds: ['location-001'],
      completeness: { executed: 0, expected: 0, complete: true, sourceComplete: true, answerComplete: true },
      answerCoverage: { numerator: 0, denominator: 0, rate: null, reason: 'no-population' },
      targetCoverage: { numerator: 0, denominator: 0, rate: null, reason: 'no-population' },
      sov: { domains: [], providers: [] },
      providers: [],
    }],
    targets: [{
      id: 'location-001',
      label: 'Location 001',
      completeness: { executed: 0, expected: 0, complete: true, sourceComplete: true, answerComplete: true },
      citationCoverage: { numerator: 0, denominator: 0, rate: null, reason: 'no-population' },
      mentionCoverage: { numerator: 0, denominator: 0, rate: null, reason: 'no-population' },
      providers: [],
    }],
    evidence: [],
    diagnostics: { bridgedObservationIds: [], historicalObservationIds: [], evidenceIncompleteObservationIds: [], ambiguousObservationIds: [], unmatchedObservationIds: [] },
  }
  const screen = setup({ report, activePlan: activePlanFixture(7) })

  fireEvent.click(screen.getByRole('button', { name: 'Report' }))

  expect(screen.getAllByText('No stored result').length).toBeGreaterThan(1)
  expect(screen.getAllByText('Not measured').length).toBeGreaterThan(1)
  expect(screen.queryByText('No tracked queries')).toBeNull()
})
