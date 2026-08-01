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
    id: 'raven',
    label: 'Cortland at Raven',
    aliases: ['Raven'],
    urls: [{ id: 'raven-exact', mode: 'exact', host: 'cortland.com', path: '/apartments/cortland-at-raven' }],
  },
  {
    id: 'rosslyn',
    label: 'Cortland Rosslyn',
    aliases: ['Rosslyn'],
    urls: [{ id: 'rosslyn-prefix', mode: 'prefix', host: 'cortland.com', path: '/apartments/cortland-rosslyn' }],
  },
  {
    id: 'west',
    label: 'Cortland at West Village',
    aliases: ['West Village', 'Cortland at West Village'],
    urls: [
      { id: 'west-primary', mode: 'prefix', host: 'cortland.com', path: '/apartments/cortland-at-west-village' },
      { id: 'west-alias', mode: 'prefix', host: 'apartments.cortland.com', path: '/cortland-at-west-village' },
    ],
  },
  {
    id: 'ambiguous-a',
    label: 'Ambiguous A',
    aliases: ['Ambiguous A'],
    urls: [{ id: 'ambiguous-a-prefix', mode: 'prefix', host: 'cortland.com', path: '/shared' }],
  },
  {
    id: 'ambiguous-b',
    label: 'Ambiguous B',
    aliases: ['Ambiguous B'],
    urls: [{ id: 'ambiguous-b-prefix', mode: 'prefix', host: 'cortland.com', path: '/shared' }],
  },
]

function baseInput(overrides: Partial<MeasurementReportInput> = {}): MeasurementReportInput {
  return {
    revision: 7,
    ownedHosts: ['cortland.com'],
    projectAliases: ['Cortland'],
    targets,
    groups: [
      {
        id: 'arlington',
        label: 'Arlington',
        targetIds: ['rosslyn'],
        competitors: [{ id: 'greystar', label: 'Greystar', aliases: ['Greystar'] }],
      },
      {
        id: 'dallas',
        label: 'Dallas',
        targetIds: ['raven', 'west'],
        competitors: [
          { id: 'camden', label: 'Camden', aliases: ['Camden'] },
          { id: 'greystar', label: 'Greystar', aliases: ['Greystar'] },
        ],
      },
    ],
    expectedSlots: [
      {
        id: 'slot-openai',
        executionId: 'exec-shared',
        queryText: 'best apartments near downtown',
        provider: 'openai',
        location: 'Dallas, TX',
      },
      {
        id: 'slot-gemini',
        executionId: 'exec-shared',
        queryText: 'best apartments near downtown',
        provider: 'gemini',
        location: 'Dallas, TX',
      },
    ],
    usageEdges: [
      { id: 'edge-arlington', type: 'group', executionId: 'exec-shared', groupId: 'arlington', targetIds: ['rosslyn'] },
      { id: 'edge-dallas', type: 'group', executionId: 'exec-shared', groupId: 'dallas', targetIds: ['raven', 'west'] },
      { id: 'edge-west', type: 'target', executionId: 'exec-shared', targetId: 'west', targetIds: ['west'] },
    ],
    observations: [
      {
        id: 'observation-openai',
        executionId: 'exec-shared',
        queryText: 'best apartments near downtown',
        provider: 'openai',
        location: 'Dallas, TX',
        answerText: 'Cortland at West Village and Greystar are common options.',
        citedUrls: ['https://cortland.com/apartments/cortland-at-west-village/floorplans'],
        citedUrlsComplete: true,
        historicalCitedUrls: ['https://external.example/ignored-because-direct-wins'],
        historicalCitedUrlsComplete: true,
      },
      {
        id: 'observation-gemini',
        executionId: null,
        queryText: 'best apartments near downtown',
        provider: 'gemini',
        location: '  dallas,   tx ',
        answerText: 'Greystar and Camden are also discussed.',
        citedUrls: null,
        citedUrlsComplete: false,
        historicalCitedUrls: ['https://cortland.com/apartments/cortland-rosslyn'],
        historicalCitedUrlsComplete: true,
      },
    ],
    ...overrides,
  }
}

describe('classifyCitedUrl', () => {
  it('resolves all six classes against every target before applying the usage edge', () => {
    const edge = { id: 'west-edge', type: 'target' as const, executionId: 'exec', targetId: 'west', targetIds: ['west'] }
    const cases = [
      ['https://cortland.com/apartments/cortland-at-west-village/floorplans', 'assigned-target'],
      ['https://www.cortland.com/apartments/cortland-at-west-village/floorplans', 'assigned-target'],
      ['https://cortland.com/apartments/cortland-rosslyn', 'sibling-target'],
      ['https://cortland.com/blog/summer', 'owned-unmapped'],
      ['https://external.example/article', 'external'],
      ['https://cortland.com/shared/article', 'ambiguous'],
      ['not a URL', 'invalid'],
    ] as const

    expect(cases.map(([url]) => classifyCitedUrl(url, targets, ['cortland.com'], edge).classification))
      .toEqual(cases.map(([, classification]) => classification))
  })

  it('classifies the same owned route relative to each usage edge', () => {
    const url = 'https://cortland.com/apartments/cortland-rosslyn'
    const assigned = classifyCitedUrl(url, targets, ['cortland.com'], {
      id: 'rosslyn-edge', type: 'target', executionId: 'exec', targetId: 'rosslyn', targetIds: ['rosslyn'],
    })
    const sibling = classifyCitedUrl(url, targets, ['cortland.com'], {
      id: 'west-edge', type: 'target', executionId: 'exec', targetId: 'west', targetIds: ['west'],
    })

    expect(assigned).toMatchObject({ classification: 'assigned-target', matchedTargetIds: ['rosslyn'] })
    expect(sibling).toMatchObject({ classification: 'sibling-target', matchedTargetIds: ['rosslyn'] })
  })
})

