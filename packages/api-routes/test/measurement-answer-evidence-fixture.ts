/**
 * One run shaped to exercise every answer-level evidence case at once:
 * multiple Properties, multiple usage edges over one execution, an answer with
 * several cited URLs, an answer with none (the loss), and an answer whose text
 * never landed.
 *
 * It is shared by the equivalence baseline capture
 * (`scripts/capture-measurement-flat-evidence.ts`) and the tests, so the
 * captured flat rows and the rows under test can only ever come from the same
 * input.
 */

import type { MeasurementReportInput, MeasurementTargetInput } from '../src/measurement-report.js'

export const answerEvidenceTargets: MeasurementTargetInput[] = [
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
  // Two Properties claiming one path is the ambiguous-source case; it must keep
  // the classification it has today once the rows are nested under an answer.
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

export function answerEvidenceInput(overrides: Partial<MeasurementReportInput> = {}): MeasurementReportInput {
  return {
    revision: 11,
    ownedHosts: ['northstar.example'],
    projectBrandNames: ['Northstar'],
    projectDomain: 'northstar.example',
    targets: answerEvidenceTargets,
    groups: [
      {
        id: 'coast',
        label: 'Coast region',
        targetIds: ['north', 'harbor'],
        competitors: [{ domain: 'challenger.example', aliases: ['Challenger'] }],
      },
    ],
    expectedSlots: [
      { id: 'slot-shared-openai', executionId: 'exec-shared', queryText: 'roof coating near harbor', provider: 'openai', location: 'Harbor, EX' },
      { id: 'slot-shared-gemini', executionId: 'exec-shared', queryText: 'roof coating near harbor', provider: 'gemini', location: 'Harbor, EX' },
      { id: 'slot-loss', executionId: 'exec-loss', queryText: 'who repairs flat roofs', provider: 'openai', location: null },
      { id: 'slot-silent', executionId: 'exec-silent', queryText: 'best coating contractor', provider: 'openai', location: null },
    ],
    usageEdges: [
      { id: 'edge-baseline', type: 'baseline', executionId: 'exec-shared' },
      { id: 'edge-north-shared', type: 'target', executionId: 'exec-shared', targetId: 'north' },
      { id: 'edge-harbor-shared', type: 'target', executionId: 'exec-shared', targetId: 'harbor' },
      { id: 'edge-north-loss', type: 'target', executionId: 'exec-loss', targetId: 'north' },
      { id: 'edge-harbor-loss', type: 'target', executionId: 'exec-loss', targetId: 'harbor' },
      { id: 'edge-north-silent', type: 'target', executionId: 'exec-silent', targetId: 'north' },
    ],
    observations: [
      {
        id: 'observation-openai',
        executionId: 'exec-shared',
        queryText: 'roof coating near harbor',
        provider: 'openai',
        location: 'Harbor, EX',
        answerText: 'Northstar Harbor and Shared A both work along the coast; Challenger is the other option.',
        citedUrls: [
          'https://northstar.example/locations/harbor/details',
          'https://northstar.example/shared/guide',
          'https://challenger.example/compare',
        ],
        citedUrlsComplete: true,
      },
      {
        // Bridged: no execution id, so it is matched on query + provider +
        // location, and its sources come from recovered historical evidence.
        id: 'observation-gemini',
        executionId: null,
        queryText: 'roof coating near harbor',
        provider: 'gemini',
        location: '  harbor,   ex ',
        answerText: 'Northstar North is another option.',
        citedUrls: null,
        citedUrlsComplete: false,
        historicalCitedUrls: ['https://northstar.example/locations/north'],
        historicalCitedUrlsComplete: true,
      },
      {
        // The loss: the engine answered and cited nobody. It produces no
        // per-URL row at all, which is exactly why a gap is invisible today.
        id: 'observation-loss',
        executionId: 'exec-loss',
        queryText: 'who repairs flat roofs',
        provider: 'openai',
        location: null,
        answerText: 'Most flat-roof work in the region goes to independent crews.',
        citedUrls: [],
        citedUrlsComplete: true,
      },
      {
        // Answer text never landed. Mention is unknown here, and must not be
        // reported as "not mentioned".
        id: 'observation-silent',
        executionId: 'exec-silent',
        queryText: 'best coating contractor',
        provider: 'openai',
        location: null,
        answerText: null,
        citedUrls: ['https://northstar.example/locations/north/reviews'],
        citedUrlsComplete: true,
      },
    ],
    ...overrides,
  }
}
