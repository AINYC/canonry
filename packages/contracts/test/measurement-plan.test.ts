import { describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  compileMeasurementPlanPreview,
  MeasurementPlanValidationError,
  matchesMeasurementTargetUrl,
  measurementPlanInputSchema,
  measurementPlanCompilePreviewResponseSchema,
  measurementPlanDiffPreviewResponseSchema,
  measurementPlanPublishRequestSchema,
  normalizeMeasurementPathPrefix,
  parseStoredMeasurementPlan,
  resolveMeasurementTarget,
  type MeasurementPlanInput,
} from '../src/measurement-plan.js'

const NORTHBRIDGE = { label: 'northbridge', city: 'Northbridge', region: 'NB', country: 'US' }

const CONTEXT = {
  canonicalDomain: 'https://www.northstar.example/',
  ownedDomains: ['residences.northstar.example'],
  brandNames: ['Northstar Living'],
  defaultContext: NORTHBRIDGE,
  locations: [NORTHBRIDGE],
  trackedQueries: [
    { id: 'q-harbor', query: 'harbor point reviews' },
    { id: 'q-best', query: 'best apartments in northbridge' },
    { id: 'q-northstar', query: 'northstar apartments' },
  ],
  expectedSnapshots: 2,
}

const PLAN: MeasurementPlanInput = {
  schemaVersion: 1,
  targets: [
    {
      stableKey: 'harbor-point',
      label: 'Harbor Point',
      urls: [
        { kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' },
        { kind: 'host', host: 'residences.northstar.example' },
      ],
      aliases: ['Harbor Point'],
      metadata: { market: 'Northbridge', state: 'NB' },
    },
    {
      stableKey: 'northstar-ridge',
      label: 'Northstar Ridge',
      urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/northstar-ridge', pathCase: 'sensitive' }],
      aliases: [],
    },
  ],
  groups: [{
    stableKey: 'northbridge',
    label: 'Northbridge portfolio',
    targetKeys: ['harbor-point'],
    competitors: ['rival.example'],
  }],
  targetQuerySelections: [
    { targetKey: 'harbor-point', queryIds: ['q-harbor', 'q-best'] },
    { targetKey: 'northstar-ridge', queryIds: ['q-best'], context: null },
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
  it('requires the caller-observed active revision for publication', () => {
    expect(measurementPlanPublishRequestSchema.parse({
      expectedActiveRevision: null,
      plan: PLAN,
    })).toMatchObject({ expectedActiveRevision: null, plan: { schemaVersion: 1 } })
    expect(measurementPlanPublishRequestSchema.parse({
      expectedActiveRevision: 7,
      plan: PLAN,
    })).toMatchObject({ expectedActiveRevision: 7 })
    expect(measurementPlanPublishRequestSchema.safeParse({ plan: PLAN }).success).toBe(false)
    expect(measurementPlanPublishRequestSchema.safeParse({ expectedActiveRevision: 0, plan: PLAN }).success).toBe(false)
  })

  it('accepts a generic synthetic target plan without cohort or lane concepts', () => {
    const parsed = measurementPlanInputSchema.parse(PLAN)

    expect(parsed).toEqual(expect.objectContaining({
      schemaVersion: 1,
      targets: expect.arrayContaining([expect.objectContaining({ stableKey: 'harbor-point' })]),
      groups: expect.arrayContaining([expect.objectContaining({ stableKey: 'northbridge' })]),
      targetQuerySelections: expect.arrayContaining([expect.objectContaining({ targetKey: 'harbor-point' })]),
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
        context: NORTHBRIDGE,
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
  it('compiles a 200-Target portfolio into one deduplicated execution graph', () => {
    const trackedQueries = Array.from({ length: 5 }, (_, index) => ({
      id: `q-${index}`,
      query: `portfolio query ${index}`,
    }))
    const targets = Array.from({ length: 200 }, (_, index) => {
      const stableKey = `property-${String(index + 1).padStart(3, '0')}`
      return {
        stableKey,
        label: `Property ${index + 1}`,
        urls: [{
          kind: 'prefix' as const,
          host: 'northstar.example',
          pathPrefix: `/apartments/${stableKey}`,
          pathCase: 'insensitive' as const,
        }],
        aliases: [`Property ${index + 1}`],
      }
    })
    const groups = Array.from({ length: 20 }, (_, index) => ({
      stableKey: `market-${String(index + 1).padStart(2, '0')}`,
      label: `Market ${index + 1}`,
      targetKeys: targets
        .filter((_, targetIndex) => targetIndex % 20 === index)
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

    expect(compiled.targets).toHaveLength(200)
    expect(compiled.groups).toHaveLength(20)
    expect(compiled.executionNodes).toHaveLength(5)
    expect(compiled.usageEdges).toHaveLength(5 + (200 * 2))
    expect(compiled.usageEdges.filter(edge => edge.kind === 'baseline')).toHaveLength(5)
    expect(compiled.usageEdges.every(edge => edge.kind === 'baseline' || edge.kind === 'target')).toBe(true)
  })

  it('freezes query snapshots, unconditional baseline edges, and mention applicability', () => {
    const compiled = compile()

    expect(compiled.projectCanonicalHost).toBe('northstar.example')
    expect(compiled.projectBrandNames).toEqual(['Northstar Living', 'northstar'])
    expect(compiled.querySnapshots).toEqual([
      { queryId: 'q-best', queryText: 'best apartments in northbridge' },
      { queryId: 'q-harbor', queryText: 'harbor point reviews' },
      { queryId: 'q-northstar', queryText: 'northstar apartments' },
    ])
    expect(compiled.usageEdges.filter(edge => edge.kind === 'baseline')).toEqual([
      expect.objectContaining({ kind: 'baseline', queryId: 'q-best' }),
      expect.objectContaining({ kind: 'baseline', queryId: 'q-harbor' }),
      expect.objectContaining({ kind: 'baseline', queryId: 'q-northstar' }),
    ])
    const baseline = compiled.usageEdges.find(edge => edge.kind === 'baseline' && edge.queryId === 'q-northstar')!
    expect(compiled.executionNodes.find(node => node.stableKey === baseline.executionNodeKey)?.context).toEqual(NORTHBRIDGE)
    expect(compiled.targets.find(target => target.stableKey === 'northstar-ridge')?.mentionNotApplicable).toBe(true)
    expect(compiled.executionNodes.every(node => node.expectedSnapshots === 2)).toBe(true)
  })

  it('dedupes identical query/context executions while preserving separate usage edges', () => {
    const compiled = compile()
    const nodes = compiled.executionNodes.filter(node => node.queryText === 'best apartments in northbridge')
    const northbridgeNode = nodes.find(node => node.context?.label === 'northbridge')!
    const sharedEdges = compiled.usageEdges.filter(edge => edge.executionNodeKey === northbridgeNode.stableKey)

    expect(nodes).toHaveLength(2)
    expect(sharedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'baseline', queryId: 'q-best' }),
      expect.objectContaining({ kind: 'target', targetKey: 'harbor-point', queryId: 'q-best' }),
    ]))
    expect(sharedEdges).toHaveLength(2)
  })

  it('splits execution nodes by resolved context and rejects conflicting Target/query contexts', () => {
    const compiled = compile()
    expect(compiled.executionNodes.filter(node => node.queryText === 'best apartments in northbridge')).toHaveLength(2)

    const conflict = copyPlan()
    conflict.targetQuerySelections!.push({ targetKey: 'harbor-point', queryIds: ['q-best'], context: null })
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
      { targetKey: 'harbor-point', queryIds: ['q-best'], context: NORTHBRIDGE },
      { targetKey: 'harbor-point', queryIds: ['q-harbor'] },
      { targetKey: 'northstar-ridge', queryIds: ['q-best'], context: null },
    ]
    expect(canonicalMeasurementPlanJson(compile(fragmented))).toBe(canonicalMeasurementPlanJson(compile()))

    const identityContext = {
      ...CONTEXT,
      brandNames: ['Northstar Living', 'Northstar Communities'],
    }
    const reorderedIdentity = compileMeasurementPlan(copyPlan(), {
      ...identityContext,
      brandNames: [...identityContext.brandNames].reverse(),
    })
    expect(canonicalMeasurementPlanJson(reorderedIdentity))
      .toBe(canonicalMeasurementPlanJson(compileMeasurementPlan(copyPlan(), identityContext)))
  })

  it('normalizes known owned hosts, competitors, and metadata into the persisted revision', () => {
    const input = copyPlan()
    input.targets[0]!.urls[0] = {
      kind: 'prefix', host: 'HTTPS://WWW.NORTHSTAR.EXAMPLE/', pathPrefix: '//apartments///harbor-point/', pathCase: 'insensitive',
    }
    input.groups![0]!.competitors = ['RIVAL.EXAMPLE', 'rival.example']
    input.targets[0]!.metadata = { state: 'NB', market: 'Northbridge' }
    const compiled = compile(input)

    expect(compiled.effectiveOwnedHosts).toEqual(['northstar.example', 'residences.northstar.example'])
    expect(compiled.groups[0]?.competitors).toEqual(['rival.example'])
    expect(compiled.targets[0]?.metadata).toEqual({ market: 'Northbridge', state: 'NB' })
    expect(compiled.targets.find(target => target.stableKey === 'harbor-point')?.urls)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/harbor-point' }),
      ]))
  })

  it('rejects unowned target hosts and owned competitors', () => {
    const unownedTarget = copyPlan()
    unownedTarget.targets[0]!.urls = [{ kind: 'host', host: 'evil.example.com' }]
    expect(() => compile(unownedTarget)).toThrow('Measurement plan validation failed')

    const ownedCompetitor = copyPlan()
    ownedCompetitor.groups![0]!.competitors = ['apartments.northstar.example']
    expect(() => compile(ownedCompetitor)).toThrow('Measurement plan validation failed')
  })
})

describe('Target URL ownership', () => {
  const TARGETS = [
    { stableKey: 'host', urls: [{ kind: 'host' as const, host: 'northstar.example' }] },
    { stableKey: 'prefix', urls: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: '/apartments', pathCase: 'insensitive' as const }] },
    { stableKey: 'nested', urls: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' as const }] },
    { stableKey: 'exact', urls: [{ kind: 'exact' as const, url: 'https://northstar.example/apartments/harbor-point/unit-1', pathCase: 'insensitive' as const }] },
  ]

  it('applies exact, longest prefix, then host-only precedence', () => {
    expect(resolveMeasurementTarget('https://northstar.example/apartments/harbor-point/unit-1', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'exact', matcher: { kind: 'exact' } })
    expect(resolveMeasurementTarget('https://northstar.example/apartments/harbor-point/unit-2', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'nested', matcher: { kind: 'prefix' } })
    expect(resolveMeasurementTarget('https://northstar.example/apartments/other', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'prefix' })
    expect(resolveMeasurementTarget('https://northstar.example/about', TARGETS))
      .toMatchObject({ status: 'matched', targetKey: 'host' })
  })

  it('allows nested prefixes, preserves path boundaries, and normalizes URL paths safely', () => {
    expect(normalizeMeasurementPathPrefix('///apartments////harbor-point///')).toBe('/apartments/harbor-point')
    expect(() => normalizeMeasurementPathPrefix('/apartments/%2e%2e/admin')).toThrow()
    expect(matchesMeasurementTargetUrl('https://northstar.example//APARTMENTS//HARBOR-POINT/unit-2', TARGETS[2]!.urls[0]!)).toBe(true)
    expect(matchesMeasurementTargetUrl('https://northstar.example/apartments/harbor-point-north', TARGETS[2]!.urls[0]!)).toBe(false)
  })

  it('returns ambiguity rather than lexicographically choosing equal target matches', () => {
    const ambiguousTargets = [
      { stableKey: 'zebra', urls: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: '/apartments', pathCase: 'sensitive' as const }] },
      { stableKey: 'alpha', urls: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: '/apartments', pathCase: 'sensitive' as const }] },
    ]
    expect(resolveMeasurementTarget('https://northstar.example/apartments/a', ambiguousTargets))
      .toMatchObject({ status: 'ambiguous', candidates: [expect.objectContaining({ targetKey: 'alpha' }), expect.objectContaining({ targetKey: 'zebra' })] })

    const plan = copyPlan()
    plan.targets[1]!.urls = [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' }]
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
    collision.targets[1]!.aliases = ['harbor-point']
    expect(measurementPlanInputSchema.safeParse(collision).success).toBe(false)

    const overlap = copyPlan()
    overlap.targets[1]!.aliases = ['Harbor Point Heights']
    const compiled = compile(overlap)
    expect(compiled.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'target-alias-prefix-overlap' }),
    ]))
    expect(compiled.targets.find(target => target.stableKey === 'northstar-ridge')?.mentionNotApplicable).toBe(false)
  })

  it('rejects exact project-brand collisions with a four-character floor', () => {
    const input = copyPlan()
    input.targets[0]!.aliases = ['Northstar Living']
    const error = validationError(() => compile(input))
    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Target alias must not equal an effective project brand term' }),
    ]))

    const short = copyPlan()
    short.targets[0]!.aliases = ['ABC']
    const shortCompiled = compileMeasurementPlan(short, { ...CONTEXT, brandNames: ['ABC'] })
    expect(shortCompiled.targets.find(target => target.stableKey === 'harbor-point')?.aliases).toContain('ABC')
  })

  it('includes effective owned-domain labels in the project-brand collision guard', () => {
    const input = copyPlan()
    input.targets[0]!.aliases = ['Harbor Point']

    const preview = compileMeasurementPlanPreview(input, {
      ...CONTEXT,
      ownedDomains: [...CONTEXT.ownedDomains, 'harbor-point.example'],
    })
    expect(preview).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({
        id: 'target-alias-project-brand-collision',
        severity: 'fail',
      })],
    })
  })

  it('decodes only the frozen stored v1 shape explicitly', () => {
    const compiled = compile()
    expect(parseStoredMeasurementPlan(compiled)).toEqual(compiled)
    expect(parseStoredMeasurementPlan(canonicalMeasurementPlanJson(compiled))).toEqual(compiled)
    // v2 is a known version now, so a v1 body wearing its label fails v2
    // validation instead of reading as an unknown version.
    expect(() => parseStoredMeasurementPlan({ ...compiled, schemaVersion: 2 })).toThrow(
      'Stored measurement plan v2 is invalid',
    )
    expect(() => parseStoredMeasurementPlan({ ...compiled, schemaVersion: 3 })).toThrow(
      'Unsupported stored measurement plan schema version: 3',
    )
    expect(() => parseStoredMeasurementPlan({ schemaVersion: 1, cohorts: [] })).toThrow('Stored measurement plan v1 is invalid')
  })
})

