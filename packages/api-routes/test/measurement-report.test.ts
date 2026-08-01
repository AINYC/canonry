import { describe, expect, it } from 'vitest'

import {
  buildMeasurementReport,
  classifyCitedUrl,
  normalizeMeasurementLocation,
  type MeasurementReportInput,
  type MeasurementTargetInput,
} from '../src/measurement-report.js'

const targets: MeasurementTargetInput[] = [
  {
    id: 'central',
    label: 'Example Living Central',
    aliases: ['Central'],
    urls: [{ id: 'central-exact', mode: 'exact', host: 'example.test', path: '/apartments/example-living-central' }],
  },
  {
    id: 'north',
    label: 'Example Living North',
    aliases: ['North'],
    urls: [{ id: 'north-prefix', mode: 'prefix', host: 'example.test', path: '/apartments/example-living-north' }],
  },
  {
    id: 'harbor',
    label: 'Example Living Harbor',
    aliases: ['Harbor', 'Example Living Harbor'],
    urls: [
      { id: 'harbor-primary', mode: 'prefix', host: 'example.test', path: '/apartments/example-living-harbor' },
      { id: 'harbor-alias', mode: 'prefix', host: 'homes.example.test', path: '/example-living-harbor' },
    ],
  },
  {
    id: 'ambiguous-a',
    label: 'Ambiguous A',
    aliases: ['Ambiguous A'],
    urls: [{ id: 'ambiguous-a-prefix', mode: 'prefix', host: 'example.test', path: '/shared' }],
  },
  {
    id: 'ambiguous-b',
    label: 'Ambiguous B',
    aliases: ['Ambiguous B'],
    urls: [{ id: 'ambiguous-b-prefix', mode: 'prefix', host: 'example.test', path: '/shared' }],
  },
]

function baseInput(overrides: Partial<MeasurementReportInput> = {}): MeasurementReportInput {
  return {
    revision: 7,
    ownedHosts: ['example.test'],
    projectAliases: ['Example Living'],
    targets,
    groups: [
      {
        id: 'north-district',
        label: 'North District',
        targetIds: ['north'],
        competitors: [{ id: 'rival-one', label: 'Rival One', aliases: ['Rival One'] }],
      },
      {
        id: 'harbor-city',
        label: 'Harbor City',
        targetIds: ['central', 'harbor'],
        competitors: [
          { id: 'rival-two', label: 'Rival Two', aliases: ['Rival Two'] },
          { id: 'rival-one', label: 'Rival One', aliases: ['Rival One'] },
        ],
      },
    ],
    expectedSlots: [
      {
        id: 'slot-openai',
        executionId: 'exec-shared',
        queryText: 'best apartments near downtown',
        provider: 'openai',
        location: 'Harbor City, EX',
      },
      {
        id: 'slot-gemini',
        executionId: 'exec-shared',
        queryText: 'best apartments near downtown',
        provider: 'gemini',
        location: 'Harbor City, EX',
      },
    ],
    usageEdges: [
      { id: 'edge-north-district', type: 'group', executionId: 'exec-shared', groupId: 'north-district', targetIds: ['north'] },
      { id: 'edge-harbor-city', type: 'group', executionId: 'exec-shared', groupId: 'harbor-city', targetIds: ['central', 'harbor'] },
      { id: 'edge-harbor', type: 'target', executionId: 'exec-shared', targetId: 'harbor', targetIds: ['harbor'] },
    ],
    observations: [
      {
        id: 'observation-openai',
        executionId: 'exec-shared',
        queryText: 'best apartments near downtown',
        provider: 'openai',
        location: 'Harbor City, EX',
        answerText: 'Example Living Harbor and Rival One are common options.',
        citedUrls: ['https://example.test/apartments/example-living-harbor/floorplans'],
        citedUrlsComplete: true,
        historicalCitedUrls: ['https://external.example/ignored-because-direct-wins'],
        historicalCitedUrlsComplete: true,
      },
      {
        id: 'observation-gemini',
        executionId: null,
        queryText: 'best apartments near downtown',
        provider: 'gemini',
        location: '  harbor city,   ex ',
        answerText: 'Rival One and Rival Two are also discussed.',
        citedUrls: null,
        citedUrlsComplete: false,
        historicalCitedUrls: ['https://example.test/apartments/example-living-north'],
        historicalCitedUrlsComplete: true,
      },
    ],
    ...overrides,
  }
}

