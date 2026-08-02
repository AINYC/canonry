/**
 * P1.2 — the sign-in route is public, and verifying a password is deliberately
 * expensive. Those two facts together are a denial-of-service unless the cost
 * is both OFF the event loop and admitted under a budget.
 *
 * The per-name counter alone does not do it: an attacker who never repeats a
 * name never trips it, and every one of those attempts still costs a full
 * derivation. These tests hold both halves.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { apiKeys, createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { hashUserPassword, verifyUserPassword } from '../src/user-password.js'

const ROOT_KEY = 'cnry_login_cost_root'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

function login(name: string, remoteAddress = '203.0.113.7') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress,
    payload: { name, password: 'whatever-they-guessed' },
  })
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-login-cost-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'root',
    keyHash: hashApiKey(ROOT_KEY),
    keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()

  await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    payload: { name: 'owner', password: ADMIN_PASSWORD, role: 'admin' },
  })
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('verifying a password does not hold the event loop', async () => {
  const digest = await hashUserPassword(ADMIN_PASSWORD)

  // A timer queued immediately before the derivation. If the derivation runs
  // on the loop, this callback cannot possibly fire until it is finished.
  let timerFired = false
  setTimeout(() => { timerFired = true }, 0)

  await verifyUserPassword('a-wrong-guess', digest)

  expect(timerFired).toBe(true)
})

test('hashing a password does not hold the event loop either', async () => {
  let timerFired = false
  setTimeout(() => { timerFired = true }, 0)

  await hashUserPassword(ADMIN_PASSWORD)

  expect(timerFired).toBe(true)
})

test('a caller who never repeats a name still runs out of budget', async () => {
  // The per-name counter is useless here on purpose: every attempt is a name
  // nobody has ever used. What has to stop it is the budget for the CALLER.
  const statuses: number[] = []
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await login(`nobody-${attempt}-${crypto.randomUUID()}`)
    statuses.push(res.statusCode)
  }

  expect(statuses).toContain(429)
  // And it has to bite well before 40 full derivations have been paid for.
  expect(statuses.indexOf(429)).toBeLessThan(35)
})

test('one exhausted caller does not lock everybody else out', async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    await login(`nobody-${attempt}`, '203.0.113.7')
  }
  expect((await login('nobody-again', '203.0.113.7')).statusCode).toBe(429)

  // A different caller has spent nothing and is unaffected.
  const other = await login('someone-else', '198.51.100.4')
  expect(other.statusCode).toBe(401)
})

test('a burst of sign-in attempts leaves the server answering other requests', async () => {
  const burst = Array.from({ length: 24 }, (_, index) =>
    login(`nobody-${index}`, `198.51.100.${index % 200}`))

  const started = Date.now()
  const health = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
  const elapsed = Date.now() - started

  expect(health.statusCode).toBe(200)
  // Generous: the point is that it is not serialized behind two dozen
  // derivations, which measured about three quarters of a second.
  expect(elapsed).toBeLessThan(400)

  await Promise.all(burst)
})

test('a correct password still signs in once the guessing stops', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '192.0.2.55',
    payload: { name: 'owner', password: ADMIN_PASSWORD },
  })
  expect(res.statusCode).toBe(200)
})
