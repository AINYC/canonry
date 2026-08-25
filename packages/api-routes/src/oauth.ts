import crypto from 'node:crypto'

import { oauthAuthorizationCodes, oauthClients, oauthTokens, users, type DatabaseClient } from '@ainyc/canonry-db'
import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { verifyUserPassword } from './user-password.js'

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
   * return the cookie header to set. Lets the authorize endpoint complete a
   * sign-in itself rather than bouncing to a route that may not exist.
   */
  startSession: (userId: string) => string
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

function badRequest(reply: FastifyReply, error: string, description: string) {
  return reply.status(400).send({ error, error_description: description })
}

/**
 * A scrypt hash of a value nothing will ever match. Compared against when the
 * account does not exist so the timing is indistinguishable from a wrong
 * password — otherwise the endpoint tells an attacker which names are real.
 */
const DUMMY_HASH = 'scrypt$16384$8$1$0000000000000000$0000000000000000000000000000000000000000000000000000000000000000'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

/** Minimal self-contained sign-in. No SPA route, no bundle, no base-path trap. */
function consentPage(action: string, error: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to continue</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;background:#10141c;color:#e8eaed;display:grid;place-items:center;min-height:100vh;margin:0}
 form{background:#171c26;padding:2rem;border-radius:12px;width:min(22rem,90vw);display:grid;gap:.75rem}
 h1{font-size:1.1rem;margin:0 0 .5rem}
 label{font-size:.85rem;color:#9aa4b2}
 input{padding:.6rem;border-radius:6px;border:1px solid #2a3140;background:#0d1117;color:inherit;font:inherit}
 button{padding:.6rem;border-radius:6px;border:0;background:#3b82f6;color:#fff;font:inherit;cursor:pointer}
 .err{color:#f87171;font-size:.85rem}
</style></head>
<body><form method="post" action="${escapeHtml(action)}">
 <h1>Sign in to continue</h1>
 ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
 <label for="name">Name</label><input id="name" name="name" autocomplete="username" autofocus>
 <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
 <button type="submit">Sign in</button>
</form></body></html>`
}

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
   * RFC 9728. The one document the spec makes mandatory, and the entry point
   * for the whole flow: a 401 from the resource names it, the client fetches
   * it, and it points at the authorization server.
   *
   * The path INSERTS the well-known segment between host and path — metadata
   * for a resource at /api/v1/mcp lives at
   * /.well-known/oauth-protected-resource/api/v1/mcp, not under the resource.
   */
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
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. Advertising `plain` would invite a downgrade attempt.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: ['read', 'offline_access'],
  }))

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

    const user = opts.resolveUser(request)
    if (!user) {
      // Sign in HERE rather than redirecting somewhere else.
      //
      // The obvious move is a bounce to the product's sign-in with a `next`
      // parameter, and it does not work: the dashboard has no /signin route,
      // it never reads `next`, and under a base path the URL 404s outright. So
      // the flow would dead-end for exactly the person it exists to serve.
      // This page posts back to the same URL and the flow resumes inline.
      return reply.type('text/html').send(consentPage(request.url, null))
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
      scope: q.scope ?? 'read',
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

  app.post('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>
    const name = body.name?.trim()
    const password = body.password
    if (!name || !password) {
      return reply.type('text/html').send(consentPage(request.url, 'Enter a name and password.'))
    }
    const account = db.select().from(users).where(eq(users.nameKey, name.toLowerCase())).get()
    // Verify against a real stored hash when the account exists, and against a
    // throwaway one when it does not, so a missing account and a wrong password
    // take the same time and the endpoint is not a user-enumeration oracle.
    const matches = account
      ? await verifyUserPassword(password, account.passwordHash)
      : (await verifyUserPassword(password, DUMMY_HASH), false)
    if (!account || !matches) {
      return reply.type('text/html').send(consentPage(request.url, 'That name and password did not match.'))
    }
    const cookie = opts.startSession(account.id)
    void reply.header('set-cookie', cookie)
    // Re-enter the GET flow now that a session exists; every validation there
    // runs again rather than being duplicated here.
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
