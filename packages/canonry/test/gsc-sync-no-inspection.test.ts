import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { executeGscSync } from '../src/gsc-sync.js'

/**
 * `gsc-sync` must not call the URL Inspection API.
 *
 * Each inspection costs ~7.1s — roughly 6.3s of Google's own latency for a live
 * index lookup, plus the ~1.1s pacing its 1 req/sec soft limit requires — and
 * one unit of a 2000/property/day quota. Doing it inline made the run scale with
 * the site: 240.9s of a 241.9s sync for 31 URLs, while the search-analytics work
 * finished in 1.07s. The dashboard polls this run for 120s, so past ~17 indexed
 * pages every sync timed out and silently showed pre-sync numbers.
 *
 * Coverage is owned by `inspect-sitemap`, which the server chains off a
 * successful sync. This test is the guard: it fails the moment an inspection
 * call is reintroduced here, because the cost is invisible until a site grows.
 */

const GSC_INSPECT_ENDPOINT = 'urlInspection/index:inspect'

function makeDb(project: unknown) {
  const runUpdates: Array<{ status?: string }> = []
  const inserted: unknown[] = []
  const emptyRows = {
    get: () => undefined,
    all: () => [],
    limit: () => ({ get: () => undefined, all: () => [] }),
    orderBy: () => ({ limit: () => ({ get: () => undefined, all: () => [] }), get: () => undefined, all: () => [] }),
  }
  return {
    runUpdates,
    inserted,
    update: () => ({ set: (vals: { status?: string }) => ({ where: () => ({ run: () => { runUpdates.push(vals); return { changes: 1 } } }) }) }),
    // `where()` must also answer the ordered/limited form the coverage writer
    // uses to find the latest site audit.
    select: () => ({
      from: () => ({
        where: () => ({ ...emptyRows, get: () => project }),
        innerJoin: () => ({ where: () => emptyRows }),
      }),
    }),
    // `onConflictDoUpdate` is part of the real drizzle insert builder (the
    // documented pattern for atomic upserts), so the stand-in has to answer it
    // or it lies about the surface it is standing in for.
    insert: () => ({
      values: (v: unknown) => ({
        run: () => { inserted.push(v); return { changes: 1 } },
        onConflictDoUpdate: () => ({ run: () => { inserted.push(v); return { changes: 1 } } }),
      }),
    }),
    delete: () => ({ where: () => ({ run: () => ({ changes: 0 }) }) }),
  }
}

const CONFIG = {
  apiUrl: 'http://localhost:4100',
  database: '/tmp/test.db',
  apiKey: 'cnry_test',
  google: {
    clientId: 'id',
    clientSecret: 'secret',
    connections: [
      { domain: 'example.com', propertyId: 'sc-domain:example.com', refreshToken: 'r', accessToken: 'a', connectionType: 'gsc' },
    ],
  },
}

describe('gsc-sync does not inspect URLs', () => {
  let originalFetch: typeof globalThis.fetch
  let requested: string[]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    requested = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('never calls the URL Inspection endpoint, even with pages that would rank', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)

      if (url.includes('oauth2') || url.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      // searchanalytics — three pages that all earned clicks, i.e. exactly the
      // set the old top-50-by-clicks selection would have inspected.
      return new Response(JSON.stringify({
        rows: [
          { keys: ['q1', 'https://example.com/a', 'US', 'DESKTOP', '2026-08-01'], clicks: 9, impressions: 90, position: 3 },
          { keys: ['q2', 'https://example.com/b', 'US', 'DESKTOP', '2026-08-01'], clicks: 5, impressions: 50, position: 5 },
          { keys: ['q3', 'https://example.com/c', 'US', 'DESKTOP', '2026-08-01'], clicks: 2, impressions: 20, position: 8 },
        ],
      }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const db = makeDb({ id: 'proj-1', canonicalDomain: 'example.com' })
    await executeGscSync(db as never, 'run-1', 'proj-1', { config: CONFIG as never })

    const inspectCalls = requested.filter((u) => u.includes(GSC_INSPECT_ENDPOINT))
    expect(
      inspectCalls,
      'gsc-sync called the URL Inspection API. At ~7.1s and one quota unit per URL ' +
      'this makes the run scale with the site and re-times-out the dashboard. ' +
      'Coverage belongs to inspect-sitemap.',
    ).toEqual([])

    expect(db.runUpdates.some((u) => u.status === 'completed')).toBe(true)
    expect(db.runUpdates.some((u) => u.status === 'failed')).toBe(false)
  })

  it('still fetches the search-analytics data it is responsible for', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('oauth2') || url.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const db = makeDb({ id: 'proj-1', canonicalDomain: 'example.com' })
    await executeGscSync(db as never, 'run-1', 'proj-1', { config: CONFIG as never })

    // Removing inspection must not have removed the work the run exists for:
    // the dimensioned fetch, the property-level daily totals, and the
    // per-query totals are three distinct searchanalytics calls.
    expect(requested.filter((u) => u.includes('searchAnalytics')).length).toBe(3)
    expect(db.runUpdates.some((u) => u.status === 'completed')).toBe(true)
  })

  it('still writes a coverage snapshot, carrying the derived columns', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('oauth2') || url.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({
        rows: [{ keys: ['q1', 'https://example.com/a', 'US', 'DESKTOP', '2026-08-01'], clicks: 9, impressions: 90, position: 3 }],
      }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const db = makeDb({ id: 'proj-1', canonicalDomain: 'example.com' })
    await executeGscSync(db as never, 'run-1', 'proj-1', { config: CONFIG as never })

    const snapshot = db.inserted.find((row) => row && typeof row === 'object' && 'unknownPages' in row)

    // Shape only. `writeCoverageSnapshot` reads impressions back out of
    // gsc_search_data, which this hand-rolled mock cannot represent, so the
    // derived NUMBERS are asserted in gsc-coverage-single-writer.test.ts
    // against a real database — where the two writers can also be run against
    // each other, which is where the interesting bug lived.
    expect(snapshot, 'gsc-sync should still write a coverage snapshot').toBeDefined()
    expect(requested.filter((u) => u.includes(GSC_INSPECT_ENDPOINT))).toEqual([])
  })
})
