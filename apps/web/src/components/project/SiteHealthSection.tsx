import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Play,
  Search,
  Settings2,
} from 'lucide-react'
import {
  SITE_CRAWL_GRAPH_MAX_EDGES,
  SITE_CRAWL_GRAPH_MAX_NODES,
  SiteCrawlIndexabilityReasons,
  SiteHealthStates,
  type SiteCrawlEdgeDto,
  type SiteCrawlGraphNodeDto,
  type SiteCrawlIndexabilityReason,
  type SiteCrawlPageAuditDto,
  type SiteCrawlPageDto,
  type SiteCrawlStructureChildDto,
  type SiteCrawlStructureResponseDto,
  type SiteCrawlTermination,
  type SiteHealthScanDto,
  type SiteHealthState,
} from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameTechnicalAeoCrawlOptions,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditOptions,
  getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteOptions,
  getApiV1ProjectsByNameTechnicalAeoDeadLinksOptions,
  getApiV1ProjectsByNameTechnicalAeoGraphOptions,
  getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsOptions,
  getApiV1ProjectsByNameTechnicalAeoRunsOptions,
  getApiV1ProjectsByNameTechnicalAeoStructureInfiniteOptions,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient, isEmbed } from '../../api.js'
import { useTriggerSiteAudit } from '../../queries/mutations.js'
import type { MetricTone } from '../../view-models.js'
import { SiteGraphSigma } from './SiteGraphSigma.js'
import {
  siteGraphStatusDescription,
  siteGraphStatusLabel,
  siteGraphVisualState,
  type SiteGraphVisualState,
} from './site-graph-sigma.js'
import { displayPagePath, siteHostFromUrl } from './site-health-paths.js'
import { PageAuditEvidence } from './PageAuditEvidence.js'
import { TechnicalAeoSection } from './TechnicalAeoSection.js'
import { WriteButton } from '../shared/AccessControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'

type SiteHealthView = 'map' | 'inventory' | 'technical'

// The `inventory` id is the stable wire/route token. Only the label reads
// "Pages"; nothing keyed off the id changes with it.
const SITE_HEALTH_VIEWS = [
  { id: 'map', label: 'Map' },
  { id: 'inventory', label: 'Pages' },
  { id: 'technical', label: 'Technical checks' },
] as const satisfies ReadonlyArray<{ id: SiteHealthView; label: string }>

const SITE_HEALTH_VIEW_DESCRIPTIONS: Record<SiteHealthView, string> = {
  map: 'Explore how pages, site sections, and internal links fit together.',
  inventory: 'Review discovered pages and the links that shape their visibility.',
  technical: 'Prioritize audit findings and inspect the pages that need work.',
}

/**
 * Page-list filters. Each one maps to a server-side filter the crawl/pages
 * route already supports, so a chip never narrows only the loaded window.
 */
type InventoryFilterId = 'all' | 'hidden'

/**
 * `hidden` is the DERIVED health state, not `indexabilityState=noindex`: a
 * redirect, a robots block, a non-HTML response, and a canonical pointing
 * elsewhere all hide a page from answer engines without ever setting noindex.
 * The route derives this with the same contract function the map uses.
 */
const INVENTORY_FILTERS = [
  { id: 'all', label: 'All', healthState: undefined },
  { id: 'hidden', label: 'Hidden pages', healthState: SiteHealthStates.hidden },
] as const satisfies ReadonlyArray<{
  id: InventoryFilterId
  label: string
  healthState: SiteHealthState | undefined
}>

/**
 * Plain-word reading of the crawler's machine indexability reasons. The
 * `Record` over the closed union is what makes a newly added reason a compile
 * error here instead of raw machine text in the UI.
 */
const INDEXABILITY_REASON_COPY: Record<SiteCrawlIndexabilityReason, string> = {
  [SiteCrawlIndexabilityReasons.metaRobotsNoindex]: 'Hidden by meta robots tag',
  [SiteCrawlIndexabilityReasons.xRobotsNoindex]: 'Hidden by X-Robots-Tag header',
  [SiteCrawlIndexabilityReasons.robotsDisallow]: 'Blocked by robots.txt',
  [SiteCrawlIndexabilityReasons.redirectTerminal]: 'Redirects to another page',
  [SiteCrawlIndexabilityReasons.canonicalToOther]: 'Points to another page as canonical',
  [SiteCrawlIndexabilityReasons.notHtmlOrUnavailable]: 'Not a reachable HTML page',
}

/** Persisted rows stay string-backed, so the lookup must admit a miss. */
const INDEXABILITY_REASON_LABELS = new Map<string, string>(Object.entries(INDEXABILITY_REASON_COPY))

/**
 * An unrecognized reason is shown verbatim. Dropping it would hide the only
 * evidence the crawler gave for a page being out of the index.
 */
function indexabilityReasonLabel(reason: string): string {
  return INDEXABILITY_REASON_LABELS.get(reason) ?? reason
}

const SCAN_HISTORY_LIMIT = 20
const INVENTORY_LIMIT = 200
const STRUCTURE_LIMIT = 100
const NEIGHBOR_LIMIT = 100
const DEAD_LINK_LIMIT = 50
const GRAPH_NODE_LIMIT = SITE_CRAWL_GRAPH_MAX_NODES
const GRAPH_EDGE_LIMIT = SITE_CRAWL_GRAPH_MAX_EDGES

