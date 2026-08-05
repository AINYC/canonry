import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, gscUrlInspections } from '@ainyc/canonry-db'
import {
  inspectUrl,
  refreshAccessToken,
} from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from './config.js'
import { saveConfigPatch } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { fetchAndParseSitemap } from './sitemap-parser.js'
import { writeCoverageSnapshot } from './gsc-coverage-snapshot.js'
import { createLogger } from './logger.js'
import { inspectUrlsPaced, INSPECT_FAILFAST_THRESHOLD } from './gsc-inspect-paced.js'

const log = createLogger('InspectSitemap')

interface InspectSitemapOptions {
  sitemapUrl?: string
  config: CanonryConfig
}

export async function executeInspectSitemap(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: InspectSitemapOptions,
): Promise<void> {
  const now = new Date().toISOString()

  // Mark run as running
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
    if (!googleClientId || !googleClientSecret) {
      throw new Error('Google OAuth is not configured in the local Canonry config')
    }

    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!conn || !conn.refreshToken) {
      throw new Error('No GSC connection found or connection is incomplete')
    }

    if (!conn.propertyId) {
      throw new Error('No GSC property selected. Use "canonry google properties" to list available sites, then set one.')
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

    // Determine sitemap URL: explicit > stored on connection > default
    const sitemapUrl = opts.sitemapUrl || conn.sitemapUrl || `https://${project.canonicalDomain}/sitemap.xml`
    log.info('sitemap.fetch', { runId, projectId, sitemapUrl })

    const urls = await fetchAndParseSitemap(sitemapUrl)
    log.info('sitemap.parsed', { runId, projectId, urlCount: urls.length, sitemapUrl })

    if (urls.length === 0) {
      throw new Error('No URLs found in sitemap')
    }

    const { inspected, errors, aborted, abortError } = await inspectUrlsPaced(
      urls,
      {
        inspectOne: (pageUrl) => inspectUrl(accessToken, pageUrl, propertyId),
        onResult: (pageUrl, result, index) => {
          const ir = result.inspectionResult
          const idx = ir.indexStatusResult
          const mob = ir.mobileUsabilityResult
          const rich = ir.richResultsResult
          const inspectedAt = new Date().toISOString()

          db.insert(gscUrlInspections).values({
            id: crypto.randomUUID(),
            projectId,
            syncRunId: runId,
            url: pageUrl,
            indexingState: idx?.indexingState ?? null,
            verdict: idx?.verdict ?? null,
            coverageState: idx?.coverageState ?? null,
            pageFetchState: idx?.pageFetchState ?? null,
            robotsTxtState: idx?.robotsTxtState ?? null,
            crawlTime: idx?.lastCrawlTime ?? null,
            lastCrawlResult: idx?.crawlResult ?? null,
            isMobileFriendly: mob?.verdict === 'PASS' ? true : mob?.verdict === 'FAIL' ? false : null,
            richResults: rich?.detectedItems?.map((d) => d.richResultType) ?? [],
            referringUrls: idx?.referringUrls ?? [],
            inspectedAt,
            createdAt: inspectedAt,
          }).run()

          log.info('inspect.url-done', { runId, projectId, url: pageUrl, progress: `${index + 1}/${urls.length}` })
        },
        onError: (pageUrl, err) => {
          log.error('inspect.url-failed', { runId, projectId, url: pageUrl, error: err instanceof Error ? err.message : String(err) })
        },
      },
      {
        log: {
          info: (action, ctx) => log.info(action, { runId, projectId, ...ctx }),
          error: (action, ctx) => log.error(action, { runId, projectId, ...ctx }),
        },
      },
    )

    if (aborted) {
      const detail = abortError instanceof Error ? abortError.message : String(abortError)
      throw new Error(
        `URL inspection aborted after ${INSPECT_FAILFAST_THRESHOLD} consecutive rate/access failures (likely GSC URL Inspection quota exhaustion or property access loss). Last error: ${detail}`,
      )
    }

    // Record coverage snapshot
    // Single writer — see gsc-coverage-snapshot.ts. This run chains off
    // gsc-sync and rewrites the same (project, date) row, so computing coverage
    // independently here silently overwrote what gsc-sync derived and reset the
    // provenance columns to their defaults.
    const coverage = writeCoverageSnapshot(db, projectId, runId)
    const snapIndexed = coverage.indexed
    const snapNotIndexed = coverage.notIndexed

    // Mark run as completed (or partial if some failed)
    const status = errors > 0 && inspected > 0 ? 'partial' : errors === urls.length ? 'failed' : 'completed'
    db.update(runs)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.info('inspect.completed', { runId, projectId, inspected, errors, total: urls.length, indexed: snapIndexed, notIndexed: snapNotIndexed })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.error('inspect.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
