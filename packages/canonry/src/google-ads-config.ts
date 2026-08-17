import type {
  CanonryConfig,
  GoogleAdsConnectionConfigEntry,
} from './config.js'

function ensureConnections(config: CanonryConfig): GoogleAdsConnectionConfigEntry[] {
  if (!config.googleAds) config.googleAds = {}
  if (!config.googleAds.connections) config.googleAds.connections = []
  return config.googleAds.connections
}

export function getGoogleAdsAuthConfig(config: CanonryConfig): {
  clientId?: string
  clientSecret?: string
  developerToken?: string
} {
  return {
    clientId: config.googleAds?.clientId ?? config.google?.clientId,
    clientSecret: config.googleAds?.clientSecret ?? config.google?.clientSecret,
    developerToken: config.googleAds?.developerToken,
  }
}

export function setGoogleAdsAuthConfig(
  config: CanonryConfig,
  patch: { developerToken?: string; clientId?: string; clientSecret?: string },
): void {
  if (!config.googleAds) config.googleAds = {}
  if (patch.developerToken !== undefined) config.googleAds.developerToken = patch.developerToken
  if (patch.clientId !== undefined) config.googleAds.clientId = patch.clientId
  if (patch.clientSecret !== undefined) config.googleAds.clientSecret = patch.clientSecret
}

export function getGoogleAdsConnection(
  config: CanonryConfig,
  projectId: string,
): GoogleAdsConnectionConfigEntry | undefined {
  // Do not fall back to the mutable display name. Legacy name-keyed entries
  // remain unreachable until the project is explicitly reconnected.
  return config.googleAds?.connections?.find((entry) => entry.projectId === projectId)
}

export function upsertGoogleAdsConnection(
  config: CanonryConfig,
  connection: GoogleAdsConnectionConfigEntry,
): GoogleAdsConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((entry) => entry.projectId === connection.projectId)
  if (index === -1) connections.push(connection)
  else connections[index] = connection
  return connection
}

export function patchGoogleAdsConnection(
  config: CanonryConfig,
  projectId: string,
  patch: Partial<Omit<GoogleAdsConnectionConfigEntry, 'projectId' | 'projectName' | 'createdAt'>>,
): GoogleAdsConnectionConfigEntry | undefined {
  const existing = getGoogleAdsConnection(config, projectId)
  if (!existing) return undefined
  const updated = { ...existing, ...patch }
  upsertGoogleAdsConnection(config, updated)
  return updated
}

export function removeGoogleAdsConnection(config: CanonryConfig, projectId: string): boolean {
  const connections = config.googleAds?.connections
  if (!connections?.length) return false
  const next = connections.filter((entry) => entry.projectId !== projectId)
  if (next.length === connections.length) return false
  if (!config.googleAds) return false
  config.googleAds.connections = next
  return true
}

/** Remove pre-project-ID credentials so unreachable secrets do not linger on disk. */
export function removeLegacyGoogleAdsConnections(config: CanonryConfig): number {
  const connections = config.googleAds?.connections
  if (!connections?.length) return 0
  const next = connections.filter((entry) => (
    typeof (entry as Partial<GoogleAdsConnectionConfigEntry>).projectId === 'string'
    && entry.projectId.trim().length > 0
  ))
  const removed = connections.length - next.length
  if (removed > 0 && config.googleAds) config.googleAds.connections = next
  return removed
}

/**
 * Config is not transactional with SQLite. On boot, remove credentials for
 * projects no longer present in the durable project table so a crash after a
 * project delete cannot leave OAuth material orphaned on disk.
 */
export function removeOrphanedGoogleAdsConnections(
  config: CanonryConfig,
  projectIds: ReadonlySet<string>,
): number {
  const connections = config.googleAds?.connections
  if (!connections?.length) return 0
  const next = connections.filter((entry) => projectIds.has(entry.projectId))
  const removed = connections.length - next.length
  if (removed > 0 && config.googleAds) config.googleAds.connections = next
  return removed
}
