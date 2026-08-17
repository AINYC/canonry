import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../src/client.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

const agentSafeTools = [
  ['canonry_google_ads_status', 'read', 'google-ads', 'GET /api/v1/projects/{name}/google-ads/status'],
  ['canonry_google_ads_customers', 'read', 'google-ads', 'GET /api/v1/projects/{name}/google-ads/customers'],
  ['canonry_google_ads_snapshots', 'read', 'google-ads', 'GET /api/v1/projects/{name}/google-ads/snapshots'],
  ['canonry_google_ads_snapshot_get', 'read', 'google-ads', 'GET /api/v1/projects/{name}/google-ads/snapshots/{snapshotId}'],
  ['canonry_google_ads_sync', 'write', 'google-ads', 'POST /api/v1/projects/{name}/google-ads/sync'],
  ['canonry_gtm_status', 'read', 'gtm', 'GET /api/v1/projects/{name}/gtm/status'],
  ['canonry_gtm_accounts', 'read', 'gtm', 'GET /api/v1/projects/{name}/gtm/accounts'],
  ['canonry_gtm_containers', 'read', 'gtm', 'GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers'],
  ['canonry_gtm_workspaces', 'read', 'gtm', 'GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers/{containerId}/workspaces'],
  ['canonry_gtm_snapshots', 'read', 'gtm', 'GET /api/v1/projects/{name}/gtm/snapshots'],
  ['canonry_gtm_snapshot_get', 'read', 'gtm', 'GET /api/v1/projects/{name}/gtm/snapshots/{snapshotId}'],
  ['canonry_gtm_sync', 'write', 'gtm', 'POST /api/v1/projects/{name}/gtm/sync'],
  ['canonry_conversion_tracking_contracts', 'read', 'conversion-tracking', 'GET /api/v1/projects/{name}/conversion-tracking/contracts'],
  ['canonry_conversion_tracking_contract_get', 'read', 'conversion-tracking', 'GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}'],
  ['canonry_conversion_tracking_integrity', 'read', 'conversion-tracking', 'GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}/integrity'],
] as const

const deferredOperatorOperations = [
  'POST /api/v1/projects/{name}/google-ads/oauth/connect',
  'POST /api/v1/projects/{name}/gtm/oauth/connect',
  'PUT /api/v1/projects/{name}/google-ads/selection',
  'PUT /api/v1/projects/{name}/gtm/selection',
  'DELETE /api/v1/projects/{name}/google-ads/connection',
  'DELETE /api/v1/projects/{name}/gtm/connection',
  'POST /api/v1/projects/{name}/conversion-tracking/contracts',
  'PUT /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
  'DELETE /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
] as const

function tool(name: string) {
  const found = canonryMcpTools.find(candidate => candidate.name === name)
  expect(found, name).toBeTruthy()
  return found!
}

