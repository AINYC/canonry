import { describe, expect, it } from 'vitest'
import type {
  CanonryConfig,
  GoogleAdsConnectionConfigEntry,
  GtmConnectionConfigEntry,
} from '../src/config.js'
import {
  getGoogleAdsAuthConfig,
  getGoogleAdsConnection,
  patchGoogleAdsConnection,
  removeGoogleAdsConnection,
  removeLegacyGoogleAdsConnections,
  setGoogleAdsAuthConfig,
  upsertGoogleAdsConnection,
} from '../src/google-ads-config.js'
import {
  getGtmAuthConfig,
  getGtmConnection,
  patchGtmConnection,
  removeGtmConnection,
  removeLegacyGtmConnections,
  upsertGtmConnection,
} from '../src/gtm-config.js'

function config(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/canonry-google-marketing.db',
    apiKey: 'cnry_test',
    google: { clientId: 'shared-client', clientSecret: 'shared-secret' },
  }
}

describe('Google marketing credential config', () => {
  it('uses dedicated Ads OAuth credentials when present and otherwise falls back to shared Google', () => {
    const value = config()
    expect(getGoogleAdsAuthConfig(value)).toMatchObject({
      clientId: 'shared-client',
      clientSecret: 'shared-secret',
    })
    setGoogleAdsAuthConfig(value, {
      developerToken: 'developer-token',
      clientId: 'ads-client',
      clientSecret: 'ads-secret',
    })
    expect(getGoogleAdsAuthConfig(value)).toEqual({
      developerToken: 'developer-token',
      clientId: 'ads-client',
      clientSecret: 'ads-secret',
    })
  })

  it('stores and rotates project-ID-scoped Ads OAuth material', () => {
    const value = config()
    const now = '2026-08-14T12:00:00.000Z'
    upsertGoogleAdsConnection(value, {
      projectId: 'project_example',
      projectName: 'example',
      refreshToken: 'refresh-1',
      scopes: ['adwords'],
      createdAt: now,
      updatedAt: now,
    })
    patchGoogleAdsConnection(value, 'project_example', { accessToken: 'access-2', updatedAt: now })
    expect(getGoogleAdsConnection(value, 'project_example')).toMatchObject({
      refreshToken: 'refresh-1',
      accessToken: 'access-2',
    })
    expect(removeGoogleAdsConnection(value, 'project_example')).toBe(true)
    expect(getGoogleAdsConnection(value, 'project_example')).toBeUndefined()
  })

  it('stores GTM OAuth material independently from Ads', () => {
    const value = config()
    const now = '2026-08-14T12:00:00.000Z'
    upsertGtmConnection(value, {
      projectId: 'project_example',
      projectName: 'example',
      refreshToken: 'gtm-refresh',
      createdAt: now,
      updatedAt: now,
    })
    patchGtmConnection(value, 'project_example', { scopes: ['tagmanager.readonly'], updatedAt: now })
    expect(getGtmConnection(value, 'project_example')?.scopes).toEqual(['tagmanager.readonly'])
    expect(getGtmAuthConfig(value)).toEqual({
      clientId: 'shared-client',
      clientSecret: 'shared-secret',
    })
    expect(removeGtmConnection(value, 'project_example')).toBe(true)
  })

  it('does not resurrect either provider credential when a project name is reused', () => {
    const value = config()
    const now = '2026-08-14T12:00:00.000Z'
    upsertGoogleAdsConnection(value, {
      projectId: 'project_deleted',
      projectName: 'example',
      refreshToken: 'ads-refresh-deleted-project',
      createdAt: now,
      updatedAt: now,
    })
    upsertGtmConnection(value, {
      projectId: 'project_deleted',
      projectName: 'example',
      refreshToken: 'gtm-refresh-deleted-project',
      createdAt: now,
      updatedAt: now,
    })

    // The host project-delete hook has only the immutable project identity.
    expect(removeGoogleAdsConnection(value, 'project_deleted')).toBe(true)
    expect(removeGtmConnection(value, 'project_deleted')).toBe(true)

    const recreatedProjectId = 'project_recreated'
    expect(getGoogleAdsConnection(value, recreatedProjectId)).toBeUndefined()
    expect(getGtmConnection(value, recreatedProjectId)).toBeUndefined()
    expect(getGoogleAdsConnection(value, 'project_deleted')).toBeUndefined()
    expect(getGtmConnection(value, 'project_deleted')).toBeUndefined()
  })

  it('purges legacy name-only credentials instead of retaining unreachable secrets', () => {
    const value = config()
    value.googleAds = {
      connections: [{
        projectName: 'example',
        refreshToken: 'legacy-ads-secret',
        createdAt: '2026-08-14T12:00:00.000Z',
        updatedAt: '2026-08-14T12:00:00.000Z',
      } as GoogleAdsConnectionConfigEntry],
    }
    value.gtm = {
      connections: [{
        projectName: 'example',
        refreshToken: 'legacy-gtm-secret',
        createdAt: '2026-08-14T12:00:00.000Z',
        updatedAt: '2026-08-14T12:00:00.000Z',
      } as GtmConnectionConfigEntry],
    }

    expect(removeLegacyGoogleAdsConnections(value)).toBe(1)
    expect(removeLegacyGtmConnections(value)).toBe(1)
    expect(value.googleAds.connections).toEqual([])
    expect(value.gtm.connections).toEqual([])
  })

  it('never falls back to a legacy mutable project name', () => {
    const value = config()
    const now = '2026-08-14T12:00:00.000Z'
    value.googleAds = {
      connections: [{
        projectName: 'example',
        refreshToken: 'legacy-ads-refresh',
        createdAt: now,
        updatedAt: now,
      } as unknown as GoogleAdsConnectionConfigEntry],
    }
    value.gtm = {
      connections: [{
        projectName: 'example',
        refreshToken: 'legacy-gtm-refresh',
        createdAt: now,
        updatedAt: now,
      } as unknown as GtmConnectionConfigEntry],
    }

    expect(getGoogleAdsConnection(value, 'project_recreated')).toBeUndefined()
    expect(getGtmConnection(value, 'project_recreated')).toBeUndefined()
  })
})
