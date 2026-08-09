import {
  DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS,
  DEFAULT_AI_REFERRER_RULES,
} from '@ainyc/canonry-integration-traffic'
import { canonicalizeCloudflareJson } from './canonical-json.js'
import {
  CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS,
  CLOUDFLARE_WORKER_BINDINGS,
  type CloudflareWorkerBotList,
  type GenerateWorkerScriptOptions,
  type GenerateWranglerTomlOptions,
} from './types.js'

/**
 * Generic edge-side filter list. Intentionally broad — the strict
 * bot/referer classification happens server-side in
 * `packages/integration-traffic`. Bump `version` whenever this set
 * structurally changes so the `cloudflare.worker.version-stale`
 * doctor check can flag stale deployments.
 */
export const DEFAULT_BOT_LIST: CloudflareWorkerBotList = {
  version: '2026-08-09',
  uaKeywords: [
    ...DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS,
    // Preserve a small forward-looking machine-traffic net. The shared
    // classifier still drops unknown products after delivery.
    'bot',
    'crawler',
    'spider',
  ],
  refererDomains: DEFAULT_AI_REFERRER_RULES.map(rule => rule.domain),
  utmSourceTokens: [
    ...new Set([
      ...DEFAULT_AI_REFERRER_RULES.map(rule => rule.domain),
      ...DEFAULT_AI_REFERRER_RULES.map(rule => rule.domain.split('.')[0]!),
      // Legacy chat.openai.com referrals classify from their first label.
      'chat',
    ]),
  ],
}

const DEFAULT_BOT_SCORE_MAX_FORWARD = 30
const WORKER_COMPATIBILITY_DATE = '2026-05-01'

function jsString(value: string): string {
  return JSON.stringify(value)
}

function jsArray(values: readonly string[]): string {
  return `[${values.map((v) => jsString(v)).join(', ')}]`
}

/**
 * Render the ES-module Worker deployed on the customer's Cloudflare zone.
 * The source contains no connection credentials. Runtime values arrive through
 * Wrangler vars and the bearer/HMAC values arrive through Worker secrets.
 *
 * Filtering and event construction are transport-neutral. The final
 * `deliverEdgeEventBatch` dispatch is the only direct-push-specific seam; the
 * Queue follow-up adds another delivery branch without changing event capture.
 */
