import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  DraftMutationResponse,
  MeasurementDraftAuthoring,
  MeasurementDraftCompilePreviewResponse,
  MeasurementDraftDiffPreviewResponse,
  MeasurementDraftResponse,
  MeasurementPlanV2PublishResponse,
  MeasurementSetupResponse,
} from '@ainyc/canonry-contracts'
import type { QueryDto } from '@ainyc/canonry-api-client'

import { ApiError } from '../src/api.js'
import { AdvancedMeasurementSection } from '../src/components/project/advanced-measurement/AdvancedMeasurementSection.js'
import {
  setupErrorMessage,
  type AdvancedMeasurementService,
  type SitemapImportInput,
  type SitemapSelectionInput,
} from '../src/components/project/advanced-measurement/service.js'

const PROJECT = 'synthetic-portfolio'
const NOW = '2026-08-02T12:00:00.000Z'
const COMPILED_CHECKSUM = 'a'.repeat(64)
const DOCUMENT_CHECKSUM = 'b'.repeat(64)
const QUERIES: QueryDto[] = [
  { id: 'q-nearby', query: 'event venues nearby', createdAt: NOW },
  { id: 'q-private', query: 'private event spaces', createdAt: NOW },
]

type Draft = NonNullable<MeasurementDraftResponse['draft']>
type DraftTarget = MeasurementDraftAuthoring['targets'][number]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function property(index: number, status: DraftTarget['status'] = 'included'): DraftTarget {
  const suffix = String(index).padStart(3, '0')
  const url = `https://portfolio.example/properties/property-${suffix}`
  return {
    stableKey: `property-${suffix}`,
    label: `Property ${suffix}`,
    status,
    aliases: [`Property ${suffix}`],
    urlMatchers: [url],
    source: 'sitemap',
    discoveredUrl: url,
    discoveryIdentity: `portfolio.example/properties/{slug}#property-${suffix}`,
  }
}

