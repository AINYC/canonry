import { describe, expect, it } from 'vitest'
import { measurementDraftAuthoringSchema } from '@ainyc/canonry-contracts'
import { compileMeasurementDraft } from '../src/measurement-draft-compile.js'

describe('measurement draft compiler', () => {
  it('uses original Property indices for every unassigned Property', () => {
    const authoring = measurementDraftAuthoringSchema.parse({
      defaultContext: { providers: ['openai'], locations: [] },
      targets: [
        {
          stableKey: 'widgets',
          label: 'Widgets',
          status: 'included',
          aliases: ['Northwind Widgets'],
          urlMatchers: ['https://northwind.example/widgets/*'],
          source: 'manual',
        },
        {
          stableKey: 'archived',
          label: 'Archived',
          status: 'excluded',
          aliases: ['Northwind Archived'],
          urlMatchers: ['https://northwind.example/archived/*'],
          source: 'manual',
        },
        {
          stableKey: 'gadgets',
          label: 'Gadgets',
          status: 'included',
          aliases: ['Northwind Gadgets'],
          urlMatchers: ['https://northwind.example/gadgets/*'],
          source: 'manual',
        },
        {
          stableKey: 'services',
          label: 'Services',
          status: 'included',
          aliases: ['Northwind Services'],
          urlMatchers: ['https://northwind.example/services/*'],
          source: 'manual',
        },
      ],
      assignments: [{
        targetKey: 'widgets',
        queryId: 'q-best-widgets',
        queryClass: 'non-brand',
        classificationSource: 'operator',
      }],
      groups: [],
    })

    const result = compileMeasurementDraft(authoring, {
      canonicalDomain: 'northwind.example',
      ownedDomains: [],
      brandNames: ['Northwind'],
      locations: [],
      trackedQueries: [{ id: 'q-best-widgets', query: 'best widget supplier' }],
    })

    expect(result.ok).toBe(true)
    expect(result.checks.filter(check => check.ruleId === 'target-without-assignments'))
      .toEqual([
        expect.objectContaining({ path: ['targets', 2] }),
        expect.objectContaining({ path: ['targets', 3] }),
      ])
  })
})
