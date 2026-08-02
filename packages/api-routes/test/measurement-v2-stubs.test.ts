import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

const NOW = '2026-08-01T00:00:00.000Z'

/**
 * Slice 1 registers these routes and leaves the bodies to the slices that own
 * each module. Registration is the contract those slices build against, so it
 * is pinned here: a route that quietly fails to mount would surface as a 404
 * only once the handler landed.
 */
const DRAFT_ROUTES = [
  ['GET', '/measurement-setup'],
  ['GET', '/measurement-plan/draft'],
  ['GET', '/measurement-plan/draft/targets'],
  ['GET', '/measurement-plan/draft/assignments'],
  ['GET', '/measurement-plan/draft/groups'],
  ['POST', '/measurement-plan/draft/actions/create'],
  ['POST', '/measurement-plan/draft/actions/upsert-target'],
  ['POST', '/measurement-plan/draft/actions/rename-target'],
  ['POST', '/measurement-plan/draft/actions/merge-targets'],
  ['POST', '/measurement-plan/draft/actions/exclude-target'],
  ['POST', '/measurement-plan/draft/actions/rebind-target'],
  ['POST', '/measurement-plan/draft/actions/apply-assignments'],
  ['POST', '/measurement-plan/draft/actions/remove-assignment'],
  ['POST', '/measurement-plan/draft/actions/clear-assignments'],
  ['POST', '/measurement-plan/draft/actions/classify-assignments'],
  ['POST', '/measurement-plan/draft/actions/upsert-group'],
  ['POST', '/measurement-plan/draft/actions/remove-group'],
  ['POST', '/measurement-plan/draft/actions/upsert-competitor'],
  ['POST', '/measurement-plan/draft/actions/remove-competitor'],
  ['POST', '/measurement-plan/draft/actions/compile-preview'],
  ['POST', '/measurement-plan/draft/actions/diff-preview'],
  ['POST', '/measurement-plan/draft/actions/publish'],
  ['POST', '/measurement-plan/draft/actions/discard'],
  ['POST', '/measurement-plan/actions/deactivate'],
  ['GET', '/measurement-query-sets'],
  ['GET', '/measurement-query-sets/qs-1'],
  ['PUT', '/measurement-query-sets/qs-1'],
  ['DELETE', '/measurement-query-sets/qs-1'],
  ['GET', '/measurement-query-templates'],
  ['PUT', '/measurement-query-templates/tpl-1'],
  ['DELETE', '/measurement-query-templates/tpl-1'],
  ['POST', '/measurement-query-templates/tpl-1/apply'],
] as const

const DISCOVERY_ROUTES = [
  ['POST', '/measurement-plan/draft/actions/import-sitemap'],
  ['POST', '/measurement-plan/draft/actions/apply-sitemap-selection'],
] as const

const OVERVIEW_ROUTES = [
  ['GET', '/measurement-overview?scope=all'],
] as const

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-v2-stubs-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'prj_1',
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    country: 'US',
    language: 'en',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)
  return { app, tmpDir }
}

const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
})

it.each([...DRAFT_ROUTES, ...DISCOVERY_ROUTES, ...OVERVIEW_ROUTES])(
  '%s %s is registered and answers 501 until its slice lands',
  async (method, route) => {
    const { app, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: `/api/v1/projects/northstar${route}`,
      ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
    })

    expect(response.statusCode, `${method} ${route} returned ${response.statusCode}`).toBe(501)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } })
    await app.close()
  },
)
