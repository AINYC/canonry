import { Hono } from 'npm:hono@4.12.25'
import type { ValTownConfig } from 'npm:@canonry/val-kit@0.1.0/config'
import {
  type CheckRecord,
  checkFingerprint,
  type CheckStore,
  isCheckExpired,
  type JobDispatcher,
  newCheckRecord,
  normalizeUserQueries,
  PUBLIC_CHECK_EXECUTION_LEASE_MS,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
  PUBLIC_RATE_LIMITED_ERROR_CODE,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import {
  HumanVerificationError,
  normalizePublicDomain,
  PublicUrlError,
  utcDay,
} from 'npm:@canonry/val-kit@0.1.0/security'
import { PublicQuotaError } from '../jobs/perception-check.ts'
import { createMcpHandler } from '../mcp/server.ts'
import { CHECK_FINGERPRINT_NAMESPACE, type PerceptionCheckResult } from '../runtime/check-result.ts'

const MAX_BODY_BYTES = 4_096
const CHECK_ID = /^[0-9a-f-]{36}$/i

export interface PageAssets {
  styles: string
  script: string
  /** Plated logo, used as the favicon. */
  mark: string
  /** Bare glyph, used inline in the brand lockup. */
  glyph: string
}

export interface ValTownAppDependencies {
  store: CheckStore<PerceptionCheckResult>
  config: ValTownConfig
  dispatcher: JobDispatcher
  /** The UI is injected so this host stays independent from the renderer implementation. */
  renderPage: (record: CheckRecord<PerceptionCheckResult> | null) => string
  assets: PageAssets
  now?: () => Date
}

export class PublicCheckUnavailableError extends Error {
  override name = 'PublicCheckUnavailableError'
}

class PublicCheckAdmissionBusyError extends Error {
  override name = 'PublicCheckAdmissionBusyError'
  constructor() {
    super('Another request for this domain is being accepted. Try again shortly.')
  }
}

class PublicCheckCapacityError extends Error {
  override name = 'PublicCheckCapacityError'
  constructor() {
    super('The public check is at capacity. Try again shortly.')
  }
}

export function createValTownApp(deps: ValTownAppDependencies): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', async (context, next) => {
    const turnstileAllowed = deps.config.publicChecksEnabled &&
      deps.config.humanVerificationStatus === 'ready' && Boolean(deps.config.turnstileSiteKey)
    context.header('Content-Security-Policy', contentSecurityPolicy(turnstileAllowed))
    context.header('X-Content-Type-Options', 'nosniff')
    context.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    context.header('Cross-Origin-Opener-Policy', 'same-origin')
    await next()
  })

  app.get('/healthz', (context) => context.json({ ok: true }))

  // Anonymous, read-only MCP over Streamable HTTP. It shares this app's store
  // so an agent reads exactly the checks the UI shows, and it owns its own
  // method/origin/envelope handling — including the 405 for a non-POST, which
  // is why it is registered for every method rather than POST alone.
  const mcp = createMcpHandler({
    store: deps.store,
    now,
    startCheck: deps.config.mcpStartChecksEnabled
      ? async (domain, remoteIp, queries) => {
        const outcome = await submitCheck(deps, {
          domain,
          queries,
          token: null,
          remoteIp,
          now: now(),
          admission: 'mcp',
        })
        return { record: (await deps.store.get(outcome.record.id)) ?? outcome.record, reused: outcome.reused }
      }
      : undefined,
  })
  app.all('/mcp', (context) => mcp(context.req.raw))
  // Immutable: the document references these with a content hash, so a changed
  // asset arrives under a new URL rather than waiting out a TTL.
  app.get('/assets/canonry-ui.css', (context) => {
    context.header('Cache-Control', 'public, max-age=31536000, immutable')
    return context.body(deps.assets.styles, 200, { 'content-type': 'text/css; charset=utf-8' })
  })
  app.get('/assets/canonry-ui.js', (context) => {
    context.header('Cache-Control', 'public, max-age=31536000, immutable')
    return context.body(deps.assets.script, 200, { 'content-type': 'application/javascript; charset=utf-8' })
  })
  app.get('/assets/canonry-mark.svg', (context) => {
    context.header('Cache-Control', 'public, max-age=31536000, immutable')
    return context.body(deps.assets.mark, 200, { 'content-type': 'image/svg+xml; charset=utf-8' })
  })
  app.get('/assets/canonry-glyph.svg', (context) => {
    context.header('Cache-Control', 'public, max-age=31536000, immutable')
    return context.body(deps.assets.glyph, 200, { 'content-type': 'image/svg+xml; charset=utf-8' })
  })

  app.get('/', async (context) => {
    const requestedId = context.req.query('check')
    const stored = requestedId && CHECK_ID.test(requestedId) ? await deps.store.get(requestedId) : null
    const record = stored && !isCheckExpired(stored, now()) ? stored : null
    context.header('Cache-Control', 'no-store')
    return context.html(deps.renderPage(record))
  })

  app.get('/api/checks/:id', async (context) => {
    const id = context.req.param('id')
    if (!CHECK_ID.test(id)) return apiError(context, 404, 'not-found', 'Check not found.')
    const record = await deps.store.get(id)
    if (!record || isCheckExpired(record, now())) return apiError(context, 404, 'not-found', 'Check not found.')
    context.header('Cache-Control', 'no-store')
    return context.json({ check: publicCheckRecord(record) })
  })

  app.post('/api/checks', async (context) => {
    const payload = await parseJsonBody(context.req.raw)
    const outcome = await submitCheck(deps, {
      domain: payload.domain,
      queries: payload.queries,
      token: typeof payload.turnstileToken === 'string' ? payload.turnstileToken : null,
      remoteIp: remoteIp(context.req.raw),
      now: now(),
    })
    context.header('Cache-Control', 'no-store')
    if (outcome.dispatch === 'busy') {
      return apiError(context, 503, 'busy', 'The public check is at capacity. Try again shortly.')
    }
    return context.json(
      { check: publicCheckRecord(outcome.record), reused: outcome.reused },
      outcome.record.status === 'queued' || outcome.record.status === 'running' ? 202 : 200,
    )
  })

  app.post('/check', async (context) => {
    let submittedDomain: unknown = null
    try {
      const form = await parseFormBody(context.req.raw)
      submittedDomain = form.get('domain')
      const outcome = await submitCheck(deps, {
        domain: submittedDomain,
        queries: form.get('queries'),
        token: form.get('cf-turnstile-response'),
        remoteIp: remoteIp(context.req.raw),
        now: now(),
      })
      if (outcome.dispatch === 'busy') throw new PublicCheckCapacityError()
      return context.redirect(`/?check=${encodeURIComponent(outcome.record.id)}`, 303)
    } catch (error) {
      const failure = formFailureRecord(submittedDomain, now(), error)
      context.header('Cache-Control', 'no-store')
      return context.html(deps.renderPage(failure), formFailureStatus(error))
    }
  })

  app.notFound((context) => apiError(context, 404, 'not-found', 'Not found.'))
  app.onError((error, context) => {
    if (error instanceof PublicUrlError) return apiError(context, 400, 'invalid-domain', error.message)
    if (error instanceof HumanVerificationError) {
      const status = error.code === 'unavailable' || error.code === 'transport' ? 503 : 403
      return apiError(context, status, `human-verification-${error.code}`, error.message)
    }
    if (error instanceof PublicQuotaError) return apiError(context, 429, `${error.scope}-quota`, error.message)
    if (error instanceof PublicCheckAdmissionBusyError) return apiError(context, 503, 'admission-busy', error.message)
    if (error instanceof PublicCheckCapacityError) return apiError(context, 503, 'busy', error.message)
    if (error instanceof PublicCheckUnavailableError) return apiError(context, 503, 'unavailable', error.message)
    if (error instanceof BodyTooLargeError) {
      return apiError(context, 413, 'body-too-large', 'Request body is too large.')
    }
    if (error instanceof InvalidBodyError) return apiError(context, 400, 'invalid-body', error.message)
    return apiError(context, 500, 'internal-error', 'The public check could not be started.')
  })

  return app
}

