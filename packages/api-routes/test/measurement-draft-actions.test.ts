import { describe, expect, it } from 'vitest'
import { measurementDraftAuthoringSchema } from '@ainyc/canonry-contracts'
import { applyDraftAction } from '../src/measurement-draft-actions.js'

describe('measurement draft assignment scale', () => {
  it('applies one query to 200 selected Targets without mutating the input', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets: Array.from({ length: 200 }, (_, index) => ({
        stableKey: `property-${String(index + 1).padStart(3, '0')}`,
        label: `Property ${String(index + 1).padStart(3, '0')}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://portfolio.example/properties/${index + 1}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [],
    })
    const targetKeys = authoring.targets.map(target => target.stableKey)

    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys, queryIds: ['q-nearby'] },
      { brandNames: ['Example Portfolio'], queriesById: new Map([['q-nearby', 'apartments nearby']]) },
    )

    expect(result.authoring.assignments).toHaveLength(200)
    expect(new Set(result.authoring.assignments.map(assignment => assignment.targetKey))).toEqual(new Set(targetKeys))
    expect(authoring.assignments).toEqual([])
  })

  it('addresses mutation warnings by authoring path instead of prose', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], locations: [] },
      targets: [{
        stableKey: 'property-001',
        label: 'Property 001',
        status: 'included',
        aliases: ['Property 001'],
        urlMatchers: ['https://portfolio.example/properties/1'],
        source: 'manual',
      }],
      assignments: [{
        targetKey: 'property-001',
        queryId: 'q-nearby',
        queryClass: 'non-brand',
        classificationSource: 'operator',
      }],
      groups: [],
    })
    const context = { brandNames: ['Example Portfolio'], queriesById: new Map([['q-nearby', 'apartments nearby']]) }

    expect(applyDraftAction('merge-targets', authoring, {
      targetKey: 'property-001',
      mergedKeys: ['property-001'],
    }, context).warnings).toEqual([
      expect.objectContaining({ code: 'merge-targets-noop', path: ['targets', 0] }),
    ])
    expect(applyDraftAction('exclude-target', authoring, {
      targetKey: 'property-001',
    }, context).warnings).toEqual([
      expect.objectContaining({ code: 'excluded-target-has-assignments', path: ['targets', 0, 'assignments'] }),
    ])
    expect(applyDraftAction('upsert-group', authoring, {
      group: {
        stableKey: 'group-target-stores',
        label: 'Target Stores',
        targetKeys: ['missing-property'],
        competitors: [],
      },
    }, context).warnings).toEqual([
      expect.objectContaining({ code: 'group-unknown-target', path: ['groups', 0, 'targetKeys'] }),
    ])
  })
})

describe('pairing a question to the Property it names', () => {
  /** 40 Properties, each with a question generated from its own name. */
  function portfolio(size: number) {
    return measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets: Array.from({ length: size }, (_, index) => ({
        stableKey: `property-${String(index + 1).padStart(3, '0')}`,
        label: `Harbour ${String(index + 1).padStart(3, '0')}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://portfolio.example/properties/${index + 1}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [],
    })
  }

  function generatedQuestions(size: number) {
    return new Map(Array.from({ length: size }, (_, index) => [
      `q-${index + 1}`,
      `is Harbour ${String(index + 1).padStart(3, '0')} a good place to live`,
    ]))
  }

  const context = (size: number) => ({
    brandNames: ['Example Portfolio'],
    queriesById: generatedQuestions(size),
  })

  it('produces one assignment per pair, not the cross product', () => {
    const size = 40
    const authoring = portfolio(size)
    const pairs = authoring.targets.map((target, index) => ({
      targetKey: target.stableKey,
      queryId: `q-${index + 1}`,
    }))

    const result = applyDraftAction('apply-paired-assignments', authoring, { pairs }, context(size))

    // The cross product of the same inputs would be 1,600.
    expect(result.authoring.assignments).toHaveLength(size)
    for (const assignment of result.authoring.assignments) {
      const index = Number(assignment.queryId.replace('q-', ''))
      expect(assignment.targetKey).toBe(`property-${String(index).padStart(3, '0')}`)
    }
  })

  it('classifies a question naming its own Property as branded', () => {
    const authoring = portfolio(3)
    const result = applyDraftAction(
      'apply-paired-assignments',
      authoring,
      { pairs: [{ targetKey: 'property-001', queryId: 'q-1' }] },
      context(3),
    )
    // "Harbour 001" is not a project brand name; the Property's own label is
    // what makes this branded.
    expect(result.authoring.assignments[0]!.queryClass).toBe('branded')
  })

  it('leaves a question that names no Property as non-brand', () => {
    const authoring = portfolio(3)
    const result = applyDraftAction(
      'apply-paired-assignments',
      authoring,
      { pairs: [{ targetKey: 'property-001', queryId: 'q-market' }] },
      { brandNames: ['Example Portfolio'], queriesById: new Map([['q-market', 'best apartments downtown']]) },
    )
    expect(result.authoring.assignments[0]!.queryClass).toBe('non-brand')
  })

  it('is idempotent: re-applying the same pairs does not duplicate', () => {
    const size = 10
    const authoring = portfolio(size)
    const pairs = authoring.targets.map((target, index) => ({
      targetKey: target.stableKey,
      queryId: `q-${index + 1}`,
    }))
    const once = applyDraftAction('apply-paired-assignments', authoring, { pairs }, context(size))
    const twice = applyDraftAction('apply-paired-assignments', once.authoring, { pairs }, context(size))
    expect(twice.authoring.assignments).toHaveLength(size)
  })

  it('refuses a pair naming a Property that does not exist', () => {
    expect(() => applyDraftAction(
      'apply-paired-assignments',
      portfolio(3),
      { pairs: [{ targetKey: 'property-999', queryId: 'q-1' }] },
      context(3),
    )).toThrow()
  })
})

describe('the cross product cap', () => {
  function portfolio(size: number) {
    return measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets: Array.from({ length: size }, (_, index) => ({
        stableKey: `property-${String(index + 1).padStart(3, '0')}`,
        label: `Harbour ${String(index + 1).padStart(3, '0')}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://portfolio.example/properties/${index + 1}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [],
    })
  }

  it('refuses the incident: every generated question onto every Property', () => {
    const size = 213
    const authoring = portfolio(size)
    const queriesById = new Map(Array.from({ length: size }, (_, index) => [
      `q-${index + 1}`,
      `is Harbour ${String(index + 1).padStart(3, '0')} a good place to live`,
    ]))

    expect(() => applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys: authoring.targets.map(target => target.stableKey), queryIds: [...queriesById.keys()] },
      { brandNames: ['Example Portfolio'], queriesById },
    )).toThrow(/45,369 assignments/)
  })

  it('still allows one question across the whole portfolio', () => {
    const authoring = portfolio(40)
    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys: authoring.targets.map(target => target.stableKey), queryIds: ['q-market'] },
      { brandNames: ['Example Portfolio'], queriesById: new Map([['q-market', 'best apartments downtown']]) },
    )
    expect(result.authoring.assignments).toHaveLength(40)
  })

  it('allows 20 market questions across the 50 Properties of one market', () => {
    const authoring = portfolio(60)
    const queriesById = new Map(Array.from({ length: 20 }, (_, i) => [`q-${i}`, `best apartments option ${i}`]))
    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      {
        targetKeys: authoring.targets.slice(0, 50).map(target => target.stableKey),
        queryIds: [...queriesById.keys()],
      },
      { brandNames: ['Example Portfolio'], queriesById },
    )
    expect(result.authoring.assignments).toHaveLength(1_000)
  })

  it('still allows several questions on a small selection', () => {
    const authoring = portfolio(40)
    const result = applyDraftAction(
      'apply-assignments',
      authoring,
      { targetKeys: ['property-001', 'property-002'], queryIds: ['q-a', 'q-b', 'q-c'] },
      {
        brandNames: ['Example Portfolio'],
        queriesById: new Map([['q-a', 'one'], ['q-b', 'two'], ['q-c', 'three']]),
      },
    )
    expect(result.authoring.assignments).toHaveLength(6)
  })
})
