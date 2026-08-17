import { describe, expect, it } from 'vitest'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'

const googleMarketingOperations = {
  included: [
    'GET /api/v1/projects/{name}/google-ads/status',
    'GET /api/v1/projects/{name}/gtm/status',
    'GET /api/v1/projects/{name}/google-ads/customers',
    'GET /api/v1/projects/{name}/gtm/accounts',
    'GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers',
    'GET /api/v1/projects/{name}/gtm/accounts/{accountId}/containers/{containerId}/workspaces',
    'POST /api/v1/projects/{name}/google-ads/sync',
    'POST /api/v1/projects/{name}/gtm/sync',
    'GET /api/v1/projects/{name}/google-ads/snapshots',
    'GET /api/v1/projects/{name}/google-ads/snapshots/{snapshotId}',
    'GET /api/v1/projects/{name}/gtm/snapshots',
    'GET /api/v1/projects/{name}/gtm/snapshots/{snapshotId}',
    'GET /api/v1/projects/{name}/conversion-tracking/contracts',
    'GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
    'GET /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}/integrity',
  ],
  deferred: [
    'POST /api/v1/projects/{name}/google-ads/oauth/connect',
    'POST /api/v1/projects/{name}/gtm/oauth/connect',
    'PUT /api/v1/projects/{name}/google-ads/selection',
    'PUT /api/v1/projects/{name}/gtm/selection',
    'DELETE /api/v1/projects/{name}/google-ads/connection',
    'DELETE /api/v1/projects/{name}/gtm/connection',
    'POST /api/v1/projects/{name}/conversion-tracking/contracts',
    'PUT /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
    'DELETE /api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
  ],
  excludedProtocol: [
    'GET /api/v1/google-marketing/callback',
  ],
} as const

describe('Google Marketing MCP OpenAPI classification', () => {
  it.each(googleMarketingOperations.included)('%s is safely agent-accessible', operation => {
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('included')
  })

  it.each(googleMarketingOperations.deferred)('%s remains an explicit operator action', operation => {
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('deferred')
  })

  it.each(googleMarketingOperations.excludedProtocol)('%s is browser protocol only', operation => {
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('excluded-protocol')
  })
})
