export const CDP_PROVIDER_NAME = 'cdp:chatgpt'

export function normalizeProviderName(name: string): string {
  const normalized = name.trim().toLowerCase()
  return normalized.startsWith('native:') ? normalized.slice('native:'.length) : normalized
}

/** Generic routes are text-only, and browser readiness comes from CDP status. */
export function isNativeApiProviderName(name: string): boolean {
  const normalized = normalizeProviderName(name)
  return normalized.length > 0 && !normalized.startsWith('route:') && !normalized.startsWith('cdp:')
}

/**
 * Mirror the answer-visibility server preflight: an explicit project provider
 * list is an allowlist; an empty list falls back to every runnable provider.
 * `undefined` means one of the authoritative readiness reads is still pending.
 */
export function resolveAiVisibilityProviderReadiness({
  projectProviders,
  configuredApiProviders,
  cdpConfigured,
}: {
  projectProviders: readonly string[]
  configuredApiProviders: readonly string[] | undefined
  cdpConfigured: boolean | undefined
}): boolean | undefined {
  const selected = projectProviders.map(normalizeProviderName)
  const selectedSet = new Set(selected)
  const canUseApiProvider = selected.length === 0
    || selected.some(isNativeApiProviderName)
  const canUseCdp = selected.length === 0 || selectedSet.has(CDP_PROVIDER_NAME)

  if (canUseApiProvider && configuredApiProviders !== undefined) {
    const apiReady = configuredApiProviders
      .map(normalizeProviderName)
      .filter(isNativeApiProviderName)
      .some(provider => selected.length === 0 || selectedSet.has(provider))
    if (apiReady) return true
  }
  if (canUseCdp && cdpConfigured === true) return true

  const apiPending = canUseApiProvider && configuredApiProviders === undefined
  const cdpPending = canUseCdp && cdpConfigured === undefined
  if (apiPending || cdpPending) return undefined
  return false
}