interface CheckSubmission {
  record: CheckRecord<PerceptionCheckResult>
  reused: boolean
  dispatch: 'completed' | 'busy' | 'ignored'
}

interface SubmitInput {
  domain: unknown
  /** Raw caller input; normalized here, never trusted as given. */
  queries?: unknown
  token: string | null
  remoteIp: string | null
  now: Date
  /**
   * Which admission rules apply. `mcp` skips human verification, which an
   * agent cannot perform, and spends from a separate, tighter daily bucket so
   * it cannot consume the browser allowance. Every other control — the global
   * daily cap, the single execution lease, cache reuse — is identical.
   */
  admission?: 'browser' | 'mcp'
}

async function submitCheck(
  deps: ValTownAppDependencies,
  input: SubmitInput,
): Promise<CheckSubmission> {
  if (!deps.config.publicChecksEnabled) {
    throw new PublicCheckUnavailableError(
      deps.config.publicChecksUnavailableMessage ?? 'Public checks are temporarily unavailable.',
    )
  }
  const target = normalizePublicDomain(input.domain)
  const userQueries = normalizeUserQueries(input.queries)
  const viaMcp = input.admission === 'mcp'
  if (!viaMcp) await deps.config.humanVerifier.verify({ token: input.token, remoteIp: input.remoteIp })
  // The questions join the reuse key. They change what the check measures, so
  // a second caller asking different questions about the same domain must not
  // be handed the first caller's answers.
  const fingerprint = checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, target.domain, userQueries)
  const timestamp = input.now.toISOString()

  // Cached and already-active work is useful without consuming the one global
  // execution slot. This keeps same-domain retries quota- and capacity-free.
  const reusable = await deps.store.findReusable(fingerprint, timestamp)
  if (reusable) return dispatchExistingCheck(deps, reusable)

  const hashedClient = await hashQuotaSubject(deps.config.quotaSalt, input.remoteIp ?? 'unknown')
  // A distinct subject rather than a distinct scope: `CheckQuotaClaim.scope` is
  // a closed union, and prefixing keeps the two buckets disjoint without
  // widening a durable contract.
  const clientSubject = viaMcp ? `mcp:${hashedClient}` : hashedClient
  const clientMax = viaMcp ? deps.config.mcpPerClientDailyLimit : deps.config.perClientDailyLimit
  const day = utcDay(input.now)
  const executionLeaseOwner = crypto.randomUUID()
  const executionLeaseUntil = new Date(input.now.getTime() + PUBLIC_CHECK_EXECUTION_LEASE_MS).toISOString()
  const capacityAvailable = await deps.store.claimGlobalLease(
    PUBLIC_CHECK_EXECUTION_LEASE_NAME,
    executionLeaseOwner,
    timestamp,
    executionLeaseUntil,
  )
  if (!capacityAvailable) throw new PublicCheckCapacityError()

  let capacityHeld = true
  let dispatchOwnsCapacity = false
  const releaseCapacity = async () => {
    if (!capacityHeld) return
    await deps.store.releaseGlobalLease(PUBLIC_CHECK_EXECUTION_LEASE_NAME, executionLeaseOwner)
    capacityHeld = false
  }

  try {
    const admission = await deps.store.admit({
      candidate: newCheckRecord<PerceptionCheckResult>({
        id: crypto.randomUUID(),
        fingerprint,
        domain: target.domain,
        userQueries,
        now: input.now,
      }),
      now: timestamp,
      clientQuota: { scope: 'client', subject: clientSubject, day, max: clientMax },
      globalQuota: { scope: 'global', subject: 'all', day, max: deps.config.globalDailyLimit },
    })
    if (admission.kind === 'quota-exhausted') throw new PublicQuotaError(admission.scope)
    if (admission.kind === 'busy') throw new PublicCheckAdmissionBusyError()

    if (admission.kind === 'reused') {
      // A concurrent same-domain admission won. It must not inherit capacity
      // reserved by this request, so it goes through ordinary reuse dispatch.
      await releaseCapacity()
      return dispatchExistingCheck(deps, admission.record)
    }

    let dispatch: 'completed' | 'busy' | 'ignored' = 'ignored'
    if (admission.record.status === 'queued') {
      // Request-bound dispatch takes responsibility for this owner as soon as
      // it receives the promise. Its runner releases even a lost job claim.
      const dispatched = deps.dispatcher.dispatch(admission.record.id, { executionLeaseOwner })
      dispatchOwnsCapacity = true
      dispatch = await dispatched
    }
    return {
      record: (await deps.store.get(admission.record.id)) ?? admission.record,
      reused: admission.kind !== 'created',
      dispatch,
    }
  } finally {
    // The runner owns capacity only after dispatch receives the owner. The app
    // releases every admission, reuse, quota, and pre-dispatch error path.
    if (!dispatchOwnsCapacity) await releaseCapacity()
  }
}