function draftFixture(input: {
  targets?: DraftTarget[]
  assignedQueryIds?: string[]
  baseActiveRevision?: number | null
} = {}): Draft {
  const targets = input.targets ?? []
  const assignedQueryIds = input.assignedQueryIds ?? []
  const baseActiveRevision = input.baseActiveRevision ?? null
  return {
    id: 'draft-synthetic',
    projectId: 'project-synthetic',
    schemaVersion: 2,
    baseActiveVersionId: baseActiveRevision === null ? null : `version-${baseActiveRevision}`,
    baseActiveRevision,
    authoring: {
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets,
      assignments: targets.flatMap(target => assignedQueryIds.map(queryId => ({
        targetKey: target.stableKey,
        queryId,
        queryClass: 'non-brand' as const,
        classificationSource: 'rule' as const,
      }))),
      groups: [],
    },
    createdBy: { kind: 'user', id: 'user-editor', label: 'Editor' },
    updatedBy: { kind: 'user', id: 'user-editor', label: 'Editor' },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function setupFixture(draft: Draft | null): MeasurementSetupResponse {
  if (!draft) {
    return {
      state: 'simple',
      nextAction: 'start_setup',
      mode: 'simple',
      activeRevision: null,
      activeSchemaVersion: null,
      draft: null,
    }
  }
  const active = draft.baseActiveRevision
  return {
    state: 'setup_in_progress',
    nextAction: 'continue_setup',
    mode: active === null ? 'draft-only' : 'active-v2',
    activeRevision: active,
    activeSchemaVersion: active === null ? null : 2,
    draft: { etag: '"mpd_7"', updatedAt: NOW },
  }
}

function compiledPlan(checksum: string) {
  return {
    schemaVersion: 2 as const,
    identities: {
      projectBrand: {
        canonicalHost: 'portfolio.example',
        ownedHosts: ['portfolio.example'],
        names: ['Example Portfolio'],
      },
    },
    targets: [],
    groups: [],
    querySnapshots: [],
    assignments: [],
    executionNodes: [],
    usageEdges: [],
    compiledChecksum: checksum,
  }
}

interface FakeServiceOptions {
  initialDraft?: Draft | null
  importedTargets?: DraftTarget[]
  importError?: Error
  assignmentConflictStatus?: 409 | 412
  discardConflictStatus?: 404
  diffActiveRevision?: number | null
  latestBaseActiveRevision?: number | null
  etagVersion?: number
}

function createFakeService(options: FakeServiceOptions = {}) {
  let currentDraft = options.initialDraft === undefined ? null : clone(options.initialDraft)
  let currentSetup = setupFixture(currentDraft)
  let etagVersion = options.etagVersion ?? (currentDraft ? 7 : 0)
  let assignmentConflictStatus = options.assignmentConflictStatus
  let movedDraftDuringDiff = false

  const currentEtag = () => currentDraft ? `"mpd_${etagVersion}"` : null
  const draftResponse = (): MeasurementDraftResponse => ({
    draft: currentDraft ? clone(currentDraft) : null,
    etag: currentEtag(),
  })
  const setupResponse = (): MeasurementSetupResponse => ({
    ...clone(currentSetup),
    draft: currentDraft ? { etag: currentEtag()!, updatedAt: currentDraft.updatedAt } : null,
  })
  const counts = () => ({
    targets: currentDraft?.authoring.targets.length ?? 0,
    includedTargets: currentDraft?.authoring.targets.filter(target => target.status === 'included').length ?? 0,
    assignments: currentDraft?.authoring.assignments.length ?? 0,
    unclassifiedAssignments: currentDraft?.authoring.assignments.filter(assignment => assignment.queryClass === 'unclassified').length ?? 0,
    groups: currentDraft?.authoring.groups.length ?? 0,
    competitors: currentDraft?.authoring.groups.reduce((total, group) => total + group.competitors.length, 0) ?? 0,
  })
  const requireDraft = (etag: string): Draft => {
    if (!currentDraft || etag !== currentEtag()) throw new ApiError('The draft changed.', 412)
    return currentDraft
  }
  const mutation = (): DraftMutationResponse => {
    etagVersion += 1
    if (currentDraft) currentDraft.updatedAt = NOW
    return { etag: currentEtag()!, changed: true, warnings: [], counts: counts() }
  }
  const preview = (): MeasurementDraftCompilePreviewResponse => ({
    ok: true,
    compiledChecksum: COMPILED_CHECKSUM,
    checks: [],
    counts: counts(),
    plan: compiledPlan(COMPILED_CHECKSUM),
  })

  const service: AdvancedMeasurementService = {
    loadSetup: vi.fn(async () => setupResponse()),
    loadDraft: vi.fn(async () => draftResponse()),
    createDraft: vi.fn(async (_projectName, expectedActiveRevision) => {
      currentDraft = draftFixture({ baseActiveRevision: expectedActiveRevision })
      currentSetup = setupFixture(currentDraft)
      return mutation()
    }),
    importSitemap: vi.fn(async (_projectName, etag, input: SitemapImportInput) => {
      const draft = requireDraft(etag)
      if (options.importError) throw options.importError
      draft.authoring.targets = clone(options.importedTargets ?? [property(1, 'proposed')])
      draft.authoring.discovery = {
        sitemapUrl: input.sitemapUrl,
        rule: input.rule,
        exclusions: input.exclusions ?? [],
        inputChecksum: 'c'.repeat(64),
      }
      return mutation()
    }),
    applySitemapSelection: vi.fn(async (_projectName, etag, selections: SitemapSelectionInput[], selectedTargetKeys: string[]) => {
      const draft = requireDraft(etag)
      const byIdentity = new Map(selections.map(selection => [selection.discoveryIdentity, selection]))
      const selected = new Set(selectedTargetKeys)
      draft.authoring.targets = draft.authoring.targets.map(target => {
        const selection = target.discoveryIdentity ? byIdentity.get(target.discoveryIdentity) : undefined
        const reviewed = selection
          ? { ...target, status: selection.action === 'ignore' ? 'excluded' as const : 'included' as const }
          : target
        return { ...reviewed, status: selected.has(target.stableKey) ? 'included' as const : 'excluded' as const }
      })
      draft.authoring.assignments = draft.authoring.assignments.filter(assignment => selected.has(assignment.targetKey))
      draft.authoring.groups = draft.authoring.groups.map(group => ({
        ...group,
        targetKeys: group.targetKeys.filter(targetKey => selected.has(targetKey)),
      }))
      return mutation()
    }),
    applyAssignments: vi.fn(async (_projectName, etag, targetKeys, queryIds) => {
      const draft = requireDraft(etag)
      if (assignmentConflictStatus !== undefined) {
        const status = assignmentConflictStatus
        assignmentConflictStatus = undefined
        etagVersion += 1
        throw new ApiError('The setup changed in another session.', status)
      }
      const existing = new Set(draft.authoring.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
      for (const targetKey of targetKeys) {
        for (const queryId of queryIds) {
          const key = `${targetKey}\u0000${queryId}`
          if (existing.has(key)) continue
          existing.add(key)
          draft.authoring.assignments.push({
            targetKey,
            queryId,
            queryClass: 'non-brand',
            classificationSource: 'rule',
          })
        }
      }
      return mutation()
    }),
    removeAssignment: vi.fn(async (_projectName, etag, targetKeys, queryId) => {
      const draft = requireDraft(etag)
      const selected = new Set(targetKeys)
      draft.authoring.assignments = draft.authoring.assignments.filter(
        assignment => !(selected.has(assignment.targetKey) && assignment.queryId === queryId),
      )
      return mutation()
    }),
    excludeTarget: vi.fn(async (_projectName, etag, targetKey) => {
      const draft = requireDraft(etag)
      draft.authoring.targets = draft.authoring.targets.map(target => (
        target.stableKey === targetKey ? { ...target, status: 'excluded' } : target
      ))
      draft.authoring.assignments = draft.authoring.assignments.filter(assignment => assignment.targetKey !== targetKey)
      draft.authoring.groups = draft.authoring.groups.map(group => ({
        ...group,
        targetKeys: group.targetKeys.filter(key => key !== targetKey),
      }))
      return mutation()
    }),
    upsertTarget: vi.fn(async (_projectName, etag, target) => {
      const draft = requireDraft(etag)
      const index = draft.authoring.targets.findIndex(candidate => candidate.stableKey === target.stableKey)
      if (index === -1) draft.authoring.targets.push(clone(target))
      else draft.authoring.targets[index] = clone(target)
      return mutation()
    }),
    upsertGroup: vi.fn(async (_projectName, etag, group) => {
      const draft = requireDraft(etag)
      const index = draft.authoring.groups.findIndex(candidate => candidate.stableKey === group.stableKey)
      const next = {
        stableKey: group.stableKey,
        label: group.label,
        targetKeys: clone(group.targetKeys),
        competitors: group.competitors === undefined
          ? (index === -1 ? [] : draft.authoring.groups[index]!.competitors)
          : clone(group.competitors),
      }
      if (index === -1) draft.authoring.groups.push(next)
      else draft.authoring.groups[index] = next
      return mutation()
    }),
    removeGroup: vi.fn(async (_projectName, etag, groupKey) => {
      const draft = requireDraft(etag)
      draft.authoring.groups = draft.authoring.groups.filter(group => group.stableKey !== groupKey)
      return mutation()
    }),
    upsertCompetitor: vi.fn(async (_projectName, etag, input) => {
      const draft = requireDraft(etag)
      const group = draft.authoring.groups.find(candidate => candidate.stableKey === input.groupKey)
      if (group) {
        const index = group.competitors.findIndex(candidate => candidate.stableKey === input.competitor.stableKey)
        if (index === -1) group.competitors.push(clone(input.competitor))
        else group.competitors[index] = clone(input.competitor)
      }
      return mutation()
    }),
    removeCompetitor: vi.fn(async (_projectName, etag, groupKey, competitorKey) => {
      const draft = requireDraft(etag)
      const group = draft.authoring.groups.find(candidate => candidate.stableKey === groupKey)
      if (group) group.competitors = group.competitors.filter(competitor => competitor.stableKey !== competitorKey)
      return mutation()
    }),
    compilePreview: vi.fn(async () => preview()),
    diffPreview: vi.fn(async () => {
      const activeRevision = options.diffActiveRevision === undefined
        ? currentDraft?.baseActiveRevision ?? null
        : options.diffActiveRevision
      const response: MeasurementDraftDiffPreviewResponse = {
        ...preview(),
        diff: {
          activeRevision,
          targets: {
            added: currentDraft?.authoring.targets.map(target => target.stableKey) ?? [],
            removed: [],
            changed: [],
            unchanged: [],
          },
          groups: { added: [], removed: [], changed: [], unchanged: [] },
          assignments: { added: currentDraft?.authoring.assignments.length ?? 0, removed: 0, reclassified: 0 },
          execution: { addedNodeKeys: [], removedNodeKeys: [] },
        },
      }
      if (!movedDraftDuringDiff && options.latestBaseActiveRevision !== undefined && currentDraft) {
        movedDraftDuringDiff = true
        currentDraft.baseActiveRevision = options.latestBaseActiveRevision
        currentDraft.baseActiveVersionId = options.latestBaseActiveRevision === null
          ? null
          : `version-${options.latestBaseActiveRevision}`
        currentSetup = setupFixture(currentDraft)
        etagVersion += 1
      }
      return response
    }),
    publish: vi.fn(async (_projectName, etag, input) => {
      requireDraft(etag)
      const revision = (input.expectedActiveRevision ?? 0) + 1
      const response: MeasurementPlanV2PublishResponse = {
        published: true,
        active: {
          revision,
          checksum: DOCUMENT_CHECKSUM,
          compiledChecksum: input.expectedCompiledChecksum,
          createdAt: NOW,
          plan: compiledPlan(input.expectedCompiledChecksum),
        },
      }
      currentDraft = null
      currentSetup = {
        state: 'awaiting_first_run',
        nextAction: 'run_measurement',
        mode: 'active-v2',
        activeRevision: revision,
        activeSchemaVersion: 2,
        draft: null,
      }
      return response
    }),
    discard: vi.fn(async (_projectName, etag) => {
      requireDraft(etag)
      currentDraft = null
      currentSetup = setupFixture(null)
      if (options.discardConflictStatus) {
        throw new ApiError('Measurement plan draft was not found.', options.discardConflictStatus)
      }
      return { discarded: true }
    }),
  }

  return {
    service,
    getDraft: () => currentDraft ? clone(currentDraft) : null,
    getEtag: currentEtag,
  }
}

function renderSection(
  fake: ReturnType<typeof createFakeService>,
  overrides: Partial<React.ComponentProps<typeof AdvancedMeasurementSection>> = {},
) {
  return render(
    <AdvancedMeasurementSection
      projectName={PROJECT}
      queries={QUERIES}
      isQueryLoading={false}
      isQueryError={false}
      service={fake.service}
      {...overrides}
    />,
  )
}

async function reviewSyntheticSitemap() {
  await screen.findByRole('heading', { name: 'Import Properties' })
  fireEvent.change(screen.getByLabelText('Sitemap URL'), {
    target: { value: 'https://portfolio.example/sitemap.xml' },
  })
  fireEvent.change(screen.getByLabelText('Example Property page'), {
    target: { value: 'https://portfolio.example/properties/property-001' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review sitemap' }))
}

async function advanceExistingDraftToReview() {
  await screen.findByRole('heading', { name: 'Properties' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Queries' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Groups' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
  await screen.findByRole('heading', { name: 'Review & publish' })
}

afterEach(cleanup)

test('keeps internal setup terminology out of customer-facing errors', () => {
  expect(setupErrorMessage(new ApiError('Measurement draft Target was not found', 404), 'Could not save this Property.'))
    .toBe('Could not save this Property.')
  expect(setupErrorMessage(new ApiError('Sitemap request timed out', 504), 'Could not review this sitemap.'))
    .toBe('Sitemap request timed out')
  expect(setupErrorMessage(new ApiError('Measurement plan draft no longer exists', 404), 'Could not discard these changes.'))
    .toBe('Could not discard these changes.')
  expect(setupErrorMessage(new ApiError('A draft already exists', 409), 'Could not open setup.'))
    .toBe('Could not open setup.')
})

describe('AdvancedMeasurementSection server draft controller', () => {
  test('starts an Advanced draft from Simple with the active revision the setup read supplied', async () => {
    const fake = createFakeService()
    renderSection(fake)

    await screen.findByRole('heading', { name: 'Import Properties' })
    expect(fake.service.createDraft).toHaveBeenCalledTimes(1)
    expect(fake.service.createDraft).toHaveBeenCalledWith(PROJECT, null)
    expect(fake.service.loadSetup).toHaveBeenCalledTimes(2)
    expect(fake.service.loadDraft).toHaveBeenCalledTimes(2)
  })

  test('shows the server sitemap error instead of replacing it with a generic failure', async () => {
    const fake = createFakeService({
      importError: new Error('The sitemap contains no Property URLs matching this rule.'),
    })
    renderSection(fake)

    await reviewSyntheticSitemap()

    expect(await screen.findByText('The sitemap contains no Property URLs matching this rule.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Import Properties' })).toBeTruthy()
  })

  test('confirms 213 synthetic sitemap proposals with one server selection action', async () => {
    const proposals = Array.from({ length: 213 }, (_, index) => property(index + 1, 'proposed'))
    const fake = createFakeService({ importedTargets: proposals })
    renderSection(fake)

    await reviewSyntheticSitemap()
    await screen.findByRole('heading', { name: 'Properties' })
    expect(screen.getByText('Showing 50 of 213 Properties')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })

    expect(fake.service.applySitemapSelection).toHaveBeenCalledTimes(1)
    const selections = vi.mocked(fake.service.applySitemapSelection).mock.calls[0]![2]
    expect(selections).toHaveLength(213)
    expect(selections.map(selection => selection.discoveryIdentity)).toEqual(
      proposals.map(proposal => proposal.discoveryIdentity),
    )
    expect(new Set(selections.map(selection => selection.action))).toEqual(new Set(['create']))
    expect(vi.mocked(fake.service.applySitemapSelection).mock.calls[0]![3]).toEqual(
      proposals.map(proposal => proposal.stableKey),
    )
  })

  test('applies every selected query to every selected Property in exactly one bulk call', async () => {
    const targets = [property(1), property(2), property(3)]
    const fake = createFakeService({ initialDraft: draftFixture({ targets }) })
    renderSection(fake)

    await screen.findByRole('heading', { name: 'Queries' })
    for (const query of QUERIES) fireEvent.click(screen.getByLabelText(`Select query ${query.query}`))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))

    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1))
    expect(fake.service.applyAssignments).toHaveBeenCalledWith(
      PROJECT,
      '"mpd_7"',
      targets.map(target => target.stableKey),
      QUERIES.map(query => query.id),
    )
    expect(fake.getDraft()?.authoring.assignments).toHaveLength(targets.length * QUERIES.length)
  })

  test('clears one query from all assigned Properties in exactly one bulk call', async () => {
    const targets = [property(1), property(2), property(3), property(4)]
    const fake = createFakeService({
      initialDraft: draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
    })
    renderSection(fake)

    await screen.findByRole('heading', { name: 'Properties' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: `Clear assignments for ${QUERIES[0]!.query}` }))

    await waitFor(() => expect(fake.service.removeAssignment).toHaveBeenCalledTimes(1))
    expect(fake.service.removeAssignment).toHaveBeenCalledWith(
      PROJECT,
      '"mpd_7"',
      targets.map(target => target.stableKey),
      'q-nearby',
    )
    expect(fake.getDraft()?.authoring.assignments).toEqual([])
  })

  test('saves the complete Property selection and cleanup in one atomic action', async () => {
    const targets = [property(1), property(2)]
    const initialDraft = draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 })
    initialDraft.authoring.groups = [{
      stableKey: 'group-synthetic',
      label: 'Synthetic group',
      targetKeys: targets.map(target => target.stableKey),
      competitors: [],
    }]
    const fake = createFakeService({ initialDraft })
    renderSection(fake)

    const firstProperty = await screen.findByLabelText('Select Property 001')
    fireEvent.click(firstProperty)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })

    expect(fake.service.applySitemapSelection).toHaveBeenCalledTimes(1)
    expect(fake.service.applySitemapSelection).toHaveBeenCalledWith(PROJECT, '"mpd_7"', [], ['property-002'])
    expect(fake.service.excludeTarget).not.toHaveBeenCalled()
    expect(fake.getDraft()?.authoring.assignments.map(assignment => assignment.targetKey)).toEqual(['property-002'])
    expect(fake.getDraft()?.authoring.groups[0]?.targetKeys).toEqual(['property-002'])
  })

  test('saves a group and its complete competitor list atomically', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
    })
    renderSection(fake)
    await advanceExistingDraftToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Synthetic metro' } })
    fireEvent.click(screen.getByLabelText('Select Property 001'))
    fireEvent.change(screen.getByLabelText('Competitor domains'), { target: { value: 'rival.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))

    await waitFor(() => expect(fake.service.upsertGroup).toHaveBeenCalledTimes(1))
    expect(fake.service.upsertGroup).toHaveBeenCalledWith(PROJECT, '"mpd_7"', {
      stableKey: 'group-synthetic-metro',
      label: 'Synthetic metro',
      targetKeys: ['property-001'],
      competitors: [{
        stableKey: 'competitor-rival.example',
        label: 'rival.example',
        domain: 'rival.example',
        aliases: [],
      }],
    })
    expect(fake.service.upsertCompetitor).not.toHaveBeenCalled()
    expect(fake.service.removeCompetitor).not.toHaveBeenCalled()
  })

  test('lets a viewer inspect the server draft without creating or mutating anything', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'] }),
    })
    renderSection(fake, { canEdit: false })

    await screen.findByRole('heading', { name: 'Review & publish' })
    expect(screen.getByText('Viewer access')).toBeTruthy()
    for (const action of [
      'Discard changes',
      'Review changes',
      'Publish setup',
      'Apply selected queries',
      'Continue',
    ]) expect(screen.queryByRole('button', { name: action })).toBeNull()
    for (const method of [
      fake.service.createDraft,
      fake.service.importSitemap,
      fake.service.applySitemapSelection,
      fake.service.applyAssignments,
      fake.service.removeAssignment,
      fake.service.publish,
      fake.service.discard,
    ]) expect(method).not.toHaveBeenCalled()
  })

  test('reloads the latest draft when compile and diff report a moved active revision', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      diffActiveRevision: 5,
      latestBaseActiveRevision: 5,
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText(
      'The published setup changed while you were reviewing. The latest draft is loaded; review it again.',
    )).toBeTruthy()
    expect(fake.service.compilePreview).toHaveBeenCalledTimes(1)
    expect(fake.service.diffPreview).toHaveBeenCalledTimes(1)
    expect(fake.getDraft()?.baseActiveRevision).toBe(5)
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeTruthy()
    expect(fake.service.publish).not.toHaveBeenCalled()
  })

  test.each([412, 409] as const)('reloads actionable state after a %s assignment conflict', async status => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)] }),
      assignmentConflictStatus: status,
    })
    renderSection(fake)
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByLabelText(`Select query ${QUERIES[0]!.query}`))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))

    expect(await screen.findByText(
      'This setup changed in another session. The latest draft is loaded; review your changes again.',
    )).toBeTruthy()
    expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Apply selected queries' })).not.toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: 'Apply selected queries' }))
    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(2))
    expect(vi.mocked(fake.service.applyAssignments).mock.calls[1]![1]).toBe('"mpd_8"')
    expect(fake.getDraft()?.authoring.assignments).toHaveLength(1)
  })

  test('publishes only the reviewed ETag, base revision, and compiled checksum', async () => {
    const onPublished = vi.fn()
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
    })
    renderSection(fake, { onPublished })
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

    await waitFor(() => expect(fake.service.publish).toHaveBeenCalledTimes(1))
    expect(fake.service.publish).toHaveBeenCalledWith(PROJECT, '"mpd_7"', {
      expectedActiveRevision: 4,
      expectedCompiledChecksum: COMPILED_CHECKSUM,
    })
    expect(onPublished).toHaveBeenCalledTimes(1)
  })

  test('discards the server draft only after explicit confirmation', async () => {
    const fake = createFakeService({ initialDraft: draftFixture() })
    renderSection(fake)
    await screen.findByRole('heading', { name: 'Import Properties' })

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(fake.service.discard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))

    await waitFor(() => expect(fake.service.discard).toHaveBeenCalledTimes(1))
    expect(fake.service.discard).toHaveBeenCalledWith(PROJECT, '"mpd_7"')
    expect(fake.getDraft()).toBeNull()
  })

  test('recovers when another session already discarded the draft', async () => {
    const fake = createFakeService({ initialDraft: draftFixture(), discardConflictStatus: 404 })
    renderSection(fake)
    await screen.findByRole('heading', { name: 'Import Properties' })

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))

    await waitFor(() => expect(fake.service.discard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(fake.service.loadDraft).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Start setup from the project Overview.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Measurement plan draft')
  })
})
