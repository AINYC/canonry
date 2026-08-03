import { z } from 'zod'
import { measurementDraftMutationResponseSchema } from './measurement-draft.js'
import { measurementV2StableKeySchema } from './measurement-plan-v2.js'

/** The CSV parser and preview checksum deliberately version their semantics. */
export const MEASUREMENT_GROUP_MEMBERSHIP_CSV_PARSER_VERSION = 'canonry.measurement-group-membership-csv/v1'
export const MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES = 1_048_576
export const MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS = 5_000

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)
const dataRowNumberSchema = z.number().int().positive()

/** A persisted identity is read by the CSV preview; it is never created there. */
export const measurementDraftSegmentDescriptorSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  kind: z.enum(['target', 'group']),
  retiredAt: z.string().datetime().nullable(),
}).strict()
export type MeasurementDraftSegmentDescriptor = z.output<typeof measurementDraftSegmentDescriptorSchema>

export const measurementDraftPreviewGroupMembershipRequestSchema = z.object({
  csv: z.string(),
}).strict()
export type MeasurementDraftPreviewGroupMembershipRequest = z.output<typeof measurementDraftPreviewGroupMembershipRequestSchema>

export const measurementDraftGroupMembershipRowStatusSchema = z.enum([
  'matched',
  'ambiguous',
  'unmatched',
  'invalid',
  'duplicate',
  'proposed',
  'excluded',
])
export type MeasurementDraftGroupMembershipRowStatus = z.output<typeof measurementDraftGroupMembershipRowStatusSchema>

/** A stable reason lets clients distinguish a repair from an intentional skip. */
export const measurementDraftGroupMembershipRowReasonSchema = z.enum([
  'column-count',
  'missing-property',
  'missing-group',
  'invalid-url',
  'property-not-found',
  'property-label-ambiguous',
  'url-not-exact-match',
  'target-proposed',
  'target-excluded',
  'group-label-ambiguous',
  'group-key-conflict',
])
export type MeasurementDraftGroupMembershipRowReason = z.output<typeof measurementDraftGroupMembershipRowReasonSchema>

const rowSourceSchema = z.object({
  /** One-based logical record number after the CSV header, not a physical line number. */
  dataRow: dataRowNumberSchema,
  property: z.string(),
  group: z.string(),
  url: z.string().nullable(),
  normalizedProperty: z.string(),
  normalizedGroupLabel: z.string(),
}).strict()

const rowFailureSchema = rowSourceSchema.extend({
  reason: measurementDraftGroupMembershipRowReasonSchema,
})

export const measurementDraftGroupMembershipRowSchema = z.discriminatedUnion('status', [
  rowSourceSchema.extend({
    status: z.literal('matched'),
    targetKey: measurementV2StableKeySchema,
    groupKey: measurementV2StableKeySchema,
  }).strict(),
  rowFailureSchema.extend({
    status: z.literal('ambiguous'),
    candidateTargetKeys: z.array(measurementV2StableKeySchema).min(1),
  }).strict(),
  rowFailureSchema.extend({
    status: z.literal('unmatched'),
  }).strict(),
  rowFailureSchema.extend({
    status: z.literal('invalid'),
  }).strict(),
  rowSourceSchema.extend({
    status: z.literal('duplicate'),
    duplicateOfRow: dataRowNumberSchema,
    targetKey: measurementV2StableKeySchema,
    groupKey: measurementV2StableKeySchema,
  }).strict(),
  rowFailureSchema.extend({
    status: z.literal('proposed'),
    targetKey: measurementV2StableKeySchema,
  }).strict(),
  rowFailureSchema.extend({
    status: z.literal('excluded'),
    targetKey: measurementV2StableKeySchema,
  }).strict(),
])
export type MeasurementDraftGroupMembershipRow = z.output<typeof measurementDraftGroupMembershipRowSchema>

/** What the current draft would change. Existing labels and competitors stay untouched. */
export const measurementDraftGroupMembershipChangeSchema = z.object({
  normalizedGroupLabel: z.string(),
  groupKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  action: z.enum(['create', 'extend']),
  matchedRows: z.array(dataRowNumberSchema),
  targetKeys: z.array(measurementV2StableKeySchema),
  addedTargetKeys: z.array(measurementV2StableKeySchema),
  unchangedTargetKeys: z.array(measurementV2StableKeySchema),
}).strict()
export type MeasurementDraftGroupMembershipChange = z.output<typeof measurementDraftGroupMembershipChangeSchema>

export const measurementDraftGroupMembershipImportCountsSchema = z.object({
  dataRows: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative(),
  ambiguousRows: z.number().int().nonnegative(),
  unmatchedRows: z.number().int().nonnegative(),
  invalidRows: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  proposedRows: z.number().int().nonnegative(),
  excludedRows: z.number().int().nonnegative(),
  /** Rows that cannot be committed without correcting the draft or source. */
  needsAttention: z.number().int().nonnegative(),
  groupsReady: z.number().int().nonnegative(),
  groupsToCreate: z.number().int().nonnegative(),
  groupsToExtend: z.number().int().nonnegative(),
  membershipsReady: z.number().int().nonnegative(),
  addedMemberships: z.number().int().nonnegative(),
  unchangedMemberships: z.number().int().nonnegative(),
}).strict()
export type MeasurementDraftGroupMembershipImportCounts = z.output<typeof measurementDraftGroupMembershipImportCountsSchema>

/** Read-semantic response; the caller must bind the later write to both checksums. */
export const measurementDraftPreviewGroupMembershipResponseSchema = z.object({
  draftEtag: z.string().trim().min(1),
  sourceChecksum: sha256HexSchema,
  previewChecksum: sha256HexSchema,
  rows: z.array(measurementDraftGroupMembershipRowSchema),
  groupChanges: z.array(measurementDraftGroupMembershipChangeSchema),
  counts: measurementDraftGroupMembershipImportCountsSchema,
}).strict()
export type MeasurementDraftPreviewGroupMembershipResponse = z.output<typeof measurementDraftPreviewGroupMembershipResponseSchema>

export const measurementDraftApplyGroupMembershipRequestSchema = z.object({
  csv: z.string(),
  sourceChecksum: sha256HexSchema,
  previewChecksum: sha256HexSchema,
  acceptedRows: z.array(dataRowNumberSchema).min(1),
}).strict().superRefine((value, context) => {
  if (new Set(value.acceptedRows).size === value.acceptedRows.length) return
  context.addIssue({
    code: 'custom',
    path: ['acceptedRows'],
    message: 'Accepted CSV data rows must be unique.',
  })
})
export type MeasurementDraftApplyGroupMembershipRequest = z.output<typeof measurementDraftApplyGroupMembershipRequestSchema>

export const measurementDraftApplyGroupMembershipResponseSchema = measurementDraftMutationResponseSchema.extend({
  /** Accepted matched CSV records, including records whose membership was already present. */
  appliedRows: z.number().int().nonnegative(),
  addedMemberships: z.number().int().nonnegative(),
  unchangedMemberships: z.number().int().nonnegative(),
}).strict()
export type MeasurementDraftApplyGroupMembershipResponse = z.output<typeof measurementDraftApplyGroupMembershipResponseSchema>