async function dispatchExistingCheck(
  deps: ValTownAppDependencies,
  record: CheckRecord<PerceptionCheckResult>,
): Promise<CheckSubmission & { reused: true }> {
  const dispatch = record.status === 'queued' ? await deps.dispatcher.dispatch(record.id) : 'ignored'
  return {
    record: (await deps.store.get(record.id)) ?? record,
    reused: true,
    dispatch,
  }
}

function publicCheckRecord(
  record: CheckRecord<PerceptionCheckResult>,
): Omit<CheckRecord<PerceptionCheckResult>, 'fingerprint' | 'leaseOwner' | 'leaseUntil'> {
  const { fingerprint: _fingerprint, leaseOwner: _leaseOwner, leaseUntil: _leaseUntil, ...safe } = record
  return safe
}

function apiError(
  context: { json: (body: unknown, status?: number) => Response; header: (name: string, value: string) => void },
  status: number,
  code: string,
  message: string,
): Response {
  context.header('Cache-Control', 'no-store')
  return context.json({ error: { code, message } }, status)
}

class BodyTooLargeError extends Error {}
class InvalidBodyError extends Error {}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new InvalidBodyError('Expected a JSON request body.')
  }
  const text = await readLimitedBody(request)
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new InvalidBodyError('Request body must be a JSON object.')
  }
}

