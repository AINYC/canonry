import { z } from 'zod'

const opaqueIdSchema = z.string().trim().min(1)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)

/** Read-only GTM connection state. OAuth credentials are never serializable here. */
export const gtmConnectionStateSchema = z.enum([
  'not-connected',
  'selection-required',
  'connected',
  'stale',
])
export type GtmConnectionState = z.infer<typeof gtmConnectionStateSchema>
export const GtmConnectionStates = gtmConnectionStateSchema.enum

export const gtmGraphSourceSchema = z.enum(['live', 'draft'])
export type GtmGraphSource = z.infer<typeof gtmGraphSourceSchema>
export const GtmGraphSources = gtmGraphSourceSchema.enum

export const gtmSelectionDtoSchema = z.object({
  accountId: opaqueIdSchema.nullable(),
  containerId: opaqueIdSchema.nullable(),
  workspaceId: opaqueIdSchema.nullable(),
  selectedAt: z.string().nullable(),
}).strict()
export type GtmSelectionDto = z.infer<typeof gtmSelectionDtoSchema>

/** Project-local metadata only. It deliberately contains no OAuth token or client secret. */
export const gtmConnectionMetadataDtoSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  scopes: z.array(z.string()).default([]),
  selection: gtmSelectionDtoSchema,
  lastValidatedAt: z.string().nullable(),
  lastSnapshotAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type GtmConnectionMetadataDto = z.infer<typeof gtmConnectionMetadataDtoSchema>

export const gtmAccountDtoSchema = z.object({
  id: opaqueIdSchema,
  path: z.string(),
  name: z.string(),
  shareData: z.boolean().nullable(),
}).strict()
export type GtmAccountDto = z.infer<typeof gtmAccountDtoSchema>

export const gtmContainerDtoSchema = z.object({
  accountId: opaqueIdSchema,
  id: opaqueIdSchema,
  path: z.string(),
  name: z.string(),
  publicId: z.string().nullable(),
  domainName: z.string().nullable(),
  usageContexts: z.array(z.string()),
}).strict()
export type GtmContainerDto = z.infer<typeof gtmContainerDtoSchema>

export const gtmWorkspaceDtoSchema = z.object({
  accountId: opaqueIdSchema,
  containerId: opaqueIdSchema,
  id: opaqueIdSchema,
  path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fingerprint: z.string().nullable(),
}).strict()
export type GtmWorkspaceDto = z.infer<typeof gtmWorkspaceDtoSchema>

export const gtmAccountsResponseSchema = z.object({
  accounts: z.array(gtmAccountDtoSchema),
  totalAccessible: z.number().int().nonnegative(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
}).strict()
export type GtmAccountsResponse = z.infer<typeof gtmAccountsResponseSchema>

export const gtmContainerListResponseSchema = z.object({
  accountId: opaqueIdSchema,
  containers: z.array(gtmContainerDtoSchema),
  totalAccessible: z.number().int().nonnegative(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
}).strict()
export type GtmContainerListResponse = z.infer<typeof gtmContainerListResponseSchema>

export const gtmWorkspaceListResponseSchema = z.object({
  accountId: opaqueIdSchema,
  containerId: opaqueIdSchema,
  workspaces: z.array(gtmWorkspaceDtoSchema),
  totalAccessible: z.number().int().nonnegative(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
}).strict()
export type GtmWorkspaceListResponse = z.infer<typeof gtmWorkspaceListResponseSchema>

/** A sanitized tag graph omits parameter values, custom HTML, and any credential-bearing template content. */
export const gtmTagDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  type: z.string(),
  paused: z.boolean(),
  firingTriggerIds: z.array(opaqueIdSchema),
  blockingTriggerIds: z.array(opaqueIdSchema),
  /** User-defined GTM variables referenced anywhere in this tag's parameter graph. */
  referencedVariableIds: z.array(opaqueIdSchema),
  /** Names only; parameter values are intentionally not persisted. */
  parameterKeys: z.array(z.string()),
  fingerprint: z.string().nullable(),
}).strict()
export type GtmTagDto = z.infer<typeof gtmTagDtoSchema>

export const gtmTriggerDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  type: z.string(),
  /** Sanitized custom-event names, when a trigger exposes them. */
  customEventNames: z.array(z.string()),
  /** Condition parameter keys only; expressions and values remain out of storage. */
  filterKeys: z.array(z.string()),
  autoEventFilterKeys: z.array(z.string()),
  fingerprint: z.string().nullable(),
}).strict()
export type GtmTriggerDto = z.infer<typeof gtmTriggerDtoSchema>

