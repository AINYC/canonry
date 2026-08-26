import { z } from 'zod'
import { hostOf } from './url-normalize.js'

const opaqueIdSchema = z.string().trim().min(1)
const productionHostSchema = z.string().trim().min(1)
  .refine(value => hostOf(value) !== null, 'Expected a hostname or http(s) URL.')

/**
 * Evidence progression for a conversion-tracking assessment.
 *
 * `configured` is intentionally not a pass state: it means Canonry has a
 * declared contract but either has not proved its static graph or found a
 * static mismatch. Consumers must inspect deterministic findings before
 * treating it as healthy.
 */
export const conversionTrackingIntegrityStatusSchema = z.enum([
  'configured',
  'statically-consistent',
  'runtime-unverified',
  'observed',
])
export type ConversionTrackingIntegrityStatus = z.infer<typeof conversionTrackingIntegrityStatusSchema>
export const ConversionTrackingIntegrityStatuses = conversionTrackingIntegrityStatusSchema.enum

export const conversionTrackingFindingOutcomeSchema = z.enum(['pass', 'fail', 'unknown'])
export type ConversionTrackingFindingOutcome = z.infer<typeof conversionTrackingFindingOutcomeSchema>
export const ConversionTrackingFindingOutcomes = conversionTrackingFindingOutcomeSchema.enum

/** Stable codes for deterministic static/runtime checks; never use free-text codes as machine state. */
export const conversionTrackingFindingCodeSchema = z.enum([
  'ads-connection-missing',
  'ads-conversion-action-missing',
  'ads-goal-missing',
  'ads-goal-not-biddable',
  'ads-action-not-primary',
  'gtm-connection-missing',
  'gtm-live-graph-missing',
  'gtm-tag-missing',
  'gtm-tag-unrecognized',
  'gtm-tag-paused',
  'gtm-trigger-missing',
  'gtm-variable-missing',
  'gtm-event-mismatch',
  'gtm-hostname-mismatch',
  'gtm-value-mapping-missing',
  'gtm-transaction-id-mapping-missing',
  'gtm-currency-mapping-missing',
  'gtm-conversion-id-mismatch',
  'gtm-conversion-label-mismatch',
  'runtime-event-not-observed',
  'runtime-gtm-not-observed',
  'runtime-ads-not-observed',
])
export type ConversionTrackingFindingCode = z.infer<typeof conversionTrackingFindingCodeSchema>
export const ConversionTrackingFindingCodes = conversionTrackingFindingCodeSchema.enum

/**
 * One project-scoped source-of-truth for what a conversion must mean. It holds
 * identifiers and verification requirements, never credentials or raw tag
 * parameter values.
 */