async function parseFormBody(request: Request): Promise<URLSearchParams> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/x-www-form-urlencoded')) {
    throw new InvalidBodyError('Expected a form submission.')
  }
  return new URLSearchParams(await readLimitedBody(request))
}

async function readLimitedBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new BodyTooLargeError()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new BodyTooLargeError()
    }
    chunks.push(next.value)
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

function remoteIp(request: Request): string | null {
  // Val injects this edge header. `x-forwarded-for` is caller-controlled on a
  // public val, so it is deliberately ignored for quota identity.
  const cf = request.headers.get('cf-connecting-ip')?.trim()
  if (cf && cf.length <= 128) return cf
  return null
}

async function hashQuotaSubject(salt: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}\u0000${value}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * `frame-ancestors` allows Val Town because the val's own page previews the
 * deployed site in an iframe, and `'none'` renders that preview blank — the
 * first thing anyone arriving from val.town sees. The allowance is exactly the
 * hosting platform and nothing else, so ordinary clickjacking is still blocked.
 * There is little to hijack regardless: no session, no credential, and the only
 * action is submitting a public domain.
 */
const FRAME_ANCESTORS = ["'self'", 'https://www.val.town', 'https://val.town'].join(' ')

/**
 * Geist is served from jsDelivr because a Val cannot ship the font itself:
 * woff2 is binary and Val Town refuses to push binary files. It is the same
 * package and version the dashboard bundles (`@fontsource-variable/geist`), so
 * the two surfaces render in the same typeface rather than this one silently
 * falling back to a system font, which is what it did before.
 */
const FONT_CDN = 'https://cdn.jsdelivr.net'

function contentSecurityPolicy(turnstileAllowed: boolean): string {
  const turnstile = turnstileAllowed ? ' https://challenges.cloudflare.com' : ''
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${FRAME_ANCESTORS}`,
    "form-action 'self'",
    `script-src 'self'${turnstile}`,
    `style-src 'self' ${FONT_CDN}`,
    `font-src ${FONT_CDN}`,
    `connect-src 'self'${turnstile}`,
    `frame-src${turnstile || " 'none'"}`,
    "img-src 'self' data: https:",
  ].join('; ')
}

function formFailureRecord(domain: unknown, now: Date, error: unknown): CheckRecord<PerceptionCheckResult> {
  const displayDomain = typeof domain === 'string' ? domain.trim().slice(0, 253) : ''
  const timestamp = now.toISOString()
  return {
    id: crypto.randomUUID(),
    fingerprint: '',
    domain: displayDomain,
    userQueries: [],
    status: 'failed',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: null,
    result: null,
    errorCode: error instanceof PublicQuotaError ? PUBLIC_RATE_LIMITED_ERROR_CODE : 'form-submission-failed',
    errorMessage: formFailureMessage(error),
    leaseOwner: null,
    leaseUntil: null,
  }
}

function formFailureMessage(error: unknown): string {
  if (
    error instanceof PublicUrlError || error instanceof PublicQuotaError || error instanceof HumanVerificationError ||
    error instanceof PublicCheckUnavailableError || error instanceof PublicCheckAdmissionBusyError ||
    error instanceof PublicCheckCapacityError
  ) return error.message
  if (error instanceof BodyTooLargeError) return 'The submission was too large. Enter only a domain.'
  if (error instanceof InvalidBodyError) return 'The form could not be read. Try again.'
  return 'The public check could not be started. Try again later.'
}

function formFailureStatus(error: unknown): 400 | 403 | 413 | 429 | 503 {
  if (error instanceof PublicUrlError || error instanceof InvalidBodyError) return 400
  if (error instanceof BodyTooLargeError) return 413
  if (error instanceof PublicQuotaError) return 429
  if (
    error instanceof PublicCheckUnavailableError || error instanceof PublicCheckAdmissionBusyError ||
    error instanceof PublicCheckCapacityError
  ) return 503
  if (error instanceof HumanVerificationError) return error.code === 'invalid' ? 403 : 503
  return 503
}