describe('Google Marketing MCP surface', () => {
  it('keeps Google Ads and GTM evidence first-class while deferring operator-only state changes', () => {
    for (const [name, access, tier, operation] of agentSafeTools) {
      expect(tool(name)).toMatchObject({
        access,
        tier,
        openApiOperations: [operation],
      })
    }

    const exposedOperations = canonryMcpTools.flatMap(candidate => candidate.openApiOperations)
    expect(exposedOperations).not.toEqual(expect.arrayContaining(deferredOperatorOperations))
    expect(canonryMcpTools.map(candidate => candidate.name)).not.toEqual(expect.arrayContaining([
      'canonry_google_ads_connect',
      'canonry_google_ads_select',
      'canonry_gtm_connect',
      'canonry_gtm_select',
      'canonry_conversion_tracking_contract_create',
      'canonry_conversion_tracking_contract_update',
      'canonry_conversion_tracking_contract_delete',
    ]))

    expect(tool('canonry_google_ads_sync').annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    })
    expect(tool('canonry_gtm_sync').annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    })
  })

  it('validates bounded snapshot and scoped GTM discovery inputs', () => {
    const snapshots = tool('canonry_google_ads_snapshots')
    expect(snapshots.inputSchema.parse({ project: 'example', limit: 100, cursor: 'next' })).toEqual({
      project: 'example', limit: 100, cursor: 'next',
    })
    expect(snapshots.inputSchema.safeParse({ project: 'example', limit: 101 }).success).toBe(false)
    expect(snapshots.inputSchema.safeParse({ project: 'example', extra: true }).success).toBe(false)

    const workspaces = tool('canonry_gtm_workspaces')
    expect(workspaces.inputSchema.parse({
      project: 'example', accountId: 'accounts/1', containerId: 'accounts/1/containers/2',
    })).toEqual({ project: 'example', accountId: 'accounts/1', containerId: 'accounts/1/containers/2' })
    expect(workspaces.inputSchema.safeParse({ project: 'example', accountId: 'accounts/1' }).success).toBe(false)
    expect(workspaces.inputSchema.safeParse({
      project: 'example', accountId: 'accounts/1', containerId: 'accounts/other/containers/2',
    }).success).toBe(false)
    expect(workspaces.inputSchema.safeParse({
      project: 'example', accountId: '..', containerId: '2',
    }).success).toBe(false)
  })

  it('routes every agent-safe tool through the generated SDK-backed ApiClient methods', async () => {
    const client = {
      getGoogleAdsStatus: vi.fn(),
      listGoogleAdsCustomers: vi.fn(),
      listGoogleAdsSnapshots: vi.fn(),
      getGoogleAdsSnapshot: vi.fn(),
      triggerGoogleAdsSync: vi.fn(),
      getGtmStatus: vi.fn(),
      listGtmAccounts: vi.fn(),
      listGtmContainers: vi.fn(),
      listGtmWorkspaces: vi.fn(),
      listGtmSnapshots: vi.fn(),
      getGtmSnapshot: vi.fn(),
      triggerGtmSync: vi.fn(),
      listConversionTrackingContracts: vi.fn(),
      getConversionTrackingContract: vi.fn(),
      getConversionTrackingIntegrity: vi.fn(),
    } as unknown as ApiClient

    const cases = [
      ['canonry_google_ads_status', { project: 'example' }, 'getGoogleAdsStatus', ['example']],
      ['canonry_google_ads_customers', { project: 'example' }, 'listGoogleAdsCustomers', ['example']],
      ['canonry_google_ads_snapshots', { project: 'example', limit: 20, cursor: 'next' }, 'listGoogleAdsSnapshots', ['example', { limit: 20, cursor: 'next' }]],
      ['canonry_google_ads_snapshot_get', { project: 'example', snapshotId: 'ads_snap_1' }, 'getGoogleAdsSnapshot', ['example', 'ads_snap_1']],
      ['canonry_google_ads_sync', { project: 'example' }, 'triggerGoogleAdsSync', ['example']],
      ['canonry_gtm_status', { project: 'example' }, 'getGtmStatus', ['example']],
      ['canonry_gtm_accounts', { project: 'example' }, 'listGtmAccounts', ['example']],
      ['canonry_gtm_containers', { project: 'example', accountId: 'accounts/1' }, 'listGtmContainers', ['example', '1']],
      ['canonry_gtm_workspaces', { project: 'example', accountId: 'accounts/1', containerId: 'accounts/1/containers/2' }, 'listGtmWorkspaces', ['example', '1', '2']],
      ['canonry_gtm_snapshots', { project: 'example', limit: 20, cursor: 'next' }, 'listGtmSnapshots', ['example', { limit: 20, cursor: 'next' }]],
      ['canonry_gtm_snapshot_get', { project: 'example', snapshotId: 'gtm_snap_1' }, 'getGtmSnapshot', ['example', 'gtm_snap_1']],
      ['canonry_gtm_sync', { project: 'example' }, 'triggerGtmSync', ['example']],
      ['canonry_conversion_tracking_contracts', { project: 'example' }, 'listConversionTrackingContracts', ['example']],
      ['canonry_conversion_tracking_contract_get', { project: 'example', contractId: 'contract_1' }, 'getConversionTrackingContract', ['example', 'contract_1']],
      ['canonry_conversion_tracking_integrity', { project: 'example', contractId: 'contract_1' }, 'getConversionTrackingIntegrity', ['example', 'contract_1']],
    ] as const

    for (const [name, input, method, args] of cases) {
      await tool(name).handler(client, input)
      expect(client[method as keyof typeof client]).toHaveBeenCalledWith(...args)
    }
  })
})
