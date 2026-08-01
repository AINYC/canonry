import { describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  MeasurementPlanValidationError,
  matchesMeasurementTargetUrl,
  measurementPlanInputSchema,
  normalizeMeasurementPathPrefix,
  parseStoredMeasurementPlan,
  resolveMeasurementTarget,
  type MeasurementPlanInput,
} from '../src/measurement-plan.js'

const ATLANTA = { label: 'atlanta', city: 'Atlanta', region: 'GA', country: 'US' }

const CONTEXT = {
  canonicalDomain: 'https://www.cortland.com/',
  ownedDomains: ['ava-decatur.cortland.com'],
  brandNames: ['Cortland'],
  defaultContext: ATLANTA,
  locations: [ATLANTA],
  trackedQueries: [
    { id: 'q-ava', query: 'ava decatur reviews' },
    { id: 'q-best', query: 'best apartments in atlanta' },
    { id: 'q-cortland', query: 'cortland apartments' },
  ],
}

const PLAN: MeasurementPlanInput = {
  schemaVersion: 1,
  targets: [
    {
      stableKey: 'ava-decatur',
      label: 'AVA Decatur',
      urls: [
        { kind: 'prefix', host: 'cortland.com', pathPrefix: '/apartments/ava-decatur', pathCase: 'insensitive' },
        { kind: 'host', host: 'ava-decatur.cortland.com' },
      ],
      aliases: ['AVA Decatur'],
      metadata: { market: 'Atlanta', state: 'GA' },
    },
    {
      stableKey: 'cortland-decatur',
      label: 'Cortland Decatur',
      urls: [{ kind: 'prefix', host: 'cortland.com', pathPrefix: '/apartments/cortland-decatur', pathCase: 'sensitive' }],
      aliases: [],
    },
  ],
  groups: [{
    stableKey: 'atlanta',
    label: 'Atlanta portfolio',
    targetKeys: ['ava-decatur'],
    competitors: ['Greystar.com'],
  }],
  targetQuerySelections: [
    { targetKey: 'ava-decatur', queryIds: ['q-ava', 'q-best'] },
    { targetKey: 'cortland-decatur', queryIds: ['q-best'], context: null },
  ],
}

function copyPlan(): MeasurementPlanInput {
  return structuredClone(PLAN)
}

function compile(input = copyPlan()) {
  return compileMeasurementPlan(input, CONTEXT)
}

function validationError(action: () => unknown): MeasurementPlanValidationError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(MeasurementPlanValidationError)
    return error as MeasurementPlanValidationError
  }
  throw new Error('Expected validation failure')
}

describe('Target measurement plan v1 authoring', () => {
  it('accepts a generic Cortland-like target plan without cohort or lane concepts', () => {
    const parsed = measurementPlanInputSchema.parse(PLAN)

    expect(parsed).toEqual(expect.objectContaining({
      schemaVersion: 1,
      targets: expect.arrayContaining([expect.objectContaining({ stableKey: 'ava-decatur' })]),
      groups: expect.arrayContaining([expect.objectContaining({ stableKey: 'atlanta' })]),
      targetQuerySelections: expect.arrayContaining([expect.objectContaining({ targetKey: 'ava-decatur' })]),
    }))
    expect(JSON.stringify(parsed)).not.toContain('branded')
    expect(JSON.stringify(parsed)).not.toContain('generic')
  })

  it('keeps Groups optional while retaining the baseline and Target authoring surfaces', () => {
    const targetOnly = copyPlan()
    delete targetOnly.groups
    const parsed = measurementPlanInputSchema.parse(targetOnly)

    expect(parsed.groups).toEqual([])
  })

  it('keeps query ownership on Targets rather than Groups', () => {
    const groupWithQueries = {
      ...copyPlan(),
      groups: [{
        ...copyPlan().groups![0]!,
        queryIds: ['q-best'],
        context: ATLANTA,
      }],
    }

    expect(measurementPlanInputSchema.safeParse(groupWithQueries).success).toBe(false)
  })

  it('rejects unknown target references and tracked-query references', () => {
    const unknownTarget = copyPlan()
    unknownTarget.groups![0]!.targetKeys = ['gone']
    expect(measurementPlanInputSchema.safeParse(unknownTarget).success).toBe(false)

    const unknownQuery = copyPlan()
    unknownQuery.targetQuerySelections![0]!.queryIds = ['q-gone']
    const error = validationError(() => compile(unknownQuery))
    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Unknown tracked query: q-gone' }),
    ]))
  })

  it('rejects duplicate target and group stable keys', () => {
    const duplicateTarget = copyPlan()
    duplicateTarget.targets.push({ ...duplicateTarget.targets[0]!, label: 'Duplicate' })
    expect(measurementPlanInputSchema.safeParse(duplicateTarget).success).toBe(false)

    const duplicateGroup = copyPlan()
    duplicateGroup.groups!.push({ ...duplicateGroup.groups![0]!, label: 'Duplicate' })
    expect(measurementPlanInputSchema.safeParse(duplicateGroup).success).toBe(false)
  })
})

