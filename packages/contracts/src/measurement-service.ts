import { z } from 'zod'
import { locationContextSchema, providerNameSchema } from './provider.js'
import { measurementStableKeySchema } from './measurement-plan.js'
import {
  measurementCursorPageSchema,
  measurementQueryClassFilterSchema,
  measurementStateSchema,
  measurementV2StableKeySchema,
} from './measurement-plan-v2.js'

/** The five deterministic outcomes produced by sitemap target discovery. */
export const measurementDiscoveryClassificationSchema = z.enum([
  'proposed',
  'alias',
  'shared',
  'unmatched',
  'excluded',
])
export type MeasurementDiscoveryClassification = z.infer<typeof measurementDiscoveryClassificationSchema>

export const measurementDiscoveryReasonSchema = z.enum([
  'primary-match',
  'exact-slug-match',
  'excluded-slug',
  'shared-path',
  'unmatched-path',
  'alias-without-primary',
  'unsupported-slug',
])
export type MeasurementDiscoveryReason = z.infer<typeof measurementDiscoveryReasonSchema>

export const measurementDiscoveryDiagnosticKindSchema = z.enum([
  'invalid-url',
  'unowned-host',
  'duplicate-url',
  'url-cap-reached',
])
export type MeasurementDiscoveryDiagnosticKind = z.infer<typeof measurementDiscoveryDiagnosticKindSchema>

export const measurementDiscoverySlugPatternSchema = z.object({
  kind: z.enum(['exact', 'prefix', 'suffix', 'contains']),
  value: z.string().trim().min(1),
}).strict()
export type MeasurementDiscoverySlugPattern = z.infer<typeof measurementDiscoverySlugPatternSchema>

export const measurementDiscoveryRouteRuleSchema = z.object({
  host: z.string().trim().min(1),
  pathTemplate: z.string().trim().min(1),
}).strict()
export type MeasurementDiscoveryRouteRule = z.infer<typeof measurementDiscoveryRouteRuleSchema>

/** Declarative input to the pure discovery kernel. It is intentionally not regex. */
export const measurementDiscoveryRuleSchema = z.object({
  primary: measurementDiscoveryRouteRuleSchema,
  aliases: z.array(measurementDiscoveryRouteRuleSchema).optional(),
  excludedSlugSuffixes: z.array(z.string().trim().min(1)).optional(),
  excludedSlugPatterns: z.array(measurementDiscoverySlugPatternSchema).optional(),
}).strict()
export type MeasurementDiscoveryRule = z.infer<typeof measurementDiscoveryRuleSchema>

/**
 * The project supplies ownership; the operator supplies only the sitemap and
 * deterministic classification rule. Fetching belongs to the adapter layer.
 */
