import crypto from 'node:crypto'

import { oauthAuthorizationCodes, oauthClients, oauthTokens, type DatabaseClient } from '@ainyc/canonry-db'
import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { CredentialChecker } from './user-session.js'

/**
 * OAuth 2.1 authorization server for the remote MCP surface.
 *
 * Exists because hosted MCP clients cannot present an API key. OpenAI states
 * plainly that ChatGPT can offer only OAuth, no authentication, or a mix — no
 * bearer field, no custom header, no client-credentials grant. So for anything
 * beyond a local CLI this is the only door.
 *
 * Deliberately NOT implemented: Dynamic Client Registration (RFC 7591). The
 * current MCP revision deprecates it and keeps it only for backwards
 * compatibility, Gemini Enterprise has no DCR path and wants a pre-registered
 * client id and secret typed into a form, and ChatGPT keeps predefined clients
 * working. An operator registers clients explicitly; nothing on the network can
 * mint one.
 *
 * Everything here is PUBLIC by design and mounts at the root, outside the
 * API-key auth scope: a client with no credential has to be able to discover
 * where to get one.
 */

const CODE_TTL_MS = 60_000
const ACCESS_TTL_MS = 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface OAuthRoutesOptions {
  db: DatabaseClient
  /** Public origin this instance is reached on, e.g. https://host. No trailing slash. */
  issuer: string
  /**
   * Every path the MCP transport is served at, e.g. /api/v1/mcp plus each
   * segmented variant. One protected-resource document is published per path,
   * because a 401 from a segment names ITS own metadata URL and a client that
   * fetches it must not get a 404.
   */
  resourcePaths: readonly string[]
  /**
   * Resolve the signed-in person from the request, or null. The authorize
   * endpoint reuses the product's existing sign-in rather than introducing a
   * second identity system.
   */
  resolveUser: (request: FastifyRequest) => { id: string; name: string } | null
  /**
   * Establish a session for a person who signed in on the consent page, and
   * return the cookie header to set.
   */
  startSession: (userId: string) => string
  /**
   * The SAME credential check /auth/login uses, budgets and all. Passed in
   * rather than reimplemented so the two sign-in doors cannot drift apart —
   * they already did once, and the second one had no rate limiting at all.
   */
  credentials: CredentialChecker
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * RFC 7636 S256 verification. `plain` is refused at the authorize endpoint, so
 * a downgrade cannot reach here.
 */
function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(challenge)
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would leak length through an exception.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Is this redirect_uri registered?
 *
 * Exact match, with ONE carve-out required by RFC 8252 s7.3: for a loopback
 * redirect the port is ignored, because a native app binds an ephemeral port at
 * runtime and cannot know it at registration time. Without this, no desktop
 * client can complete the flow at all — which is most of the clients that
 * matter here.
 *
 * The carve-out is narrow on purpose. Only the PORT floats; scheme, host and
 * path must still match exactly, and only for a literal loopback host. Anything
 * looser is an open redirect.
 */
export function redirectUriAllowed(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true
  let candidate: URL
  try {
    candidate = new URL(presented)
  } catch {
    return false
  }
  if (!isLoopbackHost(candidate.hostname)) return false
  return registered.some((entry) => {
    let allowed: URL
    try {
      allowed = new URL(entry)
    } catch {
      return false
    }
    return isLoopbackHost(allowed.hostname)
      && allowed.protocol === candidate.protocol
      && allowed.hostname === candidate.hostname
      && allowed.pathname === candidate.pathname
  })
}

/** Literal loopback only — never a name that could resolve elsewhere. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost'
}

/** Everything this server will ever grant. Advertised in the metadata document. */
export const SUPPORTED_SCOPES = ['read', 'offline_access'] as const

/**
 * Narrow a client's requested scope to what is actually on offer.
 *
 * Returns null when the client asked for something unsupported, so the caller
 * refuses rather than silently downgrading — a client that believes it holds
 * write and holds read is worse off than one told no.
 */
export function resolveRequestedScope(requested: string | undefined): string | null {
  if (!requested || !requested.trim()) return 'read'
  const parts = requested.trim().split(/\s+/)
  const supported = new Set<string>(SUPPORTED_SCOPES)
  if (parts.some(part => !supported.has(part))) return null
  // `offline_access` governs refresh tokens, never API authority, so a grant of
  // it alone still carries read.
  const apiScopes = parts.filter(part => part !== 'offline_access')
  return apiScopes.length > 0 ? parts.join(' ') : ['read', ...parts].join(' ')
}

function badRequest(reply: FastifyReply, error: string, description: string) {
  return reply.status(400).send({ error, error_description: description })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

/** Minimal self-contained sign-in. No SPA route, no bundle, no base-path trap. */
function signInPage(action: string, error: string | null): string {
  return page(`<h1>Sign in to continue</h1>
 ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
 <label for="name">Name</label><input id="name" name="name" autocomplete="username" autofocus>
 <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
 <button type="submit">Sign in</button>`, action)
}

/**
 * The approval step. Names the client, where it will send the code, and exactly
 * what is being granted, so the person approving can see what they are agreeing
 * to rather than inferring it from a redirect flash.
 */
function consentPage(o: {
  action: string
  clientName: string
  redirectUri: string
  scope: string
  userName: string
  csrf: string
}): string {
  const consentAction = `${o.action.split('?')[0]}/consent?${o.action.split('?')[1] ?? ''}`
  return page(`<h1>Allow access?</h1>
 <p class="who"><strong>${escapeHtml(o.clientName)}</strong> wants to access Canonry as
   <strong>${escapeHtml(o.userName)}</strong>.</p>
 <dl>
   <dt>Permissions</dt><dd>${escapeHtml(o.scope)}</dd>
   <dt>Redirects to</dt><dd class="uri">${escapeHtml(o.redirectUri)}</dd>
 </dl>
 <input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}">
 <div class="row">
   <button type="submit" name="approve" value="no" class="ghost">Deny</button>
   <button type="submit" name="approve" value="yes">Allow</button>
 </div>`, consentAction)
}

function page(inner: string, action: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canonry</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;background:#10141c;color:#e8eaed;display:grid;place-items:center;min-height:100vh;margin:0}
 form{background:#171c26;padding:2rem;border-radius:12px;width:min(26rem,90vw);display:grid;gap:.75rem}
 h1{font-size:1.1rem;margin:0 0 .5rem}
 label,dt{font-size:.85rem;color:#9aa4b2}
 dl{margin:0;display:grid;gap:.5rem}
 dd{margin:0}
 .uri{word-break:break-all;font-family:ui-monospace,monospace;font-size:.85rem}
 input{padding:.6rem;border-radius:6px;border:1px solid #2a3140;background:#0d1117;color:inherit;font:inherit}
 input[type=hidden]{display:none}
 button{padding:.6rem 1rem;border-radius:6px;border:0;background:#3b82f6;color:#fff;font:inherit;cursor:pointer}
 .ghost{background:#2a3140}
 .row{display:flex;gap:.5rem;justify-content:flex-end}
 .err{color:#f87171;font-size:.85rem}
 .who{margin:0}
</style></head>
<body><form method="post" action="${escapeHtml(action)}">
 ${inner}
</form></body></html>`
}

/**
 * Per-process secret for consent tokens. Regenerated on restart, which only
 * means an approval page open across a restart must be reloaded — cheap, and it
 * avoids another secret to configure and protect.
 */
const CONSENT_SECRET = crypto.randomBytes(32)

export function registerOAuthRoutes(app: FastifyInstance, opts: OAuthRoutesOptions): void {
  // RFC 6749 s4.1.3: the token endpoint takes application/x-www-form-urlencoded,
  // and real OAuth clients send exactly that. Fastify parses JSON out of the
  // box and 415s form bodies, so without this every standards-compliant client
  // fails to exchange or refresh — which is every client that matters.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)))
        } catch (error) {
          done(error as Error, undefined)
        }
      },
    )
  }

  const { db, issuer } = opts
  const resourcePaths = opts.resourcePaths
  // The canonical resource for audience binding. Segments are the same resource
  // reached through narrower doors, so a token is bound to one audience rather
  // than one per URL — otherwise a client would need a separate grant per
  // segment, which no host would do.
  const canonicalPath = resourcePaths[0] ?? '/api/v1/mcp'
  const resourceUrl = `${issuer}${canonicalPath}`

  /**
   * Binds an approval to one person AND the exact parameters shown to them, so
   * a form posted from another origin cannot approve anything, and one where
   * the client or scope was swapped after render fails to verify.
   */
  function consentToken(userId: string, clientId: string, redirectUri: string, scope: string): string {
    return crypto.createHmac('sha256', CONSENT_SECRET)
      .update([userId, clientId, redirectUri, scope].join('\u0000'))
      .digest('base64url')
  }

  function authorizationServerMetadata() {
    return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    // RFC 7591. The current MCP revision calls DCR deprecated and prefers
    // pre-registered clients or CIMD — but a desktop client has no way to be
    // pre-registered: its UI takes a URL and nothing else, so there is nowhere
    // for a human to type a client_id. Codex proved it, walking discovery
    // correctly and then stopping dead because there was no registration
    // endpoint. Deprecated in the spec is not the same as unused by clients.
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. Advertising `plain` would invite a downgrade attempt.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: [...SUPPORTED_SCOPES],
    }
  }


  /**
   * RFC 9728. The one document the spec makes mandatory, and the entry point
   * for the whole flow: a 401 from the resource names it, the client fetches
   * it, and it points at the authorization server.
   *
   * The path INSERTS the well-known segment between host and path — metadata
   * for a resource at /api/v1/mcp lives at
   * /.well-known/oauth-protected-resource/api/v1/mcp, not under the resource.
   */
  // Codex probes `/.well-known/oauth-authorization-server<resourcePath>` BEFORE
  // the bare root form, so serve both. Harmless duplication, and a client that
  // only tries the path-inserted shape would otherwise never find the server.
  for (const path of resourcePaths) {
    app.get(`/.well-known/oauth-authorization-server${path}`, async () => authorizationServerMetadata())
  }

  for (const path of resourcePaths) {
    app.get(`/.well-known/oauth-protected-resource${path}`, async () => ({
      // Every segment points at the same audience, so one grant works on all
      // of them and the token stays bound to a single resource.
      resource: resourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    }))
  }

  /** RFC 8414. */
  app.get('/.well-known/oauth-authorization-server', async () => authorizationServerMetadata())

  app.get('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const clientId = q.client_id
    const redirectUri = q.redirect_uri
    const challenge = q.code_challenge

    if (!clientId || !redirectUri) return badRequest(reply, 'invalid_request', 'client_id and redirect_uri are required.')
    if (q.response_type !== 'code') return badRequest(reply, 'unsupported_response_type', 'Only the authorization code flow is supported.')
    // PKCE is mandatory in OAuth 2.1 and S256 is the only method offered.
    if (!challenge) return badRequest(reply, 'invalid_request', 'code_challenge is required.')
    if (q.code_challenge_method !== 'S256') return badRequest(reply, 'invalid_request', 'code_challenge_method must be S256.')

    const client = db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()
    if (!client || client.revokedAt) return badRequest(reply, 'invalid_client', 'Unknown client.')
    if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
      return badRequest(reply, 'invalid_request', 'redirect_uri is not registered for this client.')
    }
    // Audience binding. A token minted for one resource must not work on another.
    if (q.resource && q.resource !== resourceUrl) {
      return badRequest(reply, 'invalid_target', 'resource does not match this authorization server.')
    }

    // Only scopes this server advertises. Storing q.scope verbatim let a client
    // ask for `*` — or any unrecognised string, since isReadOnlyKey treats
    // "contains no write scope" as read-only and an unknown token satisfies
    // neither — and receive the full write catalog.
    const grantedScope = resolveRequestedScope(q.scope)
    if (grantedScope === null) {
      return badRequest(reply, 'invalid_scope', `Supported scopes: ${SUPPORTED_SCOPES.join(', ')}.`)
    }

    const user = opts.resolveUser(request)
    if (!user) {
      // Sign in HERE rather than redirecting somewhere else. The obvious move,
      // a bounce to the product's sign-in with a `next` parameter, dead-ends:
      // the dashboard has no /signin route, never reads `next`, and 404s under
      // a base path.
      return reply.type('text/html').send(signInPage(request.url, null))
    }

    // A SESSION IS NOT CONSENT.
    //
    // Minting the code here, on a GET, off nothing but a cookie, is a
    // drive-by grant: the session cookie is SameSite=Lax so a browser attaches
    // it to a top-level navigation, registration is open so an attacker
    // supplies the client and the redirect and generates the PKCE challenge
    // himself, and the operator sees a redirect flash. A third party ends up
    // holding a token bound to that account.
    //
    // So the GET only ever ASKS. The code is minted by the POST below, which
    // carries a CSRF token bound to this session.
    return reply.type('text/html').send(consentPage({
      action: request.url,
      clientName: client.name,
      redirectUri,
      scope: grantedScope,
      userName: user.name,
      csrf: consentToken(user.id, clientId, redirectUri, grantedScope),
    }))
  })

  app.post('/oauth/authorize/consent', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>
    const body = (request.body ?? {}) as Record<string, string | undefined>
    const user = opts.resolveUser(request)
    if (!user) return badRequest(reply, 'access_denied', 'Not signed in.')

    const clientId = q.client_id
    const redirectUri = q.redirect_uri
    const challenge = q.code_challenge
    if (!clientId || !redirectUri || !challenge) {
      return badRequest(reply, 'invalid_request', 'Missing authorization parameters.')
    }
    const grantedScope = resolveRequestedScope(q.scope)
    if (grantedScope === null) return badRequest(reply, 'invalid_scope', 'Unsupported scope.')

    const client = db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()
    if (!client || client.revokedAt) return badRequest(reply, 'invalid_client', 'Unknown client.')
    if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
      return badRequest(reply, 'invalid_request', 'redirect_uri is not registered for this client.')
    }

    // The CSRF token binds the approval to THIS person and THESE exact
    // parameters, so a form posted from elsewhere, or one where the client or
    // scope was swapped after the page rendered, cannot approve anything.
    const expected = consentToken(user.id, clientId, redirectUri, grantedScope)
    const presented = body.csrf ?? ''
    const a = Buffer.from(expected)
    const b = Buffer.from(presented)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return badRequest(reply, 'access_denied', 'Approval could not be verified. Start again.')
    }
    if (body.approve !== 'yes') {
      const denied = new URL(redirectUri)
      denied.searchParams.set('error', 'access_denied')
      if (q.state) denied.searchParams.set('state', q.state)
      return reply.redirect(denied.toString())
    }

    const code = newToken()
    const now = new Date()
    db.insert(oauthAuthorizationCodes).values({
      codeHash: sha256(code),
      clientId,
      userId: user.id,
      redirectUri,
      codeChallenge: challenge,
      resource: q.resource ?? resourceUrl,
      scope: grantedScope,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    }).run()

    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (q.state) target.searchParams.set('state', q.state)
    // RFC 9207: naming the issuer lets the client detect a mix-up attack.
    target.searchParams.set('iss', issuer)
    return reply.redirect(target.toString())
  })

  /**
   * RFC 7591 Dynamic Client Registration.
   *
   * Open by necessity, not by preference: a desktop client has no field for a
   * client_id, so without this it can discover the authorization server and
   * then do nothing — which is exactly what happened. The MCP spec deprecates
   * DCR; real clients still require it.
   *
   * What keeps an open registration endpoint safe is that registering buys
   * NOTHING on its own. A client with no user behind it cannot reach a single
   * tool: every token still requires a person to sign in and approve, and the
   * authority it carries is theirs, bounded by the scope they grant. Registration
   * mints an identifier, never access.
   *
   * Public clients only. A secret is never issued here, because a client that
   * registered itself over an open endpoint has no way to keep one.
   */
  app.post('/oauth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown }
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
      : []
    if (uris.length === 0) {
      return reply.status(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required.' })
    }
    // Refuse anything we could not safely redirect to later. Loopback covers
    // native apps; https covers hosted ones. Plain http elsewhere would be a
    // token-leaking redirect.
    for (const uri of uris) {
      let parsed: URL
      try {
        parsed = new URL(uri)
      } catch {
        return reply.status(400).send({ error: 'invalid_redirect_uri', error_description: `Not a URL: ${uri}` })
      }
      const loopback = isLoopbackHost(parsed.hostname)
      if (!loopback && parsed.protocol !== 'https:') {
        return reply.status(400).send({
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris must be https, or http on a loopback host.',
        })
      }
    }

    const clientId = `dcr_${crypto.randomBytes(16).toString('hex')}`
    const now = new Date().toISOString()
    db.insert(oauthClients).values({
      id: clientId,
      name: typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 200)
        : 'Dynamically registered client',
      secretHash: null,
      redirectUris: uris,
      createdAt: now,
    }).run()

    return reply.status(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.parse(now) / 1000),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  })

  app.post('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>
    const name = body.name?.trim()
    const password = body.password
    if (!name || !password) {
      return reply.type('text/html').send(signInPage(request.url, 'Enter a name and password.'))
    }
    // The SAME check /auth/login runs, with the same four budgets. Reimplementing
    // it here is what made the dashboard's lockout bypassable through this door.
    const result = await opts.credentials.verify(request, name, password)
    if (!result.ok) {
      return reply.type('text/html').send(signInPage(request.url, result.message))
    }
    void reply.header('set-cookie', opts.startSession(result.user.id))
    // Re-enter the GET, which now renders the approval page.
    return reply.redirect(request.url)
  })

  app.post('/oauth/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>
    const now = new Date()

    // Opportunistic sweep. Codes live 60s and nothing else would ever remove
    // a code that was issued and never redeemed.
    db.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, now.toISOString())).run()

    /**
     * Every grant runs this. Checking the client at authorize time only is not
     * enough: tokens outlive the authorize request, and refresh rotation would
     * otherwise let a revoked client renew itself indefinitely.
     */
    function checkClient(clientId: string): 'ok' | 'invalid_client' | 'invalid_secret' {
      const client = db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()
      if (!client || client.revokedAt) return 'invalid_client'
      // A confidential client (one that was issued a secret) must present it.
      // Advertising client_secret_post while never checking the secret makes
      // the secret decorative and the client effectively public.
      if (client.secretHash) {
        const presented = body.client_secret
        if (!presented) return 'invalid_secret'
        const expected = Buffer.from(client.secretHash)
        const actual = Buffer.from(sha256(presented))
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
          return 'invalid_secret'
        }
      }
      return 'ok'
    }

    function issue(clientId: string, userId: string, resource: string | null, scope: string | null) {
      const accessToken = newToken()
      const refreshToken = newToken()
      const rows = [
        { token: accessToken, kind: 'access' as const, ttl: ACCESS_TTL_MS },
        { token: refreshToken, kind: 'refresh' as const, ttl: REFRESH_TTL_MS },
      ]
      for (const row of rows) {
        db.insert(oauthTokens).values({
          tokenHash: sha256(row.token),
          kind: row.kind,
          clientId,
          userId,
          resource,
          scope,
          expiresAt: new Date(now.getTime() + row.ttl).toISOString(),
          createdAt: now.toISOString(),
        }).run()
      }
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        // Without a refresh token the client silently loses access at the
        // first expiry, which reads to a user as the connector breaking.
        refresh_token: refreshToken,
        scope: scope ?? 'read',
      }
    }

    if (body.grant_type === 'authorization_code') {
      const code = body.code
      const verifier = body.code_verifier
      if (!code || !verifier) return badRequest(reply, 'invalid_request', 'code and code_verifier are required.')

      const row = db.select().from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.codeHash, sha256(code))).get()
      if (!row) return badRequest(reply, 'invalid_grant', 'Unknown or already-redeemed code.')

      // Single use: burn it before any other check can fail, so a failed
      // attempt cannot be retried against the same code.
      db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, row.codeHash)).run()

      if (Date.parse(row.expiresAt) <= now.getTime()) return badRequest(reply, 'invalid_grant', 'Code has expired.')
      if (body.client_id !== row.clientId) return badRequest(reply, 'invalid_grant', 'Code was issued to a different client.')
      const clientState = checkClient(row.clientId)
      if (clientState !== 'ok') return badRequest(reply, 'invalid_client', 'Client is unknown, revoked, or failed authentication.')
      if (body.redirect_uri !== row.redirectUri) return badRequest(reply, 'invalid_grant', 'redirect_uri does not match the authorization request.')
      if (!verifyPkce(verifier, row.codeChallenge)) return badRequest(reply, 'invalid_grant', 'PKCE verification failed.')

      return issue(row.clientId, row.userId, row.resource, row.scope)
    }

    if (body.grant_type === 'refresh_token') {
      const presented = body.refresh_token
      if (!presented) return badRequest(reply, 'invalid_request', 'refresh_token is required.')
      const row = db.select().from(oauthTokens)
        .where(and(eq(oauthTokens.tokenHash, sha256(presented)), eq(oauthTokens.kind, 'refresh'))).get()
      if (!row || row.revokedAt) return badRequest(reply, 'invalid_grant', 'Unknown or revoked refresh token.')
      if (Date.parse(row.expiresAt) <= now.getTime()) return badRequest(reply, 'invalid_grant', 'Refresh token has expired.')
      const refreshClientState = checkClient(row.clientId)
      if (refreshClientState !== 'ok') return badRequest(reply, 'invalid_client', 'Client is unknown, revoked, or failed authentication.')

      // Rotation: the presented token dies with the request that used it, so a
      // stolen refresh token is usable at most once and the theft is visible
      // as a failure on the legitimate client's next refresh.
      db.update(oauthTokens).set({ revokedAt: now.toISOString() })
        .where(eq(oauthTokens.tokenHash, row.tokenHash)).run()

      return issue(row.clientId, row.userId, row.resource, row.scope)
    }

    return badRequest(reply, 'unsupported_grant_type', 'Supported grants: authorization_code, refresh_token.')
  })

  app.post('/oauth/revoke', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>
    if (body.token) {
      db.update(oauthTokens).set({ revokedAt: new Date().toISOString() })
        .where(eq(oauthTokens.tokenHash, sha256(body.token))).run()
    }
    // RFC 7009: always 200, even for an unknown token. Distinguishing them
    // would turn this into an oracle for guessing valid tokens.
    return reply.status(200).send({})
  })
}

/**
 * Resolve an OAuth access token to its subject, or null.
 *
 * Audience is enforced here rather than at the caller: a token minted for one
 * resource is not valid at another even on the same instance.
 */
export function resolveOAuthAccessToken(
  db: DatabaseClient,
  token: string,
  expectedResource: string,
  now = new Date(),
): { userId: string; clientId: string; scope: string | null } | null {
  const row = db.select().from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthTokens.kind, 'access'))).get()
  if (!row || row.revokedAt) return null
  if (Date.parse(row.expiresAt) <= now.getTime()) return null
  if (row.resource && row.resource !== expectedResource) return null
  return { userId: row.userId, clientId: row.clientId, scope: row.scope }
}