export function generateWorkerScript(opts: GenerateWorkerScriptOptions): string {
  const botScoreMax = opts.botScoreMaxForward ?? DEFAULT_BOT_SCORE_MAX_FORWARD
  const canonicalJsonFunction = canonicalizeCloudflareJson.toString()

  return `// canonry traffic Worker — generated; do not edit by hand
// worker version: ${opts.workerVersion}
// bot-list version: ${opts.botList.version}
// delivery mode: ${opts.deliveryMode}

const UA_KEYWORDS = ${jsArray(opts.botList.uaKeywords)}
const REFERER_DOMAINS = ${jsArray(opts.botList.refererDomains)}
const UTM_SOURCE_TOKENS = ${jsArray(opts.botList.utmSourceTokens)}
const BOT_SCORE_MAX_FORWARD = ${String(botScoreMax)}
const RETRY_DELAYS_MS = [250, 1000]
const canonicalizeJson = (${canonicalJsonFunction})

function requireBinding(value, name) {
  if (typeof value === 'string' && value.length > 0) return value
  throw new Error('Missing required Worker binding: ' + name)
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function uaMatches(ua) {
  const lc = lower(ua)
  if (!lc) return false
  for (const kw of UA_KEYWORDS) {
    if (lc.indexOf(lower(kw)) !== -1) return true
  }
  return false
}

function hostMatchesKnownDomain(host) {
  let normalized = lower(host)
  if (normalized.startsWith('www.')) normalized = normalized.slice(4)
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1)
  if (!normalized) return false
  for (const domain of REFERER_DOMAINS) {
    if (normalized === domain || normalized.endsWith('.' + domain)) return true
  }
  return false
}

function refererMatches(referer) {
  if (!referer) return false
  try {
    return hostMatchesKnownDomain(new URL(referer).hostname)
  } catch (_) {
    return false
  }
}

function utmSourceMatches(value) {
  let normalized = lower(value).trim()
  if (normalized.startsWith('www.')) normalized = normalized.slice(4)
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1)
  if (!normalized) return false
  if (hostMatchesKnownDomain(normalized)) return true
  return UTM_SOURCE_TOKENS.indexOf(normalized) !== -1
}

function urlUtmMatches(value) {
  if (!value) return false
  try {
    return utmSourceMatches(new URL(value).searchParams.get('utm_source'))
  } catch (_) {
    return false
  }
}

function botSignals(cf) {
  if (!cf) return false
  const bm = cf.botManagement
  if (bm) {
    if (bm.verifiedBot === true) return true
    if (typeof bm.score === 'number' && bm.score < BOT_SCORE_MAX_FORWARD) return true
  }
  if (typeof cf.botScore === 'number' && cf.botScore < BOT_SCORE_MAX_FORWARD) return true
  return false
}

function shouldForward(request) {
  const ua = request.headers.get('user-agent') || ''
  if (uaMatches(ua)) return true
  if (urlUtmMatches(request.url)) return true
  const referer = request.headers.get('referer') || ''
  if (refererMatches(referer)) return true
  if (urlUtmMatches(referer)) return true
  return botSignals(request.cf)
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

async function signBody(secret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(timestamp + '.' + body),
  )
  return toHex(sig)
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry(operation) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response
    try {
      response = await operation()
    } catch (error) {
      if (attempt === RETRY_DELAYS_MS.length) throw error
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }

    if (response.ok) return response
    if (!isRetryableStatus(response.status) || attempt === RETRY_DELAYS_MS.length) {
      throw new Error('Canonry ingest returned HTTP ' + response.status)
    }
    await sleep(RETRY_DELAYS_MS[attempt])
  }
}

function pickCf(cf) {
  if (!cf) return null
  const bm = cf.botManagement || {}
  return {
    verifiedBot: typeof bm.verifiedBot === 'boolean' ? bm.verifiedBot : null,
    botScore: typeof bm.score === 'number' ? bm.score : (typeof cf.botScore === 'number' ? cf.botScore : null),
    country: typeof cf.country === 'string' ? cf.country : null,
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    asOrganization: typeof cf.asOrganization === 'string' ? cf.asOrganization : null,
  }
}

function buildEdgeEvent(request, status, observedAt) {
  const url = new URL(request.url)
  return {
    eventId: request.headers.get('cf-ray') || crypto.randomUUID(),
    observedAt,
    method: request.method || null,
    host: url.hostname || null,
    path: url.pathname || '/',
    queryString: url.search ? url.search.slice(1) : null,
    status: typeof status === 'number' ? status : null,
    userAgent: request.headers.get('user-agent') || null,
    remoteIp: request.headers.get('cf-connecting-ip') || null,
    referer: request.headers.get('referer') || null,
    cf: pickCf(request.cf),
  }
}

function buildEdgeEventBatch(env, request, status, observedAt) {
  return {
    schemaVersion: 1,
    workerVersion: requireBinding(env.${CLOUDFLARE_WORKER_BINDINGS.workerVersion}, ${jsString(CLOUDFLARE_WORKER_BINDINGS.workerVersion)}),
    events: [buildEdgeEvent(request, status, observedAt)],
  }
}

async function deliverViaDirectPush(env, batch) {
  const sourceId = requireBinding(env.${CLOUDFLARE_WORKER_BINDINGS.sourceId}, ${jsString(CLOUDFLARE_WORKER_BINDINGS.sourceId)})
  const ingestUrl = requireBinding(env.${CLOUDFLARE_WORKER_BINDINGS.ingestUrl}, ${jsString(CLOUDFLARE_WORKER_BINDINGS.ingestUrl)})
  const bearerToken = requireBinding(env.${CLOUDFLARE_WORKER_BINDINGS.bearerToken}, ${jsString(CLOUDFLARE_WORKER_BINDINGS.bearerToken)})
  const hmacSecret = requireBinding(env.${CLOUDFLARE_WORKER_BINDINGS.hmacSecret}, ${jsString(CLOUDFLARE_WORKER_BINDINGS.hmacSecret)})
  const body = canonicalizeJson(batch)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = await signBody(hmacSecret, timestamp, body)

  await withRetry(() => fetch(ingestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': 'Bearer ' + bearerToken,
      'X-Canonry-Timestamp': timestamp,
      'X-Canonry-Signature': signature,
      'X-Canonry-Worker-Version': batch.workerVersion,
      'X-Canonry-Source-Id': sourceId,
    },
    body,
  }))
}

async function deliverEdgeEventBatch(env, batch) {
  const deliveryMode = requireBinding(env.${CLOUDFLARE_WORKER_BINDINGS.deliveryMode}, ${jsString(CLOUDFLARE_WORKER_BINDINGS.deliveryMode)})
  if (deliveryMode === 'direct-push') {
    return deliverViaDirectPush(env, batch)
  }
  throw new Error('Unsupported Canonry delivery mode: ' + deliveryMode)
}

async function deliverSelectedRequest(env, request, status, observedAt) {
  try {
    const batch = buildEdgeEventBatch(env, request, status, observedAt)
    await deliverEdgeEventBatch(env, batch)
  } catch (err) {
    // Delivery is statistical and must never mask the customer response.
    // Emit binding names and source id only; never emit secret values.
    console.warn('Canonry traffic delivery failed', {
      sourceId: typeof env.${CLOUDFLARE_WORKER_BINDINGS.sourceId} === 'string'
        ? env.${CLOUDFLARE_WORKER_BINDINGS.sourceId}
        : null,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

export default {
  async fetch(request, env, ctx) {
    const observedAt = new Date().toISOString()
    const shouldLog = shouldForward(request)
    try {
      const response = await fetch(request)
      if (shouldLog) {
        ctx.waitUntil(deliverSelectedRequest(env, request, response.status, observedAt))
      }
      return response
    } catch (err) {
      if (shouldLog) {
        ctx.waitUntil(deliverSelectedRequest(env, request, null, observedAt))
      }
      throw err
    }
  },
}
`
}