describe('Target measurement plan v1 compilation', () => {
  it('compiles a 194-Target portfolio into one deduplicated execution graph', () => {
    const trackedQueries = Array.from({ length: 5 }, (_, index) => ({
      id: `q-${index}`,
      query: `portfolio query ${index}`,
    }))
    const targets = Array.from({ length: 194 }, (_, index) => {
      const stableKey = `property-${String(index + 1).padStart(3, '0')}`
      return {
        stableKey,
        label: `Property ${index + 1}`,
        urls: [{
          kind: 'prefix' as const,
          host: 'cortland.com',
          pathPrefix: `/apartments/${stableKey}`,
          pathCase: 'insensitive' as const,
        }],
        aliases: [`Property ${index + 1}`],
      }
    })
    const groups = Array.from({ length: 19 }, (_, index) => ({
      stableKey: `market-${String(index + 1).padStart(2, '0')}`,
      label: `Market ${index + 1}`,
      targetKeys: targets
        .filter((_, targetIndex) => targetIndex % 19 === index)
        .map(target => target.stableKey),
    }))
    const input: MeasurementPlanInput = {
      schemaVersion: 1,
      targets,
      groups,
      targetQuerySelections: targets.map(target => ({
        targetKey: target.stableKey,
        queryIds: ['q-0', 'q-1'],
      })),
    }

    const compiled = compileMeasurementPlan(input, { ...CONTEXT, trackedQueries })

    expect(compiled.targets).toHaveLength(194)
    expect(compiled.groups).toHaveLength(19)
    expect(compiled.executionNodes).toHaveLength(5)
    expect(compiled.usageEdges).toHaveLength(5 + (194 * 2) + (194 * 2))
    expect(compiled.usageEdges.filter(edge => edge.kind === 'baseline')).toHaveLength(5)
    expect(compiled.usageEdges.filter(edge => edge.kind === 'group')).toHaveLength(194 * 2)
  })

  it('freezes query snapshots, unconditional baseline edges, and mention applicability', () => {
    const compiled = compile()

    expect(compiled.querySnapshots).toEqual([
      { queryId: 'q-ava', queryText: 'ava decatur reviews' },
      { queryId: 'q-best', queryText: 'best apartments in atlanta' },
      { queryId: 'q-cortland', queryText: 'cortland apartments' },
    ])
    expect(compiled.usageEdges.filter(edge => edge.kind === 'baseline')).toEqual([
      expect.objectContaining({ kind: 'baseline', queryId: 'q-ava' }),
      expect.objectContaining({ kind: 'baseline', queryId: 'q-best' }),
      expect.objectContaining({ kind: 'baseline', queryId: 'q-cortland' }),
    ])
    const baseline = compiled.usageEdges.find(edge => edge.kind === 'baseline' && edge.queryId === 'q-cortland')!
    expect(compiled.executionNodes.find(node => node.stableKey === baseline.executionNodeKey)?.context).toEqual(ATLANTA)
    expect(compiled.targets.find(target => target.stableKey === 'cortland-decatur')?.mentionNotApplicable).toBe(true)
  })

  it('dedupes identical query/context executions while preserving separate usage edges', () => {
    const compiled = compile()
    const nodes = compiled.executionNodes.filter(node => node.queryText === 'best apartments in atlanta')
    const atlantaNode = nodes.find(node => node.context?.label === 'atlanta')!
    const sharedEdges = compiled.usageEdges.filter(edge => edge.executionNodeKey === atlantaNode.stableKey)

    expect(nodes).toHaveLength(2)
    expect(sharedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'baseline', queryId: 'q-best' }),
      expect.objectContaining({ kind: 'target', targetKey: 'ava-decatur', queryId: 'q-best' }),
      expect.objectContaining({ kind: 'group', groupKey: 'atlanta', targetKey: 'ava-decatur', queryId: 'q-best' }),
    ]))
  })

  it('splits execution nodes by resolved context and rejects conflicting Target/query contexts', () => {
    const compiled = compile()
    expect(compiled.executionNodes.filter(node => node.queryText === 'best apartments in atlanta')).toHaveLength(2)

    const conflict = copyPlan()
    conflict.targetQuerySelections!.push({ targetKey: 'ava-decatur', queryIds: ['q-best'], context: null })
    const error = validationError(() => compile(conflict))
    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Target/query assignment has conflicting resolved contexts' }),
    ]))
  })

  it('produces identical canonical bytes for semantically equivalent orderings', () => {
    const reordered = copyPlan()
    reordered.targets.reverse()
    reordered.groups!.reverse()
    reordered.targetQuerySelections!.reverse()
    reordered.targets.forEach(target => {
      target.urls.reverse()
      target.aliases.reverse()
    })
    reordered.groups!.forEach(group => {
      group.targetKeys.reverse()
      group.competitors?.reverse()
    })
    reordered.targetQuerySelections!.forEach(selection => selection.queryIds.reverse())

    expect(canonicalMeasurementPlanJson(compile(reordered))).toBe(canonicalMeasurementPlanJson(compile()))

    const fragmented = copyPlan()
    fragmented.targetQuerySelections = [
      { targetKey: 'ava-decatur', queryIds: ['q-best'], context: ATLANTA },
      { targetKey: 'ava-decatur', queryIds: ['q-ava'] },
      { targetKey: 'cortland-decatur', queryIds: ['q-best'], context: null },
    ]
    expect(canonicalMeasurementPlanJson(compile(fragmented))).toBe(canonicalMeasurementPlanJson(compile()))
  })

  it('normalizes known owned hosts, competitors, and metadata into the persisted revision', () => {
    const input = copyPlan()
    input.targets[0]!.urls[0] = {
      kind: 'prefix', host: 'HTTPS://WWW.CORTLAND.COM/', pathPrefix: '//apartments///ava-decatur/', pathCase: 'insensitive',
    }
    input.groups![0]!.competitors = ['GREYSTAR.COM', 'greystar.com']
    input.targets[0]!.metadata = { state: 'GA', market: 'Atlanta' }
    const compiled = compile(input)

    expect(compiled.effectiveOwnedHosts).toEqual(['ava-decatur.cortland.com', 'cortland.com'])
    expect(compiled.groups[0]?.competitors).toEqual(['greystar.com'])
    expect(compiled.targets[0]?.metadata).toEqual({ market: 'Atlanta', state: 'GA' })
    expect(compiled.targets.find(target => target.stableKey === 'ava-decatur')?.urls)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'prefix', host: 'cortland.com', pathPrefix: '/apartments/ava-decatur' }),
      ]))
  })

  it('rejects unowned target hosts and owned competitors', () => {
    const unownedTarget = copyPlan()
    unownedTarget.targets[0]!.urls = [{ kind: 'host', host: 'evil.example.com' }]
    expect(() => compile(unownedTarget)).toThrow('Measurement plan validation failed')

    const ownedCompetitor = copyPlan()
    ownedCompetitor.groups![0]!.competitors = ['apartments.cortland.com']
    expect(() => compile(ownedCompetitor)).toThrow('Measurement plan validation failed')
  })
})

