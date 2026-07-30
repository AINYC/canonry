import crypto from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { gscPlatformProperties, gscPlatformSearchData, gscPlatformDailyTotals, gscPlatformQueryDailyTotals, projects, runs } from '@ainyc/canonry-db'
import { GscPlatformPropertyStatuses, RunStatuses } from '@ainyc/canonry-contracts'
import { fetchSearchAnalytics, refreshAccessToken, GSC_DATA_LAG_DAYS } from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { saveConfigPatch } from './config.js'

function date(days: number): string {
  const value = new Date()
  value.setDate(value.getDate() - days)
  return value.toISOString().slice(0, 10)
}

export interface GscPlatformSyncOptions {
  days?: number
  full?: boolean
  config: CanonryConfig
}

/** Sync one explicitly-enrolled social/video Search Console property. */
export async function executeGscPlatformSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  sourceId: string,
  opts: GscPlatformSyncOptions,
): Promise<void> {
  let property: typeof gscPlatformProperties.$inferSelect | undefined

  try {
    const run = db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
      .get()
    if (!run) {
      throw new Error('GSC platform sync run not found for this project')
    }
    if (run.sourceId !== sourceId) {
      throw new Error(
        `GSC platform sync source mismatch: run targets "${run.sourceId ?? 'none'}", callback requested "${sourceId}"`,
      )
    }

    db.update(runs)
      .set({
        status: RunStatuses.running,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
      .run()

    property = db
      .select()
      .from(gscPlatformProperties)
      .where(and(
        eq(gscPlatformProperties.id, sourceId),
        eq(gscPlatformProperties.projectId, projectId),
      ))
      .get()
    if (!property) {
      throw new Error('GSC platform property not found for this project')
    }
    const syncedProperty = property

    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const { clientId, clientSecret } = getGoogleAuthConfig(opts.config)
    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth is not configured in the local Canonry config')
    }

    const connection = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!connection?.refreshToken) {
      throw new Error('No GSC connection found or connection is incomplete')
    }

    let accessToken = connection.accessToken!
    if (Date.now() > (connection.tokenExpiresAt ? new Date(connection.tokenExpiresAt).getTime() : 0) - 300_000) {
      const tokens = await refreshAccessToken(clientId, clientSecret, connection.refreshToken)
      accessToken = tokens.access_token
      patchGoogleConnection(opts.config, project.canonicalDomain, 'gsc', {
        accessToken,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      saveConfigPatch(opts.config)
    }

    const endDate = date(GSC_DATA_LAG_DAYS)
    const startDate = date((opts.full ? 480 : (opts.days ?? 30)) + GSC_DATA_LAG_DAYS)
    const [searchRows, dailyRows, queryRows] = await Promise.all([
      fetchSearchAnalytics(accessToken, syncedProperty.siteUrl, { startDate, endDate }),
      fetchSearchAnalytics(accessToken, syncedProperty.siteUrl, {
        startDate,
        endDate,
        dimensions: ['date'],
      }),
      fetchSearchAnalytics(accessToken, syncedProperty.siteUrl, {
        startDate,
        endDate,
        dimensions: ['date', 'query'],
      }),
    ])

    db.transaction((tx) => {
      const range = (
        table:
          | typeof gscPlatformSearchData
          | typeof gscPlatformDailyTotals
          | typeof gscPlatformQueryDailyTotals,
      ) => and(
        eq(table.propertyId, syncedProperty.id),
        eq(table.projectId, projectId),
        sql`${table.date} >= ${startDate}`,
        sql`${table.date} <= ${endDate}`,
      )

      tx.delete(gscPlatformSearchData).where(range(gscPlatformSearchData)).run()
      tx.delete(gscPlatformDailyTotals).where(range(gscPlatformDailyTotals)).run()
      tx.delete(gscPlatformQueryDailyTotals).where(range(gscPlatformQueryDailyTotals)).run()

      const stamp = new Date().toISOString()
      for (const row of searchRows) {
        const [query, page, country, device, rowDate] = row.keys
        tx.insert(gscPlatformSearchData).values({
          id: crypto.randomUUID(),
          propertyId: syncedProperty.id,
          projectId,
          syncRunId: runId,
          date: rowDate ?? '',
          query: query ?? '',
          page: page ?? '',
          country: country ?? null,
          device: device ?? null,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: String(row.ctr),
          position: String(row.position),
          createdAt: stamp,
        }).run()
      }

      for (const row of dailyRows) {
        const [rowDate] = row.keys
        tx.insert(gscPlatformDailyTotals).values({
          id: crypto.randomUUID(),
          propertyId: syncedProperty.id,
          projectId,
          syncRunId: runId,
          date: rowDate ?? '',
          clicks: row.clicks,
          impressions: row.impressions,
          position: String(row.position),
          createdAt: stamp,
        }).run()
      }

      for (const row of queryRows) {
        const [rowDate, query] = row.keys
        if (!rowDate || !query) continue
        tx.insert(gscPlatformQueryDailyTotals).values({
          id: crypto.randomUUID(),
          propertyId: syncedProperty.id,
          projectId,
          syncRunId: runId,
          date: rowDate,
          query,
          clicks: row.clicks,
          impressions: row.impressions,
          position: String(row.position),
          syncedAt: stamp,
          createdAt: stamp,
        }).run()
      }

      tx.update(gscPlatformProperties)
        .set({
          status: GscPlatformPropertyStatuses.active,
          lastSyncedAt: stamp,
          lastError: null,
          updatedAt: stamp,
        })
        .where(and(
          eq(gscPlatformProperties.id, syncedProperty.id),
          eq(gscPlatformProperties.projectId, projectId),
        ))
        .run()
      tx.update(runs)
        .set({ status: RunStatuses.completed, finishedAt: stamp })
        .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
        .run()
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failedAt = new Date().toISOString()
    db.transaction((tx) => {
      if (property) {
        tx.update(gscPlatformProperties)
          .set({
            status: GscPlatformPropertyStatuses.error,
            lastError: message,
            updatedAt: failedAt,
          })
          .where(and(
            eq(gscPlatformProperties.id, property.id),
            eq(gscPlatformProperties.projectId, projectId),
          ))
          .run()
      }
      tx.update(runs)
        .set({
          status: RunStatuses.failed,
          error: message,
          finishedAt: failedAt,
        })
        .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
        .run()
    })
    throw error
  }
}
