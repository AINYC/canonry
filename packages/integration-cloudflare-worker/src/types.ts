/**
 * Bot list manifest baked into the generated Worker script. Bumping
 * `version` means the deployed Worker is out of date — the
 * `cloudflare.worker.version-stale` doctor check reads this field on the
 * source row and compares it against the current package constant.
 *
 * Edge-side classification is intentionally broad — the server-side
 * classifier in `packages/integration-traffic` does the real
 * bot-id/operator decisions. Keep this list large enough to catch any
 * AI-related signal even when canonry doesn't yet have a specific rule
 * for it.
 */
export interface CloudflareWorkerBotList {
  version: string
  uaKeywords: readonly string[]
  /** Exact canonical AI engine domains; subdomains match too. */
  refererDomains: readonly string[]
  /** Exact UTM source tokens accepted by the server-side classifier. */
  utmSourceTokens: readonly string[]
}

/** Stable binding names shared by generated source, Wrangler output, and CLI setup. */
export const CLOUDFLARE_WORKER_BINDINGS = {
  deliveryMode: 'CANONRY_DELIVERY_MODE',
  sourceId: 'CANONRY_SOURCE_ID',
  ingestUrl: 'CANONRY_INGEST_URL',
  workerVersion: 'CANONRY_WORKER_VERSION',
  bearerToken: 'CANONRY_BEARER_TOKEN',
  hmacSecret: 'CANONRY_HMAC_SECRET',
} as const

export const CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS = [
  CLOUDFLARE_WORKER_BINDINGS.bearerToken,
  CLOUDFLARE_WORKER_BINDINGS.hmacSecret,
] as const

export interface GenerateWorkerScriptOptions {
  /** Queue pull becomes a second discriminated generator branch later. */
  deliveryMode: 'direct-push'
  workerVersion: string
  botList: CloudflareWorkerBotList
  /** Optional `cf.botManagement.score` threshold below which to forward. */
  botScoreMaxForward?: number
}

export interface GenerateWranglerTomlOptions {
  deliveryMode: 'direct-push'
  sourceId: string
  hostname: string
  ingestUrl: string
  workerVersion: string
  zoneId?: string | null
}