describe('Target URL ownership', () => {
  const TARGETS = [
    { stableKey: 'host', urls: [{ kind: 'host' as const, host: 'cortland.com' }] },
    { stableKey: 'prefix', urls: [{ kind: 'prefix' as const, host: 'cortland.com', pathPrefix: '/apartments', pathCase: 'insensitive' as const }] },
    { stableKey: 'nested', urls: [{ kind: 'prefix' as const, host: 'cortland.com', pathPrefix: '/apartments/ava-decatur', pathCase: 'insensitive' as const }] },
    { stableKey: 'exact', urls: [{ kind: 'exact' as const, url: 'https://cortland.com/apartments/ava-decatur/unit-1', pathCase: 'insensitive' as const }] },
  ]

  it('applies exact, longest prefix, then host-only precedence', () => {
    expect(resolveMeasurementTarget('https://cortland.com/apartments/ava-decatur/unit-1', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'exact', matcher: { kind: 'exact' } })
    expect(resolveMeasurementTarget('https://cortland.com/apartments/ava-decatur/unit-2', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'nested', matcher: { kind: 'prefix' } })
    expect(resolveMeasurementTarget('https://cortland.com/apartments/other', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'prefix' })
    expect(resolveMeasurementTarget('https://cortland.com/about', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'host' })
  })

  it('allows nested prefixes, preserves path boundaries, and normalizes URL paths safely', () => {
    expect(normalizeMeasurementPathPrefix('///apartments////ava-decatur///')).toBe('/apartments/ava-decatur')
    expect(() => normalizeMeasurementPathPrefix('/apartments/%2e%2e/admin')).toThrow()
    expect(matchesMeasurementTargetUrl('https://cortland.com//APARTMENTS//AVA-DECATUR/unit-2', TARGETS[2]!.urls[0]!)).toBe(true)
    expect(matchesMeasurementTargetUrl('https://cortland.com/apartments/ava-decatur-north', TARGETS[2]!.urls[0]!)).toBe(false)
  })

  it('returns ambiguity rather than lexicographically choosing equal target matches', () => {
    const ambiguousTargets = [
      { stableKey: 'zebra', urls: [{ kind: 'prefix' as const, host: 'cortland.com', pathPrefix: '/apartments', pathCase: 'sensitive' as const }] },
      { stableKey: 'alpha', urls: [{ kind: 'prefix' as const, host: 'cortland.com', pathPrefix: '/apartments', pathCase: 'sensitive' as const }] },
    ]
    expect(resolveMeasurementTarget('https://cortland.com/apartments/a', ambiguousTargets))
      .toMatchObject({ status: 'ambiguous', candidates: [expect.objectContaining({ targetKey: 'alpha' }), expect.objectContaining({ targetKey: 'zebra' })] })

    const plan = copyPlan()
    plan.targets[1]!.urls = [{ kind: 'prefix', host: 'cortland.com', pathPrefix: '/apartments/ava-decatur', pathCase: 'insensitive' }]
    const error = validationError(() => compile(plan))
    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Target URL matcher has an equal-specificity cross-target tie' }),
    ]))
  })

  it('normalizes SaaS subdomains and honors host boundaries', () => {
    const target = { stableKey: 'workspace', urls: [{ kind: 'host' as const, host: 'Acme.EXAMPLE.com' }] }
    expect(resolveMeasurementTarget('https://acme.example.com/dashboard', [target]))
      .toMatchObject({ status: 'matched', targetKey: 'workspace', matcher: { host: 'acme.example.com' } })
    expect(resolveMeasurementTarget('https://notacme.example.com/dashboard', [target])).toBeNull()
  })
})

