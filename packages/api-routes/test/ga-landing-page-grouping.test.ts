import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, gaTrafficSnapshots, gaAiReferrals } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialStore, Ga4CredentialRecord } from '../src/ga.js'

/**
 * GA4 has two spellings for "this session had no landing page": the literal
 * string `(not set)` and an empty string. `normalizeUrlPath` maps both to NULL,
 * but the read grouped by `COALESCE(normalized, raw)`, and that fallback fired
 * on exactly the rows normalization had emptied — so the two sentinels came
 * back as two separate rows for one condition.
 *
 * The values seeded here are the shapes observed in a production database:
 * `(not set)` present since March, an empty string that first appeared on a
 * single later date across several projects at once, and a trailing-paren path
 * from a markdown link whose closing bracket was swallowed into the href.
 */

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-landing-group-test-'))
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

describe('GA landing-page grouping', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let credentials: Map<string, Ga4CredentialRecord>
  let projectId: string
  const now = new Date().toISOString()

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    credentials = ctx.credentials
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/lp-group',
      payload: { displayName: 'LP Group', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    projectId = JSON.parse(res.payload).id

    credentials.set('lp-group', {
      projectName: 'lp-group',
      propertyId: '999888',
      clientEmail: 'sa@test.iam.gserviceaccount.com',
      privateKey: 'fake-key',
      createdAt: now,
      updatedAt: now,
    })

    const snapshot = (
      date: string,
      landingPage: string,
      landingPageNormalized: string | null,
      sessions: number,
      organicSessions: number,
    ) => {
      db.insert(gaTrafficSnapshots).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        landingPage,
        landingPageNormalized,
        sessions,
        organicSessions,
        users: sessions,
        syncedAt: now,
      }).run()
    }

    // A real page, split across two dates.
    snapshot('2026-08-01', '/aeo-methodology', '/aeo-methodology', 11, 7)
    snapshot('2026-08-02', '/aeo-methodology', '/aeo-methodology', 31, 4)
    // The markdown-link variant. Normalization already folds it.
    snapshot('2026-08-01', '/aeo-methodology)', '/aeo-methodology', 5, 0)
    // GA4's two spellings of "unattributed", both normalized away. Both columns
    // are NOT NULL, so the sentinel always arrives as one of these strings.
    snapshot('2026-08-01', '(not set)', null, 57, 15)
    snapshot('2026-08-04', '', null, 9, 0)
    // Whitespace is the same condition wearing a third coat.
    snapshot('2026-08-04', '   ', null, 3, 1)
    // A legacy row written before the normalizer ran: raw is the best we have.
    snapshot('2026-08-03', '/managed', null, 38, 1)
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function topPages() {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/lp-group/ga/traffic' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { topPages: Array<{ landingPage: string; sessions: number; organicSessions: number }> }
    return body.topPages
  }

  it('reports one unattributed row, not one per GA4 sentinel spelling', async () => {
    const pages = await topPages()
    const unattributed = pages.filter((p) => p.landingPage === '(not set)')

    expect(unattributed).toHaveLength(1)
    // 57 from "(not set)" + 9 from "" + 3 from whitespace.
    expect(unattributed[0]!.sessions).toBe(69)
    expect(unattributed[0]!.organicSessions).toBe(16)

    // The empty string must not survive as its own label.
    expect(pages.map((p) => p.landingPage)).not.toContain('')
  })

  it('folds the trailing-paren variant into the real page', async () => {
    const pages = await topPages()
    const methodology = pages.filter((p) => p.landingPage === '/aeo-methodology')

    expect(methodology).toHaveLength(1)
    // 11 + 31 from the clean rows, 5 from "/aeo-methodology)".
    expect(methodology[0]!.sessions).toBe(47)
    expect(methodology[0]!.organicSessions).toBe(11)
    expect(pages.map((p) => p.landingPage)).not.toContain('/aeo-methodology)')
  })

  it('still falls back to the raw path for a row the normalizer never touched', async () => {
    const pages = await topPages()
    const managed = pages.find((p) => p.landingPage === '/managed')

    // The fallback is the whole reason COALESCE is there; blanking the
    // sentinels must not cost us the partially-backfilled case.
    expect(managed).toBeDefined()
    expect(managed!.sessions).toBe(38)
  })

  it('conserves every seeded session across the grouping', async () => {
    const pages = await topPages()
    const seeded = 11 + 31 + 5 + 57 + 9 + 3 + 38

    expect(seeded).toBe(154)
    expect(pages.reduce((sum, p) => sum + p.sessions, 0)).toBe(seeded)
    // /aeo-methodology, (not set), /managed — seven stored rows, three pages.
    expect(pages).toHaveLength(3)
  })

  it('applies the same grouping to /ga/coverage', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/lp-group/ga/coverage' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { pages: Array<{ landingPage: string; sessions: number }> }

    expect(body.pages.filter((p) => p.landingPage === '(not set)')).toHaveLength(1)
    expect(body.pages.find((p) => p.landingPage === '(not set)')!.sessions).toBe(69)
    expect(body.pages.map((p) => p.landingPage)).not.toContain('')
  })

  it('applies the same grouping to AI referral landing pages', async () => {
    const referral = (landingPage: string | null, landingPageNormalized: string | null, sessions: number) => {
      db.insert(gaAiReferrals).values({
        id: crypto.randomUUID(),
        projectId,
        date: '2026-08-01',
        source: 'chatgpt.com',
        medium: 'referral',
        sourceDimension: 'session',
        channelGroup: 'Referral',
        trafficClass: 'organic',
        landingPage,
        landingPageNormalized,
        sessions,
        users: sessions,
        syncedAt: now,
      }).run()
    }
    referral('(not set)', null, 4)
    referral('', null, 2)

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/lp-group/ga/ai-referral-history' })
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.payload) as Array<{ landingPage: string; sessions: number }>
    const unattributed = rows.filter((r) => r.landingPage === '(not set)')

    expect(unattributed).toHaveLength(1)
    expect(unattributed[0]!.sessions).toBe(6)
    expect(rows.map((r) => r.landingPage)).not.toContain('')
  })
})
