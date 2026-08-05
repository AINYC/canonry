import crypto from 'node:crypto'
import { and, eq, gte } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { gscCoverageSnapshots, gscSearchData, gscUrlInspections } from '@ainyc/canonry-db'
import { deriveIndexCoverage } from '@ainyc/canonry-contracts'

/**
 * The ONE place a GSC index-coverage snapshot is written.
 *
 * Two runs produce coverage — `gsc-sync` and `inspect-sitemap` — and the server
 * chains the second off the first, both writing the same `(project, date)` row
 * with a delete-then-insert. When they computed it independently they drifted:
 * `gsc-sync` derived coverage across the whole property while `inspect-sitemap`
 * counted inspections alone, so the chained run silently overwrote the derived
 * figures minutes after they were written and reset the provenance columns to
 * their defaults. Same row, two meanings, last writer wins.
 *
 * Routing both through here removes the class of bug rather than the instance.
 * Callers supply only the run id; every input is read from the database, so
 * neither caller can pass a different view of the same facts.
 */

/** How far back to look for impressions when deciding a page is indexed. */
export const COVERAGE_IMPRESSION_WINDOW_DAYS = 30

export interface CoverageSnapshotResult {
  indexed: number
  notIndexed: number
  unknown: number
  verifiedByInspection: number
  derivedFromImpressions: number
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().split('T')[0]!
}

/**
 * Recompute and persist today's coverage snapshot for a project.
 *
 * Impressions come from the stored search-analytics rows rather than from the
 * caller: `inspect-sitemap` never fetches analytics, and reading both signals
 * from the same place is what keeps the two writers in agreement.
 */
export function writeCoverageSnapshot(
  db: DatabaseClient,
  projectId: string,
  runId: string,
  opts: { windowDays?: number; now?: Date } = {},
): CoverageSnapshotResult {
  const windowDays = opts.windowDays ?? COVERAGE_IMPRESSION_WINDOW_DAYS
  const since = isoDaysAgo(windowDays)

  const pageRows = db
    .select({ page: gscSearchData.page, impressions: gscSearchData.impressions })
    .from(gscSearchData)
    .where(and(eq(gscSearchData.projectId, projectId), gte(gscSearchData.date, since)))
    .all()

  const allInspections = db
    .select()
    .from(gscUrlInspections)
    .where(eq(gscUrlInspections.projectId, projectId))
    .all()

  // Latest verdict per URL — the table keeps history.
  const latestByUrl = new Map<string, typeof allInspections[number]>()
  for (const row of allInspections) {
    const existing = latestByUrl.get(row.url)
    if (!existing || row.inspectedAt > existing.inspectedAt) latestByUrl.set(row.url, row)
  }

  const coverage = deriveIndexCoverage({
    pages: pageRows.map((r) => ({ page: r.page, impressions: r.impressions })),
    inspections: [...latestByUrl.values()].map((r) => ({
      url: r.url,
      indexingState: r.indexingState,
      coverageState: r.coverageState,
    })),
  })

  const now = opts.now ?? new Date()
  const snapshotDate = now.toISOString().split('T')[0]!

  db.delete(gscCoverageSnapshots)
    .where(and(eq(gscCoverageSnapshots.projectId, projectId), eq(gscCoverageSnapshots.date, snapshotDate)))
    .run()

  db.insert(gscCoverageSnapshots).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: runId,
    date: snapshotDate,
    indexed: coverage.indexed,
    notIndexed: coverage.notIndexed,
    unknownPages: coverage.unknown,
    verifiedByInspection: coverage.verifiedByInspection,
    derivedFromImpressions: coverage.derivedFromImpressions,
    reasonBreakdown: coverage.reasonBreakdown,
    createdAt: now.toISOString(),
  }).run()

  return {
    indexed: coverage.indexed,
    notIndexed: coverage.notIndexed,
    unknown: coverage.unknown,
    verifiedByInspection: coverage.verifiedByInspection,
    derivedFromImpressions: coverage.derivedFromImpressions,
  }
}