describe('classifyCitedUrl', () => {
  it('resolves all six classes against every target before applying the usage edge', () => {
    const edge = { id: 'harbor-edge', type: 'target' as const, executionId: 'exec', targetId: 'harbor', targetIds: ['harbor'] }
    const cases = [
      ['https://example.test/apartments/example-living-harbor/floorplans', 'assigned-target'],
      ['https://www.example.test/apartments/example-living-harbor/floorplans', 'assigned-target'],
      ['https://example.test/apartments/example-living-north', 'sibling-target'],
      ['https://example.test/blog/summer', 'owned-unmapped'],
      ['https://external.example/article', 'external'],
      ['https://example.test/shared/article', 'ambiguous'],
      ['not a URL', 'invalid'],
    ] as const

    expect(cases.map(([url]) => classifyCitedUrl(url, targets, ['example.test'], edge).classification))
      .toEqual(cases.map(([, classification]) => classification))
  })

  it('classifies the same owned route relative to each usage edge', () => {
    const url = 'https://example.test/apartments/example-living-north'
    const assigned = classifyCitedUrl(url, targets, ['example.test'], {
      id: 'north-edge', type: 'target', executionId: 'exec', targetId: 'north', targetIds: ['north'],
    })
    const sibling = classifyCitedUrl(url, targets, ['example.test'], {
      id: 'harbor-edge', type: 'target', executionId: 'exec', targetId: 'harbor', targetIds: ['harbor'],
    })

    expect(assigned).toMatchObject({ classification: 'assigned-target', matchedTargetIds: ['north'] })
    expect(sibling).toMatchObject({ classification: 'sibling-target', matchedTargetIds: ['north'] })
  })
})
describe('legacy execution bridging', () => {
  it('normalizes location and bridges only a unique query/provider/location slot', () => {
    expect(normalizeMeasurementLocation('  Harbor City,   EX ')).toBe('harbor city, ex')
    const report = buildMeasurementReport(baseInput())

    expect(report.diagnostics.bridgedObservationIds).toEqual(['observation-gemini'])
    expect(report.diagnostics.ambiguousObservationIds).toEqual([])
    expect(report.evidence.find(row => row.observationId === 'observation-gemini')).toMatchObject({
      expectedSlotId: 'slot-gemini',
      bridged: true,
      historical: true,
    })
  })

  it('withholds duplicate and multiply-matched legacy observations', () => {
    const duplicateSlot = {
      id: 'slot-gemini-duplicate', executionId: 'exec-duplicate', queryText: 'best apartments near downtown', provider: 'gemini', location: 'Harbor City, EX',
    }
    const ambiguous = buildMeasurementReport(baseInput({
      expectedSlots: [...baseInput().expectedSlots, duplicateSlot],
      usageEdges: [
        ...baseInput().usageEdges,
        { id: 'edge-duplicate', type: 'group', executionId: 'exec-duplicate', groupId: 'harbor-city', targetIds: ['harbor'] },
      ],
    }))
    expect(ambiguous.diagnostics.ambiguousObservationIds).toEqual(['observation-gemini'])
    expect(ambiguous.groups.find(group => group.id === 'harbor-city')?.completeness).toMatchObject({ executed: 1, expected: 3, complete: false })

    const duplicateObservation = {
      ...baseInput().observations[1]!,
      id: 'observation-gemini-copy',
    }
    const duplicated = buildMeasurementReport(baseInput({
      observations: [...baseInput().observations, duplicateObservation],
    }))
    expect(duplicated.diagnostics.ambiguousObservationIds).toEqual([
      'observation-gemini',
      'observation-gemini-copy',
    ])
    expect(duplicated.diagnostics.bridgedObservationIds).toEqual([])
  })
})

