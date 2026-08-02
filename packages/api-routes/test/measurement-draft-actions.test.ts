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
})
