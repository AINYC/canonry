import { describe, expect, it } from 'vitest'
import {
  buildMeasurementRunManifestV1,
  measurementAttributionClassSchema,
  measurementDiscoveryRequestSchema,
  measurementDiscoveryResponseSchema,
  measurementRateSchema,
  measurementReportResponseSchema,
  measurementRunManifestV1Schema,
} from '../src/measurement-service.js'

const CONTEXT = { label: 'Northbridge', city: 'Northbridge', region: 'NB', country: 'US' }

describe('measurement service contracts', () => {
  it('accepts the deterministic sitemap discovery request vocabulary', () => {
    expect(measurementDiscoveryRequestSchema.parse({
      sitemapUrl: 'https://northstar.example/sitemap.xml',
      rule: {
        primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}' },
        aliases: [{ host: 'homes.northstar.example', pathTemplate: '/{slug}' }],
        excludedSlugSuffixes: ['-regional'],
      },
    })).toEqual(expect.objectContaining({ sitemapUrl: 'https://northstar.example/sitemap.xml' }))
    expect(measurementDiscoveryRequestSchema.safeParse({
      sitemapUrl: 'ftp://northstar.example/sitemap.xml',
      rule: { primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}' } },
    }).success).toBe(false)
  })

  it('builds a canonical per-run expected-slot manifest', () => {
    const manifest = buildMeasurementRunManifestV1({
      expectedSlots: [
        { executionId: 'exec-b', queryText: 'best homes', provider: ' OpenAI ', context: null },
        { executionId: 'exec-a', queryText: 'homes in northbridge', provider: 'GEMINI', context: CONTEXT, requestedModel: 'model-a' },
      ],
    })

    expect(manifest).toEqual({
      schemaVersion: 1,
      expectedSlots: [
        { executionId: 'exec-a', queryText: 'homes in northbridge', provider: 'gemini', context: CONTEXT, requestedModel: 'model-a' },
        { executionId: 'exec-b', queryText: 'best homes', provider: 'openai', context: null },
      ],
    })
  })

  it('rejects malformed expected-slot manifests', () => {
    expect(measurementRunManifestV1Schema.safeParse({
      schemaVersion: 1,
      expectedSlots: [{ executionId: 'exec-a', queryText: 'homes', provider: 'gemini' }],
    }).success).toBe(false)
    expect(measurementRunManifestV1Schema.safeParse({
      schemaVersion: 2,
      expectedSlots: [],
    }).success).toBe(false)
    expect(measurementRunManifestV1Schema.safeParse({
      schemaVersion: 1,
      expectedSlots: [{ executionId: 'exec-a', queryText: 'homes', provider: ' ', context: null }],
    }).success).toBe(false)
  })

  it('rejects mixed-null metrics and unknown classifications', () => {
    expect(measurementRateSchema.safeParse({ numerator: 1, denominator: null, rate: null, reason: 'incomplete' }).success).toBe(false)
    expect(measurementRateSchema.safeParse({ numerator: null, denominator: null, rate: null }).success).toBe(false)
    expect(measurementAttributionClassSchema.safeParse('unmapped').success).toBe(false)
    expect(measurementDiscoveryResponseSchema.safeParse({
      proposed: [], aliases: [], shared: [], unmatched: [], excluded: [{
        url: 'https://northstar.example/other', canonicalUrl: 'https://northstar.example/other',
        classification: 'unknown', reason: 'excluded-slug',
      }], diagnostics: [],
    }).success).toBe(false)
  })

  it('parses a complete synthetic report response', () => {
    const response = measurementReportResponseSchema.parse({
      revision: 3,
      run: { id: 'run-3', status: 'partial', createdAt: '2026-08-01T00:00:00.000Z', startedAt: null, finishedAt: null },
      groups: [{
        id: 'northbridge',
        label: 'Northbridge',
        targetIds: ['harbor'],
        completeness: { executed: 1, expected: 2, complete: false, sourceComplete: false, answerComplete: false },
        answerCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' },
        targetCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' },
        sov: {
          domains: [{ domain: 'northstar.example', own: true, presentIn: null, of: null, reason: 'incomplete' }],
          providers: [],
        },
        providers: [],
      }],
      targets: [{
        id: 'harbor', label: 'Harbor',
        completeness: { executed: 1, expected: 1, complete: true, sourceComplete: true, answerComplete: true },
        citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
        mentionCoverage: { numerator: null, denominator: null, rate: null, reason: 'aliasless' },
        providers: [],
      }],
      evidence: [{
        observationId: 'snap-1', expectedSlotId: 'slot-1', executionId: 'exec-1',
        usageEdgeId: 'target-harbor', usageEdgeType: 'target', provider: 'gemini',
        queryText: 'homes in northbridge', location: 'Northbridge', sourceUrl: 'https://northstar.example/locations/harbor',
        bridged: false, historical: false, evidenceComplete: true,
        classification: 'assigned', normalizedUrl: 'https://northstar.example/locations/harbor',
        matchedTargetIds: ['harbor'], matchedUrlIds: ['harbor-root'],
      }],
      diagnostics: {
        bridgedObservationIds: [], historicalObservationIds: [], evidenceIncompleteObservationIds: [],
        ambiguousObservationIds: [], unmatchedObservationIds: [],
      },
    })

    expect(response.groups[0]?.targetIds).toEqual(['harbor'])
    expect(response.evidence[0]?.classification).toBe('assigned')
  })
})
