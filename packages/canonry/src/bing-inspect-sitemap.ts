import crypto from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, bingUrlInspections, bingCoverageSnapshots } from '@ainyc/canonry-db'
import { RunStatuses } from '@ainyc/canonry-contracts'
import { getUrlInfo, getCrawlIssues } from '@ainyc/canonry-integration-bing'
import type { CanonryConfig } from './config.js'
import { fetchAndParseSitemap } from './sitemap-parser.js'
import { inspectUrlsPaced, INSPECT_SWEEP_MAX_URLS, INSPECT_DAILY_QUOTA } from './gsc-inspect-paced.js'
import { isRetryableHttpError } from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('BingInspectSitemap')

interface BingInspectSitemapOptions {
  sitemapUrl?: string
  config: CanonryConfig
}

function parseBingDate(value: string | undefined | null): string | null {
  if (!value) return null
  const match = /\/Date\((-?\d+)(?:[-+]\d+)?\)\//.exec(value)
  if (!match) return null
  const ms = parseInt(match[1]!, 10)
  if (ms <= 0) return null
  return new Date(ms).toISOString()
}

function isBlockingIssueType(issueType: string | null | undefined): boolean {
  if (!issueType) return true
  const trimmed = issueType.trim()
  if (!trimmed) return true
  return trimmed.split(/\s+/).some((flag) => !/^(?:None|Seo(?:Issues|Concerns))$/i.test(flag))
}

