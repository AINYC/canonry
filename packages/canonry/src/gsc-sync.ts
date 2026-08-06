import crypto from 'node:crypto'
import { eq, and, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, gscSearchData, gscDailyTotals, gscQueryDailyTotals, gscUrlInspections, gscCoverageSnapshots } from '@ainyc/canonry-db'
import {
  fetchSearchAnalytics,
  refreshAccessToken,
  GSC_DATA_LAG_DAYS,
} from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from './config.js'
import { saveConfigPatch } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { createLogger } from './logger.js'

const log = createLogger('GscSync')

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]!
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

interface GscSyncOptions {
  days?: number
  full?: boolean
  config: CanonryConfig
}

export async function executeGscSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: GscSyncOptions,
): Promise<void> {
  const now = new Date().toISOString()

  // Mark run as running
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
    if (!googleClientId || !googleClientSecret) {
      throw new Error('Google OAuth is not configured in the local Canonry config')
    }

    // Load the project to get canonicalDomain for domain-scoped connection lookup
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!conn || !conn.refreshToken) {
      throw new Error('No GSC connection found or connection is incomplete')
    }

    if (!conn.propertyId) {
      throw new Error('No GSC property selected. Use "canonry google properties" to list available sites, then set one with the API.')
    }
    const propertyId = conn.propertyId

    // Refresh token if needed
    let accessToken = conn.accessToken!
    const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : 0
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      const tokens = await refreshAccessToken(googleClientId, googleClientSecret, conn.refreshToken)
      accessToken = tokens.access_token
      patchGoogleConnection(opts.config, project.canonicalDomain, 'gsc', {
        accessToken: tokens.access_token,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      saveConfigPatch(opts.config)
    }

    // Determine date range
    const lagOffset = GSC_DATA_LAG_DAYS
    const endDate = formatDate(daysAgo(lagOffset))
    const days = opts.full ? 480 : (opts.days ?? 30) // 480 days ≈ 16 months (GSC max)
    const startDate = formatDate(daysAgo(days + lagOffset))

    // Fetch search analytics with pagination
    log.info('fetch.start', { runId, projectId, propertyId: conn.propertyId, startDate, endDate })
    const rows = await fetchSearchAnalytics(accessToken, conn.propertyId, {
      startDate,
      endDate,
    })

    log.info('fetch.complete', { runId, projectId, rowCount: rows.length })

    // Delete existing rows for this project in the same date range to avoid duplicates on re-sync
    db.delete(gscSearchData)
      .where(
        and(
          eq(gscSearchData.projectId, projectId),
          sql`${gscSearchData.date} >= ${startDate}`,
          sql`${gscSearchData.date} <= ${endDate}`,
        )
      )
      .run()

    // Store rows in batches
    const batchSize = 500
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      const insertNow = new Date().toISOString()

      for (const row of batch) {
        // keys order matches dimensions: query, page, country, device, date
        const [query, page, country, device, date] = row.keys
        db.insert(gscSearchData).values({
          id: crypto.randomUUID(),
          projectId,
          syncRunId: runId,
          date: date ?? '',
          query: query ?? '',
          page: page ?? '',
          country: country ?? null,
          device: device ?? null,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: String(row.ctr),
          position: String(row.position),
          createdAt: insertNow,
        }).run()
      }
    }

    // Property-level daily totals (no query/page dimensions). Summing the
    // dimensioned rows above does NOT equal Google's property total: the `page`
    // dimension over-counts impressions and the dropped anonymized rare queries
    // under-count clicks. Fetch the un-dimensioned daily figure so the headline
    // totals + daily trend match the GSC UI. Shares the main fetch's try block —
    // a failure fails the sync, which is acceptable because the dimensioned data
    // is already persisted and a re-sync recovers the totals.
    const totalRows = await fetchSearchAnalytics(accessToken, propertyId, {
      startDate,
      endDate,
      dimensions: ['date'],
    })

    db.delete(gscDailyTotals)
      .where(
        and(
          eq(gscDailyTotals.projectId, projectId),
          sql`${gscDailyTotals.date} >= ${startDate}`,
          sql`${gscDailyTotals.date} <= ${endDate}`,
        )
      )
      .run()

    const dailyTotalsNow = new Date().toISOString()
    for (const row of totalRows) {
      const [date] = row.keys
      db.insert(gscDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date: date ?? '',
        clicks: row.clicks,
        impressions: row.impressions,
        position: String(row.position),
        createdAt: dailyTotalsNow,
      }).run()
    }

    log.info('daily-totals.complete', { runId, projectId, rowCount: totalRows.length })

    // Per-query daily totals (no `page` dimension). Same reason as above,
    // applied one level down: summing `gsc_search_data` by query multiplies
    // impressions by how many of the site's pages ranked on the same SERP.
    // That error is ~0% for a query with one ranking page and ~500% for
    // brand+category terms where several rank together, so it reorders a
    // top-queries table rather than merely inflating it. Google deduplicates
    // when `page` is absent, and also returns its own per-query `position`.
    const queryTotalRows = await fetchSearchAnalytics(accessToken, propertyId, {
      startDate,
      endDate,
      dimensions: ['date', 'query'],
    })

    db.delete(gscQueryDailyTotals)
      .where(
        and(
          eq(gscQueryDailyTotals.projectId, projectId),
          sql`${gscQueryDailyTotals.date} >= ${startDate}`,
          sql`${gscQueryDailyTotals.date} <= ${endDate}`,
        )
      )
      .run()

    const queryTotalsNow = new Date().toISOString()
    for (const row of queryTotalRows) {
      // keys order matches dimensions: date, query
      const [date, query] = row.keys
      if (!date || !query) continue
      db.insert(gscQueryDailyTotals).values({
        id: crypto.randomUUID(),
        projectId,
        date,
        query,
        clicks: row.clicks,
        impressions: row.impressions,
        position: String(row.position),
        syncedAt: queryTotalsNow,
        syncRunId: runId,
        createdAt: queryTotalsNow,
      }).run()
    }

    log.info('query-totals.complete', { runId, projectId, rowCount: queryTotalRows.length })

    // URL inspection deliberately does NOT happen here.
    //
    // Each call to Google's URL Inspection API costs ~7.1s (≈6.3s of Google's
    // own latency for a live index lookup, plus the ~1.1s pacing the API's
    // 1 req/sec soft limit requires) and one unit of a 2000/property/day quota.
    // Inspecting inline made the run scale with the site: measured at 240.9s of
    // a 241.9s sync for 31 URLs — 99.6% of the run — while the search-analytics
    // work above finished in 1.07s. The dashboard polls this run for 120s, so
    // every sync on a site with more than ~17 indexed pages timed out, silently,
    // and showed pre-sync numbers.
    //
    // Coverage is instead owned by `inspect-sitemap`, which the server already
    // chains off a successful sync via `maybeRefreshGscCoverage`. That walks the
    // whole sitemap rather than the top 50 by clicks, so it is both more complete
    // and no longer duplicated — the two loops previously re-inspected 33 of the
    // same URLs per cycle, spending quota to confirm what search analytics had
    // already reported for free.

    // Record coverage snapshot from all inspections for this project (latest per URL)
    const allInspections = db
      .select()
      .from(gscUrlInspections)
      .where(eq(gscUrlInspections.projectId, projectId))
      .all()

    const latestByUrl = new Map<string, typeof allInspections[number]>()
    for (const row of allInspections) {
      const existing = latestByUrl.get(row.url)
      if (!existing || row.inspectedAt > existing.inspectedAt) {
        latestByUrl.set(row.url, row)
      }
    }

    let snapIndexed = 0
    let snapNotIndexed = 0
    const reasonCounts: Record<string, number> = {}
    for (const [, row] of latestByUrl) {
      if (row.indexingState === 'INDEXING_ALLOWED') {
        snapIndexed++
      } else {
        snapNotIndexed++
        const reason = row.coverageState ?? 'Unknown'
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
      }
    }

    const snapshotDate = formatDate(new Date())
    db.delete(gscCoverageSnapshots)
      .where(and(eq(gscCoverageSnapshots.projectId, projectId), eq(gscCoverageSnapshots.date, snapshotDate)))
      .run()
    db.insert(gscCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: runId,
      date: snapshotDate,
      indexed: snapIndexed,
      notIndexed: snapNotIndexed,
      reasonBreakdown: reasonCounts,
      createdAt: new Date().toISOString(),
    }).run()

    // Mark run as completed
    db.update(runs)
      .set({ status: 'completed', finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.info('sync.completed', { runId, projectId, searchDataRows: rows.length, indexed: snapIndexed, notIndexed: snapNotIndexed })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.error('sync.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
