import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { AdvancedMeasurementSection } from '../src/components/project/advanced-measurement/AdvancedMeasurementSection.js'
import { serializePortfolioDraft, type PortfolioSetupDraft } from '../src/components/project/portfolio-setup-model.js'

type Props = ComponentProps<typeof AdvancedMeasurementSection>

const projectName = 'synthetic-advanced-measurement'
const storageKey = `canonry:advanced-measurement:compatibility-draft:v1:${projectName}`
const legacyStorageKey = `canonry:portfolio-draft:${projectName}`
const locations = [{ label: 'Downtown', city: 'Harbor City', region: 'NY', country: 'US' }]
const queries = [
  { id: 'q-nearby', query: 'best venue near me' },
  { id: 'q-events', query: 'private event venue' },
]

function discovery() {
  return {
    proposed: [{
      classification: 'proposed' as const,
      reason: 'primary-match' as const,
      stableKey: 'harbor-house',
      slug: 'harbor-house',
      label: 'Harbor House',
      primaryUrl: 'https://example.com/venues/harbor-house',
      aliasCoverageUrls: [],
    }],
    aliases: [],
    shared: [],
    unmatched: [],
    excluded: [],
    diagnostics: [],
  }
}

function activePlan(revision = 3): NonNullable<Props['activePlan']> {
  return {
    revision,
    checksum: `checksum-${revision}`,
    createdAt: '2026-08-02T12:00:00.000Z',
    plan: {
      schemaVersion: 1,
      defaultContext: locations[0]!,
      effectiveOwnedHosts: ['example.com'],
      projectCanonicalHost: 'example.com',
      projectBrandNames: ['Example'],
      targets: [{
        stableKey: 'harbor-house',
        label: 'Harbor House',
        aliases: ['Harbor House'],
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/venues/harbor-house', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'harbor-house', queryIds: ['q-nearby'] }],
      querySnapshots: [{ queryId: 'q-nearby', queryText: 'best venue near me' }],
      executionNodes: [{ stableKey: 'execution-1', queryText: 'best venue near me', context: locations[0]!, expectedSnapshots: 1 }],
      usageEdges: [{ kind: 'target', executionNodeKey: 'execution-1', queryId: 'q-nearby', targetKey: 'harbor-house' }],
      warnings: [],
    },
  }
}

function legacyDraft(overrides: Partial<PortfolioSetupDraft> = {}): PortfolioSetupDraft {
  return {
    schemaVersion: 1,
    targets: [{
      stableKey: 'harbor-house',
      label: 'Harbor House',
      status: 'confirmed',
      urls: [{ kind: 'exact', url: 'https://example.com/venues/harbor-house', pathCase: 'insensitive' }],
      aliases: ['Harbor House'],
    }],
    exceptions: [],
    coverageReviews: [],
    querySets: [],
    queryTemplates: [],
    assignments: [],
    groups: [],
    ...overrides,
  }
}

function compilePreview(checks: Array<{ severity: 'fail' | 'warn'; message: string }> = []) {
  return {
    ok: true as const,
    checks: checks.map((check, index) => ({
      id: 'invalid-authoring' as const,
      severity: check.severity,
      message: check.message,
      path: [index],
    })),
    executionNodes: [],
    dedupSaved: 0,
    usageEdges: { baseline: 0, target: 0 },
    estCostUsd: null,
    plan: {} as never,
  }
}

function diffPreview(checks: Array<{ severity: 'fail' | 'warn'; message: string }> = []) {
  return {
    ...compilePreview(checks),
    diff: null,
  }
}

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    projectName,
    queries,
    isQueryLoading: false,
    isQueryError: false,
    activePlan: null,
    isPlanLoading: false,
    isPlanError: false,
    onDiscover: vi.fn(async () => discovery()),
    onCompilePlan: vi.fn(async () => compilePreview()),
    onDiffPlan: vi.fn(async () => diffPreview()),
    onPublishPlan: vi.fn(async () => ({ active: activePlan(4) })),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementSection {...props} />), props }
}

