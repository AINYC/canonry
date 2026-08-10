import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { siteCrawlEdges } from '@ainyc/canonry-db'
import {
  createTemplateLinkPairIndex,
  isTemplateLinkRatio,
  observeTemplateLinkEdges,
  SiteHealthTemplateDetections,
  templateLinkDetection,
  templateLinkRatio,
  type SiteHealthTemplateDetectionOutcome,
  type TemplateLinkEdgeInput,
} from '@ainyc/canonry-contracts'

/**
 * Links are read and written in bounded batches. The crawl budget reaches one
 * million links, and neither pass may hold them all: the pair index is bounded
 * by DISTINCT (target, anchor) pairs, which is low hundreds on a real site.
 */
const TEMPLATE_LINK_READ_BATCH = 2_000
/** SQLite caps bound parameters; this stays well inside the default limit. */
const TEMPLATE_LINK_WRITE_BATCH = 500

export interface SiteCrawlTemplateLinkScope {
  projectId: string
  runId: string
  attemptId: string
}

export interface SiteCrawlTemplateLinkResult {
  detection: SiteHealthTemplateDetectionOutcome
  /** Links classified as nav, header, or footer chrome for this attempt. */
  templateEdgeCount: number
}

/**
 * Keyset (not OFFSET) paging over `edge_key`, so the unique
 * `(project, run, attempt, edge_key)` index seeks straight to each batch
 * instead of re-walking every prior row at the maximum crawl budget.
 */
function* streamAttemptEdges(
  db: DatabaseClient,
  scope: SiteCrawlTemplateLinkScope,
): Generator<TemplateLinkEdgeInput[]> {
  let after = ''
  for (;;) {
    const rows = db.select({
      edgeKey: siteCrawlEdges.edgeKey,
      sourceNodeKey: siteCrawlEdges.sourceNodeKey,
      targetNodeKey: siteCrawlEdges.targetNodeKey,
      anchors: siteCrawlEdges.anchors,
    }).from(siteCrawlEdges)
      .where(and(
        eq(siteCrawlEdges.projectId, scope.projectId),
        eq(siteCrawlEdges.runId, scope.runId),
        eq(siteCrawlEdges.attemptId, scope.attemptId),
        gt(siteCrawlEdges.edgeKey, after),
      ))
      .orderBy(asc(siteCrawlEdges.edgeKey))
      .limit(TEMPLATE_LINK_READ_BATCH)
      .all()
    if (rows.length === 0) return
    yield rows
    after = rows[rows.length - 1]!.edgeKey
    if (rows.length < TEMPLATE_LINK_READ_BATCH) return
  }
}

function* chunked<T>(values: readonly T[], size = TEMPLATE_LINK_WRITE_BATCH): Generator<T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size)
  }
}

/**
 * Mark one attempt's nav, header, and footer links.
 *
 * Runs after the crawl and BEFORE graph layout, because the layout excludes
 * template links from its physics. Classification itself lives in
 * `@ainyc/canonry-contracts` so the migration backfill, the publish path, and
 * the tests all share one derivation.
 *
 * Below the page floor this marks NOTHING and returns
 * `unavailable-too-few-pages`, which the snapshot records: on a five-page site
 * every link looks ubiquitous, and an empty template-link list would read as
 * "this site has no nav" rather than "we could not tell".
 *
 * Idempotent: every link in the attempt is reset before the classified writes,
 * so a retried publish produces the same rows.
 */
export function classifySiteCrawlTemplateLinks(
  db: DatabaseClient,
  scope: SiteCrawlTemplateLinkScope,
  pagesFetched: number,
): SiteCrawlTemplateLinkResult {
  const scopeFilter = and(
    eq(siteCrawlEdges.projectId, scope.projectId),
    eq(siteCrawlEdges.runId, scope.runId),
    eq(siteCrawlEdges.attemptId, scope.attemptId),
  )
  const detection = templateLinkDetection(pagesFetched)

  // Start from "classified, not a template link". A NULL left behind here
  // would be read as a scan whose links were never classified at all.
  db.update(siteCrawlEdges).set({ isTemplate: false, templateRatio: null }).where(scopeFilter).run()
  if (detection !== SiteHealthTemplateDetections.applied) {
    return { detection, templateEdgeCount: 0 }
  }

  const index = createTemplateLinkPairIndex()
  for (const batch of streamAttemptEdges(db, scope)) observeTemplateLinkEdges(index, batch)

  // Grouped by the exact ratio, so the number of UPDATE statements is bounded
  // by distinct source-page counts rather than by the link budget.
  const edgeKeysByRatio = new Map<number, string[]>()
  let templateEdgeCount = 0
  for (const batch of streamAttemptEdges(db, scope)) {
    for (const edge of batch) {
      const ratio = templateLinkRatio(index, pagesFetched, edge)
      if (ratio == null) continue
      const group = edgeKeysByRatio.get(ratio)
      if (group) group.push(edge.edgeKey)
      else edgeKeysByRatio.set(ratio, [edge.edgeKey])
      if (isTemplateLinkRatio(ratio)) templateEdgeCount += 1
    }
  }

  const now = new Date().toISOString()
  for (const [ratio, edgeKeys] of edgeKeysByRatio) {
    const isTemplate = isTemplateLinkRatio(ratio)
    for (const chunk of chunked(edgeKeys)) {
      db.update(siteCrawlEdges)
        .set({ isTemplate, templateRatio: ratio, updatedAt: now })
        .where(and(scopeFilter, inArray(siteCrawlEdges.edgeKey, chunk)))
        .run()
    }
  }
  return { detection, templateEdgeCount }
}
