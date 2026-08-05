import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, gaTrafficSnapshots, siteAuditPages, siteAuditSnapshots, runs } from '@ainyc/canonry-db'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialStore, Ga4CredentialRecord } from '../src/ga.js'

/**
 * One page's sessions split across four spellings of its own path, which is
 * what a production table looked like: `/aeo-methodology` alongside
 * `/aeo-met`, `/aeo-meth` and `/aeo-methodolo`, each holding a slice.
 *
 * The fold is only safe because the site audit says which paths exist, so
 * these tests also pin the no-audit and ambiguous cases where it must not act.
 */

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-fold-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const credentials: Map<string, Ga4CredentialRecord> = new Map()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: (projectName: string) => credentials.get(projectName),
    upsertConnection: (connection: Ga4CredentialRecord) => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: (projectName: string) => credentials.delete(projectName),
  }

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ga4CredentialStore })
  return { app, db, tmpDir, credentials }
}

describe('GA truncated landing-path fold', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let credentials: Map<string, Ga4CredentialRecord>
  let projectId: string
  const now = new Date().toISOString()

  const snapshot = (landingPage: string, sessions: number, organicSessions: number) => {
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-08-01',
      landingPage,
      landingPageNormalized: landingPage,
      sessions,
      organicSessions,
      users: sessions,
      syncedAt: now,
    }).run()
  }

  /** Record a site audit that crawled `urls`, which is the only page authority. */
  const seedAudit = (urls: string[]) => {
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: RunKinds['site-audit'],
      status: RunStatuses.completed,
      trigger: RunTriggers.manual,
      startedAt: now,
      createdAt: now,
    }).run()
    db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      runId,
      sitemapUrl: 'https://example.com/sitemap.xml',
      auditedAt: now,
      createdAt: now,
    }).run()
    for (const url of urls) {
      db.insert(siteAuditPages).values({
        id: crypto.randomUUID(),
        projectId,
        runId,
        url,
        status: 'success',
        createdAt: now,
      }).run()
    }
    return runId
  }

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    credentials = ctx.credentials
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/fold-test',
      payload: { displayName: 'Fold Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    projectId = JSON.parse(res.payload).id

    credentials.set('fold-test', {
      projectName: 'fold-test',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    snapshot('/aeo-methodology', 42, 11)
    snapshot('/aeo-met', 9, 2)
    snapshot('/aeo-meth', 5, 1)
    snapshot('/aeo-methodolo', 7, 4)
    // A real page that prefixes nothing, and a section root that prefixes a post.
    snapshot('/managed', 38, 1)
    snapshot('/blog', 20, 3)
    snapshot('/blog/ai-visibility-tools-are-lying', 76, 0)
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function topPages(query = '') {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/fold-test/ga/traffic${query}` })
    expect(res.statusCode).toBe(200)
    return (JSON.parse(res.payload) as {
      topPages: Array<{ landingPage: string; sessions: number; organicSessions: number }>
    }).topPages
  }

  it('leaves every path alone when the project has never been audited', async () => {
    const pages = await topPages()
    expect(pages.map((p) => p.landingPage).sort()).toEqual([
      '/aeo-met', '/aeo-meth', '/aeo-methodolo', '/aeo-methodology', '/blog', '/blog/ai-visibility-tools-are-lying', '/managed',
    ])
    expect(pages.find((p) => p.landingPage === '/aeo-methodology')!.sessions).toBe(42)
  })

  it('still honours the limit when there is no page list to fold against', async () => {
    // With no audit nothing can fold, so the query is bounded in SQL rather
    // than pulling every grouped row to throw most of them away. The largest
    // project on a live instance has 3,164 distinct landing paths.
    const pages = await topPages('?limit=2')
    expect(pages).toHaveLength(2)
    expect(pages[0]!.landingPage).toBe('/blog/ai-visibility-tools-are-lying')
  })

  it('folds the truncated spellings once an audit says which pages exist', async () => {
    seedAudit([
      'https://example.com/aeo-methodology',
      'https://example.com/managed',
      'https://example.com/blog',
      'https://example.com/blog/ai-visibility-tools-are-lying',
    ])

    const pages = await topPages()
    const methodology = pages.filter((p) => p.landingPage === '/aeo-methodology')

    expect(methodology).toHaveLength(1)
    // 42 + 9 + 5 + 7.
    expect(methodology[0]!.sessions).toBe(63)
    expect(methodology[0]!.organicSessions).toBe(18)

    const labels = pages.map((p) => p.landingPage)
    expect(labels).not.toContain('/aeo-met')
    expect(labels).not.toContain('/aeo-meth')
    expect(labels).not.toContain('/aeo-methodolo')
  })

  it('never folds a real page into one it merely prefixes', async () => {
    const pages = await topPages()
    const blog = pages.find((p) => p.landingPage === '/blog')

    // `/blog` prefixes the post and would be ambiguous on string alone, but it
    // is a page in its own right and keeps its own sessions.
    expect(blog).toBeDefined()
    expect(blog!.sessions).toBe(20)
    expect(pages.find((p) => p.landingPage === '/blog/ai-visibility-tools-are-lying')!.sessions).toBe(76)
  })

  it('conserves total sessions across the fold', async () => {
    const pages = await topPages()
    expect(pages.reduce((sum, p) => sum + p.sessions, 0)).toBe(42 + 9 + 5 + 7 + 38 + 20 + 76)
    expect(pages).toHaveLength(4)
  })

  it('folds before applying the limit, so a fragment below the cut is not lost', async () => {
    // limit=1 keeps only the top row. The fragments are far below it; if the
    // limit ran first in SQL they would be cut before they could be merged.
    const pages = await topPages('?limit=1')
    expect(pages).toHaveLength(1)
    expect(pages[0]!.landingPage).toBe('/blog/ai-visibility-tools-are-lying')

    // And the merged page outranks what it would have without its fragments.
    const top2 = await topPages('?limit=2')
    expect(top2[1]!.landingPage).toBe('/aeo-methodology')
    expect(top2[1]!.sessions).toBe(63)
  })

  it('applies the same fold to /ga/coverage', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/fold-test/ga/coverage' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { pages: Array<{ landingPage: string; sessions: number }> }

    expect(body.pages.find((p) => p.landingPage === '/aeo-methodology')!.sessions).toBe(63)
    expect(body.pages.map((p) => p.landingPage)).not.toContain('/aeo-met')
  })
})
