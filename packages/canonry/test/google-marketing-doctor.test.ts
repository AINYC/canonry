import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  createClient,
  googleAdsConnections,
  gtmConnections,
  migrate,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

it('reports retained Google marketing evidence after disconnect as not connected', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-marketing-doctor-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
  }
  const previousConfigDir = process.env.CANONRY_CONFIG_DIR
  process.env.CANONRY_CONFIG_DIR = tmpDir
  const app = await createServer({ config, db, logger: false })

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        displayName: 'Example Hotel',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const projectId = (JSON.parse(created.body) as { id: string }).id
    const now = '2026-08-14T12:00:00.000Z'

    // These are the durable, redacted rows left by normal disconnect. The
    // private config intentionally has no OAuth entries for either provider.
    db.insert(googleAdsConnections).values({
      id: 'disconnected-ads',
      projectId,
      selectedLoginCustomerId: null,
      selectedCustomerId: null,
      scopes: [],
      lastInventorySnapshotAt: now,
      lastMetricsSnapshotAt: now,
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(gtmConnections).values({
      id: 'disconnected-gtm',
      projectId,
      selectedAccountId: null,
      selectedContainerId: null,
      selectedWorkspaceId: null,
      scopes: [],
      lastSnapshotAt: now,
      createdAt: now,
      updatedAt: now,
    }).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/example/doctor?check=google-ads.*,gtm.*',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(response.statusCode).toBe(200)
    const report = JSON.parse(response.body) as {
      checks: Array<{ id: string; status: string; code: string }>
    }

    expect(report.checks).toHaveLength(9)
    expect(report.checks.every((check) => check.status === 'skipped')).toBe(true)
    expect(report.checks.filter((check) => check.id.startsWith('google-ads.')).map((check) => check.code))
      .toEqual([
        'google-ads.auth.not-connected',
        'google-ads.auth.not-connected',
        'google-ads.auth.not-connected',
        'google-ads.auth.not-connected',
      ])
    expect(report.checks.filter((check) => check.id.startsWith('gtm.')).map((check) => check.code))
      .toEqual([
        'gtm.auth.not-connected',
        'gtm.auth.not-connected',
        'gtm.auth.not-connected',
        'gtm.auth.not-connected',
        'gtm.runtime.not-connected',
      ])
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = previousConfigDir
  }
})