export const measurementDiscoveryRequestSchema = z.object({
  sitemapUrl: z.string().url().refine(value => {
    try {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'Sitemap URL must use http or https'),
  rule: measurementDiscoveryRuleSchema,
  maxUrls: z.number().int().positive().max(10_000).optional(),
}).strict()
export type MeasurementDiscoveryRequest = z.infer<typeof measurementDiscoveryRequestSchema>

const discoveryItemSchema = z.object({
  url: z.string(),
  canonicalUrl: z.string().nullable(),
  classification: z.enum(['shared', 'unmatched', 'excluded']),
  reason: z.enum(['excluded-slug', 'shared-path', 'unmatched-path', 'alias-without-primary', 'unsupported-slug']),
}).strict().superRefine((value, ctx) => {
  const permitted: Record<typeof value.classification, readonly string[]> = {
    shared: ['shared-path'],
    unmatched: ['unmatched-path', 'alias-without-primary', 'unsupported-slug'],
    excluded: ['excluded-slug'],
  }
  if (!permitted[value.classification].includes(value.reason)) {
    ctx.addIssue({ code: 'custom', message: 'Discovery classification and reason do not match' })
  }
})

export const measurementDiscoveryCandidateSchema = z.object({
  classification: z.literal('proposed'),
  reason: z.literal('primary-match'),
  stableKey: measurementStableKeySchema,
  slug: z.string().trim().min(1),
  label: z.string().trim().min(1),
  primaryUrl: z.string().url(),
  aliasCoverageUrls: z.array(z.string().url()),
}).strict()
export type MeasurementDiscoveryCandidate = z.infer<typeof measurementDiscoveryCandidateSchema>

export const measurementDiscoveryAliasSchema = z.object({
  classification: z.literal('alias'),
  reason: z.literal('exact-slug-match'),
  slug: z.string().trim().min(1),
  url: z.string().url(),
  targetStableKey: measurementStableKeySchema,
}).strict()
export type MeasurementDiscoveryAlias = z.infer<typeof measurementDiscoveryAliasSchema>

export const measurementDiscoveryDiagnosticSchema = z.object({
  kind: measurementDiscoveryDiagnosticKindSchema,
  url: z.string(),
  canonicalUrl: z.string().nullable(),
  duplicateOf: z.string().optional(),
}).strict()
export type MeasurementDiscoveryDiagnostic = z.infer<typeof measurementDiscoveryDiagnosticSchema>

/** The wire response mirrors the pure classifier's five explicit outcome buckets. */
export const measurementDiscoveryResponseSchema = z.object({
  proposed: z.array(measurementDiscoveryCandidateSchema),
  aliases: z.array(measurementDiscoveryAliasSchema),
  shared: z.array(discoveryItemSchema),
  unmatched: z.array(discoveryItemSchema),
  excluded: z.array(discoveryItemSchema),
  diagnostics: z.array(measurementDiscoveryDiagnosticSchema),
}).strict().superRefine((value, ctx) => {
  const buckets: Array<[string, readonly typeof value.shared[number]['classification'][]]> = [
    ['shared', ['shared']],
    ['unmatched', ['unmatched']],
    ['excluded', ['excluded']],
  ]
  for (const [name, allowed] of buckets) {
    for (const item of value[name as keyof Pick<typeof value, 'shared' | 'unmatched' | 'excluded'>]) {
      if (!allowed.includes(item.classification)) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'Discovery item is in the wrong result bucket' })
      }
    }
  }
})
export type MeasurementDiscoveryResponse = z.infer<typeof measurementDiscoveryResponseSchema>

/** The exact attribution vocabulary. Unknown classes must never be coerced. */
export const measurementAttributionClassSchema = z.enum([
  'assigned',
  'sibling',
  'ownedUnmapped',
  'external',
  'ambiguous',
  'invalid',
])
export type MeasurementAttributionClass = z.infer<typeof measurementAttributionClassSchema>

export const measurementUsageEdgeTypeSchema = z.enum(['baseline', 'target'])
export type MeasurementUsageEdgeType = z.infer<typeof measurementUsageEdgeTypeSchema>

export const measurementMetricReasonSchema = z.enum([
  'incomplete',
  'evidence-incomplete',
  'no-population',
  'aliasless',
  'no-competitors',
  'no-project-aliases',
])
export type MeasurementMetricReason = z.infer<typeof measurementMetricReasonSchema>

/** A rate is either fully measured or wholly unavailable; partial denominators are forbidden. */
export const measurementRateSchema = z.union([
  z.object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().positive(),
    rate: z.number().min(0).max(1),
  }).strict(),
  z.object({
    numerator: z.null(),
    denominator: z.null(),
    rate: z.null(),
    reason: measurementMetricReasonSchema,
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.numerator !== null && value.numerator > value.denominator) {
    ctx.addIssue({ code: 'custom', path: ['numerator'], message: 'Rate numerator cannot exceed denominator' })
  }
})
export type MeasurementRate = z.infer<typeof measurementRateSchema>

