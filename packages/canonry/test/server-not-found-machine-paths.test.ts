import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

/**
 * The SPA fallback answers unmatched paths with index.html and a 200. That is
 * right for dashboard deep links and wrong for two shapes that no browser is
 * asking for:
 *
 * - `/.well-known/*` carries OAuth discovery. A client handed HTML with a 200
 *   cannot tell "no metadata here" from "metadata is malformed", so serving
 *   MCP over OAuth is impossible until this returns a real 404.
 * - Dotfile probes (/.env, /.git/config) are scanners. A 200 tells them the
 *   path exists.
 *
 * The regression this file really guards is the OTHER direction: the carve-out
 * must stay narrow enough that `/projects/<name>` still returns the document.
 */

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  cleanup: () => Promise<void>
}

const INDEX_HTML = '<!doctype html><html><head><base href="/"></head><body><div id="root"></div></body></html>'

async function buildServer(basePath?: string): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-not-found-${crypto.randomUUID()}`)
  const assetsDir = path.join(tmpDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  // The whole SPA-fallback block is guarded by `fs.existsSync(assetsDir)`, so
  // without a real index.html on disk every assertion below would pass for the
  // wrong reason — a headless build 404s everything already.
  fs.writeFileSync(path.join(assetsDir, 'index.html'), INDEX_HTML)

  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)

  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey: `cnry_${crypto.randomBytes(16).toString('hex')}`,
    providers: {},
    ...(basePath ? { basePath } : {}),
  }

  const app = await createServer({ config, db, logger: false, assetsDir })
  return {
    app,
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

describe('not-found handler: machine-facing paths', () => {
  let built: Built

  beforeAll(async () => {
    built = await buildServer()
  })

  afterAll(async () => {
    await built.cleanup()
  })

  it('serves the SPA document for a dashboard deep link', async () => {
    // The guard on the carve-out. If this ever 404s, the rule got too broad
    // and every shared project link in the product is broken.
    const res = await built.app.inject({ method: 'GET', url: '/projects/acme' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
  })

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/anything-at-all',
  ])('returns a JSON 404 for %s', async (url) => {
    const res = await built.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).not.toContain('<!doctype html>')
  })

  it.each([
    '/.env',
    '/.env.local',
    '/.env.production',
    '/.git/config',
    '/backend/.env',
  ])('returns a JSON 404 for the dotfile probe %s', async (url) => {
    const res = await built.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('still 404s API routes as JSON', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })
})

describe('not-found handler: machine-facing paths under a base path', () => {
  let built: Built

  beforeAll(async () => {
    built = await buildServer('/t/demo')
  })

  afterAll(async () => {
    await built.cleanup()
  })

  it('returns a JSON 404 for base-path-prefixed discovery', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/t/demo/.well-known/oauth-protected-resource' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('still serves the SPA document for a deep link under the base path', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/t/demo/projects/acme' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
  })
})