export const gtmVariableDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  type: z.string(),
  /** The data-layer key is needed for static contract checks and is not a secret value. */
  dataLayerVariableName: z.string().nullable(),
  parameterKeys: z.array(z.string()),
  fingerprint: z.string().nullable(),
}).strict()
export type GtmVariableDto = z.infer<typeof gtmVariableDtoSchema>

/** Whether Canonry could safely recognize a GTM tag's Google Ads conversion semantics. */
export const gtmGoogleAdsTagAssessmentRecognitionSchema = z.enum(['recognized', 'unknown'])
export type GtmGoogleAdsTagAssessmentRecognition = z.infer<typeof gtmGoogleAdsTagAssessmentRecognitionSchema>
export const GtmGoogleAdsTagAssessmentRecognitions = gtmGoogleAdsTagAssessmentRecognitionSchema.enum

/** A safe mapping stores a literal or variable reference, never a raw template parameter body. */
export const gtmGoogleAdsTagMappingSourceSchema = z.enum([
  'literal',
  'variable-ref',
  'absent',
  'unknown',
])
export type GtmGoogleAdsTagMappingSource = z.infer<typeof gtmGoogleAdsTagMappingSourceSchema>
export const GtmGoogleAdsTagMappingSources = gtmGoogleAdsTagMappingSourceSchema.enum

/**
 * A GTM variable name is configuration metadata, not an evaluated value. Keep
 * the persisted form deliberately narrow: the braces make it clear that this
 * is a reference, and the character/length bound prevents it becoming an
 * arbitrary literal transport.
 */
const gtmGoogleAdsTagVariableReferenceSchema = z.string().trim().min(5).max(132)
  .regex(/^\{\{\w[\w ./-]{0,127}\}\}$/)

const gtmGoogleAdsTagAbsentMappingDtoSchema = z.object({
  source: z.literal(GtmGoogleAdsTagMappingSources.absent),
  literal: z.null(),
  variableRef: z.null(),
}).strict()

const gtmGoogleAdsTagUnknownMappingDtoSchema = z.object({
  source: z.literal(GtmGoogleAdsTagMappingSources.unknown),
  literal: z.null(),
  variableRef: z.null(),
}).strict()

const gtmGoogleAdsTagVariableReferenceMappingDtoSchema = z.object({
  source: z.literal(GtmGoogleAdsTagMappingSources['variable-ref']),
  literal: z.null(),
  variableRef: gtmGoogleAdsTagVariableReferenceSchema,
}).strict()

function literalMappingSchema(literal: z.ZodType<string>) {
  return z.object({
    source: z.literal(GtmGoogleAdsTagMappingSources.literal),
    literal,
    variableRef: z.null(),
  }).strict()
}

/** Safe Google Ads conversion IDs (`AW-` plus a bounded numeric ID). */
const gtmGoogleAdsConversionIdLiteralSchema = z.string().trim().max(23)
  .regex(/^(?:AW-)?\d{1,20}$/i)

/** Google Ads conversion labels are opaque IDs, not free-form operator text. */
const gtmGoogleAdsConversionLabelLiteralSchema = z.string().trim().min(1).max(128)
  .regex(/^[\w-]+$/)

/**
 * GTM values arrive as strings. Persist only a bounded decimal representation
 * rather than an arbitrary tag literal. The DTO adapter canonicalizes safe
 * values before this OpenAPI-visible persistence schema receives them.
 */
const gtmGoogleAdsConversionValueLiteralSchema = z.string().trim().min(1).max(20)
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)

/** ISO 4217-style static currency values; variable references remain explicit. */
const gtmGoogleAdsCurrencyLiteralSchema = z.string().trim().length(3)
  .regex(/^[a-z]{3}$/i)

/**
 * Generic mapping vocabulary for callers that only need to inspect source
 * shape. Assessments below use field-specific variants, which are the
 * persistence boundary for provider-derived GTM values.
 */
