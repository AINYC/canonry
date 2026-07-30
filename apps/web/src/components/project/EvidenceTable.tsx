import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from 'lucide-react'

import { Button } from '../ui/button.js'
import {
  DataTablePagination,
  DataTableSearch,
  filterClientTableRows,
  useClientTable,
} from '../shared/DataTableControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import {
  buildQueryEvidenceGroups,
  type QueryEvidenceGroupModel,
  type QueryEvidenceSignal,
} from './query-evidence-model.js'
import type { CitationInsightVm } from '../../view-models.js'

type QuickView = 'all' | 'changed' | 'losses'
type SortKey = 'latest' | 'query'
type SortDirection = 'asc' | 'desc'

const QUICK_VIEWS: QuickView[] = ['all', 'changed', 'losses']

function matchesQuickView(group: QueryEvidenceGroupModel, view: QuickView): boolean {
  if (view === 'changed') return group.changed
  if (view === 'losses') return group.hasLoss
  return true
}

function quickViewLabel(view: QuickView): string {
  if (view === 'changed') return 'Changed'
  if (view === 'losses') return 'Mention/citation losses'
  return 'All'
}

function searchText(group: QueryEvidenceGroupModel): string {
  return [
    group.query,
    group.location ?? '',
    ...group.items.flatMap(item => [item.provider, item.model ?? '', item.location ?? '']),
    ...group.changes.map(change => change.copy),
  ].join(' ')
}

function observedTimestamp(group: QueryEvidenceGroupModel): number {
  const timestamp = Date.parse(group.latestObservedAt ?? '')
  return Number.isFinite(timestamp) ? timestamp : -1
}

function compareGroups(
  left: QueryEvidenceGroupModel,
  right: QueryEvidenceGroupModel,
  key: SortKey,
  direction: SortDirection,
): number {
  const comparison = key === 'query'
    ? left.query.localeCompare(right.query)
      || (left.location ?? '').localeCompare(right.location ?? '')
    : observedTimestamp(left) - observedTimestamp(right)
  const stable = comparison === 0 ? left.query.localeCompare(right.query) : comparison
  return direction === 'asc' ? stable : -stable
}

function formatObservedDate(value: string | null): string {
  if (!value) return 'Not run'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Not run'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatObservedTitle(value: string | null): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined
  return `${new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)}`
}

function signalForDrawer(signal: QueryEvidenceSignal | null): 'mentions' | 'citations' {
  return signal === 'mention' ? 'mentions' : 'citations'
}

function changeTone(group: QueryEvidenceGroupModel): string {
  if (group.representativeDirection === 'lost') return 'query-change-copy--loss'
  if (group.representativeDirection === 'gained') return 'query-change-copy--gain'
  return 'query-change-copy--neutral'
}

function SortHeader({
  label,
  sortKey,
  current,
  direction,
  onSort,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  direction: SortDirection
  onSort: (key: SortKey) => void
}) {
  const active = current === sortKey
  const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="query-change-sort"
        aria-label={`Sort by ${label}${active ? `, currently ${ariaSort}` : ''}`}
      >
        {label}
        <Icon aria-hidden="true" className={`size-3 ${active ? 'text-secondary' : 'text-faint'}`} />
      </button>
    </th>
  )
}