/** Frozen expected work for one run. Completion compares only against this manifest. */
const normalizedMeasurementProviderSchema = z.string().trim().min(1)
  .overwrite(value => value.toLocaleLowerCase('en'))

export const measurementExpectedSlotV1Schema = z.object({
  executionId: z.string().trim().min(1),
  queryText: z.string().trim().min(1),
  provider: normalizedMeasurementProviderSchema,
  context: locationContextSchema.nullable(),
  requestedModel: z.string().trim().min(1).optional(),
}).strict()
export type MeasurementExpectedSlotV1 = z.infer<typeof measurementExpectedSlotV1Schema>

export const measurementRunManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  expectedSlots: z.array(measurementExpectedSlotV1Schema),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>()
  for (const [index, slot] of value.expectedSlots.entries()) {
    const identity = [slot.executionId, slot.provider].join('\u0000')
    if (seen.has(identity)) {
      ctx.addIssue({ code: 'custom', path: ['expectedSlots', index], message: 'Duplicate expected provider slot' })
    }
    seen.add(identity)
  }
})
export type MeasurementRunManifestV1 = z.infer<typeof measurementRunManifestV1Schema>

export function parseMeasurementRunManifestV1(value: unknown): MeasurementRunManifestV1 {
  return measurementRunManifestV1Schema.parse(value)
}

export function buildMeasurementRunManifestV1(input: Omit<MeasurementRunManifestV1, 'schemaVersion'>): MeasurementRunManifestV1 {
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  const expectedSlots = [...input.expectedSlots]
    .map(slot => measurementExpectedSlotV1Schema.parse(slot))
    .sort((left, right) => (
      compareText(left.executionId, right.executionId)
      || compareText(left.provider, right.provider)
      || compareText(left.queryText, right.queryText)
      || compareText(left.context?.label ?? '', right.context?.label ?? '')
      || compareText(left.requestedModel ?? '', right.requestedModel ?? '')
    ))
  return measurementRunManifestV1Schema.parse({ schemaVersion: 1, expectedSlots })
}

export const measurementCompletenessSchema = z.object({
  executed: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  complete: z.boolean(),
  sourceComplete: z.boolean(),
  /**
   * How many of the executed answers had every cited URL captured. Rates that
   * depend on citations are computed over these, so a reader can always see the
   * basis a rate stands on rather than assuming it covered every answer.
   */
  sourceCompleteObservations: z.number().int().nonnegative(),
  answerComplete: z.boolean(),
}).strict()
export type MeasurementCompleteness = z.infer<typeof measurementCompletenessSchema>

export const measurementSovDomainSchema = z.union([
  z.object({
    domain: z.string().trim().min(1),
    own: z.boolean(),
    presentIn: z.number().int().nonnegative(),
    of: z.number().int().positive(),
  }).strict(),
  z.object({
    domain: z.string().trim().min(1),
    own: z.boolean(),
    presentIn: z.null(),
    of: z.null(),
    reason: measurementMetricReasonSchema,
  }).strict(),
])
export type MeasurementSovDomain = z.infer<typeof measurementSovDomainSchema>

export const measurementSovSchema = z.object({
  domains: z.array(measurementSovDomainSchema),
  providers: z.array(z.object({
    provider: providerNameSchema,
    domains: z.array(measurementSovDomainSchema),
  }).strict()),
}).strict()
export type MeasurementSov = z.infer<typeof measurementSovSchema>

export const measurementProviderCoverageSchema = z.object({
  provider: providerNameSchema,
  completeness: measurementCompletenessSchema,
  answerCoverage: measurementRateSchema,
}).strict()
export type MeasurementProviderCoverage = z.infer<typeof measurementProviderCoverageSchema>

export const measurementGroupReportSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  /** Drill-down ids only; groups never own query assignments. */
  targetIds: z.array(z.string().trim().min(1)),
  completeness: measurementCompletenessSchema,
  answerCoverage: measurementRateSchema,
  targetCoverage: measurementRateSchema,
  sov: measurementSovSchema,
  providers: z.array(measurementProviderCoverageSchema),
}).strict()
export type MeasurementGroupReport = z.infer<typeof measurementGroupReportSchema>