describe('Target aliases and frozen storage', () => {
  it('rejects mention-equivalent alias collisions, warns on prefix overlap, and marks alias-less targets N/A', () => {
    const collision = copyPlan()
    collision.targets[1]!.aliases = ['ava-decatur']
    expect(measurementPlanInputSchema.safeParse(collision).success).toBe(false)

    const overlap = copyPlan()
    overlap.targets[1]!.aliases = ['AVA Decatur Heights']
    const compiled = compile(overlap)
    expect(compiled.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'target-alias-prefix-overlap' }),
    ]))
    expect(compiled.targets.find(target => target.stableKey === 'cortland-decatur')?.mentionNotApplicable).toBe(false)
  })

  it('warns instead of rejecting project-brand collisions with a four-character floor', () => {
    const input = copyPlan()
    input.targets[0]!.aliases = ['Cortland']
    const compiled = compile(input)
    expect(compiled.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'target-alias-project-brand-collision' }),
    ]))

    const short = copyPlan()
    short.targets[0]!.aliases = ['ABC']
    const shortCompiled = compileMeasurementPlan(short, { ...CONTEXT, brandNames: ['ABC'] })
    expect(shortCompiled.warnings.some(warning => warning.code === 'target-alias-project-brand-collision')).toBe(false)
  })

  it('decodes only the frozen stored v1 shape explicitly', () => {
    const compiled = compile()
    expect(parseStoredMeasurementPlan(compiled)).toEqual(compiled)
    expect(parseStoredMeasurementPlan(canonicalMeasurementPlanJson(compiled))).toEqual(compiled)
    expect(() => parseStoredMeasurementPlan({ ...compiled, schemaVersion: 2 })).toThrow(
      'Unsupported stored measurement plan schema version: 2',
    )
    expect(() => parseStoredMeasurementPlan({ schemaVersion: 1, cohorts: [] })).toThrow('Stored measurement plan v1 is invalid')
  })
})