export async function executeBingInspectSitemap(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: BingInspectSitemapOptions,
): Promise<void> {
  const startedAt = new Date().toISOString()
  db.update(runs).set({ status: RunStatuses.running, startedAt }).where(eq(runs.id, runId)).run()

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const conn = opts.config.bing?.connections?.find((c) => c.domain === project.canonicalDomain)
    if (!conn) {
      throw new Error('No Bing connection found for this project. Run "canonry bing connect <project>" first.')
    }
    if (!conn.siteUrl) {
      throw new Error('No Bing site configured. Run "canonry bing set-site <project> <url>" first.')
    }

    const sitemapUrl = opts.sitemapUrl ?? `https://${project.canonicalDomain}/sitemap.xml`
    log.info('sitemap.fetch', { runId, projectId, sitemapUrl })

    const sitemapUrls = await fetchAndParseSitemap(sitemapUrl)
    log.info('sitemap.parsed', { runId, projectId, urlCount: sitemapUrls.length, sitemapUrl })

    if (sitemapUrls.length === 0) {
      throw new Error('No URLs found in sitemap')
    }

    // Diff vs already-tracked URLs so the log clearly distinguishes new
    // discoveries from re-inspections of the existing tracked set.
    const trackedRows = db
      .select({ url: bingUrlInspections.url })
      .from(bingUrlInspections)
      .where(eq(bingUrlInspections.projectId, projectId))
      .all()
    const trackedUrls = new Set(trackedRows.map((r) => r.url))
    const discovered = sitemapUrls.filter((u) => !trackedUrls.has(u))
    log.info('sitemap.diff', {
      runId,
      projectId,
      sitemapTotal: sitemapUrls.length,
      alreadyTracked: sitemapUrls.length - discovered.length,
      newlyDiscovered: discovered.length,
    })

    // Fetch the blocking-crawl-issues set once so each URL's derivation can
    // honor it without N extra HTTP calls. Failure here must not block the
    // whole inspection — fall back to "no blocked URLs".
    let blockedUrls = new Set<string>()
    try {
      const issues = await getCrawlIssues(conn.apiKey, conn.siteUrl)
      for (const issue of issues) {
        if (issue.Url && isBlockingIssueType(issue.IssueType ?? null)) {
          blockedUrls.add(issue.Url)
        }
      }
      log.info('crawl-issues.loaded', { runId, projectId, blockedCount: blockedUrls.size })
    } catch (err) {
      log.warn('crawl-issues.lookup-failed', {
        runId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      })
      blockedUrls = new Set()
    }

    // Same budget guard as the GSC sweep: a sitemap larger than the daily
    // allowance cannot finish, and grinding into the wall surfaces as a failure
    // rather than as "the quota ran out".
    const skipped = Math.max(0, sitemapUrls.length - INSPECT_SWEEP_MAX_URLS)
    const targetUrls = skipped > 0 ? sitemapUrls.slice(0, INSPECT_SWEEP_MAX_URLS) : sitemapUrls
    if (skipped > 0) {
      log.warn('sitemap.over-budget', {
        runId,
        projectId,
        sitemapUrls: sitemapUrls.length,
        inspecting: targetUrls.length,
        skipped,
        dailyQuota: INSPECT_DAILY_QUOTA,
        note: `Sitemap has ${sitemapUrls.length} pages; inspecting the first ${targetUrls.length}. ${skipped} pages will not have a verdict from this run.`,
      })
    }

    // Narrowed once here — the guard above proves it, but TypeScript cannot
    // carry that through the callback closure below.
    const siteUrl = conn.siteUrl

    let inspected = 0
    let errors = 0

    // Paced through the shared driver rather than a bare setTimeout loop: it
    // adds jitter (so two overlapping sweeps don't phase-lock), per-URL retry,
    // and a consecutive-failure circuit breaker. Without the breaker a wholly
    // throttled property grinds the entire sitemap against a wall, spending the
    // daily allowance to produce nothing.
    //
    // The retry predicate is Bing's, not the GSC default: Bing reports a
    // throttle as `400` with `ErrorCode 5`, which the GSC predicate does not
    // recognise — so the breaker would never trip and every failure would look
    // permanent.
    const outcome = await inspectUrlsPaced(
      targetUrls,
      {
        inspectOne: (pageUrl) => getUrlInfo(conn.apiKey, siteUrl, pageUrl),
        onResult: (pageUrl, result) => {
          const inspectedAt = new Date().toISOString()
          const httpCode = result.HttpStatus ?? result.HttpCode ?? null
          const lastCrawledDate = parseBingDate(result.LastCrawledDate)
          const inIndexDate = parseBingDate(result.InIndexDate)
          const discoveryDate = parseBingDate(result.DiscoveryDate)

          // Mirrors the derivation in packages/api-routes/src/bing.ts inspect-url:
          // GetUrlInfo no longer ships an InIndex flag, so DocumentSize and a
          // recent successful crawl are the positive signals.
          let derivedInIndex: boolean | null = null
          if (result.DocumentSize != null && result.DocumentSize > 0) {
            derivedInIndex = true
          } else if (lastCrawledDate != null) {
            derivedInIndex = httpCode != null && httpCode >= 400 ? false : true
          } else if (discoveryDate != null) {
            derivedInIndex = false
          }
          if (derivedInIndex === true && blockedUrls.has(pageUrl)) {
            derivedInIndex = false
          }

          db.insert(bingUrlInspections).values({
            id: crypto.randomUUID(),
            projectId,
            url: pageUrl,
            httpCode,
            inIndex: derivedInIndex,
            lastCrawledDate,
            inIndexDate,
            inspectedAt,
            syncRunId: runId,
            createdAt: inspectedAt,
            documentSize: result.DocumentSize ?? null,
            anchorCount: result.AnchorCount ?? null,
            discoveryDate,
          }).run()

          inspected++
          log.info('inspect.url-done', { runId, projectId, url: pageUrl, progress: `${inspected}/${targetUrls.length}` })
        },
        onError: (pageUrl, err) => {
          errors++
          log.error('inspect.url-failed', {
            runId,
            projectId,
            url: pageUrl,
            error: err instanceof Error ? err.message : String(err),
          })
        },
      },
      { isRetryable: isRetryableHttpError, concurrency: 1, log },
    )

    if (outcome.aborted) {
      log.error('inspect.circuit-break', {
        runId,
        projectId,
        inspected,
        errors,
        note: 'Bing inspection stopped early after sustained failures; the remaining pages were not attempted.',
      })
    }

    // Coverage snapshot — pick the latest definitive (non-null) inspection per
    // URL across all history, mirroring the GET /bing/coverage logic so the
    // snapshot row matches what users see in the dashboard.
    const allInspections = db
      .select()
      .from(bingUrlInspections)
      .where(eq(bingUrlInspections.projectId, projectId))
      .orderBy(desc(bingUrlInspections.inspectedAt))
      .all()

    const latestByUrl = new Map<string, typeof allInspections[number]>()
    const definitiveByUrl = new Map<string, typeof allInspections[number]>()
    for (const row of allInspections) {
      if (!latestByUrl.has(row.url)) latestByUrl.set(row.url, row)
      if (!definitiveByUrl.has(row.url) && row.inIndex != null) definitiveByUrl.set(row.url, row)
    }
    for (const [url, latest] of latestByUrl) {
      if (latest.inIndex == null) {
        const def = definitiveByUrl.get(url)
        if (def) latestByUrl.set(url, def)
      }
    }

    let snapIndexed = 0
    let snapNotIndexed = 0
    let snapUnknown = 0
    for (const [, row] of latestByUrl) {
      if (row.inIndex === true) snapIndexed++
      else if (row.inIndex === false) snapNotIndexed++
      else snapUnknown++
    }

    const snapshotDate = new Date().toISOString().split('T')[0]!
    const snapNow = new Date().toISOString()
    db.insert(bingCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: runId,
      date: snapshotDate,
      indexed: snapIndexed,
      notIndexed: snapNotIndexed,
      unknown: snapUnknown,
      createdAt: snapNow,
    }).onConflictDoUpdate({
      target: [bingCoverageSnapshots.projectId, bingCoverageSnapshots.date],
      set: {
        indexed: snapIndexed,
        notIndexed: snapNotIndexed,
        unknown: snapUnknown,
        createdAt: snapNow,
        syncRunId: runId,
      },
    }).run()

    const status: typeof RunStatuses[keyof typeof RunStatuses] =
      errors === sitemapUrls.length
        ? RunStatuses.failed
        : errors > 0
          ? RunStatuses.partial
          : RunStatuses.completed

    db.update(runs)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.info('inspect.completed', {
      runId,
      projectId,
      inspected,
      errors,
      total: sitemapUrls.length,
      newlyDiscovered: discovered.length,
      indexed: snapIndexed,
      notIndexed: snapNotIndexed,
      unknown: snapUnknown,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: RunStatuses.failed, error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.error('inspect.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
