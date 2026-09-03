/**
 * The shape of this val's Technical AEO sample.
 *
 * It is a PRODUCT schema, not a kit contract: it names five pages, a link
 * graph, and a factor scorecard, none of which another val's check would
 * produce. `@canonry/val-kit` stores it opaquely as the `TResult` of a
 * `CheckRecord`, so what it contains is decided here and nowhere else — see
 * `../runtime/check-result.ts` for the record it hangs on, and bump
 * `CHECK_FINGERPRINT_NAMESPACE` when a change to these types adds or removes a
 * measured signal.
 */

export interface FactorSample {
  id: string
  name: string
  score: number
  applicable: boolean | null
  findings: Array<{ code: string; message: string }>
  recommendations: string[]
}

export interface SiteHealthPageSample {
  url: string
  status: 'success' | 'error'
  score: number | null
  depth: number | null
  indexability: string | null
  factors: FactorSample[]
  criticalDefects: Array<{
    id: string
    severity: string
    detail: string
    recommendation: string
  }>
  error: string | null
}

/**
 * One page in the crawled link graph. A node is either a page the crawler
 * actually fetched and audited (`crawled`), or a link target it saw but never
 * opened — the distinction matters, because only a crawled node can carry a
 * score, and drawing the two alike would imply measurement that never happened.
 */
export interface SiteMapNode {
  key: string
  url: string
  /** Path for display, or the host for the site root. */
  label: string
  depth: number | null
  crawled: boolean
  score: number | null
  indexable: boolean | null
  inboundLinks: number
  outboundLinks: number
}

/** A followable-or-not internal link between two mapped nodes. */
export interface SiteMapEdge {
  from: string
  to: string
  followable: boolean
}

/**
 * A bounded internal-link graph built from the same crawl as the page audit.
 *
 * `totalPages` / `totalEdges` are the pre-cap totals, so a reader can always
 * tell a displayed sample from the whole site.
 */
export interface SiteMapSample {
  nodes: SiteMapNode[]
  edges: SiteMapEdge[]
  totalPages: number
  totalEdges: number
  truncated: boolean
}

export interface SiteHealthSample {
  schemaVersion: string
  label: '5-page Technical AEO sample'
  domain: string
  rootUrl: string
  finalRootUrl: string | null
  status: 'complete' | 'partial' | 'error'
  score: number | null
  pagesDiscovered: number
  pagesFetched: number
  pagesObserved: number
  elapsedMs: number
  terminationReason: string | null
  warnings: string[]
  factors: Array<{ id: string; name: string; averageScore: number; count: number }>
  pages: SiteHealthPageSample[]
  /** Null when the crawl produced no usable graph, never an empty stand-in. */
  siteMap: SiteMapSample | null
  attemptedHosts: string[]
  error: string | null
}

/** The phase that produces the sample above. The kit never runs it. */
export interface SiteHealthRunner {
  run(domain: string, signal: AbortSignal): Promise<SiteHealthSample>
}