describe('Target measurement plan compile preview', () => {
  it('returns a typed success with frozen execution and usage counts', () => {
    const preview = compileMeasurementPlanPreview(copyPlan(), CONTEXT)

    expect(measurementPlanCompilePreviewResponseSchema.parse(preview)).toEqual(preview)
    expect(preview).toMatchObject({
      ok: true,
      dedupSaved: expect.any(Number),
      usageEdges: { baseline: 3, target: 3 },
      estCostUsd: null,
    })
    if (preview.ok) {
      expect(preview.executionNodes.every(node => node.expectedSnapshots === 2)).toBe(true)
    }
  })

  it('returns typed FAIL checks instead of throwing and preserves WARN direction', () => {
    const conflict = copyPlan()
    conflict.targetQuerySelections!.push({ targetKey: 'harbor-point', queryIds: ['q-best'], context: null })
    const invalid = compileMeasurementPlanPreview(conflict, CONTEXT)
    expect(measurementPlanCompilePreviewResponseSchema.parse(invalid)).toEqual(invalid)
    expect(invalid).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ id: 'target-query-context-conflict', severity: 'fail' })],
      executionNodes: [],
      dedupSaved: 0,
      usageEdges: { baseline: 0, target: 0 },
      estCostUsd: null,
    })
    expect(measurementPlanDiffPreviewResponseSchema.parse({ ...invalid, diff: null }))
      .toEqual({ ...invalid, diff: null })

    const overlap = copyPlan()
    overlap.targets[1]!.aliases = ['Harbor Point Heights']
    const valid = compileMeasurementPlanPreview(overlap, CONTEXT)
    expect(valid).toMatchObject({
      ok: true,
      checks: [expect.objectContaining({
        id: 'target-alias-prefix-overlap',
        severity: 'warn',
        path: ['targets'],
      })],
    })
  })

  it('names cross-target URL and alias ownership failures', () => {
    const routeTie = copyPlan()
    routeTie.targets[1]!.urls = [{
      kind: 'prefix',
      host: 'northstar.example',
      pathPrefix: '/apartments/harbor-point',
      pathCase: 'insensitive',
    }]
    expect(compileMeasurementPlanPreview(routeTie, CONTEXT)).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ id: 'target-url-ownership-tie', severity: 'fail' })],
    })

    const aliasCollision = copyPlan()
    aliasCollision.targets[1]!.aliases = ['harbor-point']
    expect(compileMeasurementPlanPreview(aliasCollision, CONTEXT)).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ id: 'target-alias-cross-target-collision', severity: 'fail' })],
    })
  })
})