/**
 * Companion `wrangler.toml` for operators who prefer `wrangler deploy`.
 * Non-secret runtime values are regular vars. Secret values are installed
 * independently and therefore never enter source, TOML, API, or MCP output.
 */
export function generateWranglerToml(opts: GenerateWranglerTomlOptions): string {
  const hostname = opts.hostname.trim().toLowerCase().replace(/\.$/, '')
  const routeConfig = opts.zoneId
    ? `[[routes]]
pattern = ${jsString(`${hostname}/*`)}
zone_id = ${jsString(opts.zoneId)}
`
    : `# No route is declared because connect did not receive a zoneId.
# After deploy, attach this exact route in the Cloudflare dashboard:
#   ${hostname}/*
`

  return `name = "canonry-traffic-${opts.sourceId}"
main = "worker.js"
compatibility_date = "${WORKER_COMPATIBILITY_DATE}"
workers_dev = false

[vars]
${CLOUDFLARE_WORKER_BINDINGS.deliveryMode} = ${jsString(opts.deliveryMode)}
${CLOUDFLARE_WORKER_BINDINGS.sourceId} = ${jsString(opts.sourceId)}
${CLOUDFLARE_WORKER_BINDINGS.ingestUrl} = ${jsString(opts.ingestUrl)}
${CLOUDFLARE_WORKER_BINDINGS.workerVersion} = ${jsString(opts.workerVersion)}

[secrets]
required = ${jsArray(CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS)}

# Install required Worker secrets interactively or through Canonry's deploy
# command. Never write their values into this file:
${CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS.map(name => `#   wrangler secret put ${name}`).join('\n')}

# Deploy this Worker via:
#   wrangler deploy
${routeConfig}
`
}