async function importAndConfirm() {
  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://example.com/sitemap.xml' } })
  fireEvent.change(screen.getByLabelText('Use URLs from this domain'), { target: { value: 'example.com' } })
  fireEvent.change(screen.getByLabelText('Property URL pattern'), { target: { value: '/venues/*' } })
  fireEvent.change(screen.getByLabelText('Additional URL domain'), { target: { value: 'venues.example.com' } })
  fireEvent.change(screen.getByLabelText('Additional URL pattern'), { target: { value: '/*' } })
  fireEvent.change(screen.getByLabelText('Ignore these URL paths'), { target: { value: '/venues/archive, retired' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review sitemap' }))
  await screen.findByRole('heading', { name: 'Properties' })

  fireEvent.click(screen.getByLabelText('Select Harbor House'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Queries' })
}

async function navigateToReview() {
  await importAndConfirm()
  fireEvent.click(screen.getByLabelText('Select query best venue near me'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))
  await waitFor(() => expect(within(screen.getByText('best venue near me').closest('tr')!).getByText('Harbor House')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Groups' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
  await screen.findByRole('heading', { name: 'Review & publish' })
}

function expectNoImplementationLanguage(container: HTMLElement) {
  const rendered = container.textContent?.toLocaleLowerCase() ?? ''
  for (const term of ['target', 'edge', 'node', 'manifest', 'revision', 'checksum', 'stablekey']) {
    expect(rendered).not.toContain(term)
  }
}

beforeEach(() => {
  const values = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size },
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
    },
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('AdvancedMeasurementSection compatibility controller', () => {
  test('uses the current discovery and plan APIs through Import, Properties, Queries, Groups, and Review only', async () => {
    const onPublished = vi.fn()
    const { container, props } = setup({ onPublished })

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Import',
      'Properties',
      'Queries',
      'Groups (optional)',
      'Review and publish',
    ])
    expect(container.textContent).not.toContain('Results')
    expectNoImplementationLanguage(container)

    await importAndConfirm()

    expect(props.onDiscover).toHaveBeenCalledWith({
      sitemapUrl: 'https://example.com/sitemap.xml',
      rule: {
        primary: { host: 'example.com', pathTemplate: '/venues/{slug}' },
        aliases: [{ host: 'venues.example.com', pathTemplate: '/{slug}' }],
        excludedSlugPatterns: [
          { kind: 'exact', value: 'archive' },
          { kind: 'exact', value: 'retired' },
        ],
      },
    })

    fireEvent.click(screen.getByLabelText('Select query best venue near me'))
    fireEvent.click(screen.getByLabelText('Select query private event venue'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))

    await waitFor(() => {
      expect(within(screen.getByText('best venue near me').closest('tr')!).getByText('Harbor House')).toBeTruthy()
      expect(within(screen.getByText('private event venue').closest('tr')!).getByText('Harbor House')).toBeTruthy()
    })
    expect(screen.queryByText('Assignment class')).toBeNull()
    expect(screen.queryByText('Needs classification')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear assignments for best venue near me' }))
    await waitFor(() => {
      expect(within(screen.getByText('best venue near me').closest('tr')!).getByText('Not applied')).toBeTruthy()
      expect(within(screen.getByText('private event venue').closest('tr')!).getByText('Harbor House')).toBeTruthy()
    })

    fireEvent.click(screen.getByLabelText('Select query best venue near me'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Harbor venues' } })
    fireEvent.click(screen.getByLabelText('Select Harbor House'))
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.getByText('Harbor venues')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Review & publish' })

    expect(screen.queryByRole('button', { name: 'Publish setup' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await waitFor(() => {
      expect(props.onCompilePlan).toHaveBeenCalledTimes(1)
      expect(props.onDiffPlan).toHaveBeenCalledTimes(1)
    })
    expect(props.onPublishPlan).not.toHaveBeenCalled()
    expect(screen.getByText('Setup checked')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))
    await waitFor(() => {
      expect(props.onPublishPlan).toHaveBeenCalledWith(expect.any(Object), null)
    })
    expect(window.localStorage.getItem(storageKey)).toBeNull()
    expect(onPublished).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Unpublished changes')).toBeNull()
    expect(screen.getByText('Advanced measurement setup published.')).toBeTruthy()
    expect(container.textContent).not.toContain('Results')
    expectNoImplementationLanguage(container)
  })

  test('blocks publish when local validation or current compile checks fail', async () => {
    const onCompilePlan = vi.fn(async () => compilePreview([{ severity: 'fail', message: 'A target is not valid for this project.' }]))
    const onDiffPlan = vi.fn(async () => diffPreview())
    const onPublishPlan = vi.fn(async () => ({ active: activePlan(4) }))
    setup({ onCompilePlan, onDiffPlan, onPublishPlan })

    await navigateToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    await waitFor(() => {
      expect(onCompilePlan).toHaveBeenCalledTimes(1)
      expect(onDiffPlan).toHaveBeenCalledTimes(1)
    })
    expect(onPublishPlan).not.toHaveBeenCalled()
    expect(screen.getByText('A Property is not valid for this project.')).toBeTruthy()
    expect(screen.queryByText('A target is not valid for this project.')).toBeNull()
  })

  test('requires a complete additional URL rule before sitemap discovery', async () => {
    const { props } = setup()

    fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://example.com/sitemap.xml' } })
    fireEvent.change(screen.getByLabelText('Additional URL domain'), { target: { value: 'venues.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review sitemap' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Add both a valid Additional URL domain and Additional URL pattern.'))
    expect(props.onDiscover).not.toHaveBeenCalled()
  })

  test('labels browser-only compatibility drafts truthfully and discards them without touching the active setup', async () => {
    setup()

    fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://example.com/sitemap.xml' } })
    await waitFor(() => expect(screen.getByText('Unpublished changes')).toBeTruthy())
    expect(window.localStorage.getItem(storageKey)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))
    await waitFor(() => expect(screen.queryByText('Unpublished changes')).toBeNull())
    expect((screen.getByLabelText('Sitemap URL') as HTMLInputElement).value).toBe('')
    expect(window.localStorage.getItem(storageKey)).toBeNull()
  })

  test('blocks review when the published setup changes after a local edit begins', async () => {
    const active = activePlan(3)
    const view = setup({ activePlan: active })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    await waitFor(() => expect(window.localStorage.getItem(storageKey)).not.toBeNull())

    view.rerender(<AdvancedMeasurementSection {...view.props} activePlan={activePlan(4)} />)
    expect((await screen.findByRole('alert')).textContent).toContain('The published setup changed in another session.')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
    await screen.findByRole('heading', { name: 'Review & publish' })
    expect(screen.getByRole('button', { name: 'Review changes' })).toHaveProperty('disabled', true)
    expect(view.props.onCompilePlan).not.toHaveBeenCalled()
    expect(view.props.onPublishPlan).not.toHaveBeenCalled()
  })

  test('seeds editing from an active plan without mislabeling it as an unpublished draft, and keeps it read-only for viewers', async () => {
    const active = activePlan()
    const editor = setup({ activePlan: active })

    await screen.findByRole('heading', { name: 'Properties' })
    expect(screen.getByText('Harbor House')).toBeTruthy()
    expect(screen.queryByText('Unpublished changes')).toBeNull()
    editor.unmount()

    const viewer = setup({ activePlan: active, canEdit: false })
    await screen.findByRole('heading', { name: 'Properties' })
    expect(screen.getByText('Viewing only. Property changes are unavailable.')).toBeTruthy()
    expect(viewer.container.querySelectorAll('button')).toHaveLength(0)
    expect(viewer.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  test('keeps plan loading and load failure distinct, with the supplied retry only on failure', () => {
    const loading = setup({ isPlanLoading: true })
    expect(screen.getByLabelText('Loading advanced measurement setup')).toBeTruthy()
    loading.unmount()

    const onRetryPlan = vi.fn()
    setup({ isPlanError: true, onRetryPlan })
    expect(screen.getByRole('alert').textContent).toContain('Could not load the active measurement setup.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetryPlan).toHaveBeenCalledTimes(1)
  })

  test('migrates an existing Portfolio draft before opening the new setup', async () => {
    window.localStorage.setItem(legacyStorageKey, serializePortfolioDraft(legacyDraft()))

    setup()

    await screen.findByRole('heading', { name: 'Properties' })
    expect(screen.getByText('Harbor House')).toBeTruthy()
    expect(screen.getByText('Unpublished changes')).toBeTruthy()
    expect(window.localStorage.getItem(legacyStorageKey)).toBeNull()
    expect(window.localStorage.getItem(storageKey)).not.toBeNull()
  })

  test('keeps a legacy Portfolio draft usable when this browser cannot save its migration', async () => {
    window.localStorage.setItem(legacyStorageKey, serializePortfolioDraft(legacyDraft()))
    const save = window.localStorage.setItem
    window.localStorage.setItem = () => { throw new Error('storage unavailable') }

    try {
      setup()

      await screen.findByRole('heading', { name: 'Properties' })
      expect(screen.getByText('Harbor House')).toBeTruthy()
      await screen.findByText('Unpublished changes are only available on this page. This browser cannot save them.')
      expect(window.localStorage.getItem(legacyStorageKey)).not.toBeNull()
    } finally {
      window.localStorage.setItem = save
    }
  })

  test('resolves every sitemap exception and coverage review before publishing', async () => {
    const oldUrl = { kind: 'exact' as const, url: 'https://example.com/venues/harbor-house', pathCase: 'insensitive' as const }
    const importedUrl = { kind: 'exact' as const, url: 'https://example.com/venues/harbor-house-updated', pathCase: 'insensitive' as const }
    window.localStorage.setItem(legacyStorageKey, serializePortfolioDraft(legacyDraft({
      exceptions: [{
        key: 'unmatched\u0000outside-project\u0000https://outside.example/listing',
        bucket: 'unmatched',
        url: 'https://outside.example/listing',
        canonicalUrl: 'https://outside.example/listing',
        reason: 'outside-project',
        status: 'unreviewed',
      }],
      coverageReviews: [{
        targetKey: 'harbor-house',
        existingUrls: [oldUrl],
        importedUrls: [importedUrl],
        previousStatus: 'confirmed',
        resolution: 'pending',
      }],
      assignments: [{ targetKey: 'harbor-house', queryId: 'q-nearby', context: undefined }],
    })))
    const { props } = setup()

    await screen.findByRole('heading', { name: 'Properties' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
    await screen.findByRole('heading', { name: 'Review & publish' })

    expect(screen.getByText('Sitemap changes need review')).toBeTruthy()
    expect(screen.getByText('1 sitemap entry needs review.')).toBeTruthy()
    expect(screen.getByText('1 Property has URL coverage changes.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review changes' })).toHaveProperty('disabled', true)
    expect(screen.getByText('https://outside.example/listing')).toBeTruthy()
    expect(screen.getByText('This choice applies to all 1 changed Property.')).toBeTruthy()
    expect(screen.getByText(oldUrl.url)).toBeTruthy()
    expect(screen.getByText(importedUrl.url)).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Use current sitemap URLs'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sitemap changes' }))

    await waitFor(() => expect(screen.queryByText('Sitemap changes need review')).toBeNull())
    expect(screen.getByRole('button', { name: 'Review changes' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))
    await waitFor(() => expect(props.onPublishPlan).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ urls: [importedUrl] })],
    }), null))
  })

  test('turns every reviewed Property into an explicit include or exclusion', async () => {
    const onDiscover = vi.fn(async () => ({
      ...discovery(),
      proposed: [
        ...discovery().proposed,
        {
          classification: 'proposed' as const,
          reason: 'primary-match' as const,
          stableKey: 'garden-room',
          slug: 'garden-room',
          label: 'Garden Room',
          primaryUrl: 'https://example.com/venues/garden-room',
          aliasCoverageUrls: [],
        },
      ],
    }))
    setup({ onDiscover })

    await importAndConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(within(screen.getByText('Harbor House').closest('tr')!).getByText('Included')).toBeTruthy()
    expect(within(screen.getByText('Garden Room').closest('tr')!).getByText('Excluded')).toBeTruthy()
    expect(screen.queryByText(/confirm or reject/i)).toBeNull()
  })

  test('removes assignments and group membership when a Property is excluded', async () => {
    const active = activePlan()
    active.plan.targets.push({
      stableKey: 'garden-room',
      label: 'Garden Room',
      aliases: ['Garden Room'],
      urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/venues/garden-room', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
    })
    active.plan.targetQuerySelections = [
      { targetKey: 'harbor-house', queryIds: ['q-events'] },
      { targetKey: 'garden-room', queryIds: ['q-nearby'] },
    ]
    active.plan.querySnapshots.push({ queryId: 'q-events', queryText: 'private event venue' })
    active.plan.groups = [{
      stableKey: 'harbor-area',
      label: 'Harbor area',
      targetKeys: ['harbor-house', 'garden-room'],
      competitors: [],
    }]
    const onPublishPlan = vi.fn(async () => ({ active: activePlan(4) }))
    setup({ activePlan: active, onPublishPlan })

    fireEvent.click(screen.getByLabelText('Select Harbor House'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })

    expect(within(screen.getByText('private event venue').closest('tr')!).getByText('Not applied')).toBeTruthy()
    expect(within(screen.getByText('best venue near me').closest('tr')!).getByText('Garden Room')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Harbor area' }))
    expect(screen.queryByLabelText('Select Harbor House')).toBeNull()
    expect((screen.getByLabelText('Select Garden Room') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clear form' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

    await waitFor(() => expect(onPublishPlan).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ stableKey: 'garden-room' })],
      targetQuerySelections: [{ targetKey: 'garden-room', queryIds: ['q-nearby'] }],
      groups: [expect.objectContaining({ stableKey: 'harbor-area', targetKeys: ['garden-room'] })],
    }), 3))
  })

  test('requires at least one Property query assignment before continuing', async () => {
    setup()

    await importAndConfirm()

    expect(screen.getByText('Apply at least one query to a Property before continuing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  test('preserves an existing assignment location when the same query is applied again', async () => {
    const active = activePlan()
    active.plan.targetQuerySelections = [{ targetKey: 'harbor-house', queryIds: ['q-nearby'], context: locations[0]! }]
    const onPublishPlan = vi.fn(async () => ({ active: activePlan(4) }))
    setup({ activePlan: active, onPublishPlan })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByLabelText('Select query best venue near me'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

    await waitFor(() => expect(onPublishPlan).toHaveBeenCalledWith(expect.objectContaining({
      targetQuerySelections: [{ targetKey: 'harbor-house', queryIds: ['q-nearby'], context: locations[0] }],
    }), 3))
  })

  test('shows and clears an assignment whose tracked query was deleted', async () => {
    const active = activePlan()
    active.plan.targetQuerySelections = [{ targetKey: 'harbor-house', queryIds: ['q-deleted'] }]
    setup({ activePlan: active, queries: [] })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    expect(screen.getAllByText('Unavailable tracked query').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Clear assignments for Unavailable tracked query' }))

    expect(screen.getByText('Apply at least one query to a Property before continuing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  test('edits a saved group without changing its published identity', async () => {
    const active = activePlan()
    active.plan.groups = [{
      stableKey: 'harbor-area',
      label: 'Harbor area',
      targetKeys: ['harbor-house'],
      competitors: ['rival.example'],
    }]
    const onPublishPlan = vi.fn(async () => ({ active: activePlan(4) }))
    setup({ activePlan: active, onPublishPlan })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Harbor area' }))
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Waterfront area' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.getByText('Waterfront area')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

    await waitFor(() => expect(onPublishPlan).toHaveBeenCalledWith(expect.objectContaining({
      groups: [expect.objectContaining({ stableKey: 'harbor-area', label: 'Waterfront area' })],
    }), 3))
  })

  test('refuses a new group name that would overwrite an existing group identity', async () => {
    const active = activePlan()
    active.plan.groups = [{
      stableKey: 'group-metro-offices',
      label: 'Metro Offices',
      targetKeys: ['harbor-house'],
      competitors: [],
    }]
    setup({ activePlan: active })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Metro_Offices' } })
    fireEvent.click(screen.getByText('0 of 1 Properties selected'))
    fireEvent.click(screen.getByLabelText('Select Harbor House'))
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))

    expect((await screen.findByRole('alert')).textContent).toContain('A group named "Metro Offices" already exists. Edit it or choose a different name.')
    expect(screen.getAllByText('Metro Offices')).toHaveLength(1)
  })

  test('preserves the saved group identity when an edit resumes after reload', async () => {
    const active = activePlan()
    active.plan.groups = [{
      stableKey: 'harbor-area',
      label: 'Harbor area',
      targetKeys: ['harbor-house'],
      competitors: ['rival.example'],
    }]
    const onPublishPlan = vi.fn(async () => ({ active: activePlan(4) }))
    const first = setup({ activePlan: active, onPublishPlan })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Harbor area' }))
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Waterfront area' } })
    await waitFor(() => expect(window.localStorage.getItem(storageKey)).not.toBeNull())
    first.unmount()

    setup({ activePlan: active, onPublishPlan })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    expect((screen.getByLabelText('Group name') as HTMLInputElement).value).toBe('Waterfront area')
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(screen.getByText('Waterfront area')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

    await waitFor(() => expect(onPublishPlan).toHaveBeenCalledWith(expect.objectContaining({
      groups: [expect.objectContaining({ stableKey: 'harbor-area', label: 'Waterfront area' })],
    }), 3))
  })
})