const numberFormatter = new Intl.NumberFormat()
const scanDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const SITE_HEALTH_STATUS_TONES: Record<SiteGraphVisualState, MetricTone> = {
  eligible: 'positive',
  hidden: 'caution',
  failed: 'negative',
  unchecked: 'neutral',
}

function formatScanDate(value: string | null | undefined): string {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : scanDateFormatter.format(date)
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

type InspectableCrawlPage = SiteCrawlPageDto | SiteCrawlGraphNodeDto

function crawlStatus(page: InspectableCrawlPage): { label: string; tone: MetricTone } {
  const state = siteGraphVisualState(page)
  return {
    label: siteGraphStatusLabel(state),
    tone: SITE_HEALTH_STATUS_TONES[state],
  }
}

function formatImportance(value: number | null): string {
  if (value == null) return 'Not scored'
  const percent = value <= 1 ? value * 100 : value
  return `${Math.round(percent)}%`
}

function formatHealth(page: InspectableCrawlPage): string {
  return page.auditScore == null ? 'Not checked' : `${Math.round(page.auditScore)}/100`
}

function metricValue(value: number | null | undefined): string {
  return value == null ? 'Not available' : numberFormatter.format(value)
}

function movedSiteHosts(requestedRootUrl: string | null, effectiveRootUrl: string | null): {
  requested: string
  effective: string
} | null {
  if (!requestedRootUrl || !effectiveRootUrl) return null
  try {
    const requested = new URL(requestedRootUrl).host
    const effective = new URL(effectiveRootUrl).host
    return requested !== effective ? { requested, effective } : null
  } catch {
    return null
  }
}

function scanTone(status: string | null | undefined): MetricTone {
  if (status === 'completed') return 'positive'
  if (status === 'partial' || status === 'queued' || status === 'running') return 'caution'
  if (status === 'failed' || status === 'cancelled') return 'negative'
  return 'neutral'
}

/**
 * A scan that kept no crawl is still real, selectable history. Say what it
 * holds ("Score only") rather than hiding it or letting it look broken.
 */
function scanOptionLabel(scan: SiteHealthScanDto): string {
  const when = formatScanDate(scan.finishedAt ?? scan.startedAt ?? scan.createdAt)
  const suffix = scan.hasCrawlData ? '' : ' · Score only'
  return `${when} · ${titleCase(scan.status)}${suffix}`
}

/**
 * Why a scan stopped, in plain words. A closed Record over the crawler's own
 * vocabulary, so a new reason is a compile error rather than silently falling
 * through to generic copy.
 */
const TERMINATION_COPY: Record<SiteCrawlTermination, string> = {
  'complete': 'This scan finished on its own.',
  'unknown': 'This scan stopped before it checked every page it found.',
  'max-pages': 'This scan stopped at the page limit, so some pages were not checked.',
  'max-edges': 'This scan stopped at the link limit, so some links are missing.',
  'max-fetches': 'This scan stopped after checking as many pages as it could.',
  'max-duration': 'This scan ran out of time, so some pages were not checked.',
  'max-bytes': 'This scan stopped at the data limit, so some pages were not checked.',
  'max-page-bytes': 'This scan skipped a page that was too large to read.',
  'max-depth': 'This scan stopped at the depth limit, so deeper pages were not checked.',
  'max-links-per-page': 'This scan stopped reading links on pages that had too many.',
  'max-query-variants': 'This scan stopped at the limit for pages that differ only by a query string.',
  'max-sitemap-fanout': 'This scan stopped at the sitemap limit, so some sitemaps were not read.',
  'max-sitemap-urls': 'This scan stopped at the sitemap page limit, so some pages were not found.',
  'root-host-redirect': 'The site moved to another address during this scan.',
}

const TERMINATION_LABELS = new Map<string, string>(Object.entries(TERMINATION_COPY))

function terminationCopy(termination: string | null): string {
  if (!termination) return 'This scan stopped before it checked every page it found.'
  // An unrecognized reason is shown as-is: it is the only thing the crawler
  // told us about why the scan stopped.
  return TERMINATION_LABELS.get(termination) ?? `This scan stopped early: ${termination}.`
}

/**
 * Tri-state, and it never shows a bare zero when the check did not run: "0"
 * would read as "we looked and found none".
 */
function deadLinkLabel(state: string, found?: number): { label: string; tone: MetricTone } {
  if (state === 'disabled') return { label: 'Broken links: not checked', tone: 'neutral' }
  if (state === 'complete') {
    return found
      ? { label: `Broken links: ${numberFormatter.format(found)} found`, tone: 'negative' }
      : { label: 'Broken links: none found', tone: 'positive' }
  }
  if (state === 'partial') {
    return { label: `Broken links: ${numberFormatter.format(found ?? 0)} found so far`, tone: 'caution' }
  }
  return { label: 'Broken links: not checked', tone: 'neutral' }
}

function LinkMetrics({ page }: { page: InspectableCrawlPage }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-default rounded-lg border border-default sm:grid-cols-4 sm:divide-y-0">
      <div className="px-4 py-3">
        <dt className="text-xs text-muted">Clicks from home</dt>
        <dd className="mt-1 text-sm font-medium tabular-nums text-heading">{page.depth ?? 'Not reached'}</dd>
      </div>
      <div className="px-4 py-3">
        <dt className="text-xs text-muted">Links in</dt>
        <dd className="mt-1 text-sm font-medium tabular-nums text-heading">{metricValue(page.inboundUniqueEdges)}</dd>
      </div>
      <div className="px-4 py-3">
        <dt className="text-xs text-muted">Links out</dt>
        <dd className="mt-1 text-sm font-medium tabular-nums text-heading">{metricValue(page.outboundUniqueEdges)}</dd>
      </div>
      <div className="px-4 py-3">
        <dt className="text-xs text-muted">Link importance</dt>
        <dd className="mt-1 text-sm font-medium tabular-nums text-heading">{formatImportance(page.linkScoreNormalized)}</dd>
      </div>
    </dl>
  )
}

