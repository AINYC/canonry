import type { CanonryConfig, GtmConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): GtmConnectionConfigEntry[] {
  if (!config.gtm) config.gtm = {}
  if (!config.gtm.connections) config.gtm.connections = []
  return config.gtm.connections
}

export function getGtmAuthConfig(config: CanonryConfig): {
  clientId?: string
  clientSecret?: string
} {
  return {
    clientId: config.gtm?.clientId ?? config.google?.clientId,
    clientSecret: config.gtm?.clientSecret ?? config.google?.clientSecret,
  }
}

export function setGtmAuthConfig(
  config: CanonryConfig,
  patch: { clientId?: string; clientSecret?: string },
): void {
  if (!config.gtm) config.gtm = {}
  if (patch.clientId !== undefined) config.gtm.clientId = patch.clientId
  if (patch.clientSecret !== undefined) config.gtm.clientSecret = patch.clientSecret
}

export function getGtmConnection(
  config: CanonryConfig,
  projectId: string,
): GtmConnectionConfigEntry | undefined {
  // Do not fall back to the mutable display name. Legacy name-keyed entries
  // remain unreachable until the project is explicitly reconnected.
  return config.gtm?.connections?.find((entry) => entry.projectId === projectId)
}

export function upsertGtmConnection(
  config: CanonryConfig,
  connection: GtmConnectionConfigEntry,
): GtmConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((entry) => entry.projectId === connection.projectId)
  if (index === -1) connections.push(connection)
  else connections[index] = connection
  return connection
}

export function patchGtmConnection(
  config: CanonryConfig,
  projectId: string,
  patch: Partial<Omit<GtmConnectionConfigEntry, 'projectId' | 'projectName' | 'createdAt'>>,
): GtmConnectionConfigEntry | undefined {
  const existing = getGtmConnection(config, projectId)
  if (!existing) return undefined
  const updated = { ...existing, ...patch }
  upsertGtmConnection(config, updated)
  return updated
}

export function removeGtmConnection(config: CanonryConfig, projectId: string): boolean {
  const connections = config.gtm?.connections
  if (!connections?.length) return false
  const next = connections.filter((entry) => entry.projectId !== projectId)
  if (next.length === connections.length) return false
  if (!config.gtm) return false
  config.gtm.connections = next
  return true
}

/** Remove pre-project-ID credentials so unreachable secrets do not linger on disk. */
export function removeLegacyGtmConnections(config: CanonryConfig): number {
  const connections = config.gtm?.connections
  if (!connections?.length) return 0
  const next = connections.filter((entry) => (
    typeof (entry as Partial<GtmConnectionConfigEntry>).projectId === 'string'
    && entry.projectId.trim().length > 0
  ))
  const removed = connections.length - next.length
  if (removed > 0 && config.gtm) config.gtm.connections = next
  return removed
}

/** See removeOrphanedGoogleAdsConnections. */
export function removeOrphanedGtmConnections(
  config: CanonryConfig,
  projectIds: ReadonlySet<string>,
): number {
  const connections = config.gtm?.connections
  if (!connections?.length) return 0
  const next = connections.filter((entry) => projectIds.has(entry.projectId))
  const removed = connections.length - next.length
  if (removed > 0 && config.gtm) config.gtm.connections = next
  return removed
}
