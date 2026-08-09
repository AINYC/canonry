import type { CanonryConfig, CloudflareTrafficConnectionConfigEntry } from './config.js'

function unsupportedDeliveryMode(deliveryMode: unknown): Error {
  const label = typeof deliveryMode === 'string' ? ` "${deliveryMode}"` : ''
  return new Error(`Unsupported Cloudflare traffic delivery mode${label}`)
}

function ensureConnections(config: CanonryConfig): CloudflareTrafficConnectionConfigEntry[] {
  if (!config.cloudflareTraffic) config.cloudflareTraffic = {}
  if (!config.cloudflareTraffic.connections) config.cloudflareTraffic.connections = []
  return config.cloudflareTraffic.connections
}

function normalizeDirectPushConnection(
  connection: CloudflareTrafficConnectionConfigEntry,
): CloudflareTrafficConnectionConfigEntry {
  const deliveryMode = (connection as { deliveryMode?: unknown }).deliveryMode
  if (deliveryMode !== undefined && deliveryMode !== 'direct-push') {
    throw unsupportedDeliveryMode(deliveryMode)
  }
  if (deliveryMode === 'direct-push') return connection
  return { ...connection, deliveryMode: 'direct-push' }
}

export function listCloudflareTrafficConnections(
  config: CanonryConfig,
): CloudflareTrafficConnectionConfigEntry[] {
  return (config.cloudflareTraffic?.connections ?? []).map(normalizeDirectPushConnection)
}

export function getCloudflareTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): CloudflareTrafficConnectionConfigEntry | undefined {
  const connection = (config.cloudflareTraffic?.connections ?? []).find((c) => c.projectName === projectName)
  return connection ? normalizeDirectPushConnection(connection) : undefined
}

/**
 * Lookup by `sourceId` is the ingest path: the Worker forwards
 * `X-Canonry-Source-Id`, and the receiver resolves the matching credential
 * to verify the bearer and HMAC. Keyed separately from project name so a
 * forthcoming "many sources per project" model (e.g. multi-zone) doesn't
 * require a schema change.
 */
export function getCloudflareTrafficConnectionBySourceId(
  config: CanonryConfig,
  sourceId: string,
): CloudflareTrafficConnectionConfigEntry | undefined {
  const connection = (config.cloudflareTraffic?.connections ?? []).find((c) => c.sourceId === sourceId)
  return connection ? normalizeDirectPushConnection(connection) : undefined
}

export function upsertCloudflareTrafficConnection(
  config: CanonryConfig,
  connection: CloudflareTrafficConnectionConfigEntry,
): CloudflareTrafficConnectionConfigEntry {
  const deliveryMode = (connection as { deliveryMode?: unknown }).deliveryMode
  if (deliveryMode !== 'direct-push') {
    throw unsupportedDeliveryMode(deliveryMode)
  }
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeCloudflareTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.cloudflareTraffic?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.cloudflareTraffic) return false
  config.cloudflareTraffic.connections = next
  if (next.length === 0) {
    delete config.cloudflareTraffic
  }
  return true
}
