import crypto from 'node:crypto'

import { oauthAuthorizationCodes, oauthClients, oauthTokens, type DatabaseClient } from '@ainyc/canonry-db'
import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

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
  /** Path the MCP transport is served at, e.g. /api/v1/mcp. */
  resourcePath: string
  /**
   * Resolve the signed-in person from the request, or null. The authorize
   * endpoint reuses the product's existing sign-in rather than introducing a
   * second identity system.
   */
  resolveUser: (request: FastifyRequest) => { id: string; name: string } | null
  /** Where to send someone who is not signed in yet. */
  signInPath?: string
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

function badRequest(reply: FastifyReply, error: string, description: string) {
  return reply.status(400).send({ error, error_description: description })
}

export function registerOAuthRoutes(app: FastifyInstance, opts: OAuthRoutesOptions): void {
  const { db, issuer, resourcePath } = opts
  const resourceUrl = `${issuer}${resourcePath}`
  const signInPath = opts.signInPath ?? '/signin'

  /**
   * RFC 9728. The one document the spec makes mandatory, and the entry point
   * for the whole flow: a 401 from the resource names it, the client fetches
   * it, and it points at the authorization server.
   *
   * The path INSERTS the well-known segment between host and path — metadata
   * for a resource at /api/v1/mcp lives at
   * /.well-known/oauth-protected-resource/api/v1/mcp, not under the resource.
   */
  app.get(`/.well-known/oauth-protected-resource${resourcePath}`, async () => ({
    resource: resourceUrl,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  }))

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
    // Exact match, never a prefix: a prefix rule lets an open redirect through.
    if (!client.redirectUris.includes(redirectUri)) {
      return badRequest(reply, 'invalid_request', 'redirect_uri is not registered for this client.')
    }
    // Audience binding. A token minted for one resource must not work on another.
    if (q.resource && q.resource !== resourceUrl) {
      return badRequest(reply, 'invalid_target', 'resource does not match this authorization server.')
    }

    const user = opts.resolveUser(request)
    if (!user) {
      // Not signed in. Bounce through the product's own sign-in and come back
      // to this exact authorize URL, so the flow resumes where it left off.
      const back = encodeURIComponent(request.url)
      return reply.redirect(`${signInPath}?next=${back}`)
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

  app.post('/oauth/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>
    const now = new Date()

    // Opportunistic sweep. Codes live 60s and nothing else would ever remove
    // a code that was issued and never redeemed.
    db.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, now.toISOString())).run()

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
