import { describe, expect, test } from 'vitest'

import type {
  LocationContext,
  MeasurementDiscoveryResponse,
  MeasurementPlanResponse,
  QueryDto,
} from '@ainyc/canonry-api-client'
import {
  addTargetUrl,
  applyQuerySet,
  clearTargetAssignments,
  confirmTarget,
  createDraftFromDiscovery,
  expandQueryTemplate,
  mapExpandedTemplateQueries,
  parsePortfolioDraft,
  reconcileDraftWithDiscovery,
  rejectTarget,
  removeReportingGroup,
  removeTargetUrl,
  resolveCoverageReviews,
  renameTarget,
  reviewAllExceptions,
  reviewExceptions,
  serializePortfolioDraft,
  stateFromActivePlan,
  toMeasurementPlanInput,
  upsertQuerySet,
  upsertQueryTemplate,
  upsertReportingGroup,
  validatePortfolioDraft,
} from '../src/components/project/portfolio-setup-model.js'

const PLACE_CONTEXT: LocationContext = {
  label: 'Harbor City, CA',
  city: 'Harbor City',
  region: 'CA',
  country: 'US',
  timezone: 'America/Los_Angeles',
}

function discoveryFixture(): MeasurementDiscoveryResponse {
  return {
    proposed: [
      {
        classification: 'proposed',
        reason: 'primary-match',
        stableKey: 'north-pier',
        slug: 'north-pier',
        label: 'North Pier',
        primaryUrl: 'https://harbor.example/venues/north-pier/',
        aliasCoverageUrls: ['https://venues.harbor.example/north-pier/'],
      },
      {
        classification: 'proposed',
        reason: 'primary-match',
        stableKey: 'south-quay',
        slug: 'south-quay',
        label: 'South Quay',
        primaryUrl: 'https://harbor.example/venues/south-quay/',
        aliasCoverageUrls: [],
      },
    ],
    aliases: [{
      classification: 'alias',
      reason: 'exact-slug-match',
      slug: 'north-pier',
      url: 'https://venues.harbor.example/north-pier/',
      targetStableKey: 'north-pier',
    }],
    shared: [{
      url: 'https://harbor.example/venues/',
      canonicalUrl: 'https://harbor.example/venues',
      classification: 'shared',
      reason: 'shared-path',
    }],
    unmatched: [{
      url: 'https://harbor.example/about',
      canonicalUrl: 'https://harbor.example/about',
      classification: 'unmatched',
      reason: 'unmatched-path',
    }],
    excluded: [{
      url: 'https://harbor.example/venues/north-pier-blog',
      canonicalUrl: 'https://harbor.example/venues/north-pier-blog',
      classification: 'excluded',
      reason: 'excluded-slug',
    }],
    diagnostics: [],
  }
}

function scaledDiscoveryFixture(count: number, aliasHost: string): MeasurementDiscoveryResponse {
  return {
    proposed: Array.from({ length: count }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return {
        classification: 'proposed' as const,
        reason: 'primary-match' as const,
        stableKey: `venue-${number}`,
        slug: `venue-${number}`,
        label: `Venue ${number}`,
        primaryUrl: `https://harbor.example/venues/venue-${number}/`,
        aliasCoverageUrls: [`https://${aliasHost}/venue-${number}/`],
      }
    }),
    aliases: [],
    shared: [],
    unmatched: [],
    excluded: [],
    diagnostics: [],
  }
}