export const gtmGoogleAdsTagFieldMappingDtoSchema = z.discriminatedUnion('source', [
  literalMappingSchema(z.string().trim().min(1).max(256)),
  gtmGoogleAdsTagVariableReferenceMappingDtoSchema,
  gtmGoogleAdsTagAbsentMappingDtoSchema,
  gtmGoogleAdsTagUnknownMappingDtoSchema,
])
export type GtmGoogleAdsTagFieldMappingDto = z.infer<typeof gtmGoogleAdsTagFieldMappingDtoSchema>

/** Conversion IDs may be canonical safe literals or bounded GTM references. */
export const gtmGoogleAdsConversionIdMappingDtoSchema = z.discriminatedUnion('source', [
  literalMappingSchema(gtmGoogleAdsConversionIdLiteralSchema),
  gtmGoogleAdsTagVariableReferenceMappingDtoSchema,
  gtmGoogleAdsTagAbsentMappingDtoSchema,
  gtmGoogleAdsTagUnknownMappingDtoSchema,
])

/** Conversion labels may be opaque safe literals or bounded GTM references. */
export const gtmGoogleAdsConversionLabelMappingDtoSchema = z.discriminatedUnion('source', [
  literalMappingSchema(gtmGoogleAdsConversionLabelLiteralSchema),
  gtmGoogleAdsTagVariableReferenceMappingDtoSchema,
  gtmGoogleAdsTagAbsentMappingDtoSchema,
  gtmGoogleAdsTagUnknownMappingDtoSchema,
])

/** Values may be bounded decimals or bounded GTM references. */
export const gtmGoogleAdsConversionValueMappingDtoSchema = z.discriminatedUnion('source', [
  literalMappingSchema(gtmGoogleAdsConversionValueLiteralSchema),
  gtmGoogleAdsTagVariableReferenceMappingDtoSchema,
  gtmGoogleAdsTagAbsentMappingDtoSchema,
  gtmGoogleAdsTagUnknownMappingDtoSchema,
])

/**
 * Transaction IDs are evaluated user data. Preserve a variable reference only;
 * static order IDs, emails, and other literals are never persisted.
 */
export const gtmGoogleAdsTransactionIdMappingDtoSchema = z.discriminatedUnion('source', [
  gtmGoogleAdsTagVariableReferenceMappingDtoSchema,
  gtmGoogleAdsTagAbsentMappingDtoSchema,
  gtmGoogleAdsTagUnknownMappingDtoSchema,
])

/** Currency may be a normalized ISO-style code or a bounded GTM reference. */
export const gtmGoogleAdsCurrencyMappingDtoSchema = z.discriminatedUnion('source', [
  literalMappingSchema(gtmGoogleAdsCurrencyLiteralSchema),
  gtmGoogleAdsTagVariableReferenceMappingDtoSchema,
  gtmGoogleAdsTagAbsentMappingDtoSchema,
  gtmGoogleAdsTagUnknownMappingDtoSchema,
])

export const gtmGoogleAdsTagTriggerStrategySchema = z.enum([
  'all-pages',
  'custom-event',
  'filtered',
  'unknown',
])
export type GtmGoogleAdsTagTriggerStrategy = z.infer<typeof gtmGoogleAdsTagTriggerStrategySchema>
export const GtmGoogleAdsTagTriggerStrategies = gtmGoogleAdsTagTriggerStrategySchema.enum

/** A redacted GTM condition keeps only the semantics needed for static checks. */
export const gtmGoogleAdsConditionPredicateDtoSchema = z.object({
  operator: z.string().trim().min(1).max(64),
  value: z.string().max(2_048),
  negated: z.boolean(),
  ignoreCase: z.boolean(),
}).strict()
export type GtmGoogleAdsConditionPredicateDto = z.infer<
  typeof gtmGoogleAdsConditionPredicateDtoSchema
>

/** Conditions stay grouped by firing trigger so unrelated predicates cannot be combined. */
export const gtmGoogleAdsTriggerPredicateDtoSchema = z.object({
  triggerId: opaqueIdSchema,
  triggerType: z.string(),
  eventPredicates: z.array(gtmGoogleAdsConditionPredicateDtoSchema),
  hostnamePredicates: z.array(gtmGoogleAdsConditionPredicateDtoSchema),
  /** Other or malformed conditions can restrict firing, so integrity must fail closed. */
  unsupportedConditionCount: z.number().int().nonnegative(),
}).strict()
export type GtmGoogleAdsTriggerPredicateDto = z.infer<
  typeof gtmGoogleAdsTriggerPredicateDtoSchema
