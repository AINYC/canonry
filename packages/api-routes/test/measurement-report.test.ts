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
    id: 'north',
    label: 'Northstar North',
    aliases: ['Northstar North', 'North'],
    urls: [{ id: 'north-url', mode: 'prefix', host: 'northstar.example', path: '/locations/north' }],
  },
  {
    id: 'harbor',
    label: 'Northstar Harbor',
    aliases: ['Northstar Harbor', 'Harbor'],
    urls: [{ id: 'harbor-url', mode: 'prefix', host: 'northstar.example', path: '/locations/harbor' }],
  },
  {
    id: 'shared-a',
    label: 'Shared A',
    aliases: ['Shared A'],
    urls: [{ id: 'shared-a-url', mode: 'prefix', host: 'northstar.example', path: '/shared' }],
  },
  {
    id: 'shared-b',
    label: 'Shared B',
    aliases: ['Shared B'],
    urls: [{ id: 'shared-b-url', mode: 'prefix', host: 'northstar.example', path: '/shared' }],
  },
]

function baseInput(overrides: Partial<MeasurementReportInput> = {}): MeasurementReportInput {
  return {
    revision: 7,
    ownedHosts: ['northstar.example'],
    projectBrandNames: ['Northstar'],
    projectDomain: 'northstar.example',
    targets,
    groups: [
      {
        id: 'north-region',
        label: 'North region',
        targetIds: ['north'],
        competitors: [{ domain: 'challenger.example', aliases: ['Challenger'] }],
      },
      {
        id: 'harbor-region',
        label: 'Harbor region',
        targetIds: ['north', 'harbor'],
        competitors: [{ domain: 'challenger.example', aliases: ['Challenger'] }],
      },
    ],
    expectedSlots: [
      { id: 'slot-openai', executionId: 'exec-shared', queryText: 'service near harbor', provider: 'openai', location: 'Harbor, EX' },
      { id: 'slot-gemini', executionId: 'exec-shared', queryText: 'service near harbor', provider: 'gemini', location: 'Harbor, EX' },
    ],
    usageEdges: [
      { id: 'baseline', type: 'baseline', executionId: 'exec-shared' },
      { id: 'north-edge', type: 'target', executionId: 'exec-shared', targetId: 'north' },
      { id: 'harbor-edge', type: 'target', executionId: 'exec-shared', targetId: 'harbor' },
    ],
    observations: [
      {
        id: 'observation-openai', executionId: 'exec-shared', queryText: 'service near harbor', provider: 'openai', location: 'Harbor, EX',
        answerText: 'Northstar Harbor and Challenger are comparable.',
        citedUrls: ['https://northstar.example/locations/harbor/details'], citedUrlsComplete: true,
      },
      {
        id: 'observation-gemini', executionId: null, queryText: 'service near harbor', provider: 'gemini', location: '  harbor,   ex ',
        answerText: 'Northstar North is another option.',
        citedUrls: null, citedUrlsComplete: false,
        historicalCitedUrls: ['https://northstar.example/locations/north'], historicalCitedUrlsComplete: true,
      },
    ],
    ...overrides,
  }
}

describe('attribution', () => {
  it('prefers exact over prefix over host and honors configured path case', () => {
    const routeTarget: MeasurementTargetInput = {
      id: 'route-target', label: 'Route target', aliases: [],
      urls: [
        { id: 'host', mode: 'host', host: 'northstar.example' },
        { id: 'prefix', mode: 'prefix', host: 'northstar.example', path: '/locations', pathCase: 'insensitive' },
        { id: 'exact', mode: 'exact', host: 'northstar.example', path: '/locations/Harbor' },
      ],
    }
    const edge = { id: 'route-edge', type: 'target' as const, executionId: 'exec', targetId: 'route-target' }

    expect(classifyCitedUrl('https://northstar.example/locations/Harbor', [routeTarget], [], edge))
      .toMatchObject({ classification: 'assigned', matchedUrlIds: ['exact'] })
    expect(classifyCitedUrl('https://northstar.example/locations/harbor/child', [routeTarget], [], edge))
      .toMatchObject({ classification: 'assigned', matchedUrlIds: ['prefix'] })
    expect(classifyCitedUrl('https://northstar.example/elsewhere', [routeTarget], [], edge))
      .toMatchObject({ classification: 'assigned', matchedUrlIds: ['host'] })
  })

  it('assigns all six stable attribution classes', () => {
    const targetEdge = { id: 'harbor-edge', type: 'target' as const, executionId: 'exec', targetId: 'harbor' }
    const cases = [
      ['https://northstar.example/locations/harbor/details', 'assigned'],
      ['https://northstar.example/locations/north', 'sibling'],
      ['https://northstar.example/unmapped', 'ownedUnmapped'],
      ['https://outside.example/article', 'external'],
      ['https://northstar.example/shared/article', 'ambiguous'],
      ['not a url', 'invalid'],
    ] as const

    expect(cases.map(([url]) => classifyCitedUrl(url, targets, ['northstar.example'], targetEdge).classification))
      .toEqual(cases.map(([, classification]) => classification))
  })

  it('classifies a matched URL relative to its target edge', () => {
    const url = 'https://northstar.example/locations/north'
    expect(classifyCitedUrl(url, targets, ['northstar.example'], {
      id: 'north-edge', type: 'target', executionId: 'exec', targetId: 'north',
    }).classification).toBe('assigned')
    expect(classifyCitedUrl(url, targets, ['northstar.example'], {
      id: 'harbor-edge', type: 'target', executionId: 'exec', targetId: 'harbor',
    }).classification).toBe('sibling')
  })
})

