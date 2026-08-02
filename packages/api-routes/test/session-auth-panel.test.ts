/**
 * Adversarial panel findings. Each hole is demonstrated before it is closed.
 *
 * The theme running through all of them: a rule written against the WRONG
 * attribute. "Is this a user principal" is not the same question as "did this
 * credential arrive in a cookie"; "what is `request.ip`" is not the same
 * question as "who is calling"; "is this a GET" is not the same question as
 * "is this free".
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  adsConnections,
  apiKeys,
  createClient,
  migrate,
  projects,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ROOT_KEY = 'cnry_panel_root'
const READ_KEY = 'cnry_panel_read'
const LEGACY_COOKIE = 'canonry_session'
const LEGACY_SESSION_ID = 'legacy-dashboard-password-session'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'
const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string
let rootKeyId: string
let liveDeliveryCalls: number

function seedKey(name: string, token: string, scopes: string[]): string {
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id,
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function withKey(token: string) {
  return { authorization: `Bearer ${token}` }
}

async function createAccount(name: string, password: string, role: 'admin' | 'viewer') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: withKey(ROOT_KEY),
    payload: { name, password, role },
  })
}

async function signIn(name: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { name, password },
  })
  expect(res.statusCode).toBe(200)
  const raw = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0]!
    : String(res.headers['set-cookie'])
  return decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-panel-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'sample',
    displayName: 'Sample',
    canonicalDomain: 'sample.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  rootKeyId = seedKey('root', ROOT_KEY, ['*'])
  seedKey('reader', READ_KEY, ['read'])

  db.insert(adsConnections).values({
    id: crypto.randomUUID(),
    projectId,
    adAccountId: 'sample-account',
    status: 'connected',
    createdAt: now,
    updatedAt: now,
  }).run()

  liveDeliveryCalls = 0

  app = Fastify()
  app.register(apiRoutes, {
    db,
    // The install's shared dashboard password mints a session bound to the
    // ROOT key — a cookie carrying full authority.
    sessionCookieName: LEGACY_COOKIE,
    resolveSessionApiKeyId: (id: string) => (id === LEGACY_SESSION_ID ? rootKeyId : null),
    adsCredentialStore: {
      getConnection: () => ({ accessToken: 'sample-token' }),
      upsertConnection: (connection: unknown) => connection,
      deleteConnection: () => true,
    } as never,
    adsLiveDeliveryReader: {
      listCampaigns: async () => { liveDeliveryCalls++; return [] },
      listAdGroups: async () => { liveDeliveryCalls++; return [] },
      listAds: async () => { liveDeliveryCalls++; return [] },
      getInsights: async () => { liveDeliveryCalls++; return [] },
    } as never,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── P1.1 the CSRF rule keyed on the wrong attribute ───────────────────────

test('a cross-origin write riding the shared dashboard cookie is refused', async () => {
  // This cookie resolves to a wildcard API key, so the "API keys are exempt"
  // carve-out lets it straight through — a full-authority CSRF hole sitting
  // right next to the CSRF fix. What matters is that the credential arrived in
  // a COOKIE, not what it happens to resolve to.
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: {
      cookie: `${LEGACY_COOKIE}=${LEGACY_SESSION_ID}`,
      origin: 'http://evil.localhost:4100',
      host: HOST,
    },
    payload: {},
  })

  expect(res.statusCode).toBe(403)
})

test('the shared dashboard cookie still works from the dashboard itself', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: { cookie: `${LEGACY_COOKIE}=${LEGACY_SESSION_ID}`, origin: ORIGIN, host: HOST },
    payload: {},
  })
  expect(res.statusCode).toBe(201)
})

test('a real header-carried API key is never subject to the origin rule', async () => {
  // Nothing attaches an Authorization header automatically, so there is no
  // request to ride. Checking it here would break every CLI and agent.
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: { ...withKey(ROOT_KEY), origin: 'http://anywhere.example' },
    payload: {},
  })
  expect(res.statusCode).toBe(201)
})

// ─── P1.2 the caller budget behind a proxy ─────────────────────────────────

/**
 * The same install, deployed the way it actually is: behind an edge proxy.
 *
 * The host has to DECLARE the trust, not just hand it to Fastify — everything
 * that budgets per caller reads the declaration, because a forwarded header on
 * its own is a string the caller chose.
 */
async function bootProxiedApp(trustProxy: boolean) {
  const proxied = Fastify({ trustProxy })
  proxied.register(apiRoutes, { db, trustProxyConfigured: trustProxy })
  await proxied.ready()
  return proxied
}

function guessFrom(server: ReturnType<typeof Fastify>, forwardedFor: string, attempt: number) {
  // Every request arrives from the SAME socket — the edge proxy — and only the
  // forwarded chain says who is really behind it.
  return server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '10.0.0.2',
    headers: { 'x-forwarded-for': forwardedFor, origin: ORIGIN, host: HOST },
    payload: { name: `nobody-${attempt}`, password: 'a-wrong-guess' },
  })
}

test('callers behind a proxy are told apart when the forwarded chain is trusted', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const proxied = await bootProxiedApp(true)

  try {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      statuses.push((await guessFrom(proxied, '203.0.113.9', attempt)).statusCode)
    }
    expect(statuses).toContain(429)

    // A different person, behind the SAME proxy, is unaffected — which is the
    // whole point. Keyed on the socket they would share one budget and this
    // sign-in would be refused.
    const bystander = await proxied.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.4', origin: ORIGIN, host: HOST },
      payload: { name: 'owner', password: ADMIN_PASSWORD },
    })
    expect(bystander.statusCode).toBe(200)
  } finally {
    await proxied.close()
  }
})