>

export const gtmGoogleAdsTagReviewReasonSchema = z.enum([
  'not-google-ads-tag',
  'unsupported-tag-type',
  'custom-html-opaque',
  'conversion-id-unresolved',
  'conversion-label-unresolved',
  'value-mapping-missing',
  'transaction-id-mapping-missing',
  'currency-mapping-missing',
  'trigger-unresolved',
  'hostname-filter-unresolved',
])
export type GtmGoogleAdsTagReviewReason = z.infer<typeof gtmGoogleAdsTagReviewReasonSchema>
export const GtmGoogleAdsTagReviewReasons = gtmGoogleAdsTagReviewReasonSchema.enum

/**
 * Provider-neutral, redacted assessment of one GTM tag as a Google Ads
 * conversion source. The individual mappings enforce their own safe literal
 * forms. `orderId` never stores a literal, and custom HTML/template bodies
 * remain opaque.
 */
export const gtmGoogleAdsTagAssessmentDtoSchema = z.object({
  tagId: opaqueIdSchema,
  tagType: z.string(),
  recognition: gtmGoogleAdsTagAssessmentRecognitionSchema,
  recognitionReason: z.string().nullable(),
  conversionId: gtmGoogleAdsConversionIdMappingDtoSchema,
  conversionLabel: gtmGoogleAdsConversionLabelMappingDtoSchema,
  value: gtmGoogleAdsConversionValueMappingDtoSchema,
  transactionId: gtmGoogleAdsTransactionIdMappingDtoSchema,
  currency: gtmGoogleAdsCurrencyMappingDtoSchema,
  triggerStrategy: gtmGoogleAdsTagTriggerStrategySchema,
  triggerIds: z.array(opaqueIdSchema),
  triggerPredicates: z.array(gtmGoogleAdsTriggerPredicateDtoSchema),
  reviewReasons: z.array(gtmGoogleAdsTagReviewReasonSchema),
}).strict().superRefine((assessment, context) => {
  if (
    assessment.recognition === GtmGoogleAdsTagAssessmentRecognitions.recognized
    && assessment.recognitionReason !== null
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recognitionReason'], message: 'Recognized assessments cannot carry an unknown-recognition reason.' })
  }
  if (
    assessment.recognition === GtmGoogleAdsTagAssessmentRecognitions.unknown
    && !assessment.recognitionReason
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recognitionReason'], message: 'Unknown assessments require a recognition reason.' })
  }
})
export type GtmGoogleAdsTagAssessmentDto = z.infer<typeof gtmGoogleAdsTagAssessmentDtoSchema>

/** Tags, triggers, and variables at one immutable live version or mutable draft workspace. */
export const gtmConfigurationGraphDtoSchema = z.object({
  accountId: opaqueIdSchema,
  containerId: opaqueIdSchema,
  workspaceId: opaqueIdSchema.nullable(),
  tags: z.array(gtmTagDtoSchema),
  triggers: z.array(gtmTriggerDtoSchema),
  variables: z.array(gtmVariableDtoSchema),
  googleAdsTagAssessments: z.array(gtmGoogleAdsTagAssessmentDtoSchema).default([]),
}).strict()
export type GtmConfigurationGraphDto = z.infer<typeof gtmConfigurationGraphDtoSchema>

export const gtmContainerVersionDtoSchema = z.object({
  accountId: opaqueIdSchema,
  containerId: opaqueIdSchema,
  id: opaqueIdSchema,
  path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fingerprint: z.string().nullable(),
  deleted: z.boolean(),
}).strict()
export type GtmContainerVersionDto = z.infer<typeof gtmContainerVersionDtoSchema>

export const gtmLiveContainerGraphDtoSchema = z.object({
  source: z.literal(GtmGraphSources.live),
  version: gtmContainerVersionDtoSchema,
  graph: gtmConfigurationGraphDtoSchema,
  fetchedAt: z.string(),
}).strict()
export type GtmLiveContainerGraphDto = z.infer<typeof gtmLiveContainerGraphDtoSchema>