describe('report kernel', () => {
  it('bridges a unique historical observation without a route or live provider read', () => {
    expect(normalizeMeasurementLocation('  Harbor,   EX ')).toBe('harbor, ex')

    const report = buildMeasurementReport(baseInput())

    expect(report.diagnostics.bridgedObservationIds).toEqual(['observation-gemini'])
    expect(report.evidence.find(row => row.observationId === 'observation-gemini')).toMatchObject({
      expectedSlotId: 'slot-gemini', bridged: true, historical: true,
    })
  })

  it('derives reporting-group population from target edges and deduplicates a shared execution', () => {
    const report = buildMeasurementReport(baseInput())
    const group = report.groups.find(candidate => candidate.id === 'harbor-region')!

    expect(group.targetIds).toEqual(['harbor', 'north'])
    expect(group.completeness).toEqual({ executed: 2, expected: 2, complete: true, sourceComplete: true, answerComplete: true })
    expect(group.answerCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(group.targetCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(report.evidence.filter(row => row.usageEdgeType === 'target')).toHaveLength(4)
    expect(report.evidence.some(row => row.usageEdgeId === 'baseline')).toBe(true)
  })

  it('returns null numerator, denominator, and rate together for incomplete evidence', () => {
    const report = buildMeasurementReport(baseInput({ observations: [baseInput().observations[0]!] }))
    const group = report.groups.find(candidate => candidate.id === 'harbor-region')!

    expect(group.completeness).toMatchObject({ executed: 1, expected: 2, complete: false })
    expect(group.answerCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
    expect(group.targetCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
    expect(report.targets.find(target => target.id === 'harbor')?.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
  })

  it('keeps every unavailable rate structurally null', () => {
    const evidenceIncomplete = buildMeasurementReport(baseInput({
      observations: baseInput().observations.map(observation => observation.id === 'observation-gemini'
        ? { ...observation, historicalCitedUrlsComplete: false }
        : observation),
    }))
    expect(evidenceIncomplete.groups.find(candidate => candidate.id === 'north-region')?.answerCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })

    const noPopulation = buildMeasurementReport(baseInput({
      groups: [{ id: 'empty', label: 'Empty', targetIds: ['not-a-target'], competitors: [] }],
    }))
    expect(noPopulation.groups[0]?.answerCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'no-population' })

    const aliaslessTarget: MeasurementTargetInput = { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] }
    const aliasless = buildMeasurementReport(baseInput({
      targets: [...targets, aliaslessTarget],
      usageEdges: [...baseInput().usageEdges, { id: 'aliasless-edge', type: 'target', executionId: 'exec-shared', targetId: 'aliasless' }],
    }))
    expect(aliasless.targets.find(target => target.id === 'aliasless')?.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'aliasless' })
  })

  it('keeps project and competitor answer presence symmetric and revision-pinned', () => {
    const report = buildMeasurementReport(baseInput())
    const group = report.groups.find(candidate => candidate.id === 'north-region')!

    expect(group.sov.domains).toEqual([
      { domain: 'northstar.example', own: true, presentIn: 2, of: 2 },
      { domain: 'challenger.example', own: false, presentIn: 1, of: 2 },
    ])
    expect(group.sov.providers).toEqual([
      {
        provider: 'gemini',
        domains: [
          { domain: 'northstar.example', own: true, presentIn: 1, of: 1 },
          { domain: 'challenger.example', own: false, presentIn: 0, of: 1 },
        ],
      },
      {
        provider: 'openai',
        domains: [
          { domain: 'northstar.example', own: true, presentIn: 1, of: 1 },
          { domain: 'challenger.example', own: false, presentIn: 1, of: 1 },
        ],
      },
    ])

    const renamedTarget = buildMeasurementReport(baseInput({
      targets: targets.map(target => target.id === 'north' ? { ...target, label: 'Renamed target', aliases: ['Renamed target'] } : target),
    }))
    expect(renamedTarget.groups.find(candidate => candidate.id === 'north-region')?.sov.domains)
      .toEqual(group.sov.domains)
  })

  it('does not bridge an observation when its historical slot key is ambiguous', () => {
    const report = buildMeasurementReport(baseInput({
      expectedSlots: [
        ...baseInput().expectedSlots,
        { id: 'slot-gemini-duplicate', executionId: 'other-execution', queryText: 'service near harbor', provider: 'gemini', location: 'Harbor, EX' },
      ],
    }))

    expect(report.diagnostics.ambiguousObservationIds).toEqual(['observation-gemini'])
    expect(report.diagnostics.bridgedObservationIds).toEqual([])
  })

  it('withholds duplicate observations for one expected slot', () => {
    const duplicate = { ...baseInput().observations[0]!, id: 'observation-openai-duplicate' }
    const report = buildMeasurementReport(baseInput({ observations: [...baseInput().observations, duplicate] }))

    expect(report.diagnostics.ambiguousObservationIds).toEqual(['observation-openai', 'observation-openai-duplicate'])
    expect(report.evidence.some(row => row.expectedSlotId === 'slot-openai')).toBe(false)
  })

  it('uses the longest token-aware target alias and returns aliasless N/A', () => {
    const mentionTargets: MeasurementTargetInput[] = [
      { id: 'long', label: 'Long', aliases: ['Northstar Harbor'], urls: [] },
      { id: 'short', label: 'Short', aliases: ['Harbor'], urls: [] },
      { id: 'north', label: 'North', aliases: ['North'], urls: [] },
      { id: 'aliasless', label: 'Aliasless', aliases: [], urls: [] },
    ]
    const report = buildMeasurementReport({
      revision: 1, ownedHosts: ['northstar.example'], projectBrandNames: ['Northstar'], projectDomain: 'northstar.example',
      targets: mentionTargets, groups: [],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: mentionTargets.map(target => ({ id: `edge-${target.id}`, type: 'target' as const, executionId: 'exec', targetId: target.id })),
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Northstar Harbor is compared with North.', citedUrls: [], citedUrlsComplete: true,
      }],
    })

    expect(report.targets.find(target => target.id === 'long')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'short')?.mentionCoverage).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(report.targets.find(target => target.id === 'north')?.mentionCoverage).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(report.targets.find(target => target.id === 'aliasless')?.mentionCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'aliasless' })
  })

  it('is deterministic when plan and observation collections are reordered', () => {
    const input = baseInput()
    const shuffled: MeasurementReportInput = {
      ...input,
      ownedHosts: [...input.ownedHosts].reverse(),
      targets: [...input.targets].reverse().map(target => ({ ...target, aliases: [...target.aliases].reverse(), urls: [...target.urls].reverse() })),
      groups: [...input.groups].reverse().map(group => ({ ...group, targetIds: [...group.targetIds].reverse(), competitors: [...group.competitors].reverse() })),
      expectedSlots: [...input.expectedSlots].reverse(),
      usageEdges: [...input.usageEdges].reverse(),
      observations: [...input.observations].reverse(),
    }

    expect(buildMeasurementReport(shuffled)).toEqual(buildMeasurementReport(input))
  })

  it('keeps a 200-target reporting denominator while deduplicating one shared execution', () => {
    const portfolioTargets: MeasurementTargetInput[] = Array.from({ length: 200 }, (_, index) => ({
      id: `target-${String(index).padStart(3, '0')}`,
      label: `Target ${index}`,
      aliases: [`Target ${index}`],
      urls: [{ id: `target-${index}-url`, mode: 'prefix', host: 'portfolio.example', path: `/targets/target-${index}` }],
    }))
    const targetIds = portfolioTargets.map(target => target.id)
    const report = buildMeasurementReport({
      revision: 1, ownedHosts: ['portfolio.example'], projectBrandNames: ['Portfolio'], projectDomain: 'portfolio.example',
      targets: portfolioTargets,
      groups: [{ id: 'portfolio', label: 'Portfolio', targetIds, competitors: [] }],
      expectedSlots: [{ id: 'slot', executionId: 'exec', queryText: 'query', provider: 'openai', location: null }],
      usageEdges: portfolioTargets.map(target => ({ id: `edge-${target.id}`, type: 'target' as const, executionId: 'exec', targetId: target.id })),
      observations: [{
        id: 'observation', executionId: 'exec', queryText: 'query', provider: 'openai', location: null,
        answerText: 'Target 199', citedUrls: ['https://portfolio.example/targets/target-199/details'], citedUrlsComplete: true,
      }],
    })

    expect(report.groups[0]?.completeness).toMatchObject({ executed: 1, expected: 1, complete: true })
    expect(report.groups[0]?.targetCoverage).toEqual({ numerator: 1, denominator: 200, rate: 1 / 200 })
    expect(report.evidence.filter(row => row.usageEdgeType === 'target')).toHaveLength(200)
  })
})
