import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, oauthClients, oauthTokens, users } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { beforeEach, afterEach, expect, test } from 'vitest'

import { registerOAuthRoutes, resolveOAuthAccessToken } from '../src/oauth.js'

/**
 * OAuth 2.1 for the MCP resource. Most of these are NEGATIVE cases on purpose:
 * an authorization server is defined by what it refuses, and every check below
 * is one an attacker would otherwise walk through.
 */

const ISSUER = 'https://instance.example.com'
const RESOURCE_PATH = '/api/v1/mcp'
const REDIRECT = 'https://client.example.com/callback'
const VERIFIER = 'a'.repeat(64)
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url')

let db: ReturnType<typeof createClient>
let app: ReturnType<typeof Fastify>
let tmpDir: string
let signedInUserId: string | null

function build() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-oauth-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  const userId = crypto.randomUUID()
  db.insert(users).values({
    id: userId, name: 'Sam', nameKey: 'sam', passwordHash: 'x', role: 'viewer', createdAt: now,
  }).run()
  signedInUserId = userId

  db.insert(oauthClients).values({
    id: 'client-1', name: 'Test client', secretHash: null, redirectUris: [REDIRECT], createdAt: now,
  }).run()

  app = Fastify()
  registerOAuthRoutes(app, {
    db,
    issuer: ISSUER,
    resourcePath: RESOURCE_PATH,
    resolveUser: () => (signedInUserId ? { id: signedInUserId, name: 'Sam' } : null),
  })
  return userId
}

beforeEach(() => { build() })
afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...overrides,
  })
  return `/oauth/authorize?${params.toString()}`
}

async function getCode(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: authorizeUrl() })
  expect(res.statusCode).toBe(302)
  return new URL(res.headers.location as string).searchParams.get('code')!
}

test('publishes protected-resource metadata at the RFC 9728 inserted path', async () => {
  // The well-known segment goes BETWEEN host and path. Serving it under the
  // resource instead is the mistake that makes discovery silently unreachable.
  const res = await app.inject({ method: 'GET', url: `/.well-known/oauth-protected-resource${RESOURCE_PATH}` })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({
    resource: `${ISSUER}${RESOURCE_PATH}`,
    authorization_servers: [ISSUER],
  })
})

test('advertises S256 only, never plain', async () => {
  const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
  expect(res.statusCode).toBe(200)
  expect(res.json().code_challenge_methods_supported).toEqual(['S256'])
})

test('authorize refuses a plain PKCE downgrade', async () => {
  const res = await app.inject({ method: 'GET', url: authorizeUrl({ code_challenge_method: 'plain' }) })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toBe('invalid_request')
})

test('authorize refuses a missing code_challenge', async () => {
  const params = new URLSearchParams({
    response_type: 'code', client_id: 'client-1', redirect_uri: REDIRECT, code_challenge_method: 'S256',
  })
  const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${params.toString()}` })
  expect(res.statusCode).toBe(400)
})

test('authorize refuses an unregistered redirect_uri', async () => {
  // Exact match only. A prefix rule here is an open redirect.
  const res = await app.inject({ method: 'GET', url: authorizeUrl({ redirect_uri: 'https://client.example.com/callback/../evil' }) })
  expect(res.statusCode).toBe(400)
})

test('authorize refuses a resource that is not this server', async () => {
  const res = await app.inject({ method: 'GET', url: authorizeUrl({ resource: 'https://elsewhere.example.com/api/v1/mcp' }) })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toBe('invalid_target')
})

test('authorize sends a signed-out person to sign in and returns to the same request', async () => {
  signedInUserId = null
  const res = await app.inject({ method: 'GET', url: authorizeUrl() })
  expect(res.statusCode).toBe(302)
  const location = res.headers.location as string
  expect(location.startsWith('/signin?next=')).toBe(true)
  expect(decodeURIComponent(location.split('next=')[1]!)).toContain('/oauth/authorize')
})

test('authorize returns a code plus state and iss', async () => {
  const res = await app.inject({ method: 'GET', url: authorizeUrl() })
  const url = new URL(res.headers.location as string)
  expect(url.searchParams.get('code')).toBeTruthy()
  expect(url.searchParams.get('state')).toBe('xyz')
  // RFC 9207: lets the client detect a mix-up attack.
  expect(url.searchParams.get('iss')).toBe(ISSUER)
})

test('token exchanges a code for an access token and a refresh token', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.token_type).toBe('Bearer')
  expect(body.access_token).toBeTruthy()
  expect(body.refresh_token).toBeTruthy()

  const resolved = resolveOAuthAccessToken(db, body.access_token, `${ISSUER}${RESOURCE_PATH}`)
  expect(resolved?.userId).toBe(signedInUserId)
})

test('token refuses a wrong PKCE verifier', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: 'b'.repeat(64), client_id: 'client-1', redirect_uri: REDIRECT },
  })
  expect(res.statusCode).toBe(400)
  expect(res.json().error).toBe('invalid_grant')
})

test('a code is single use even when the first attempt FAILED', async () => {
  // Burned before any other check, so a wrong verifier cannot be retried
  // against the same code until it is guessed.
  const code = await getCode()
  const payload = { grant_type: 'authorization_code', code, client_id: 'client-1', redirect_uri: REDIRECT }
  const first = await app.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, code_verifier: 'b'.repeat(64) } })
  expect(first.statusCode).toBe(400)
  const second = await app.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, code_verifier: VERIFIER } })
  expect(second.statusCode).toBe(400)
})

test('token refuses a code presented by a different client', async () => {
  const now = new Date().toISOString()
  db.insert(oauthClients).values({ id: 'client-2', name: 'Other', secretHash: null, redirectUris: [REDIRECT], createdAt: now }).run()
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-2', redirect_uri: REDIRECT },
  })
  expect(res.statusCode).toBe(400)
})

test('refresh rotates: the presented token dies with the request that used it', async () => {
  const code = await getCode()
  const first = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const refresh = first.json().refresh_token as string

  const second = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh } })
  expect(second.statusCode).toBe(200)
  expect(second.json().refresh_token).not.toBe(refresh)

  const replay = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refresh } })
  expect(replay.statusCode).toBe(400)
})

test('an access token is not valid for a different resource', async () => {
  // Audience binding. Without it a token minted for one endpoint works on any.
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const token = res.json().access_token as string
  expect(resolveOAuthAccessToken(db, token, `${ISSUER}${RESOURCE_PATH}`)).not.toBeNull()
  expect(resolveOAuthAccessToken(db, token, 'https://elsewhere.example.com/api/v1/mcp')).toBeNull()
})

test('a revoked access token stops resolving', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const token = res.json().access_token as string
  const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token } })
  expect(revoke.statusCode).toBe(200)
  expect(resolveOAuthAccessToken(db, token, `${ISSUER}${RESOURCE_PATH}`)).toBeNull()
})

test('revoke answers 200 for an unknown token rather than acting as an oracle', async () => {
  const res = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: 'not-a-real-token' } })
  expect(res.statusCode).toBe(200)
})

test('tokens are stored as digests, never in plaintext', async () => {
  const code = await getCode()
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'client-1', redirect_uri: REDIRECT },
  })
  const token = res.json().access_token as string
  const rows = db.select().from(oauthTokens).all()
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) expect(row.tokenHash).not.toBe(token)
  expect(db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, token)).get()).toBeUndefined()
})