export const gtmDraftWorkspaceGraphDtoSchema = z.object({
  source: z.literal(GtmGraphSources.draft),
  workspace: gtmWorkspaceDtoSchema,
  graph: gtmConfigurationGraphDtoSchema,
  /** Number of GTM workspace conflicts observed during the read, not a write result. */
  conflictCount: z.number().int().nonnegative(),
  fetchedAt: z.string(),
}).strict()
export type GtmDraftWorkspaceGraphDto = z.infer<typeof gtmDraftWorkspaceGraphDtoSchema>

/** The selected container plus both deployed (live) and candidate (draft) graph views. */
export const gtmContainerGraphDtoSchema = z.object({
  account: gtmAccountDtoSchema,
  container: gtmContainerDtoSchema,
  workspaces: z.array(gtmWorkspaceDtoSchema),
  live: gtmLiveContainerGraphDtoSchema.nullable(),
  draft: gtmDraftWorkspaceGraphDtoSchema.nullable(),
  fetchedAt: z.string(),
}).strict()
export type GtmContainerGraphDto = z.infer<typeof gtmContainerGraphDtoSchema>

/** Disconnected/selection-required states cannot leak an account/container graph. */
export const gtmConnectionStatusDtoSchema = z.discriminatedUnion('status', [
  z.object({
    connected: z.literal(false),
    status: z.literal(GtmConnectionStates['not-connected']),
    connection: z.null(),
    selection: z.null(),
  }).strict(),
  z.object({
    connected: z.literal(true),
    status: z.literal(GtmConnectionStates['selection-required']),
    connection: gtmConnectionMetadataDtoSchema,
    selection: gtmSelectionDtoSchema,
  }).strict(),
  z.object({
    connected: z.literal(true),
    status: z.literal(GtmConnectionStates.connected),
    connection: gtmConnectionMetadataDtoSchema,
    selection: gtmSelectionDtoSchema,
  }).strict(),
  z.object({
    connected: z.literal(true),
    status: z.literal(GtmConnectionStates.stale),
    connection: gtmConnectionMetadataDtoSchema,
    selection: gtmSelectionDtoSchema,
  }).strict(),
])
export type GtmConnectionStatusDto = z.infer<typeof gtmConnectionStatusDtoSchema>

export const gtmSnapshotKindSchema = z.enum(['accounts', 'container', 'live', 'draft'])
export type GtmSnapshotKind = z.infer<typeof gtmSnapshotKindSchema>
export const GtmSnapshotKinds = gtmSnapshotKindSchema.enum

/**
 * The original provider body stays out of the DB. These fields allow integrity
 * and freshness audits to identify the exact redacted observation that was read.
 */
export const gtmRawSnapshotMetadataDtoSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  connectionId: opaqueIdSchema,
  runId: opaqueIdSchema,
  kind: gtmSnapshotKindSchema,
  accountId: opaqueIdSchema.nullable(),
  containerId: opaqueIdSchema.nullable(),
  workspaceId: opaqueIdSchema.nullable(),
  payloadChecksum: sha256Schema,
  rawPayloadSha256: sha256Schema.nullable(),
  rawPayloadBytes: z.number().int().nonnegative().nullable(),
  redactedFieldCount: z.number().int().nonnegative(),
  capturedAt: z.string(),
  createdAt: z.string(),
}).strict()
export type GtmRawSnapshotMetadataDto = z.infer<typeof gtmRawSnapshotMetadataDtoSchema>

export const gtmSnapshotPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(GtmSnapshotKinds.accounts),
    data: gtmAccountsResponseSchema,
  }).strict(),
  z.object({
    kind: z.literal(GtmSnapshotKinds.container),
    data: gtmContainerGraphDtoSchema,
  }).strict(),
  z.object({
    kind: z.literal(GtmSnapshotKinds.live),
    data: gtmLiveContainerGraphDtoSchema,
  }).strict(),
  z.object({
    kind: z.literal(GtmSnapshotKinds.draft),
    data: gtmDraftWorkspaceGraphDtoSchema,
  }).strict(),
])
export type GtmSnapshotPayload = z.infer<typeof gtmSnapshotPayloadSchema>

export const gtmRawSnapshotDtoSchema = z.object({
  metadata: gtmRawSnapshotMetadataDtoSchema,
  payload: gtmSnapshotPayloadSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.metadata.kind !== snapshot.payload.kind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'kind'], message: 'Snapshot metadata and payload kinds must match.' })
  }
})
export type GtmRawSnapshotDto = z.infer<typeof gtmRawSnapshotDtoSchema>
