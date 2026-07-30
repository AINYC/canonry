import { describe, expect, it } from 'vitest'
import {
  gscPlatformPropertyDtoSchema,
  gscPlatformPropertyListResponseDtoSchema,
  gscPlatformPropertyUpsertRequestDtoSchema,
  gscPlatformPerformanceDtoSchema,
} from '../src/google.js'

describe('GSC platform-property contracts', () => {
  const property = {
    id: 'property_1',
    projectId: 'project_1',
    siteUrl: '123456789',
    displayName: null,
    platform: 'youtube',
    kind: 'social-video',
    permissionLevel: null,
    status: 'active',
    lastSyncedAt: null,
    lastError: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }

  it('accepts the additive social/video platform property DTO and list envelope', () => {
    expect(gscPlatformPropertyDtoSchema.parse(property)).toEqual(property)
    expect(gscPlatformPropertyListResponseDtoSchema.parse({ properties: [property] })).toEqual({ properties: [property] })
  })

  it('validates platform upserts and defaults their forward-compatible kind', () => {
    expect(gscPlatformPropertyUpsertRequestDtoSchema.parse({
      siteUrl: '123456789',
      platform: 'instagram',
      displayName: null,
    })).toEqual({
      siteUrl: '123456789',
      platform: 'instagram',
      displayName: null,
      kind: 'social-video',
    })
    expect(gscPlatformPropertyUpsertRequestDtoSchema.safeParse({ siteUrl: '', platform: 'linkedin' }).success).toBe(false)
  })

  it('accepts platform performance rows without conflating property identity', () => {
    const parsed = gscPlatformPerformanceDtoSchema.parse({
      properties: [property],
      selectedPropertyId: 'property_1',
      window: { startDate: '2026-07-01', endDate: '2026-07-30' },
      totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 },
      daily: [{ date: '2026-07-30', clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 }],
      rows: [{
        propertyId: 'property_1',
        siteUrl: '123456789',
        displayName: null,
        platform: 'youtube',
        dimension: 'query',
        value: 'canonry',
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 4.2,
      }],
      pagination: { limit: 50, offset: 0, hasMore: false },
    })

    expect(parsed.rows[0]?.platform).toBe('youtube')
  })
})