export const conversionTrackingContractSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  name: z.string().trim().min(1),
  /** The semantic application event, for example `purchase` or `generate_lead`. */
  eventName: z.string().trim().min(1),
  googleAds: z.object({
    customerId: opaqueIdSchema,
    conversionActionId: opaqueIdSchema,
    /** Optional safe GTM-facing identifier; absent on imported legacy contracts. */
    conversionId: z.string().trim().min(1).optional(),
    /** Optional safe GTM-facing identifier; absent on imported legacy contracts. */
    conversionLabel: z.string().trim().min(1).optional(),
    /** Empty means the contract is not asserting campaign-specific goal membership. */
    campaignIds: z.array(opaqueIdSchema).max(50).default([]),
    requireBiddableGoal: z.boolean().default(true),
    requirePrimaryAction: z.boolean().default(true),
  }).strict(),
  gtm: z.object({
    accountId: opaqueIdSchema,
    containerId: opaqueIdSchema,
    tagId: opaqueIdSchema,
    triggerIds: z.array(opaqueIdSchema).default([]),
    variableIds: z.array(opaqueIdSchema).default([]),
  }).strict(),
  runtime: z.object({
    verificationRequired: z.boolean().default(true),
    requireTransactionId: z.boolean().default(true),
    requireValue: z.boolean().default(true),
    requireCurrency: z.boolean().default(true),
    productionHosts: z.array(productionHostSchema).default([]),
  }).strict(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type ConversionTrackingContract = z.infer<typeof conversionTrackingContractSchema>

/** Operator-authored fields; identity, project ownership, and timestamps are server-owned. */
export const conversionTrackingContractWriteRequestSchema = conversionTrackingContractSchema.omit({
  id: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
})
export type ConversionTrackingContractWriteRequest = z.infer<
  typeof conversionTrackingContractWriteRequestSchema
>

export const conversionTrackingStaticCheckStateSchema = z.enum([
  'not-run',
  'consistent',
  'inconsistent',
])
export type ConversionTrackingStaticCheckState = z.infer<typeof conversionTrackingStaticCheckStateSchema>
export const ConversionTrackingStaticCheckStates = conversionTrackingStaticCheckStateSchema.enum

export const conversionTrackingRuntimeObservationSchema = z.enum([
  'not-run',
  'not-observed',
  'observed',
])
export type ConversionTrackingRuntimeObservation = z.infer<typeof conversionTrackingRuntimeObservationSchema>
export const ConversionTrackingRuntimeObservations = conversionTrackingRuntimeObservationSchema.enum

/** Inputs to the monotonic evidence-status resolver. */
export const conversionTrackingIntegrityEvidenceSchema = z.object({
  staticCheck: conversionTrackingStaticCheckStateSchema,
  runtimeVerificationRequired: z.boolean(),
  runtimeObservation: conversionTrackingRuntimeObservationSchema,
}).strict()
export type ConversionTrackingIntegrityEvidence = z.infer<typeof conversionTrackingIntegrityEvidenceSchema>

/**
 * Derive the strongest honest status. Runtime evidence never upgrades an
 * unproven or inconsistent static graph: an observed ping does not prove that
 * the configured campaign goal, tag, and contract are aligned.
 */
export function deriveConversionTrackingIntegrityStatus(
  evidence: ConversionTrackingIntegrityEvidence,
): ConversionTrackingIntegrityStatus {
  if (evidence.staticCheck !== ConversionTrackingStaticCheckStates.consistent) {
    return ConversionTrackingIntegrityStatuses.configured
  }
  if (!evidence.runtimeVerificationRequired) {
    return ConversionTrackingIntegrityStatuses['statically-consistent']
  }
  if (evidence.runtimeObservation === ConversionTrackingRuntimeObservations.observed) {
    return ConversionTrackingIntegrityStatuses.observed
  }
  return ConversionTrackingIntegrityStatuses['runtime-unverified']
}

export const conversionTrackingIntegrityFindingDtoSchema = z.object({
  code: conversionTrackingFindingCodeSchema,
  subject: z.string().trim().min(1),
  outcome: conversionTrackingFindingOutcomeSchema,
  /** The evidence level at which this deterministic finding was produced. */
  status: conversionTrackingIntegrityStatusSchema,
  evidenceIds: z.array(opaqueIdSchema).default([]),
}).strict()
export type ConversionTrackingIntegrityFindingDto = z.infer<typeof conversionTrackingIntegrityFindingDtoSchema>

export const conversionTrackingIntegrityAssessmentDtoSchema = z.object({
  contract: conversionTrackingContractSchema,
  status: conversionTrackingIntegrityStatusSchema,
  findings: z.array(conversionTrackingIntegrityFindingDtoSchema),
  evaluatedAt: z.string(),
}).strict()
export type ConversionTrackingIntegrityAssessmentDto = z.infer<typeof conversionTrackingIntegrityAssessmentDtoSchema>

/**
 * Everything the "declare a conversion" form needs to offer real choices
 * instead of asking an operator to hand-copy opaque numeric ids out of two
 * other consoles.
 *
 * Both lists come from the latest STORED snapshots, so reading them costs no
 * provider quota and cannot spend the advertiser's budget. A list is empty when
 * the provider is connected but has not synced, which the form must present as
 * "sync first", not as "no options exist".
 */
export const conversionTrackingOptionSchema = z.object({
  id: opaqueIdSchema,
  /** Human label the operator recognises, e.g. "Booking completed". */
  name: z.string(),
  /** Secondary line: the Ads category, or the GTM tag type. */
  detail: z.string(),
  /**
   * False when the option exists but is not a sensible target: a removed Ads
   * action, or a paused GTM tag. Offered but flagged, never silently hidden,
   * because a contract may legitimately point at one.
   */
  active: z.boolean(),
})
export type ConversionTrackingOption = z.infer<typeof conversionTrackingOptionSchema>

export const conversionTrackingOptionsDtoSchema = z.object({
  googleAds: z.object({
    /** Null when Google Ads is not connected or no customer is selected. */
    customerId: opaqueIdSchema.nullable(),
    syncedAt: z.string().nullable(),
    conversionActions: z.array(conversionTrackingOptionSchema),
  }),
  gtm: z.object({
    containerId: opaqueIdSchema.nullable(),
    syncedAt: z.string().nullable(),
    tags: z.array(conversionTrackingOptionSchema),
  }),
})
export type ConversionTrackingOptionsDto = z.infer<typeof conversionTrackingOptionsDtoSchema>