describe('buildMeasurementReport', () => {
  it('keeps group and target populations separate while preserving cross-wired drill-down evidence', () => {
    const report = buildMeasurementReport(baseInput())
    const northDistrict = report.groups.find(group => group.id === 'north-district')!
    const harborCity = report.groups.find(group => group.id === 'harbor-city')!
    const harbor = report.targets.find(target => target.id === 'harbor')!

    expect(harborCity.completeness).toMatchObject({ executed: 2, expected: 2, complete: true, sourceComplete: true })
    expect(harborCity.answerCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(harborCity.targetCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(northDistrict.answerCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(harbor.citationCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })

    expect(report.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observationId: 'observation-gemini', usageEdgeId: 'edge-north-district',
        classification: 'assigned-target', matchedTargetIds: ['north'],
      }),
      expect.objectContaining({
        observationId: 'observation-gemini', usageEdgeId: 'edge-harbor-city',
        classification: 'sibling-target', matchedTargetIds: ['north'],
      }),
    ]))

    expect(harborCity.providers).toEqual([
      expect.objectContaining({ provider: 'gemini', answerCoverage: { numerator: 0, denominator: 1, rate: 0 } }),
      expect.objectContaining({ provider: 'openai', answerCoverage: { numerator: 1, denominator: 1, rate: 1 } }),
    ])
  })

  it('withholds URL rates for missing slots or incomplete source evidence', () => {
    const missing = buildMeasurementReport(baseInput({ observations: [baseInput().observations[0]!] }))
    expect(missing.groups.find(group => group.id === 'harbor-city')).toMatchObject({
      completeness: { executed: 1, expected: 2, complete: false },
      answerCoverage: { numerator: 1, denominator: 2, rate: null, reason: 'incomplete' },
    })

    const evidenceIncomplete = buildMeasurementReport(baseInput({
      observations: baseInput().observations.map(observation => observation.id === 'observation-gemini'
        ? { ...observation, historicalCitedUrlsComplete: false }
        : observation),
    }))
    expect(evidenceIncomplete.groups.find(group => group.id === 'harbor-city')).toMatchObject({
      completeness: { executed: 2, expected: 2, complete: true, sourceComplete: false },
      answerCoverage: { numerator: 1, denominator: 2, rate: null, reason: 'evidence-incomplete' },
    })
    expect(evidenceIncomplete.diagnostics.evidenceIncompleteObservationIds).toEqual(['observation-gemini'])
  })

  it('uses longest token-aware aliases, supports multiple mentions, and returns N/A for alias-less targets', () => {
    const mentionTargets: MeasurementTargetInput[] = [
      { id: 'long', label: 'Long', aliases: ['Example Living Harbor'], urls: [] },
      { id: 'short', label: 'Short', aliases: ['Harbor'], urls: [] },
      { id: 'north', label: 'North', aliases: ['North'], urls: [] },
      { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] },
    ]
    const report = buildMeasurementReport({
      revision: 1,
      ownedHosts: ['example.test'],
      projectAliases: ['Example Living'],
      targets: mentionTargets,
      groups: [],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: mentionTargets.map(target => ({
        id: `edge-${target.id}`, type: 'target' as const, executionId: 'exec', targetId: target.id, targetIds: [target.id],
      })),
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Example Living Harbor is compared with North.', citedUrls: [], citedUrlsComplete: true,
      }],
    })

    expect(report.targets.find(target => target.id === 'long')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'short')?.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(report.targets.find(target => target.id === 'north')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'aliasless')?.mentionCoverage).toEqual({
      numerator: 0, denominator: 1, rate: null, reason: 'aliasless',
    })
  })

  it('computes revision-frozen competitor SoV with provider breakdown', () => {
    const report = buildMeasurementReport(baseInput())
    const harborCity = report.groups.find(group => group.id === 'harbor-city')!

    expect(harborCity.sov).toMatchObject({
      projectMentions: 1,
      competitorMentions: 3,
      denominator: 4,
      rate: 0.25,
      competitors: [
        { id: 'rival-one', label: 'Rival One', mentions: 2 },
        { id: 'rival-two', label: 'Rival Two', mentions: 1 },
      ],
      providers: [
        { provider: 'gemini', projectMentions: 0, competitorMentions: 2, denominator: 2, rate: 0 },
        { provider: 'openai', projectMentions: 1, competitorMentions: 1, denominator: 2, rate: 0.5 },
      ],
    })
  })

  it('returns deterministic output independent of input ordering', () => {
    const input = baseInput()
    const shuffled: MeasurementReportInput = {
      ...input,
      ownedHosts: [...input.ownedHosts].reverse(),
      targets: [...input.targets].reverse().map(target => ({ ...target, urls: [...target.urls].reverse(), aliases: [...target.aliases].reverse() })),
      groups: [...input.groups].reverse().map(group => ({
        ...group,
        targetIds: [...group.targetIds].reverse(),
        competitors: [...group.competitors].reverse(),
      })),
      expectedSlots: [...input.expectedSlots].reverse(),
      usageEdges: [...input.usageEdges].reverse(),
      observations: [...input.observations].reverse(),
    }

    expect(buildMeasurementReport(shuffled)).toEqual(buildMeasurementReport(input))
  })

  it('resolves and reports a 213-target portfolio without changing the denominator', () => {
    const portfolioTargets: MeasurementTargetInput[] = Array.from({ length: 213 }, (_, index) => ({
      id: `property-${String(index).padStart(3, '0')}`,
      label: `Property ${index}`,
      aliases: [`Property ${index}`],
      urls: [{
        id: `property-${index}-url`,
        mode: 'prefix' as const,
        host: 'portfolio.example',
        path: `/apartments/property-${index}`,
      }],
    }))
    const targetIds = portfolioTargets.map(target => target.id)
    const report = buildMeasurementReport({
      revision: 1,
      ownedHosts: ['portfolio.example'],
      projectAliases: ['Portfolio'],
      targets: portfolioTargets,
      groups: [{ id: 'portfolio', label: 'Portfolio', targetIds, competitors: [] }],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: [{ id: 'edge', type: 'group', executionId: 'exec', groupId: 'portfolio', targetIds }],
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Property 212', citedUrls: ['https://portfolio.example/apartments/property-212/floorplans'], citedUrlsComplete: true,
      }],
    })

    expect(report.groups[0]?.answerCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.groups[0]?.targetCoverage).toEqual({ numerator: 1, denominator: 213, rate: 1 / 213 })
    expect(report.evidence[0]).toMatchObject({ classification: 'assigned-target', matchedTargetIds: ['property-212'] })
  })
})