export function EvidenceTable({
  evidence,
  compareLocations = false,
  hasTrackedQueries = evidence.length > 0,
  isFiltered = false,
  locationScope,
}: {
  evidence: CitationInsightVm[]
  compareLocations?: boolean
  hasTrackedQueries?: boolean
  isFiltered?: boolean
  locationScope?: string
}) {
  const { openEvidence } = useDrawer()
  const [quickView, setQuickView] = useState<QuickView>('all')
  const [sortKey, setSortKey] = useState<SortKey>('latest')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const groups = useMemo(
    () => buildQueryEvidenceGroups(evidence, { compareLocations }),
    [evidence, compareLocations],
  )

  const groupsTable = useClientTable({
    rows: groups,
    getSearchText: searchText,
  })

  const searchMatchedGroups = useMemo(
    () => filterClientTableRows(groups, groupsTable.query, searchText),
    [groups, groupsTable.query],
  )

  const quickViewCounts = useMemo(() => Object.fromEntries(
    QUICK_VIEWS.map(view => [
      view,
      searchMatchedGroups.filter(group => matchesQuickView(group, view)).length,
    ]),
  ) as Record<QuickView, number>, [searchMatchedGroups])

  useEffect(() => {
    if (quickView !== 'all' && quickViewCounts[quickView] === 0) {
      setQuickView('all')
      groupsTable.setPage(1)
    }
  }, [groupsTable, quickView, quickViewCounts])

  const displayedGroups = useMemo(() => searchMatchedGroups
    .filter(group => matchesQuickView(group, quickView))
    .sort((left, right) => compareGroups(left, right, sortKey, sortDirection)),
  [searchMatchedGroups, quickView, sortKey, sortDirection])

  const visibleTable = useClientTable({
    rows: displayedGroups,
    getSearchText: () => '',
  })

  const handleSort = (nextKey: SortKey) => {
    visibleTable.setPage(1)
    if (sortKey === nextKey) {
      setSortDirection(previous => previous === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(nextKey)
    setSortDirection(nextKey === 'query' ? 'asc' : 'desc')
  }

  const handleQuickView = (nextView: QuickView) => {
    setQuickView(nextView)
    visibleTable.setPage(1)
  }

  const clearFilters = () => {
    setQuickView('all')
    groupsTable.setQuery('')
    groupsTable.setPage(1)
    visibleTable.setPage(1)
  }

  if (groups.length === 0) {
    return (
      <div className="query-change-empty">
        <p className="text-sm font-medium text-strong">
          {!hasTrackedQueries
            ? 'No queries tracked yet'
            : isFiltered
              ? 'No query evidence matches these filters'
              : 'Waiting for the first query results'}
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-secondary">
          {!hasTrackedQueries
            ? 'Add queries with Manage queries, then run a sweep to collect mention and citation evidence.'
            : isFiltered
              ? 'Choose another location or clear the competitor filter to see query changes.'
              : 'Run a sweep to collect the first mention and citation results for these tracked queries.'}
        </p>
      </div>
    )
  }

  const hasVisibleRows = visibleTable.totalRows > 0
  const availableViews = QUICK_VIEWS.filter(view => view === 'all' || quickViewCounts[view] > 0)

  return (
    <div>
      <div className="query-change-controls">
        <DataTableSearch
          value={groupsTable.query}
          onChange={(value) => {
            groupsTable.setQuery(value)
            visibleTable.setPage(1)
          }}
          label="Search queries, locations, or engines"
          placeholder="Search queries, locations, or engines"
          className="max-w-xl"
        />
        <div className="query-change-filter-row">
          <div className="evidence-quick-views" role="group" aria-label="Query change views">
            <span className="evidence-quick-views-label">View</span>
            <div className="evidence-quick-view-list">
              {availableViews.map(view => {
                const active = quickView === view
                const count = quickViewCounts[view]
                return (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${quickViewLabel(view)}, ${count} ${count === 1 ? 'query' : 'queries'}`}
                    onClick={() => handleQuickView(view)}
                    className={`evidence-quick-view ${active ? 'evidence-quick-view--active' : ''}`}
                  >
                    <span>{quickViewLabel(view)}</span>
                    <span className="evidence-quick-view-count">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <p className="query-change-comparison-note">
            Changes use each engine’s previous result from an earlier day.
            <InfoTooltip text="Same-day reruns are grouped together, and results from different locations are never compared." />
          </p>
        </div>
      </div>

      {hasVisibleRows ? (
        <div className="query-change-table-wrap">
          <table className="query-change-table">
            <caption className="sr-only">
              Query changes by tracked query. Mention changes describe brand or domain
              presence in answer text. Citation changes describe your domain in source
              links. Select Review evidence to see every engine on one dated history and
              inspect the exact answer, source links, and competitor evidence.
            </caption>
            <thead>
              <tr>
                <SortHeader
                  label="Query"
                  sortKey="query"
                  current={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <th scope="col">What changed</th>
                <SortHeader
                  label="Latest result"
                  sortKey="latest"
                  current={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleTable.rows.map(group => {
                const engineCount = new Set(
                  group.items.map(item => item.provider.trim()).filter(Boolean),
                ).size
                const remainingChanges = Math.max(0, group.changeCount - 1)
                const representativeCopy = group.changes[0]?.copy ?? group.eventCopy
                const reviewId = group.representativeEvidenceId
                return (
                  <tr key={group.key} className="query-change-row">
                    <th scope="row" className="query-change-query">
                      <span>{group.query}</span>
                      <span className="query-change-query-meta">
                        {[
                          compareLocations ? (group.location ?? 'No location') : null,
                          engineCount > 0
                            ? `${engineCount} ${engineCount === 1 ? 'engine' : 'engines'}`
                            : 'Awaiting first sweep',
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </th>
                    <td data-label="What changed" className={`query-change-copy ${changeTone(group)}`}>
                      <span>{representativeCopy}</span>
                      {remainingChanges > 0 ? (
                        <span className="query-change-more">
                          +{remainingChanges} more {remainingChanges === 1 ? 'change' : 'changes'}
                        </span>
                      ) : null}
                    </td>
                    <td
                      data-label="Latest result"
                      className="query-change-observed"
                      title={formatObservedTitle(group.latestObservedAt)}
                    >
                      {formatObservedDate(group.latestObservedAt)}
                    </td>
                    <td className="query-change-action">
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={!reviewId}
                        aria-label={reviewId
                          ? `Review evidence for ${group.query}`
                          : `No evidence recorded for ${group.query}`}
                        onClick={() => {
                          if (!reviewId) return
                          const drawerSignal = signalForDrawer(group.representativeSignal)
                          const drawerLocation = compareLocations
                            ? (group.location ?? '')
                            : locationScope
                          if (drawerLocation !== undefined) {
                            openEvidence(reviewId, drawerSignal, drawerLocation)
                          } else {
                            openEvidence(reviewId, drawerSignal)
                          }
                        }}
                      >
                        Review evidence
                        <ChevronRight aria-hidden="true" className="ml-1 size-3.5" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="query-change-empty">
          <p className="text-sm font-medium text-strong">No queries match this view</p>
          <p className="mt-1 text-xs text-secondary">Clear the search or view filter to see all tracked queries.</p>
          <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}

      <DataTablePagination
        page={visibleTable.page}
        pageSize={visibleTable.pageSize}
        visibleRows={visibleTable.rows.length}
        totalRows={visibleTable.totalRows}
        onPageChange={visibleTable.setPage}
        itemLabel={compareLocations ? 'query locations with evidence' : 'queries with evidence'}
      />
      <p className="sr-only" aria-live="polite">
        Showing {visibleTable.totalRows} of {groups.length}{' '}
        {compareLocations ? 'query locations' : 'queries'} with evidence.
      </p>
    </div>
  )
}
