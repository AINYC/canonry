import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES,
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS,
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_PARSER_VERSION,
  measurementDraftApplyGroupMembershipRequestSchema,
  measurementDraftApplyGroupMembershipResponseSchema,
  measurementDraftPreviewGroupMembershipRequestSchema,
  measurementDraftPreviewGroupMembershipResponseSchema,
  measurementDraftSegmentDescriptorSchema,
} from '../src/measurement-group-import.js'

const CHECKSUM = 'a'.repeat(64)

describe('measurement group membership import contracts', () => {
  it('keeps the CSV bounds and parser version explicit', () => {
    expect(MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES).toBe(1_048_576)
    expect(MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS).toBe(5_000)
    expect(MEASUREMENT_GROUP_MEMBERSHIP_CSV_PARSER_VERSION).toBe('canonry.measurement-group-membership-csv/v1')
  })

  it('accepts a strict preview request and no incidental route fields', () => {
    expect(measurementDraftPreviewGroupMembershipRequestSchema.parse({ csv: 'property,group\nHarbor House,Dallas' }))
      .toEqual({ csv: 'property,group\nHarbor House,Dallas' })
    expect(() => measurementDraftPreviewGroupMembershipRequestSchema.parse({ csv: 'x', write: true })).toThrow()
  })

  it('requires both checksums and a unique non-empty reviewed selection for apply', () => {
    const request = {
      csv: 'property,group\nHarbor House,Dallas',
      sourceChecksum: CHECKSUM,
      previewChecksum: 'b'.repeat(64),
      acceptedRows: [1, 2],
    }
    expect(measurementDraftApplyGroupMembershipRequestSchema.parse(request)).toEqual(request)
    expect(() => measurementDraftApplyGroupMembershipRequestSchema.parse({ ...request, acceptedRows: [] })).toThrow()
    expect(() => measurementDraftApplyGroupMembershipRequestSchema.parse({ ...request, acceptedRows: [1, 1] })).toThrow()
    expect(() => measurementDraftApplyGroupMembershipRequestSchema.parse({ ...request, sourceChecksum: 'not-a-checksum' })).toThrow()
    expect(() => measurementDraftApplyGroupMembershipRequestSchema.parse({ ...request, acceptedRows: [0] })).toThrow()
  })

  it('makes persisted segment state typed and explicit for preview/apply parity', () => {
    expect(measurementDraftSegmentDescriptorSchema.parse({
      stableKey: 'group-dallas',
      kind: 'group',
      retiredAt: null,
    })).toEqual({ stableKey: 'group-dallas', kind: 'group', retiredAt: null })
    expect(() => measurementDraftSegmentDescriptorSchema.parse({
      stableKey: 'group-dallas',
      kind: 'segment',
      retiredAt: null,
    })).toThrow()
  })

  it('expresses every row outcome without permitting unresolved rows to masquerade as matched', () => {
    const base = {
      dataRow: 1,
      property: 'Harbor House',
      group: 'Dallas',
      url: 'https://example.com/harbor-house',
      normalizedProperty: 'harbor house',
      normalizedGroupLabel: 'dallas',
    }
    const response = measurementDraftPreviewGroupMembershipResponseSchema.parse({
      draftEtag: '"mpd_4"',
      sourceChecksum: CHECKSUM,
      previewChecksum: 'b'.repeat(64),
      rows: [
        { ...base, status: 'matched', targetKey: 'harbor-house', groupKey: 'group-dallas' },
        { ...base, dataRow: 2, status: 'ambiguous', reason: 'property-label-ambiguous', candidateTargetKeys: ['harbor-house', 'harbor-house-2'] },
        { ...base, dataRow: 3, status: 'unmatched', reason: 'url-not-exact-match' },
        { ...base, dataRow: 4, status: 'invalid', reason: 'invalid-url' },
        { ...base, dataRow: 5, status: 'duplicate', duplicateOfRow: 1, targetKey: 'harbor-house', groupKey: 'group-dallas' },
        { ...base, dataRow: 6, status: 'proposed', reason: 'target-proposed', targetKey: 'harbor-house' },
        { ...base, dataRow: 7, status: 'excluded', reason: 'target-excluded', targetKey: 'harbor-house' },
      ],
      groupChanges: [{
        normalizedGroupLabel: 'dallas',
        groupKey: 'group-dallas',
        label: 'Dallas',
        action: 'create',
        matchedRows: [1],
        targetKeys: ['harbor-house'],
        addedTargetKeys: ['harbor-house'],
        unchangedTargetKeys: [],
      }],
      counts: {
        dataRows: 7,
        matchedRows: 1,
        ambiguousRows: 1,
        unmatchedRows: 1,
        invalidRows: 1,
        duplicateRows: 1,
        proposedRows: 1,
        excludedRows: 1,
        needsAttention: 4,
        groupsReady: 1,
        groupsToCreate: 1,
        groupsToExtend: 0,
        membershipsReady: 1,
        addedMemberships: 1,
        unchangedMemberships: 0,
      },
    })
    expect(response.rows).toHaveLength(7)
    expect(() => measurementDraftPreviewGroupMembershipResponseSchema.parse({
      ...response,
      rows: [{ ...base, status: 'matched', targetKey: 'harbor-house' }],
    })).toThrow()
  })

  it('extends the standard draft mutation response with concrete import result counts', () => {
    const response = measurementDraftApplyGroupMembershipResponseSchema.parse({
      etag: '"mpd_5"',
      changed: true,
      warnings: [],
      counts: {
        targets: 1,
        includedTargets: 1,
        assignments: 0,
        unclassifiedAssignments: 0,
        groups: 1,
        competitors: 0,
      },
      appliedRows: 2,
      addedMemberships: 1,
      unchangedMemberships: 1,
    })
    expect(response.addedMemberships).toBe(1)
  })
})