function NeighborTable({
  direction,
  edges,
  truncated,
  rootHost,
}: {
  direction: 'inbound' | 'outbound'
  edges: SiteCrawlEdgeDto[]
  truncated: boolean
  rootHost: string | null
}) {
  const heading = direction === 'inbound' ? 'Links in' : 'Links out'
  return (
    <section className="min-w-0" aria-labelledby={`site-health-${direction}-heading`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 id={`site-health-${direction}-heading`} className="text-sm font-medium text-heading">
          {heading} ({metricValue(edges.length)})
        </h4>
        {truncated && <span className="text-xs text-muted">First {NEIGHBOR_LIMIT}</span>}
      </div>
      {edges.length === 0 ? (
        <p className="rounded-lg border border-subtle bg-surface-subtle px-3 py-4 text-sm text-secondary">
          No {direction} internal links were observed.
        </p>
      ) : (
        <div className="evidence-table-wrap max-h-64 overflow-auto">
          <table className="evidence-table site-health-table min-w-[420px]">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Anchor text</th>
                <th scope="col">Times</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => {
                const url = direction === 'inbound' ? edge.sourceUrl : edge.targetUrl
                return (
                <tr key={edge.edgeKey}>
                  {/* The path is the display; the full URL stays on hover. */}
                  <td className="max-w-64 truncate font-mono" title={url}>
                    {displayPagePath(url, rootHost)}
                  </td>
                  <td className="max-w-52 truncate" title={edge.anchors.join(', ') || undefined}>
                    {edge.anchors.join(', ') || 'No anchor text'}
                  </td>
                  <td className="tabular-nums">{metricValue(edge.occurrences)}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/**
 * Only the full page DTO carries the crawler's reasons; the compact graph node
 * does not. The inspector must therefore look the page up in the inventory
 * read rather than reuse whichever object it selected from, or a page picked
 * on the map silently shows no reason at all.
 */
function indexabilityReasons(page: InspectableCrawlPage | null): readonly string[] {
  return page && 'indexabilityReasons' in page ? page.indexabilityReasons : []
}

function PageInspector({
  page,
  isLoading,
  error,
  inbound,
  outbound,
  inboundTruncated,
  outboundTruncated,
  audit,
  auditLoading,
  auditError,
  onRetryAudit,
  rootHost,
  reasonSource,
}: {
  page: InspectableCrawlPage | null
  isLoading: boolean
  error: Error | null
  inbound: SiteCrawlEdgeDto[]
  outbound: SiteCrawlEdgeDto[]
  inboundTruncated: boolean
  outboundTruncated: boolean
  audit: SiteCrawlPageAuditDto | undefined
  auditLoading: boolean
  auditError: Error | null
  onRetryAudit: () => void
  rootHost: string | null
  /** The same page from the inventory read, which carries the crawler reasons. */
  reasonSource: SiteCrawlPageDto | null
}) {
  if (!page) {
    return (
      <section className="border-t border-default pt-5" aria-label="Selected page details">
        <h3 className="text-base font-medium text-heading">Page links</h3>
        <p className="mt-1 text-sm text-secondary">Select a page to inspect its internal links and crawl signals.</p>
      </section>
    )
  }

  const status = crawlStatus(page)
  const reasons = indexabilityReasons(reasonSource ?? page)
  return (
    <section className="border-t border-default pt-5" aria-labelledby="site-health-page-inspector-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="site-health-page-inspector-title" className="break-words font-mono text-base font-semibold text-heading">
              {page.path}
            </h3>
            <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
          </div>
          <p className="mt-1 break-all text-sm text-secondary">{page.url}</p>
          {reasons.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-secondary" aria-label="Why this page is hidden">
              {reasons.map((reason) => (
                <li key={reason}>{indexabilityReasonLabel(reason)}</li>
              ))}
            </ul>
          )}
        </div>
        <Button asChild variant="secondary" size="sm">
          <a href={page.url} target="_blank" rel="noreferrer">
            Open page <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>

      <div className="mt-4">
        <PageAuditEvidence
          audit={audit}
          isLoading={auditLoading}
          error={auditError}
          onRetry={onRetryAudit}
        />
      </div>

      <section className="mt-5 border-t border-default pt-5" aria-labelledby="site-health-page-links-heading">
        <h3 id="site-health-page-links-heading" className="text-base font-semibold text-heading">Internal links</h3>
        <p className="mt-1 text-sm text-secondary">Observed links to and from this page in the selected scan.</p>
        <div className="mt-4">
          <LinkMetrics page={page} />
        </div>
        <div className="mt-5">
          {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-secondary">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Loading page links...
          </div>
        ) : error ? (
          <p className="rounded-lg border border-negative bg-negative-soft px-4 py-3 text-sm text-negative" role="alert">
            Page links could not be loaded.
          </p>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <NeighborTable direction="inbound" edges={inbound} truncated={inboundTruncated} rootHost={rootHost} />
            <NeighborTable direction="outbound" edges={outbound} truncated={outboundTruncated} rootHost={rootHost} />
          </div>
          )}
        </div>
      </section>
    </section>
  )
}

function InventoryTable({
  pages,
  total,
  selectedNodeKey,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  filter,
  onFilterChange,
}: {
  pages: SiteCrawlPageDto[]
  total: number
  selectedNodeKey: string | null
  onSelect: (nodeKey: string) => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  filter: InventoryFilterId
  onFilterChange: (filter: InventoryFilterId) => void
}) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLowerCase()
  const visiblePages = useMemo(
    () => normalizedSearch
      ? pages.filter((page) => `${page.path} ${page.url}`.toLowerCase().includes(normalizedSearch))
      : pages,
    [normalizedSearch, pages],
  )
  const searchCoversLoadedWindowOnly = normalizedSearch.length > 0 && (hasNextPage || pages.length < total)

  return (
    <section aria-labelledby="site-health-inventory-heading">
      <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 id="site-health-inventory-heading" className="text-base font-semibold text-heading">Pages</h2>
          <p className="mt-1 text-sm text-secondary">
            {filter === 'all'
              ? `Showing ${metricValue(pages.length)} of ${metricValue(total)} pages found.`
              : `Showing ${metricValue(pages.length)} of ${metricValue(total)} hidden pages.`}
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search loaded pages</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded pages"
            className="h-9 w-full rounded-md border border-base bg-bg pl-9 pr-3 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-600"
          />
        </label>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter pages">
        {INVENTORY_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => onFilterChange(option.id)}
            className={`filter-chip ${filter === option.id ? 'filter-chip-active' : ''}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="evidence-table-wrap">
        <table className="evidence-table site-health-table min-w-[800px]">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col" title={siteGraphStatusDescription('eligible')}>Status</th>
              <th scope="col">Clicks from home</th>
              <th scope="col">Links in</th>
              <th scope="col">Links out</th>
              <th scope="col">Link importance</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {visiblePages.map((page) => {
              const status = crawlStatus(page)
              return (
                <tr key={page.nodeKey} className={selectedNodeKey === page.nodeKey ? 'bg-surface-active' : undefined}>
                  <td className="max-w-80">
                    <button
                      type="button"
                      onClick={() => onSelect(page.nodeKey)}
                      className="block max-w-full truncate rounded-sm font-mono text-sm font-medium text-link outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                      title={page.url}
                    >
                      {page.path}
                    </button>
                  </td>
                  <td title={siteGraphStatusDescription(siteGraphVisualState(page))}>
                    <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
                  </td>
                  <td className="tabular-nums">{page.depth ?? 'Not reached'}</td>
                  <td className="tabular-nums">{metricValue(page.inboundUniqueEdges)}</td>
                  <td className="tabular-nums">{metricValue(page.outboundUniqueEdges)}</td>
                  <td className="tabular-nums">{formatImportance(page.linkScoreNormalized)}</td>
                  <td className="tabular-nums">{formatHealth(page)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {visiblePages.length === 0 && (
        <p className="border-x border-b border-default px-4 py-8 text-center text-sm text-secondary">
          {normalizedSearch.length === 0
            ? filter === 'hidden'
              ? 'No hidden pages were found in this scan.'
              : 'No pages are available.'
            : searchCoversLoadedWindowOnly
              ? `No matches in the ${metricValue(pages.length)} loaded pages. Load more pages to continue searching.`
              : 'No pages match this search.'}
        </p>
      )}
      {hasNextPage && (
        <div className="flex justify-center border-x border-b border-default px-4 py-3">
          <Button variant="secondary" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore}>
            {isFetchingNextPage && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
            {isFetchingNextPage ? 'Loading more pages' : 'Load more pages'}
          </Button>
        </div>
      )}
    </section>
  )
}

function SiteSectionRow({
  projectName,
  runId,
  section,
  onSelect,
}: {
  projectName: string
  runId: string
  section: SiteCrawlStructureChildDto
  onSelect: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const descendantCount = section.pageCount - (section.hasPage ? 1 : 0)
  const expandable = descendantCount > 0

  return (
    <li>
      <div className="flex min-h-11 items-center gap-1 px-2 py-1">
        {expandable ? (
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${section.path}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted outline-none hover:bg-surface-hover hover:text-heading focus-visible:ring-2 focus-visible:ring-mono-400"
          >
            {expanded
              ? <ChevronDown className="size-3.5" aria-hidden="true" />
              : <ChevronRight className="size-3.5" aria-hidden="true" />}
          </button>
        ) : (
          <span className="block size-8 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onSelect(section.path)}
          className="min-w-0 flex-1 break-all rounded-sm py-2 text-left font-mono text-sm text-heading outline-none hover:text-link focus-visible:ring-2 focus-visible:ring-mono-400"
        >
          {section.path}
        </button>
        <span className="shrink-0 px-2 font-mono text-xs text-muted">{metricValue(section.pageCount)}</span>
      </div>
      {expanded && (
        <div className="ml-6 border-l border-default pl-1">
          <SiteSectionChildren
            projectName={projectName}
            runId={runId}
            parentPath={section.path}
            onSelect={onSelect}
          />
        </div>
      )}
    </li>
  )
}

function SiteSectionChildren({
  projectName,
  runId,
  parentPath,
  onSelect,
}: {
  projectName: string
  runId: string
  parentPath: string
  onSelect: (path: string) => void
}) {
  const structureInput = {
    client: heyClient,
    path: { name: projectName },
    query: { runId, parentPath, limit: STRUCTURE_LIMIT },
  } as const
  const structureQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameTechnicalAeoStructureInfiniteOptions(structureInput),
    initialPageParam: structureInput,
    getNextPageParam: (lastPage: SiteCrawlStructureResponseDto) => lastPage.nextCursor
      ? {
          path: structureInput.path,
          query: { ...structureInput.query, cursor: lastPage.nextCursor },
        }
      : undefined,
  })
  const sections = structureQuery.data?.pages.flatMap((page) => page.children) ?? []

  if (structureQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-sm text-secondary" role="status">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Loading sections...
      </div>
    )
  }
  if (structureQuery.error) {
    return <p className="px-3 py-4 text-sm text-negative" role="alert">Site sections could not be loaded.</p>
  }
  if (sections.length === 0) {
    return <p className="px-3 py-4 text-sm text-secondary">No nested sections were found.</p>
  }

  return (
    <>
      <ul className="divide-y divide-default">
        {sections.map((section) => (
          <SiteSectionRow
            key={section.path}
            projectName={projectName}
            runId={runId}
            section={section}
            onSelect={onSelect}
          />
        ))}
      </ul>
      {structureQuery.hasNextPage && (
        <div className="px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={structureQuery.isFetchingNextPage}
            onClick={() => void structureQuery.fetchNextPage()}
          >
            {structureQuery.isFetchingNextPage ? 'Loading more sections' : 'Load more sections'}
          </Button>
        </div>
      )}
    </>
  )
}

function GraphLoadingState() {
  return (
    <div
      role="status"
      className="flex min-h-[420px] items-center justify-center rounded-lg border border-default bg-surface-inset px-6 text-center lg:min-h-[520px]"
    >
      <div className="max-w-sm">
        <LoaderCircle className="mx-auto size-5 animate-spin text-muted" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-heading">Preparing the interactive site map</p>
        <p className="mt-1 text-sm text-secondary">Page and link data is ready for the graph renderer.</p>
      </div>
    </div>
  )
}

export function SiteHealthSection({ projectName, projectId }: { projectName: string; projectId: string }) {
  const [view, setView] = useState<SiteHealthView>('map')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)
  const [checkDeadLinks, setCheckDeadLinks] = useState(false)
  const [inventoryFilter, setInventoryFilter] = useState<InventoryFilterId>('all')
  const embedded = isEmbed()
  const runMutation = useTriggerSiteAudit()

  // The Site Health scan history, not the generic run list: it already excludes
  // probes and says which scans kept a crawl.
  const auditRunsQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: SCAN_HISTORY_LIMIT },
    }),
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => query.state.data?.scans.some(
      (scan) => scan.status === 'queued' || scan.status === 'running',
    ) ? 3_000 : 15_000,
  })
  const auditScans = auditRunsQuery.data?.scans ?? []
  const activeAudit = auditScans.find((scan) => scan.status === 'queued' || scan.status === 'running')
  const latestTerminalAudit = auditScans
    .find((scan) => scan.status === 'completed' || scan.status === 'partial')
  const requestedRunId = selectedRunId ?? latestTerminalAudit?.runId ?? null

  const crawlQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlOptions({
      client: heyClient,
      path: { name: projectName },
      ...(requestedRunId ? { query: { runId: requestedRunId } } : {}),
    }),
    refetchInterval: !selectedRunId && activeAudit ? 3_000 : false,
  })
  const crawl = crawlQuery.data
  const resolvedRunId = requestedRunId ?? crawl?.runId ?? null
  const detailsEnabled = Boolean(resolvedRunId && crawl?.hasCrawlData && crawl.detailsAvailable)
  const scopedRunQuery = resolvedRunId ? { runId: resolvedRunId } : {}

  const graphQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoGraphOptions({
      client: heyClient,
      path: { name: projectName },
      query: { ...scopedRunQuery, maxNodes: GRAPH_NODE_LIMIT, maxEdges: GRAPH_EDGE_LIMIT },
    }),
    enabled: detailsEnabled,
  })
  // The chip narrows on the server, so `total` and the cursor stay truthful
  // instead of describing an unfiltered list.
  const inventoryHealthState = INVENTORY_FILTERS
    .find((option) => option.id === inventoryFilter)?.healthState
  const pagesInput = {
    client: heyClient,
    path: { name: projectName },
    query: {
      ...scopedRunQuery,
      ...(inventoryHealthState ? { healthState: inventoryHealthState } : {}),
      limit: INVENTORY_LIMIT,
      sort: 'path' as const,
    },
  }
  const pagesQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesInfiniteOptions(pagesInput),
    enabled: detailsEnabled,
    initialPageParam: pagesInput,
    getNextPageParam: (lastPage) => lastPage.nextCursor
      ? {
          path: pagesInput.path,
          query: { ...pagesInput.query, cursor: lastPage.nextCursor },
        }
      : undefined,
  })
  const deadLinkDetailsEnabled = detailsEnabled
    && (crawl?.deadLinks.state === 'complete' || crawl?.deadLinks.state === 'partial')
  const deadLinksQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoDeadLinksOptions({
      client: heyClient,
      path: { name: projectName },
      query: { ...scopedRunQuery, limit: DEAD_LINK_LIMIT },
    }),
    enabled: deadLinkDetailsEnabled,
  })

  const graphPages = graphQuery.data?.nodes ?? []
  const internalLinkCount = graphQuery.data?.layout.state === 'ready'
    ? graphQuery.data.totalEdges
    : null
  const inventoryPages = useMemo(
    () => pagesQuery.data?.pages.flatMap((page) => page.pages) ?? [],
    [pagesQuery.data],
  )
  const inventoryTotal = pagesQuery.data?.pages[0]?.total ?? inventoryPages.length
  const inventoryPage = useMemo(
    () => inventoryPages.find((page) => page.nodeKey === selectedNodeKey) ?? null,
    [inventoryPages, selectedNodeKey],
  )
  // A filter narrows the page list on the server. When the selected page is no
  // longer in that list, the inspector below it is describing a row the reader
  // can no longer see, so the selection is dropped rather than left stale.
  const selectionFilteredOut = Boolean(
    selectedNodeKey && inventoryHealthState && !pagesQuery.isLoading && !inventoryPage,
  )
  useEffect(() => {
    if (selectionFilteredOut) setSelectedNodeKey(null)
  }, [selectionFilteredOut])
  const selectedPage = useMemo(
    () => selectionFilteredOut
      ? null
      : graphPages.find((page) => page.nodeKey === selectedNodeKey) ?? inventoryPage,
    [graphPages, inventoryPage, selectedNodeKey, selectionFilteredOut],
  )
  const effectiveSelectedNodeKey = selectedPage?.nodeKey ?? null
  const neighborsQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoInternalLinksNeighborsOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        ...scopedRunQuery,
        nodeKey: effectiveSelectedNodeKey ?? undefined,
        limit: NEIGHBOR_LIMIT,
      },
    }),
    enabled: detailsEnabled && Boolean(effectiveSelectedNodeKey),
  })
  const pageAuditQuery = useQuery({
    ...getApiV1ProjectsByNameTechnicalAeoCrawlPagesAuditOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        ...scopedRunQuery,
        nodeKey: effectiveSelectedNodeKey ?? undefined,
      },
    }),
    enabled: detailsEnabled && Boolean(effectiveSelectedNodeKey),
  })

  // The server already orders scans newest first, so the dropdown does not
  // keep a second ordering of the same list.
  const selectableScans = useMemo(
    () => auditScans.filter((scan) => scan.status === 'completed' || scan.status === 'partial'),
    [auditScans],
  )
  const newestRunStatus = auditScans[0]?.status ?? null
  const selectedRun = resolvedRunId ? auditScans.find((scan) => scan.runId === resolvedRunId) : undefined
  const status = !selectedRunId && activeAudit
    ? activeAudit.status
    : crawl?.runStatus ?? selectedRun?.status ?? null
  const statusLabel = status === 'running'
    ? 'Scan running'
    : status === 'queued'
      ? 'Scan queued'
      : status === 'partial'
        ? 'Partial scan'
        : status === 'completed'
          ? 'Complete'
          : status === 'failed'
            ? 'Scan failed'
            : 'No scan'
  const deadLinks = deadLinksQuery.data
  const deadLinkStatus = deadLinkLabel(
    deadLinks?.state ?? crawl?.deadLinks.state ?? 'unavailable',
    deadLinks && 'found' in deadLinks ? deadLinks.found : crawl?.deadLinks && 'found' in crawl.deadLinks ? crawl.deadLinks.found : undefined,
  )
  const movedSite = movedSiteHosts(crawl?.requestedRootUrl ?? null, crawl?.rootUrl ?? null)
  const rootHost = siteHostFromUrl(crawl?.rootUrl ?? null)
  const scanBusy = runMutation.isPending || Boolean(activeAudit)

  const selectRun = (runId: string) => {
    setSelectedRunId(runId || null)
    setSelectedNodeKey(null)
  }
  const startScan = () => runMutation.mutate({
    projectName,
    projectId,
    body: { checkDeadLinks },
  })
  const selectSection = (path: string) => {
    const matchingPage = graphPages.find((page) => page.path === path || page.path.startsWith(`${path}/`))
    if (matchingPage) setSelectedNodeKey(matchingPage.nodeKey)
  }

  const selectView = (nextView: SiteHealthView) => setView(nextView)
  const handleViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % SITE_HEALTH_VIEWS.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + SITE_HEALTH_VIEWS.length) % SITE_HEALTH_VIEWS.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = SITE_HEALTH_VIEWS.length - 1
    }
    if (nextIndex == null) return
    event.preventDefault()
    selectView(SITE_HEALTH_VIEWS[nextIndex]!.id)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-heading">Site Health</h2>
            <ToneBadge tone={scanTone(status)}>{statusLabel}</ToneBadge>
            {selectedRun && (
              <span className="text-xs text-muted">{formatScanDate(selectedRun.finishedAt ?? selectedRun.startedAt)}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-secondary">{SITE_HEALTH_VIEW_DESCRIPTIONS[view]}</p>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <label className="grid gap-1 text-xs text-muted">
            Scan history
            <select
              aria-label="View a Site Health scan"
              value={selectedRunId ?? ''}
              onChange={(event) => selectRun(event.target.value)}
              className="h-9 min-w-48 rounded-md border border-base bg-bg px-3 text-sm text-primary outline-none focus:border-strong focus:ring-2 focus:ring-mono-600"
            >
              <option value="">Latest scan</option>
              {selectableScans.map((scan) => (
                <option key={scan.runId} value={scan.runId}>{scanOptionLabel(scan)}</option>
              ))}
            </select>
          </label>

          {!embedded && (
            <div className="flex items-end gap-2 pt-5">
              <details className="group relative">
                <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-base bg-bg px-3 text-sm font-medium text-heading outline-none hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-mono-400">
                  <Settings2 className="size-4" aria-hidden="true" />
                  Scan settings
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-strong bg-bg-elevated p-4 shadow-[0_12px_32px_var(--color-shadow-panel)]">
                  <label className="flex cursor-pointer items-start gap-3 text-sm text-heading">
                    <input
                      type="checkbox"
                      aria-label="Check dead links"
                      checked={checkDeadLinks}
                      disabled={scanBusy}
                      onChange={(event) => setCheckDeadLinks(event.target.checked)}
                      className="mt-0.5 size-4 rounded border-base accent-mono-200 focus:ring-2 focus:ring-mono-400"
                    />
                    <span>
                      <span className="font-medium">Check dead links</span>
                      <span className="mt-1 block text-sm text-secondary">Adds dead-link analysis to this scan.</span>
                    </span>
                  </label>
                </div>
              </details>
              <WriteButton onClick={startScan} disabled={scanBusy}>
                {scanBusy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                {activeAudit?.status === 'running' ? 'Scan running' : activeAudit?.status === 'queued' ? 'Scan queued' : 'Run scan'}
              </WriteButton>
            </div>
          )}
        </div>
      </header>

      {crawl?.hasCrawlData && view !== 'technical' && (
        <div className="grid grid-cols-2 divide-x divide-y divide-default rounded-lg border border-default bg-surface-subtle sm:grid-cols-4 sm:divide-y-0">
          <div className="px-4 py-3">
            <div className="text-xs text-muted">Pages found</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(crawl.counts.pagesDiscovered)}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-muted">Pages checked</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(crawl.counts.pagesFetched)}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-muted" title={siteGraphStatusDescription('eligible')}>Indexable</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(crawl.counts.pagesEligible)}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-muted">Internal links</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-heading">{metricValue(internalLinkCount)}</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-default">
        <div role="tablist" aria-label="Site Health views" aria-orientation="horizontal" className="flex min-w-0 gap-5">
          {SITE_HEALTH_VIEWS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`site-health-${item.id}-tab`}
              aria-selected={view === item.id}
              aria-controls={`site-health-${item.id}-panel`}
              tabIndex={view === item.id ? 0 : -1}
              ref={(element) => { tabRefs.current[index] = element }}
              onClick={() => selectView(item.id)}
              onKeyDown={(event) => handleViewKeyDown(event, index)}
              className={`min-h-11 border-b-2 px-0.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-mono-400 ${
                view === item.id
                  ? 'border-strong text-heading'
                  : 'border-transparent text-secondary hover:border-base hover:text-primary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {crawl?.hasCrawlData && view !== 'technical' && (
          <div className="flex items-center gap-2 pb-2">
            <span className="text-xs text-muted">Dead-link check</span>
            <ToneBadge tone={deadLinkStatus.tone}>{deadLinkStatus.label}</ToneBadge>
          </div>
        )}
      </div>

      {!selectedRunId && activeAudit && (
        <div className="rounded-lg border border-caution bg-caution-soft px-4 py-3 text-sm text-caution" role="status">
          The scan is running. The latest completed results remain available until it finishes.
        </div>
      )}
      {movedSite && (
        <div className="rounded-lg border border-base bg-surface-subtle px-4 py-3 text-sm text-secondary" role="status">
          <span className="font-medium text-heading">Site address changed during this scan.</span>{' '}
          The scan started at <span className="font-mono text-primary">{movedSite.requested}</span> and continued at{' '}
          <span className="font-mono text-primary">{movedSite.effective}</span>. The map and inventory use the new address.
        </div>
      )}
      {crawl?.hasCrawlData && !crawl.complete && (
        <div className="rounded-lg border border-caution bg-caution-soft px-4 py-3 text-sm text-caution" role="status">
          {terminationCopy(crawl.termination)}
        </div>
      )}
      {!activeAudit && newestRunStatus === 'failed' && !selectedRunId && (
        <div className="flex gap-3 rounded-lg border border-negative bg-negative-soft px-4 py-3 text-sm text-negative" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>The latest scan failed. The previous completed results remain available.</span>
        </div>
      )}

      {view === 'technical' ? (
        <div id="site-health-technical-panel" role="tabpanel" aria-labelledby="site-health-technical-tab" className="min-w-0">
          <TechnicalAeoSection
            projectName={projectName}
            projectId={projectId}
            runId={resolvedRunId}
            integrated
          />
        </div>
      ) : crawlQuery.isLoading ? (
        <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-secondary" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Loading site health...
        </div>
      ) : crawlQuery.error ? (
        <section className="rounded-lg border border-negative bg-negative-soft px-5 py-6" role="alert">
          <h2 className="font-semibold text-negative">Site Health could not load</h2>
          <p className="mt-1 text-sm text-negative">Try loading the crawl again.</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void crawlQuery.refetch()}>Try again</Button>
        </section>
      ) : !crawl?.hasCrawlData ? (
        <section className="rounded-lg border border-default bg-surface-subtle px-5 py-8 text-center">
          <h2 className="text-base font-semibold text-heading">Full-site map not available</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-secondary">
            {crawl?.legacyAuditAvailable
              ? 'Existing technical checks are preserved. Run a new scan to build the page and internal-link map.'
              : embedded
                ? 'A full-site scan has not been run for this project.'
                : 'Run a scan to discover pages, site sections, and internal links.'}
          </p>
          {crawl?.legacyAuditAvailable && (
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => setView('technical')}>View technical checks</Button>
          )}
        </section>
      ) : !crawl.detailsAvailable ? (
        <section className="rounded-lg border border-caution bg-caution-soft px-5 py-6">
          <h2 className="font-semibold text-caution">Page details unavailable</h2>
          <p className="mt-1 text-sm text-caution">Summary metrics are preserved for this scan, but its page graph cannot be opened.</p>
        </section>
      ) : view === 'inventory' ? (
        <div id="site-health-inventory-panel" role="tabpanel" aria-labelledby="site-health-inventory-tab" className="space-y-5">
          {pagesQuery.isLoading ? (
            <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-secondary" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Loading page inventory...
            </div>
          ) : pagesQuery.error ? (
            <p className="rounded-lg border border-negative bg-negative-soft px-4 py-3 text-sm text-negative" role="alert">
              The page inventory could not be loaded.
            </p>
          ) : (
            <InventoryTable
              pages={inventoryPages}
              total={inventoryTotal}
              selectedNodeKey={effectiveSelectedNodeKey}
              onSelect={setSelectedNodeKey}
              hasNextPage={Boolean(pagesQuery.hasNextPage)}
              isFetchingNextPage={pagesQuery.isFetchingNextPage}
              onLoadMore={() => void pagesQuery.fetchNextPage()}
              filter={inventoryFilter}
              onFilterChange={setInventoryFilter}
            />
          )}
          <PageInspector
            page={selectedPage}
            isLoading={neighborsQuery.isLoading && Boolean(selectedPage)}
            error={neighborsQuery.error}
            inbound={neighborsQuery.data?.inbound ?? []}
            outbound={neighborsQuery.data?.outbound ?? []}
            inboundTruncated={neighborsQuery.data?.inboundTruncated ?? false}
            outboundTruncated={neighborsQuery.data?.outboundTruncated ?? false}
            audit={pageAuditQuery.data}
            auditLoading={pageAuditQuery.isLoading && Boolean(selectedPage)}
            auditError={pageAuditQuery.error}
            onRetryAudit={() => { void pageAuditQuery.refetch() }}
            rootHost={rootHost}
            reasonSource={inventoryPage}
          />
        </div>
      ) : (
        <div id="site-health-map-panel" role="tabpanel" aria-labelledby="site-health-map-tab" className="space-y-5">
          <section aria-labelledby="site-map-heading">
            <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
              <div>
                <h2 id="site-map-heading" className="text-base font-semibold text-heading">Site map</h2>
                <p className="mt-1 text-sm text-secondary">Scroll to zoom. Click a page to inspect it.</p>
              </div>
              {graphQuery.data?.sampled && (
                <span className="text-xs text-muted">
                  Showing {metricValue(graphQuery.data.nodes.length)} of {metricValue(graphQuery.data.totalNodes)} pages
                  {' · '}
                  {metricValue(graphQuery.data.edges.length)} of {metricValue(graphQuery.data.totalEdges)} links
                </span>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              {graphQuery.isLoading ? (
                <GraphLoadingState />
              ) : graphQuery.error ? (
                <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-negative bg-negative-soft px-6 text-center text-sm text-negative lg:min-h-[520px]" role="alert">
                  The interactive map could not be loaded.
                </div>
              ) : (
                <SiteGraphSigma
                  nodes={graphQuery.data?.nodes ?? []}
                  edges={graphQuery.data?.edges ?? []}
                  layoutState={graphQuery.data?.layout.state ?? 'unavailable'}
                  layoutUnavailableReason={graphQuery.data?.layout.state === 'unavailable' ? graphQuery.data.layout.reason : null}
                  rootNodeKey={graphQuery.data?.rootNodeKey ?? null}
                  selectedNodeKey={effectiveSelectedNodeKey}
                  onSelectNode={(node) => setSelectedNodeKey(node.nodeKey)}
                  ariaLabel={`Interactive site map showing ${metricValue(graphQuery.data?.nodes.length ?? 0)} pages and ${metricValue(graphQuery.data?.edges.length ?? 0)} internal links`}
                />
              )}

              <aside className="rounded-lg border border-default bg-surface-subtle" aria-labelledby="site-sections-heading">
                <div className="border-b border-default px-4 py-3">
                  <h3 id="site-sections-heading" className="text-sm font-semibold text-heading">Site sections</h3>
                  <p className="mt-1 text-xs text-muted">Folders in this scan</p>
                </div>
                <div className="max-h-[468px] overflow-auto">
                  {resolvedRunId && (
                    <SiteSectionChildren
                      projectName={projectName}
                      runId={resolvedRunId}
                      parentPath="/"
                      onSelect={selectSection}
                    />
                  )}
                </div>
              </aside>
            </div>

          </section>

          <PageInspector
            page={selectedPage}
            isLoading={neighborsQuery.isLoading && Boolean(selectedPage)}
            error={neighborsQuery.error}
            inbound={neighborsQuery.data?.inbound ?? []}
            outbound={neighborsQuery.data?.outbound ?? []}
            inboundTruncated={neighborsQuery.data?.inboundTruncated ?? false}
            outboundTruncated={neighborsQuery.data?.outboundTruncated ?? false}
            audit={pageAuditQuery.data}
            auditLoading={pageAuditQuery.isLoading && Boolean(selectedPage)}
            auditError={pageAuditQuery.error}
            onRetryAudit={() => { void pageAuditQuery.refetch() }}
            rootHost={rootHost}
            reasonSource={inventoryPage}
          />
        </div>
      )}
    </div>
  )
}