test('an undeclared proxy still budgets, and does so on the only honest address', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const proxied = await bootProxiedApp(false)

  try {
    // Nothing here was declared, so the forwarded header is just a string the
    // caller chose and carries no weight. The budget applies to the socket —
    // the only address that cannot be forged — and therefore still applies.
    const statuses: number[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      statuses.push((await guessFrom(proxied, '203.0.113.9', attempt)).statusCode)
    }
    expect(statuses).toContain(429)

    // The cost of leaving it undeclared is that everyone behind the proxy
    // shares that bucket. That is a MISCONFIGURATION for the operator to fix
    // with CANONRY_TRUST_PROXY, and it is a far better failure than a budget an
    // attacker can switch off from outside by inventing a header.
    const bystander = await proxied.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.4', origin: ORIGIN, host: HOST },
      payload: { name: 'owner', password: ADMIN_PASSWORD },
    })
    expect(bystander.statusCode).toBe(429)
  } finally {
    await proxied.close()
  }
})

test('the trust setting reads the way an operator would write it', async () => {
  const { resolveTrustProxy } = await import('../src/trust-proxy.js')

  expect(resolveTrustProxy(undefined)).toBe(false)
  expect(resolveTrustProxy('')).toBe(false)
  expect(resolveTrustProxy('false')).toBe(false)
  expect(resolveTrustProxy('true')).toBe(true)
  expect(resolveTrustProxy('1')).toBe(1)
  expect(resolveTrustProxy('2')).toBe(2)
  expect(resolveTrustProxy('10.0.0.1, 192.168.0.0/16')).toEqual(['10.0.0.1', '192.168.0.0/16'])
})

// ─── P2.4 a GET that spends money ──────────────────────────────────────────

test('the paid live-delivery read is refused to a view-only account', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/sample/ads/live-delivery',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewer}` },
  })

  // A GET, so nothing in the method-based gate can see it — but it fans out
  // thousands of billed provider calls.
  expect(res.statusCode).toBe(403)
  expect(liveDeliveryCalls).toBe(0)
})

test('the paid live-delivery read is refused to a read-only key', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/sample/ads/live-delivery',
    headers: withKey(READ_KEY),
  })
  expect(res.statusCode).toBe(403)
  expect(liveDeliveryCalls).toBe(0)
})

// ─── P2.3 the admin gate ignored what the key could do ─────────────────────

test('a read-only key cannot enumerate the accounts on this install', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(READ_KEY) })
  expect(res.statusCode).toBe(403)
})

// ─── P2.5 sessions that never end ──────────────────────────────────────────

test('a session cannot be renewed past its absolute lifetime', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)
  const tokenHash = crypto.createHash('sha256').update(session).digest('hex')

  // Sliding renewal on its own extends forever, so a stolen cookie that keeps
  // being used never expires. Age it past the ceiling and it must stop, even
  // though its sliding window is still wide open.
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  db.update(userSessions).set({ createdAt: longAgo }).where(eq(userSessions.tokenHash, tokenHash)).run()

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })
  expect(res.statusCode).toBe(401)
  expect(db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).get()).toBeUndefined()
})

test('somebody can end every session they have without needing a root key', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const laptop = await signIn('owner', ADMIN_PASSWORD)
  const phone = await signIn('owner', ADMIN_PASSWORD)

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/sessions',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${laptop}` },
  })
  expect(listed.statusCode).toBe(200)
  const body = JSON.parse(listed.body) as { sessions: Array<{ current: boolean }> }
  expect(body.sessions).toHaveLength(2)
  expect(body.sessions.filter(s => s.current)).toHaveLength(1)

  const revoked = await app.inject({
    method: 'DELETE',
    url: '/api/v1/auth/sessions',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${laptop}`, origin: ORIGIN, host: HOST },
  })
  expect(revoked.statusCode).toBe(204)

  // Both are gone, including the one that asked.
  for (const token of [laptop, phone]) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${token}` },
    })
    expect(res.statusCode).toBe(401)
  }
})

test('one account cannot end another account sessions', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const admin = await signIn('owner', ADMIN_PASSWORD)
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  await app.inject({
    method: 'DELETE',
    url: '/api/v1/auth/sessions',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewer}`, origin: ORIGIN, host: HOST },
  })

  const stillWorks = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${admin}` },
  })
  expect(stillWorks.statusCode).toBe(200)
})

test('another origin cannot end somebody else sessions for them', async () => {
  // The revoke route is on the auth skip-list so it works from a session the
  // rest of the API is refusing — which means it has to run the same-origin
  // check itself, or it becomes a cross-origin logout button.
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const foreign = await app.inject({
    method: 'DELETE',
    url: '/api/v1/auth/sessions',
    headers: {
      cookie: `${USER_SESSION_COOKIE_NAME}=${session}`,
      origin: 'http://evil.localhost:4100',
      host: HOST,
    },
  })
  expect(foreign.statusCode).toBe(403)

  const stillWorks = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })
  expect(stillWorks.statusCode).toBe(200)
})