describe('portfolio setup draft', () => {
  test('turns deterministic discovery into reviewable targets, URL coverage, and exceptions', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())

    expect(draft.targets).toEqual([
      expect.objectContaining({
        stableKey: 'north-pier',
        label: 'North Pier',
        status: 'proposed',
        urls: [
          { kind: 'prefix', host: 'harbor.example', pathPrefix: '/venues/north-pier', pathCase: 'insensitive' },
          { kind: 'prefix', host: 'venues.harbor.example', pathPrefix: '/north-pier', pathCase: 'insensitive' },
        ],
      }),
      expect.objectContaining({ stableKey: 'south-quay', status: 'proposed' }),
    ])
    expect(draft.exceptions.map(item => item.bucket)).toEqual(['excluded', 'shared', 'unmatched'])
    expect(draft.exceptions.every(item => item.status === 'unreviewed')).toBe(true)

    draft = confirmTarget(draft, 'north-pier')
    draft = rejectTarget(draft, 'south-quay')
    draft = renameTarget(draft, 'north-pier', 'North Pier Landing')
    draft = addTargetUrl(draft, 'north-pier', { kind: 'host', host: 'north-pier.example' })
    draft = removeTargetUrl(draft, 'north-pier', {
      kind: 'prefix',
      host: 'venues.harbor.example',
      pathPrefix: '/north-pier',
      pathCase: 'insensitive',
    })
    draft = reviewAllExceptions(draft)

    expect(draft.targets[0]).toEqual(expect.objectContaining({
      label: 'North Pier Landing',
      status: 'confirmed',
      urls: [
        { kind: 'prefix', host: 'harbor.example', pathPrefix: '/venues/north-pier', pathCase: 'insensitive' },
        { kind: 'host', host: 'north-pier.example' },
      ],
    }))
    expect(draft.targets[1]?.status).toBe('rejected')
    expect(draft.exceptions.every(item => item.status === 'reviewed')).toBe(true)
  })

  test('applies reusable query sets with one batch context and keeps groups reporting-only', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = reviewAllExceptions(draft)
    draft = upsertQuerySet(draft, {
      key: 'harbor-searches',
      label: 'Harbor searches',
      queryIds: ['q-nearby', 'q-family'],
      context: PLACE_CONTEXT,
    })
    draft = applyQuerySet(draft, 'harbor-searches', ['south-quay', 'north-pier'])
    draft = upsertReportingGroup(draft, {
      stableKey: 'coastal-portfolio',
      label: 'Coastal portfolio',
      targetKeys: ['south-quay', 'north-pier'],
      competitors: ['rival.example'],
      // Runtime callers can carry stale fields; the model must not retain them.
      queryIds: ['q-nearby'],
      context: PLACE_CONTEXT,
    } as never)

    expect(draft.assignments).toHaveLength(4)
    expect(draft.assignments).toEqual(expect.arrayContaining([
      { targetKey: 'north-pier', queryId: 'q-nearby', context: PLACE_CONTEXT },
      { targetKey: 'south-quay', queryId: 'q-family', context: PLACE_CONTEXT },
    ]))
    expect(draft.groups).toEqual([{
      stableKey: 'coastal-portfolio',
      label: 'Coastal portfolio',
      targetKeys: ['north-pier', 'south-quay'],
      competitors: ['rival.example'],
    }])

    const plan = toMeasurementPlanInput(draft)
    expect(plan.targetQuerySelections).toEqual([
      { targetKey: 'north-pier', queryIds: ['q-family', 'q-nearby'], context: PLACE_CONTEXT },
      { targetKey: 'south-quay', queryIds: ['q-family', 'q-nearby'], context: PLACE_CONTEXT },
    ])
    expect(plan.groups?.[0]).not.toHaveProperty('queryIds')
    expect(plan.groups?.[0]).not.toHaveProperty('context')
  })

  test('expands target-label templates deterministically and maps returned project rows', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = reviewAllExceptions(draft)
    draft = upsertQueryTemplate(draft, {
      key: 'reviews',
      label: 'Review searches',
      template: 'reviews for {target.label}',
      context: PLACE_CONTEXT,
    })

    const expanded = expandQueryTemplate(draft, 'reviews', ['south-quay', 'north-pier'])
    expect(expanded).toEqual([
      { targetKey: 'north-pier', queryText: 'reviews for North Pier', context: PLACE_CONTEXT },
      { targetKey: 'south-quay', queryText: 'reviews for South Quay', context: PLACE_CONTEXT },
    ])

    const returned: QueryDto[] = [
      { id: 'q-south', query: 'reviews for South Quay', createdAt: '2026-08-01T10:00:00.000Z' },
      { id: 'q-north', query: 'reviews for North Pier', createdAt: '2026-08-01T10:00:00.000Z' },
    ]
    draft = mapExpandedTemplateQueries(draft, expanded, returned)
    expect(draft.assignments).toEqual([
      { targetKey: 'north-pier', queryId: 'q-north', context: PLACE_CONTEXT },
      { targetKey: 'south-quay', queryId: 'q-south', context: PLACE_CONTEXT },
    ])
  })

  test('does not partially assign a template when the query API omits a generated row', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = upsertQueryTemplate(draft, {
      key: 'reviews',
      label: 'Review searches',
      template: 'reviews for {target.label}',
      context: null,
    })
    const expanded = expandQueryTemplate(draft, 'reviews', ['north-pier', 'south-quay'])

    expect(() => mapExpandedTemplateQueries(draft, expanded, [
      { id: 'q-north', query: 'reviews for North Pier', createdAt: '2026-08-01T10:00:00.000Z' },
    ])).toThrow(/reviews for South Quay/)
    expect(draft.assignments).toEqual([])
  })

  test('blocks publication until targets and discovery exceptions have been reviewed', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    expect(validatePortfolioDraft(draft).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'target-review-required',
      'exception-review-required',
      'no-confirmed-targets',
    ]))
    expect(() => toMeasurementPlanInput(draft)).toThrow(/not ready/i)

    draft = confirmTarget(draft, 'north-pier')
    draft = rejectTarget(draft, 'south-quay')
    draft = reviewAllExceptions(draft)
    expect(validatePortfolioDraft(draft)).toEqual([])
    expect(toMeasurementPlanInput(draft).targets.map(target => target.stableKey)).toEqual(['north-pier'])
  })

  test('seeds an editable draft from an active immutable revision without losing semantics', () => {
    const activePlan: NonNullable<MeasurementPlanResponse['active']>['plan'] = {
      schemaVersion: 1,
      defaultContext: PLACE_CONTEXT,
      effectiveOwnedHosts: ['harbor.example'],
      projectCanonicalHost: 'harbor.example',
      projectBrandNames: ['Harbor'],
      targets: [{
        stableKey: 'north-pier',
        label: 'North Pier',
        urls: [{ kind: 'prefix', host: 'harbor.example', pathPrefix: '/venues/north-pier', pathCase: 'insensitive' }],
        aliases: ['North Pier'],
        metadata: { region: 'coast' },
        mentionNotApplicable: false,
      }],
      groups: [{
        stableKey: 'coastal-portfolio',
        label: 'Coastal portfolio',
        targetKeys: ['north-pier'],
        competitors: ['rival.example'],
      }],
      targetQuerySelections: [{ targetKey: 'north-pier', queryIds: ['q-nearby'] }],
      querySnapshots: [{ queryId: 'q-nearby', queryText: 'venues near the harbor' }],
      executionNodes: [{ stableKey: 'exec-1', queryText: 'venues near the harbor', context: PLACE_CONTEXT, expectedSnapshots: 2 }],
      usageEdges: [{ kind: 'target', executionNodeKey: 'exec-1', queryId: 'q-nearby', targetKey: 'north-pier' }],
      warnings: [],
    }

    const draft = stateFromActivePlan(activePlan)
    expect(draft.targets).toEqual([{
      stableKey: 'north-pier',
      label: 'North Pier',
      status: 'confirmed',
      urls: [{ kind: 'prefix', host: 'harbor.example', pathPrefix: '/venues/north-pier', pathCase: 'insensitive' }],
      aliases: ['North Pier'],
      metadata: { region: 'coast' },
    }])
    expect(draft.assignments).toEqual([{ targetKey: 'north-pier', queryId: 'q-nearby', context: undefined }])
    expect(draft.groups).toEqual(activePlan.groups)
    expect(toMeasurementPlanInput(draft)).toEqual({
      schemaVersion: 1,
      targets: [{
        stableKey: 'north-pier',
        label: 'North Pier',
        urls: activePlan.targets[0]!.urls,
        aliases: ['North Pier'],
        metadata: { region: 'coast' },
      }],
      groups: activePlan.groups,
      targetQuerySelections: activePlan.targetQuerySelections,
    })
  })

  test('preserves explicit no-location separately from inherited project context', () => {
    const activePlan: NonNullable<MeasurementPlanResponse['active']>['plan'] = {
      schemaVersion: 1,
      defaultContext: PLACE_CONTEXT,
      effectiveOwnedHosts: ['harbor.example'],
      projectCanonicalHost: 'harbor.example',
      projectBrandNames: ['Harbor'],
      targets: [{
        stableKey: 'north-pier',
        label: 'North Pier',
        urls: [{ kind: 'prefix', host: 'harbor.example', pathPrefix: '/venues/north-pier', pathCase: 'insensitive' }],
        aliases: ['North Pier'],
        mentionNotApplicable: false,
      }],
      groups: [],
      targetQuerySelections: [
        { targetKey: 'north-pier', queryIds: ['q-inherit'] },
        { targetKey: 'north-pier', queryIds: ['q-none'], context: null },
      ],
      querySnapshots: [
        { queryId: 'q-inherit', queryText: 'nearby venues' },
        { queryId: 'q-none', queryText: 'venue reputation' },
      ],
      executionNodes: [],
      usageEdges: [],
      warnings: [],
    }

    const input = toMeasurementPlanInput(stateFromActivePlan(activePlan))
    expect(input.targetQuerySelections).toEqual([
      { targetKey: 'north-pier', queryIds: ['q-inherit'] },
      { targetKey: 'north-pier', queryIds: ['q-none'], context: null },
    ])
  })

  test('preserves conflicting bulk contexts for the server compile check', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(draft, 'north-pier')
    draft = upsertQuerySet(draft, { key: 'default', label: 'Default', queryIds: ['q-nearby'], context: undefined })
    draft = applyQuerySet(draft, 'default', ['north-pier'])
    draft = upsertQuerySet(draft, { key: 'none', label: 'No location', queryIds: ['q-nearby'], context: null })
    draft = applyQuerySet(draft, 'none', ['north-pier'])
    draft = rejectTarget(draft, 'south-quay')
    draft = reviewAllExceptions(draft)

    expect(toMeasurementPlanInput(draft).targetQuerySelections).toEqual([
      { targetKey: 'north-pier', queryIds: ['q-nearby'] },
      { targetKey: 'north-pier', queryIds: ['q-nearby'], context: null },
    ])
  })

  test('reconciles refreshed discovery without erasing reviewed setup', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = reviewAllExceptions(draft)
    draft = upsertQuerySet(draft, {
      key: 'nearby', label: 'Nearby', queryIds: ['q-nearby'], context: undefined,
    })
    draft = applyQuerySet(draft, 'nearby', ['north-pier'])
    draft = upsertReportingGroup(draft, {
      stableKey: 'coast', label: 'Coast', targetKeys: ['north-pier'], competitors: ['rival.example'],
    })

    const refreshed = discoveryFixture()
    refreshed.proposed[0]!.aliasCoverageUrls = ['https://new-directory.harbor.example/north-pier/']
    refreshed.aliases = []
    refreshed.proposed.push({
      classification: 'proposed',
      reason: 'primary-match',
      stableKey: 'east-dock',
      slug: 'east-dock',
      label: 'East Dock',
      primaryUrl: 'https://harbor.example/venues/east-dock/',
      aliasCoverageUrls: [],
    })

    const reconciled = reconcileDraftWithDiscovery(draft, refreshed)
    expect(reconciled.targets.find(target => target.stableKey === 'north-pier')).toEqual(expect.objectContaining({
      status: 'proposed',
      label: 'North Pier',
    }))
    expect(reconciled.targets.find(target => target.stableKey === 'east-dock')?.status).toBe('proposed')
    expect(reconciled.assignments).toEqual(draft.assignments)
    expect(reconciled.groups).toEqual(draft.groups)
    expect(reconciled.querySets).toEqual(draft.querySets)
    expect(reconciled.exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'url-not-rediscovered', status: 'unreviewed' }),
    ]))
  })

  test('preserves the saved coverage baseline across repeated unresolved imports', () => {
    let draft = createDraftFromDiscovery(scaledDiscoveryFixture(1, 'saved-directory.harbor.example'))
    draft = confirmTarget(draft, 'venue-001')

    draft = reconcileDraftWithDiscovery(draft, scaledDiscoveryFixture(1, 'first-import.harbor.example'))
    draft = reconcileDraftWithDiscovery(draft, scaledDiscoveryFixture(1, 'second-import.harbor.example'))
    draft = resolveCoverageReviews(draft, ['venue-001'], 'keep-existing')

    const hosts = draft.targets[0]!.urls.map(url => url.kind === 'exact' ? new URL(url.url).hostname : url.host)
    expect(hosts).toContain('saved-directory.harbor.example')
    expect(hosts).not.toContain('first-import.harbor.example')
    expect(hosts).not.toContain('second-import.harbor.example')
  })

  test('resolves 213 refreshed Targets in bulk without acknowledging untouched churn', () => {
    const originalDiscovery = scaledDiscoveryFixture(213, 'old-directory.harbor.example')
    let draft = createDraftFromDiscovery(originalDiscovery)
    for (const target of draft.targets) draft = confirmTarget(draft, target.stableKey)

    const refreshedDiscovery = scaledDiscoveryFixture(213, 'new-directory.harbor.example')
    draft = reconcileDraftWithDiscovery(draft, refreshedDiscovery)
    expect(draft.coverageReviews).toHaveLength(213)
    expect(draft.coverageReviews.every(review => review.resolution === 'pending')).toBe(true)

    const keepKeys = draft.targets.slice(0, 100).map(target => target.stableKey)
    const replaceKeys = draft.targets.slice(100, 200).map(target => target.stableKey)
    draft = resolveCoverageReviews(draft, keepKeys, 'keep-existing')
    draft = resolveCoverageReviews(draft, replaceKeys, 'replace-with-imported')

    expect(draft.targets[0]?.urls).toContainEqual(expect.objectContaining({ host: 'old-directory.harbor.example' }))
    expect(draft.targets[0]?.urls).not.toContainEqual(expect.objectContaining({ host: 'new-directory.harbor.example' }))
    expect(draft.targets[100]?.urls).toContainEqual(expect.objectContaining({ host: 'new-directory.harbor.example' }))
    expect(draft.targets[100]?.urls).not.toContainEqual(expect.objectContaining({ host: 'old-directory.harbor.example' }))
    expect(draft.targets[212]?.status).toBe('proposed')
    expect(draft.coverageReviews.filter(review => review.resolution === 'pending')).toHaveLength(13)
    expect(draft.exceptions.filter(item => item.reason === 'url-not-rediscovered' && item.status === 'unreviewed')).toHaveLength(13)

    const restored = parsePortfolioDraft(serializePortfolioDraft(draft))
    expect(restored.coverageReviews).toEqual(draft.coverageReviews)
    const rereconciled = reconcileDraftWithDiscovery(restored, refreshedDiscovery)
    expect(rereconciled.coverageReviews.filter(review => review.resolution === 'pending')).toHaveLength(13)
    expect(rereconciled.targets[0]?.status).toBe('confirmed')
  })

  test('reviews only explicitly visible URL items', () => {
    const fixture = discoveryFixture()
    fixture.shared = []
    fixture.excluded = []
    fixture.unmatched = Array.from({ length: 25 }, (_, index) => ({
      url: `https://harbor.example/page-${index + 1}`,
      canonicalUrl: `https://harbor.example/page-${index + 1}`,
      classification: 'unmatched' as const,
      reason: 'unmatched-path' as const,
    }))
    let draft = createDraftFromDiscovery(fixture)
    const visibleKeys = draft.exceptions.slice(0, 20).map(item => item.key)

    draft = reviewExceptions(draft, visibleKeys)
    expect(draft.exceptions.filter(item => item.status === 'reviewed')).toHaveLength(20)
    expect(draft.exceptions.filter(item => item.status === 'unreviewed')).toHaveLength(5)
  })

  test('makes active Target removal reversible without leaking it into the candidate plan', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = reviewAllExceptions(draft)
    draft = upsertQuerySet(draft, { key: 'nearby', label: 'Nearby', queryIds: ['q-nearby'], context: undefined })
    draft = applyQuerySet(draft, 'nearby', ['north-pier'])
    draft = upsertReportingGroup(draft, { stableKey: 'coast', label: 'Coast', targetKeys: ['north-pier'] })
    const originalCandidate = toMeasurementPlanInput(draft)

    draft = rejectTarget(draft, 'north-pier')
    expect(draft.assignments).toEqual([{ targetKey: 'north-pier', queryId: 'q-nearby', context: undefined }])
    expect(draft.groups).toEqual([{ stableKey: 'coast', label: 'Coast', targetKeys: ['north-pier'] }])
    const removedCandidate = toMeasurementPlanInput(draft)
    expect(removedCandidate.targets.map(target => target.stableKey)).toEqual(['south-quay'])
    expect(removedCandidate.targetQuerySelections).toEqual([])
    expect(removedCandidate.groups).toEqual([])

    draft = confirmTarget(draft, 'north-pier')
    expect(toMeasurementPlanInput(draft)).toEqual(originalCandidate)
  })

  test('clears assignments for selected Targets so bulk mistakes are recoverable', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = upsertQuerySet(draft, { key: 'nearby', label: 'Nearby', queryIds: ['q-nearby'], context: undefined })
    draft = applyQuerySet(draft, 'nearby', ['north-pier', 'south-quay'])

    draft = clearTargetAssignments(draft, ['north-pier'])
    expect(draft.assignments).toEqual([
      { targetKey: 'south-quay', queryId: 'q-nearby', context: undefined },
    ])
  })

  test('removes a saved reporting group without changing its Properties or query assignments', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(confirmTarget(draft, 'north-pier'), 'south-quay')
    draft = upsertQuerySet(draft, { key: 'nearby', label: 'Nearby', queryIds: ['q-nearby'], context: undefined })
    draft = applyQuerySet(draft, 'nearby', ['north-pier'])
    draft = upsertReportingGroup(draft, { stableKey: 'coast', label: 'Coast', targetKeys: ['north-pier'] })

    draft = removeReportingGroup(draft, 'coast')

    expect(draft.groups).toEqual([])
    expect(draft.targets).toHaveLength(2)
    expect(draft.assignments).toEqual([{ targetKey: 'north-pier', queryId: 'q-nearby', context: undefined }])
  })

  test('uses contract URL normalization and rejects exact routes that could widen silently', () => {
    const draft = createDraftFromDiscovery(discoveryFixture())
    const invalid = [
      'https://user:pass@harbor.example/venues/north-pier',
      'https://harbor.example:444/venues/north-pier',
      'https://harbor.example/venues/north-pier?preview=1',
      'https://harbor.example/venues/north-pier#details',
      'https://harbor.example/venues/../admin',
      'https://harbor.example/venues/%2e%2e/admin',
    ]
    for (const url of invalid) {
      expect(() => addTargetUrl(draft, 'north-pier', { kind: 'exact', url, pathCase: 'insensitive' })).toThrow()
    }
    const normalized = addTargetUrl(draft, 'north-pier', {
      kind: 'exact', url: 'https://www.harbor.example//venues//north-pier/', pathCase: 'insensitive',
    })
    expect(normalized.targets[0]?.urls).toContainEqual({
      kind: 'exact', url: 'https://harbor.example/venues/north-pier', pathCase: 'insensitive',
    })
  })

  test('retains duplicate diagnostics and treats rename as typo correction', () => {
    const fixture = discoveryFixture()
    fixture.diagnostics = [{
      kind: 'duplicate-url',
      url: 'https://harbor.example/venues/north-pier/',
      canonicalUrl: 'https://harbor.example/venues/north-pier',
      duplicateOf: 'https://harbor.example/venues/north-pier',
    }]
    let draft = createDraftFromDiscovery(fixture)
    expect(draft.exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'duplicate-url', duplicateOf: 'https://harbor.example/venues/north-pier' }),
    ]))

    draft = renameTarget(draft, 'north-pier', 'North Pier Landing')
    expect(draft.targets.find(target => target.stableKey === 'north-pier')?.aliases).toEqual(['North Pier Landing'])
  })

  test('ignores rejected Target identities when validating the publishable plan', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(draft, 'north-pier')
    draft = rejectTarget(draft, 'south-quay')
    draft = reviewAllExceptions(draft)
    draft = upsertReportingGroup(draft, {
      stableKey: 'south-quay', label: 'Published group', targetKeys: ['north-pier'],
    })
    expect(validatePortfolioDraft(draft).map(issue => issue.code)).not.toContain('duplicate-stable-key')
  })

  test('serializes deterministically and rejects malformed saved drafts', () => {
    let draft = createDraftFromDiscovery(discoveryFixture())
    draft = confirmTarget(draft, 'north-pier')
    draft = rejectTarget(draft, 'south-quay')
    draft = reviewAllExceptions(draft)

    const serialized = serializePortfolioDraft(draft)
    expect(serializePortfolioDraft(parsePortfolioDraft(serialized))).toBe(serialized)
    expect(() => parsePortfolioDraft('{')).toThrow(/saved setup/i)
    expect(() => parsePortfolioDraft(JSON.stringify({ schemaVersion: 1, targets: 'wrong' }))).toThrow(/saved setup/i)
  })
})
