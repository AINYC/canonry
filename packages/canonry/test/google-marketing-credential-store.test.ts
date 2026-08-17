import { expect, it, vi } from 'vitest'
import type { CanonryConfig } from '../src/config.js'
import { getGoogleAdsConnection } from '../src/google-ads-config.js'
import { getGtmConnection } from '../src/gtm-config.js'
import { createGoogleMarketingConfigCredentialStore } from '../src/server.js'

const PROJECT = { id: 'project_1', name: 'example' }
const NOW = '2026-08-14T12:00:00.000Z'

function config(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: {},
    googleAds: {
      developerToken: 'old-developer-token',
      connections: [{
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        credentialGeneration: 'old-ads-generation',
        accessToken: 'old-ads-access-token',
        refreshToken: 'old-ads-refresh-token',
        tokenExpiresAt: '2026-08-14T11:00:00.000Z',
        scopes: ['old-ads-scope'],
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
    gtm: {
      connections: [{
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        credentialGeneration: 'old-gtm-generation',
        accessToken: 'old-gtm-access-token',
        refreshToken: 'old-gtm-refresh-token',
        tokenExpiresAt: '2026-08-14T11:00:00.000Z',
        scopes: ['old-gtm-scope'],
        createdAt: NOW,
        updatedAt: NOW,
      }],
    },
  }
}

it('rolls back an OAuth credential write on persistence failure and can compensate a later DB failure', () => {
  const value = config()
  let failPersistence = true
  const saveConfigPatch = vi.fn(() => {
    if (failPersistence) throw new Error('simulated config save failure')
  })
  const store = createGoogleMarketingConfigCredentialStore({
    config: value,
    saveConfigPatch,
    randomUUID: () => 'new-ads-generation',
  })

  expect(() => store.upsert(PROJECT, 'google-ads', {
    accessToken: 'new-ads-access-token',
    refreshToken: 'new-ads-refresh-token',
    expiresAt: '2026-08-14T14:00:00.000Z',
    scopes: ['new-ads-scope'],
    developerToken: 'new-developer-token',
    createdAt: NOW,
    updatedAt: NOW,
  })).toThrow('simulated config save failure')
  expect(value.googleAds?.developerToken).toBe('old-developer-token')
  expect(getGoogleAdsConnection(value, PROJECT.id)).toMatchObject({
    credentialGeneration: 'old-ads-generation',
    accessToken: 'old-ads-access-token',
    refreshToken: 'old-ads-refresh-token',
  })

  failPersistence = false
  const rollback = store.upsert(PROJECT, 'google-ads', {
    accessToken: 'new-ads-access-token',
    refreshToken: 'new-ads-refresh-token',
    expiresAt: '2026-08-14T14:00:00.000Z',
    scopes: ['new-ads-scope'],
    developerToken: 'new-developer-token',
    createdAt: NOW,
    updatedAt: NOW,
  })
  expect(getGoogleAdsConnection(value, PROJECT.id)).toMatchObject({
    credentialGeneration: 'new-ads-generation',
    accessToken: 'new-ads-access-token',
    refreshToken: 'new-ads-refresh-token',
  })

  rollback()
  expect(value.googleAds?.developerToken).toBe('old-developer-token')
  expect(getGoogleAdsConnection(value, PROJECT.id)).toMatchObject({
    credentialGeneration: 'old-ads-generation',
    accessToken: 'old-ads-access-token',
    refreshToken: 'old-ads-refresh-token',
  })
})

it('restores both provider credential arrays when disconnect persistence fails', () => {
  const value = config()
  const store = createGoogleMarketingConfigCredentialStore({
    config: value,
    saveConfigPatch: () => {
      throw new Error('simulated config save failure')
    },
  })

  expect(() => store.delete(PROJECT, 'google-ads')).toThrow('simulated config save failure')
  expect(getGoogleAdsConnection(value, PROJECT.id)?.refreshToken).toBe('old-ads-refresh-token')
  expect(getGtmConnection(value, PROJECT.id)?.refreshToken).toBe('old-gtm-refresh-token')

  expect(() => store.delete(PROJECT, 'gtm')).toThrow('simulated config save failure')
  expect(getGoogleAdsConnection(value, PROJECT.id)?.refreshToken).toBe('old-ads-refresh-token')
  expect(getGtmConnection(value, PROJECT.id)?.refreshToken).toBe('old-gtm-refresh-token')
})
