import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, apiKeys, type DatabaseClient } from '@ainyc/canonry-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

/**
 * MCP over Streamable HTTP. The properties worth pinning are the ones the
 * stdio adapter got for free and this transport does not: that the endpoint is
 * authenticated at all, that a read-only key is not refused by the method-based
 * write gate, and that a session belongs to the credential that opened it.
 */

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}
const MCP_ACCEPT = 'application/json, text/event-stream'

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  wildcardKey: string
  readOnlyKey: string
  cleanup: () => Promise<void>
}

async function buildServer(): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-mcp-http-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)

  const wildcardKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const readOnlyKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  for (const [raw, scopes, name] of [[wildcardKey, ['*'], 'root'], [readOnlyKey, ['read'], 'reader']] as const) {
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name,
      keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      keyPrefix: raw.slice(0, 9),
      scopes: [...scopes],
      createdAt: new Date().toISOString(),
    }).run()
  }

  const config: CanonryConfig = {
    apiUrl: 'http://127.0.0.1:4100',
    database: dbPath,
    apiKey: wildcardKey,
    providers: {},
  }
  const app = await createServer({ config, db, logger: false })
  return {
    app,
    wildcardKey,
    readOnlyKey,
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

function initRequest(built: Built, key: string) {
  return built.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { authorization: `Bearer ${key}`, accept: MCP_ACCEPT, 'content-type': 'application/json' },
    payload: INIT,
  })
}

describe('MCP over Streamable HTTP', () => {
  let built: Built

  beforeEach(async () => {
    built = await buildServer()
  })

  afterEach(async () => {
    await built.cleanup()
  })

  it('refuses an unauthenticated caller', async () => {
    // The whole reason this mounts inside the api-routes scope. A route on the
    // root app has no auth hook and would answer this 200.
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { accept: MCP_ACCEPT, 'content-type': 'application/json' },
      payload: INIT,
    })
    expect(res.statusCode).toBe(401)
  })

  it('admits a READ-ONLY key through the write-method gate', async () => {
    // The positive case for `transportEnvelope`. Without it the global
    // read-only gate 403s this POST before the handler ever runs, and a
    // read-only credential is useless to a hosted client.
    const res = await initRequest(built, built.readOnlyKey)
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).toBeLessThan(400)
  })

  it('issues a session id on initialize and accepts it on a follow-up', async () => {
    const first = await initRequest(built, built.readOnlyKey)
    const sessionId = first.headers['mcp-session-id']
    expect(typeof sessionId).toBe('string')

    const second = await built.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        authorization: `Bearer ${built.readOnlyKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': sessionId as string,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(second.statusCode).toBeLessThan(400)
  })

  it('refuses a session id belonging to a different credential', async () => {
    // A session is pinned to the key that opened it. Without this, a leaked
    // session id would let any authenticated caller ride another caller's
    // server — and inherit its tool scope, which is the escalation that
    // matters: a read-only caller reusing a wildcard session.
    const first = await initRequest(built, built.wildcardKey)
    const sessionId = first.headers['mcp-session-id'] as string
    expect(typeof sessionId).toBe('string')

    const stolen = await built.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        authorization: `Bearer ${built.readOnlyKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(stolen.statusCode).toBe(404)
  })

  it('404s an unknown session id rather than silently opening a new one', async () => {
    // A client whose session was reaped must be told to re-initialize.
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        authorization: `Bearer ${built.readOnlyKey}`,
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-session-id': crypto.randomUUID(),
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    })
    expect(res.statusCode).toBe(404)
  })
})