export const measurementTargetProviderReportSchema = z.object({
  provider: providerNameSchema,
  completeness: measurementCompletenessSchema,
  citationCoverage: measurementRateSchema,
  mentionCoverage: measurementRateSchema,
}).strict()
export type MeasurementTargetProviderReport = z.infer<typeof measurementTargetProviderReportSchema>

export const measurementTargetReportSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  completeness: measurementCompletenessSchema,
  citationCoverage: measurementRateSchema,
  mentionCoverage: measurementRateSchema,
  providers: z.array(measurementTargetProviderReportSchema),
}).strict()
export type MeasurementTargetReport = z.infer<typeof measurementTargetReportSchema>

export const measurementAttributionEvidenceSchema = z.object({
  observationId: z.string().trim().min(1),
  expectedSlotId: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  usageEdgeId: z.string().trim().min(1),
  usageEdgeType: measurementUsageEdgeTypeSchema,
  provider: providerNameSchema,
  queryText: z.string().trim().min(1),
  location: z.string().nullable(),
  sourceUrl: z.string(),
  bridged: z.boolean(),
  historical: z.boolean(),
  evidenceComplete: z.boolean(),
  classification: measurementAttributionClassSchema,
  normalizedUrl: z.string().nullable(),
  matchedTargetIds: z.array(z.string().trim().min(1)),
  matchedUrlIds: z.array(z.string().trim().min(1)),
}).strict()
export type MeasurementAttributionEvidence = z.infer<typeof measurementAttributionEvidenceSchema>

export const measurementReportDiagnosticsSchema = z.object({
  bridgedObservationIds: z.array(z.string()),
  historicalObservationIds: z.array(z.string()),
  evidenceIncompleteObservationIds: z.array(z.string()),
  ambiguousObservationIds: z.array(z.string()),
  unmatchedObservationIds: z.array(z.string()),
}).strict()
export type MeasurementReportDiagnostics = z.infer<typeof measurementReportDiagnosticsSchema>

export const measurementReportRunSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(['completed', 'partial']),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
}).strict()
export type MeasurementReportRun = z.infer<typeof measurementReportRunSchema>

/** Adapter response: a revision-pinned kernel report with optional run metadata. */
export const measurementReportResponseSchema = z.object({
  revision: z.number().int().positive(),
  run: measurementReportRunSchema.nullable(),
  groups: z.array(measurementGroupReportSchema),
  targets: z.array(measurementTargetReportSchema),
  evidence: z.array(measurementAttributionEvidenceSchema),
  diagnostics: measurementReportDiagnosticsSchema,
}).strict()
export type MeasurementReportResponse = z.infer<typeof measurementReportResponseSchema>

/**
 * A cursor-paged slice of one Property's source evidence.
 *
 * The rows are the same `MeasurementAttributionEvidence` the whole-report read
 * returns — same field names, same vocabulary — narrowed to the usage edges
 * this Property owns. `measurement.state` is what a reader must render when the
 * page is empty: an unmeasured Property has no evidence, and that is not the
 * same statement as a measured Property having none.
 */
export const measurementPropertyEvidenceResponseSchema = z.object({
  property: z.object({
    targetKey: measurementV2StableKeySchema,
    label: z.string().min(1),
  }).strict(),
  queryClass: measurementQueryClassFilterSchema,
  measurement: z.object({
    state: measurementStateSchema,
    displayedRunId: z.string().min(1).optional(),
    completedAt: z.string().datetime().optional(),
  }).strict(),
  evidence: measurementCursorPageSchema(measurementAttributionEvidenceSchema),
}).strict()
export type MeasurementPropertyEvidenceResponse = z.infer<typeof measurementPropertyEvidenceResponseSchema>
