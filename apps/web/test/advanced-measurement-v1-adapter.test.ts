import { describe, expect, it } from 'vitest'
import type { MeasurementPlanResponse, MeasurementReportResponse } from '@ainyc/canonry-api-client'

import { adaptVersionOneMeasurementReport } from '../src/components/project/advanced-measurement/v1-report-adapter.js'

const activePlan = {
  revision: 3,
  checksum: 'synthetic-checksum',
  plan: {
    schemaVersion: 1,
    defaultContext: null,
    effectiveOwnedHosts: ['example.com'],
    projectCanonicalHost: 'example.com',
    projectBrandNames: ['Example'],
    targets: [{
      stableKey: 'harbor-house',
      label: 'Harbor House',
      aliases: ['Harbor House'],
      urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/places/harbor', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
    }],
    groups: [{ stableKey: 'waterfront', label: 'Waterfront', targetKeys: ['harbor-house'], competitors: ['rival.example'] }],
    targetQuerySelections: [{ targetKey: 'harbor-house', queryIds: ['query-1'], context: null }],
    querySnapshots: [{ queryId: 'query-1', queryText: 'event venues near the harbor' }],
    executionNodes: [],
    usageEdges: [],
    warnings: [],
  },
} as unknown as NonNullable<MeasurementPlanResponse['active']>

const report = {
  revision: 3,
  run: {
    id: 'run-1',
    status: 'completed',
    createdAt: '2026-08-02T12:00:00.000Z',
    startedAt: '2026-08-02T12:00:00.000Z',
    finishedAt: '2026-08-02T12:05:00.000Z',
  },
  groups: [],
  targets: [{
    id: 'harbor-house',
    label: 'Harbor House',
    completeness: { executed: 1, expected: 1, sourceCompleteObservations: 1, complete: true, sourceComplete: true, answerComplete: true },
    citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
    mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
    providers: [],
  }],
  evidence: [{
    observationId: 'observation-1',
    expectedSlotId: 'slot-1',
    executionId: 'execution-1',
    usageEdgeId: 'target:harbor-house:query-1:node-1',
    usageEdgeType: 'target',
    provider: 'openai',
    queryText: 'event venues near the harbor',
    location: null,
    sourceUrl: 'https://example.com/places/another',
    bridged: true,
    historical: false,
    evidenceComplete: true,
    classification: 'sibling',
    normalizedUrl: 'https://example.com/places/another',
    matchedTargetIds: ['another-house'],
    matchedUrlIds: ['another-house:url:0'],
  }],
  diagnostics: {
    bridgedObservationIds: ['observation-1'],
    historicalObservationIds: [],
    evidenceIncompleteObservationIds: [],
    ambiguousObservationIds: [],
    unmatchedObservationIds: [],
  },
} as unknown as MeasurementReportResponse

describe('version-one advanced measurement adapter', () => {
  it('preserves bridged Property evidence as Historical while marking class reporting unavailable', () => {
    const adapted = adaptVersionOneMeasurementReport(activePlan, report)

    expect(adapted.classReporting).toBe('plan-v1')
    expect(adapted.latestMeasurement.status.label).toBe('Complete')
    expect(adapted.latestMeasurement.date).toBe('Aug 2, 2026')
    expect(adapted.overall.aggregate.properties[0]).toMatchObject({
      id: 'harbor-house',
      name: 'Harbor House',
      assignedQueries: ['event venues near the harbor'],
      urls: ['https://example.com/places/harbor'],
      historical: true,
    })
    expect(adapted.overall.aggregate.properties[0]!.evidence[0]).toMatchObject({
      kind: 'another-property',
      historical: true,
    })
  })
})
