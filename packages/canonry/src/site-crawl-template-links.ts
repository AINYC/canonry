import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { siteCrawlEdges } from '@ainyc/canonry-db'
import {
  classifyTemplateLinkEdge,
  createTemplateLinkPairIndex,
  observeTemplateLinkEdges,
  SiteHealthLinkClassificationSources,
  templateLinkDetection,
  templateLinkPlacementAvailable,
  templateLinkUbiquityAvailable,
  type SiteCrawlPlacementOccurrencesDto,
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
  /** Links decided by where they sit in the page rather than by repetition. */
  placementEdgeCount: number
}

/**
 * A link's three placement counts, or null when this scan recorded none.
 *
 * All three columns are written together or not at all, so one NULL means the
 * whole observation is absent. Reading a partial row as zeros would turn "we
 * never looked" into "the page said nothing", and those are different claims.
 */
function placementOccurrencesOf(row: {
  placementNavigationOccurrences: number | null
  placementContentOccurrences: number | null
  placementUnknownOccurrences: number | null
}): SiteCrawlPlacementOccurrencesDto | null {
  const { placementNavigationOccurrences: navigation } = row
  const { placementContentOccurrences: content } = row
  const { placementUnknownOccurrences: unknown } = row
  if (navigation == null || content == null || unknown == null) return null
  return { navigation, content, unknown }
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
      placementNavigationOccurrences: siteCrawlEdges.placementNavigationOccurrences,
      placementContentOccurrences: siteCrawlEdges.placementContentOccurrences,
      placementUnknownOccurrences: siteCrawlEdges.placementUnknownOccurrences,
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
    yield rows.map((row) => ({
      edgeKey: row.edgeKey,
      sourceNodeKey: row.sourceNodeKey,
      targetNodeKey: row.targetNodeKey,
      anchors: row.anchors,
      placementOccurrences: placementOccurrencesOf(row),
    }))
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
 * One UPDATE per distinct written value, so the statement count is bounded by
 * distinct decisions rather than by the link budget. The unit separator keeps
 * the two fields from running together into an ambiguous key.
 */
function writeGroupKey(isTemplate: boolean, templateRatio: number | null): string {
  return `${isTemplate ? '1' : '0'}\u001F${templateRatio ?? ''}`
}

/**
 * Mark one attempt's nav, header, and footer links.
 *
 * Runs after the crawl and BEFORE graph layout, because the layout excludes
 * template links from its physics. Classification itself lives in
 * `@ainyc/canonry-contracts` so the migration backfill, the publish path, and
 * the tests all share one derivation.
 *
 * DOM placement decides every link the crawler recorded a landmark answer for.
 * Ubiquity is the fallback for links the page said nothing about, and for scans
 * captured before the crawler reported placement at all. That ordering is the
 * point of the pass: ubiquity keys on (target URL, anchor text) and therefore
 * cannot see an editorial link whose anchor text matches the nav's.
 *
 * With neither rule available (no placement, and fewer pages than the ubiquity
 * floor) this marks NOTHING and returns `unavailable-too-few-pages`, which the
 * snapshot records: on a five-page site every link looks ubiquitous, and an
 * empty template-link list would read as "this site has no nav" rather than
 * "we could not tell".
 *
 * Idempotent: every link in the attempt is reset before the classified writes,
 * so a retried publish produces the same rows.
 */
export function classifySiteCrawlTemplateLinks(
  db: DatabaseClient,
  scope: SiteCrawlTemplateLinkScope,
  pagesFetched: number,
  placementRulesetVersion: string | null,
): SiteCrawlTemplateLinkResult {
  const scopeFilter = and(
    eq(siteCrawlEdges.projectId, scope.projectId),
    eq(siteCrawlEdges.runId, scope.runId),
    eq(siteCrawlEdges.attemptId, scope.attemptId),
  )
  const placementAvailable = templateLinkPlacementAvailable(placementRulesetVersion)
  const ubiquityAvailable = templateLinkUbiquityAvailable(pagesFetched)

  // What a link keeps when no rule writes over it. With a fallback in force
  // every link gets an answer, so the reset is "classified, not chrome" and a
  // stray NULL would be misread as a scan that was never classified. Without
  // one, a link the DOM stayed silent about genuinely has no answer, so it must
  // keep NULL and stay out of BOTH the content and the template bucket.
  const unwritten = placementAvailable && !ubiquityAvailable ? null : false
  db.update(siteCrawlEdges).set({ isTemplate: unwritten, templateRatio: null }).where(scopeFilter).run()
  if (!placementAvailable && !ubiquityAvailable) {
    return {
      detection: templateLinkDetection({
        placementAvailable,
        ubiquityAvailable,
        usedUbiquityFallback: false,
        leftUnclassified: false,
      }),
      templateEdgeCount: 0,
      placementEdgeCount: 0,
    }
  }

  const index = createTemplateLinkPairIndex()
  if (ubiquityAvailable) {
    // The index measures how often a (target, anchor) pair repeats across the
    // whole scan, so it is built from EVERY link. Leaving placement-decided
    // links out would shrink the denominator of a rule they never enter.
    for (const batch of streamAttemptEdges(db, scope)) observeTemplateLinkEdges(index, batch)
  }

  // Grouped by the exact written value, so the number of UPDATE statements is
  // bounded by distinct decisions rather than by the link budget.
  const edgeKeysByValue = new Map<string, { isTemplate: boolean; templateRatio: number | null; edgeKeys: string[] }>()
  let templateEdgeCount = 0
  let placementEdgeCount = 0
  let usedUbiquityFallback = false
  let leftUnclassified = false
  for (const batch of streamAttemptEdges(db, scope)) {
    for (const edge of batch) {
      const decision = classifyTemplateLinkEdge(edge, { index, pagesFetched, placementAvailable, ubiquityAvailable })
      if (decision.source === SiteHealthLinkClassificationSources.placement) placementEdgeCount += 1
      // Only real evidence counts as a mixed classification. A redirect or
      // canonical edge has no anchor and no placement, so it reaches the
      // fallback and measures nothing; counting it would put every scan in the
      // mixed state and make the distinction worthless.
      if (decision.source === SiteHealthLinkClassificationSources.ubiquity && decision.templateRatio != null) {
        usedUbiquityFallback = true
      }
      if (decision.isTemplate == null) {
        leftUnclassified = true
        continue
      }
      if (decision.isTemplate) templateEdgeCount += 1
      // Nothing to write when the decision already equals the reset value.
      if (decision.isTemplate === unwritten && decision.templateRatio == null) continue
      const key = writeGroupKey(decision.isTemplate, decision.templateRatio)
      const group = edgeKeysByValue.get(key)
      if (group) group.edgeKeys.push(decision.edgeKey)
      else {
        edgeKeysByValue.set(key, {
          isTemplate: decision.isTemplate,
          templateRatio: decision.templateRatio,
          edgeKeys: [decision.edgeKey],
        })
      }
    }
  }

  const now = new Date().toISOString()
  for (const group of edgeKeysByValue.values()) {
    for (const chunk of chunked(group.edgeKeys)) {
      db.update(siteCrawlEdges)
        .set({ isTemplate: group.isTemplate, templateRatio: group.templateRatio, updatedAt: now })
        .where(and(scopeFilter, inArray(siteCrawlEdges.edgeKey, chunk)))
        .run()
    }
  }
  return {
    detection: templateLinkDetection({
      placementAvailable,
      ubiquityAvailable,
      usedUbiquityFallback,
      leftUnclassified,
    }),
    templateEdgeCount,
    placementEdgeCount,
  }
}