describe('legacy execution bridging', () => {
  it('normalizes location and bridges only a unique query/provider/location slot', () => {
    expect(normalizeMeasurementLocation('  Dallas,   TX ')).toBe('dallas, tx')
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
      id: 'slot-gemini-duplicate', executionId: 'exec-duplicate', queryText: 'best apartments near downtown', provider: 'gemini', location: 'Dallas, TX',
    }
    const ambiguous = buildMeasurementReport(baseInput({
      expectedSlots: [...baseInput().expectedSlots, duplicateSlot],
      usageEdges: [
        ...baseInput().usageEdges,
        { id: 'edge-duplicate', type: 'group', executionId: 'exec-duplicate', groupId: 'dallas', targetIds: ['west'] },
      ],
    }))
    expect(ambiguous.diagnostics.ambiguousObservationIds).toEqual(['observation-gemini'])
    expect(ambiguous.groups.find(group => group.id === 'dallas')?.completeness).toMatchObject({ executed: 1, expected: 3, complete: false })

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
    const arlington = report.groups.find(group => group.id === 'arlington')!
    const dallas = report.groups.find(group => group.id === 'dallas')!
    const west = report.targets.find(target => target.id === 'west')!

    expect(dallas.completeness).toMatchObject({ executed: 2, expected: 2, complete: true, sourceComplete: true })
    expect(dallas.answerCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(dallas.targetCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(arlington.answerCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect(west.citationCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })

    expect(report.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observationId: 'observation-gemini', usageEdgeId: 'edge-arlington',
        classification: 'assigned-target', matchedTargetIds: ['rosslyn'],
      }),
      expect.objectContaining({
        observationId: 'observation-gemini', usageEdgeId: 'edge-dallas',
        classification: 'sibling-target', matchedTargetIds: ['rosslyn'],
      }),
    ]))

    expect(dallas.providers).toEqual([
      expect.objectContaining({ provider: 'gemini', answerCoverage: { numerator: 0, denominator: 1, rate: 0 } }),
      expect.objectContaining({ provider: 'openai', answerCoverage: { numerator: 1, denominator: 1, rate: 1 } }),
    ])
  })

  it('withholds URL rates for missing slots or incomplete source evidence', () => {
    const missing = buildMeasurementReport(baseInput({ observations: [baseInput().observations[0]!] }))
    expect(missing.groups.find(group => group.id === 'dallas')).toMatchObject({
      completeness: { executed: 1, expected: 2, complete: false },
      answerCoverage: { numerator: 1, denominator: 2, rate: null, reason: 'incomplete' },
    })

    const evidenceIncomplete = buildMeasurementReport(baseInput({
      observations: baseInput().observations.map(observation => observation.id === 'observation-gemini'
        ? { ...observation, historicalCitedUrlsComplete: false }
        : observation),
    }))
    expect(evidenceIncomplete.groups.find(group => group.id === 'dallas')).toMatchObject({
      completeness: { executed: 2, expected: 2, complete: true, sourceComplete: false },
      answerCoverage: { numerator: 1, denominator: 2, rate: null, reason: 'evidence-incomplete' },
    })
    expect(evidenceIncomplete.diagnostics.evidenceIncompleteObservationIds).toEqual(['observation-gemini'])
  })

  it('uses longest token-aware aliases, supports multiple mentions, and returns N/A for alias-less targets', () => {
    const mentionTargets: MeasurementTargetInput[] = [
      { id: 'long', label: 'Long', aliases: ['Cortland at West Village'], urls: [] },
      { id: 'short', label: 'Short', aliases: ['West Village'], urls: [] },
      { id: 'rosslyn', label: 'Rosslyn', aliases: ['Rosslyn'], urls: [] },
      { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] },
    ]
    const report = buildMeasurementReport({
      revision: 1,
      ownedHosts: ['cortland.com'],
      projectAliases: ['Cortland'],
      targets: mentionTargets,
      groups: [],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: mentionTargets.map(target => ({
        id: `edge-${target.id}`, type: 'target' as const, executionId: 'exec', targetId: target.id, targetIds: [target.id],
      })),
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Cortland at West Village is compared with Rosslyn.', citedUrls: [], citedUrlsComplete: true,
      }],
    })

    expect(report.targets.find(target => target.id === 'long')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'short')?.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(report.targets.find(target => target.id === 'rosslyn')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'aliasless')?.mentionCoverage).toEqual({
      numerator: 0, denominator: 1, rate: null, reason: 'aliasless',
    })
  })

  it('computes revision-frozen competitor SoV with provider breakdown', () => {
    const report = buildMeasurementReport(baseInput())
    const dallas = report.groups.find(group => group.id === 'dallas')!

    expect(dallas.sov).toMatchObject({
      projectMentions: 1,
      competitorMentions: 3,
      denominator: 4,
      rate: 0.25,
      competitors: [
        { id: 'camden', label: 'Camden', mentions: 1 },
        { id: 'greystar', label: 'Greystar', mentions: 2 },
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
