import { Fragment, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronRight, Clock3, Minus } from 'lucide-react'

import { Button } from '../ui/button.js'
import {
  DataTablePagination,
  DataTableSearch,
  filterClientTableRows,
  useClientTable,
} from '../shared/DataTableControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
import {
  buildRecentRecordedDays,
  EvidenceHistoryStrip,
  recentRecordedDateAxis,
  type EvidenceHistoryMatrixData,
} from './EvidenceHistoryMatrix.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import type { CitationInsightVm, CitationState, RunHistoryPoint } from '../../view-models.js'

export type CoverageMode = 'citations' | 'mentions'
export type EvidenceQuickView =
  | 'all'
  | 'changed'
  | 'mention-lost'
  | 'citation-lost'
  | 'never-mentioned'
  | 'never-cited'
export type EvidenceSortKey = 'attention' | 'query' | 'mentioned' | 'cited'
type SortDirection = 'asc' | 'desc'
type SignalTone = 'positive' | 'negative' | 'neutral' | 'pending'
type SignalChange = 'gained' | 'lost' | 'unchanged' | 'unavailable'

export interface EvidenceSignalSummary {
  key: CoverageMode
  label: string
  tone: SignalTone
}

export interface EvidenceSignalCoverage {
  present: number
  observed: number
  expected: number
  never: boolean
}

export interface EvidenceGroupSummary {
  mentioned: EvidenceSignalCoverage
  cited: EvidenceSignalCoverage
  mentionGainedProviders: string[]
  mentionLostProviders: string[]
  citationGainedProviders: string[]
  citationLostProviders: string[]
  changeLabels: string[]
  changed: boolean
  hasPriorDateComparison: boolean
  attentionRank: number
}

interface EvidenceGroup {
  key: string
  domId: string
  phrase: string
  location: string | null
  items: CitationInsightVm[]
  summary: EvidenceGroupSummary
}

const QUICK_VIEWS: EvidenceQuickView[] = [
  'all',
  'changed',
  'mention-lost',
  'citation-lost',
  'never-mentioned',
  'never-cited',
]

function evidenceGroupSearchText(group: EvidenceGroup): string {
  return [
    group.phrase,
    group.location ?? '',
    ...group.items.flatMap((item) => [item.provider, item.location ?? '']),
  ].join(' ')
}

/** Project the requested signal onto the shared state vocabulary.
 * Mention and citation remain independent; neither is inferred from the other. */
function deriveStateForMode(
  input: {
    citationState: string
    answerMentioned?: boolean
    mentionState?: string
    visibilityState?: string
  },
  mode: CoverageMode,
): CitationState {
  if (mode === 'citations') return input.citationState as CitationState
  if (input.mentionState === 'mentioned') return 'cited'
  if (input.mentionState === 'not-mentioned') return 'not-cited'
  if (input.mentionState === 'pending') return 'pending'
  if (input.visibilityState === 'pending') return 'pending'
  if (input.answerMentioned == null && input.mentionState == null && input.visibilityState == null) return 'pending'
  const mentioned = input.visibilityState === 'visible' || input.answerMentioned === true
  return mentioned ? 'cited' : 'not-cited'
}

function historyForMode(history: RunHistoryPoint[], mode: CoverageMode): RunHistoryPoint[] {
  if (mode === 'citations') return history
  return history.map(point => ({
    ...point,
    citationState: deriveStateForMode(point, mode),
  }))
}

function isPresentState(state: string): boolean {
  return state === 'cited' || state === 'emerging'
}

function comparisonAcrossSweepDates(projected: RunHistoryPoint[]): {
  latest: RunHistoryPoint | null
  previous: RunHistoryPoint | null
} {
  const datedPoints = projected.map((point, index) => ({
    index,
    point,
    timestamp: Date.parse(point.createdAt),
  }))
  if (datedPoints.some(({ timestamp }) => !Number.isFinite(timestamp))) {
    return { latest: projected.at(-1) ?? null, previous: null }
  }

  datedPoints.sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
  const latestPoint = datedPoints.at(-1) ?? null
  const latest = latestPoint?.point ?? null
  if (!latest) return { latest: null, previous: null }

  const latestDate = new Date(latestPoint!.timestamp).toISOString().slice(0, 10)
  for (let index = datedPoints.length - 2; index >= 0; index -= 1) {
    const candidate = datedPoints[index]!
    const candidateDate = new Date(candidate.timestamp).toISOString().slice(0, 10)
    if (candidateDate !== latestDate) {
      return { latest, previous: candidate.point }
    }
  }
  return { latest, previous: null }
}

function summarizeProjectedSignalHistory(projected: RunHistoryPoint[], mode: CoverageMode): EvidenceSignalSummary {
  const subject = mode === 'mentions' ? 'mention' : 'citation'
  const subjectCap = mode === 'mentions' ? 'Mention' : 'Citation'
  const comparison = comparisonAcrossSweepDates(projected)
  if (!comparison.latest) {
    return { key: mode, label: `${subjectCap} pending`, tone: 'pending' }
  }

  const latest = comparison.latest.citationState
  const previous = comparison.previous?.citationState ?? null
  if (latest === 'pending') {
    return { key: mode, label: `${subjectCap} pending`, tone: 'pending' }
  }
  const isPresent = isPresentState(latest)
  const wasPresent = previous !== null && isPresentState(previous)

  if (previous !== null && wasPresent && !isPresent) {
    return { key: mode, label: `Lost ${subject}`, tone: 'negative' }
  }
  if (previous !== null && !wasPresent && isPresent) {
    return { key: mode, label: `New ${subject}`, tone: 'positive' }
  }
  if (previous === null && isPresent) {
    return { key: mode, label: `First ${subject}`, tone: 'positive' }
  }
  if (isPresent) {
    return { key: mode, label: mode === 'mentions' ? 'Still mentioned' : 'Still cited', tone: 'neutral' }
  }
  return { key: mode, label: `No ${subject}`, tone: 'neutral' }
}

export function summarizeSignalHistory(history: RunHistoryPoint[], mode: CoverageMode): EvidenceSignalSummary {
  return summarizeProjectedSignalHistory(historyForMode(history, mode), mode)
}

function classifySignalChange(history: RunHistoryPoint[], mode: CoverageMode): SignalChange {
  const projected = historyForMode(history, mode)
  if (projected.length < 2) return 'unavailable'

  const comparison = comparisonAcrossSweepDates(projected)
  if (!comparison.latest || !comparison.previous) return 'unavailable'
  const locations = new Set(
    [comparison.previous, comparison.latest].map(point => point.location?.trim() || null),
  )
  if (locations.size > 1) return 'unavailable'
  const latest = comparison.latest.citationState
  const previous = comparison.previous.citationState
  if (latest === 'pending' || previous === 'pending') return 'unavailable'
  const isPresent = isPresentState(latest)
  const wasPresent = isPresentState(previous)

  if (wasPresent && !isPresent) return 'lost'
  if (!wasPresent && isPresent) return 'gained'
  return 'unchanged'
}

function coverageForItems(items: CitationInsightVm[], mode: CoverageMode): EvidenceSignalCoverage {
  const providerItems = items.filter(item => item.provider.trim().length > 0)
  const currentStates = providerItems.map(item => deriveStateForMode(item, mode))
  const observedStates = currentStates.filter(state => state !== 'pending')
  const historicalStates = providerItems.flatMap(item => {
    const history = historyForMode(item.runHistory, mode)
    return history.length > 0
      ? history.map(point => point.citationState)
      : [deriveStateForMode(item, mode)]
  }).filter(state => state !== 'pending')

  return {
    present: observedStates.filter(isPresentState).length,
    observed: observedStates.length,
    expected: providerItems.length,
    never: historicalStates.length > 0 && historicalStates.every(state => !isPresentState(state)),
  }
}

function changedProviders(
  items: CitationInsightVm[],
  mode: CoverageMode,
  change: Extract<SignalChange, 'gained' | 'lost'>,
): string[] {
  return [...new Set(
    items
      .filter(item => item.provider && classifySignalChange(item.runHistory, mode) === change)
      .map(item => item.provider),
  )]
}

function providerLabel(provider: string): string {
  if (!provider) return 'Unknown engine'
  const knownLabels: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Gemini',
    claude: 'Claude',
    perplexity: 'Perplexity',
    local: 'Local',
    zai: 'Z.ai',
    deepinfra: 'DeepInfra',
  }
  if (knownLabels[provider.toLocaleLowerCase()]) return knownLabels[provider.toLocaleLowerCase()]!
  return provider.charAt(0).toLocaleUpperCase() + provider.slice(1)
}

function formatChangeLabel(
  signal: 'Mention' | 'Citation',
  direction: 'gained' | 'lost',
  providers: string[],
): string | null {
  if (providers.length === 0) return null
  if (providers.length === 1) return `${signal} ${direction} on ${providerLabel(providers[0]!)}`
  return `${signal} ${direction} on ${providers.length} engines`
}

export function summarizeEvidenceGroup(items: CitationInsightVm[]): EvidenceGroupSummary {
  const mentioned = coverageForItems(items, 'mentions')
  const cited = coverageForItems(items, 'citations')
  const mentionLostProviders = changedProviders(items, 'mentions', 'lost')
  const citationLostProviders = changedProviders(items, 'citations', 'lost')
  const mentionGainedProviders = changedProviders(items, 'mentions', 'gained')
  const citationGainedProviders = changedProviders(items, 'citations', 'gained')
  const changeLabels = [
    formatChangeLabel('Mention', 'lost', mentionLostProviders),
    formatChangeLabel('Citation', 'lost', citationLostProviders),
    formatChangeLabel('Mention', 'gained', mentionGainedProviders),
    formatChangeLabel('Citation', 'gained', citationGainedProviders),
  ].filter((label): label is string => label !== null)
  const lossCount = mentionLostProviders.length + citationLostProviders.length
  const gainCount = mentionGainedProviders.length + citationGainedProviders.length
  const hasPriorDateComparison = items.some(item => (
    classifySignalChange(item.runHistory, 'mentions') !== 'unavailable'
    || classifySignalChange(item.runHistory, 'citations') !== 'unavailable'
  ))
  const absenceRank = Number(mentioned.observed > 0 && mentioned.present === 0)
    + Number(cited.observed > 0 && cited.present === 0)

  return {
    mentioned,
    cited,
    mentionGainedProviders,
    mentionLostProviders,
    citationGainedProviders,
    citationLostProviders,
    changeLabels,
    changed: changeLabels.length > 0,
    hasPriorDateComparison,
    attentionRank: (lossCount * 100) + (gainCount * 10) + absenceRank,
  }
}

function matchesQuickView(summary: EvidenceGroupSummary, view: EvidenceQuickView): boolean {
  switch (view) {
    case 'all': return true
    case 'changed': return summary.changed
    case 'mention-lost': return summary.mentionLostProviders.length > 0
    case 'citation-lost': return summary.citationLostProviders.length > 0
    case 'never-mentioned': return summary.mentioned.never
    case 'never-cited': return summary.cited.never
  }
}

function quickViewLabel(view: EvidenceQuickView): string {
  switch (view) {
    case 'all': return 'All'
    case 'changed': return 'Changed vs prior recorded day'
    case 'mention-lost': return 'Mention lost'
    case 'citation-lost': return 'Citation lost'
    case 'never-mentioned': return 'No recent mentions'
    case 'never-cited': return 'No recent citations'
  }
}

function quickViewAccessibleLabel(view: EvidenceQuickView): string {
  switch (view) {
    case 'changed': return 'Changed vs prior recorded day'
    case 'mention-lost': return 'Mention lost vs prior recorded day'
    case 'citation-lost': return 'Citation lost vs prior recorded day'
    default: return quickViewLabel(view)
  }
}

function coverageSortValue(coverage: EvidenceSignalCoverage): number {
  return coverage.observed === 0 ? -1 : coverage.present / coverage.observed
}

function compareGroups(
  left: EvidenceGroup,
  right: EvidenceGroup,
  key: EvidenceSortKey,
  direction: SortDirection,
): number {
  const multiplier = direction === 'asc' ? 1 : -1
  let comparison = 0
  switch (key) {
    case 'query':
      comparison = left.phrase.localeCompare(right.phrase)
      break
    case 'mentioned':
      comparison = coverageSortValue(left.summary.mentioned) - coverageSortValue(right.summary.mentioned)
      break
    case 'cited':
      comparison = coverageSortValue(left.summary.cited) - coverageSortValue(right.summary.cited)
      break
    case 'attention':
      comparison = left.summary.attentionRank - right.summary.attentionRank
      break
  }
  return comparison === 0
    ? left.phrase.localeCompare(right.phrase)
    : comparison * multiplier
}

function coverageText(coverage: EvidenceSignalCoverage): string {
  if (coverage.observed === 0) return 'No result'
  return `${coverage.present} of ${coverage.observed}`
}

function coverageReportingText(coverage: EvidenceSignalCoverage): string {
  if (coverage.expected === 0) return 'No results expected'
  if (coverage.observed < coverage.expected) {
    return `${coverage.observed} of ${coverage.expected} results reported`
  }
  return 'all results reported'
}

function coverageDescription(coverage: EvidenceSignalCoverage, verb: 'mentioned' | 'cited'): string {
  if (coverage.observed === 0) return `No engine results have reported whether this query was ${verb}.`
  const pending = coverage.expected - coverage.observed
  return `${coverage.present} of ${coverage.observed} reporting engine results ${verb}${pending > 0 ? `; ${pending} awaiting a result` : ''}.`
}

function currentStatusLabel(state: CitationState, mode: CoverageMode): string {
  if (state === 'pending') return 'No result'
  if (mode === 'mentions') return isPresentState(state) ? 'Mentioned' : 'Not mentioned'
  return isPresentState(state) ? 'Cited' : 'Not cited'
}

function EvidenceSignalValue({
  state,
  mode,
}: {
  state: CitationState
  mode: CoverageMode
}) {
  const tone = state === 'pending' ? 'pending' : isPresentState(state) ? 'present' : 'absent'
  const Icon = tone === 'present' ? Check : tone === 'pending' ? Clock3 : Minus

  return (
    <span className={`evidence-signal-value evidence-signal-value--${tone}`}>
      <Icon aria-hidden="true" />
      <span>
        <span className="sr-only">
          {mode === 'mentions' ? 'Mention status: ' : 'Citation status: '}
        </span>
        {currentStatusLabel(state, mode)}
      </span>
    </span>
  )
}

function changeToneClass(label: string): string {
  if (label.includes('lost')) return 'text-negative'
  if (label.includes('gained')) return 'text-positive'
  return 'text-secondary'
}

function ChangeSummary({
  labels,
  hasPriorDateComparison,
}: {
  labels: string[]
  hasPriorDateComparison: boolean
}) {
  if (labels.length === 0) {
    return (
      hasPriorDateComparison ? (
        <span className="inline-flex items-center gap-1 text-secondary">
          No change
          <InfoTooltip text="No mention or citation changes when each engine's latest result was compared with its most recent result from an earlier UTC day at the same location." />
        </span>
      ) : (
        <span className="text-secondary">No prior-day comparison</span>
      )
    )
  }
  const visibleLabels = labels.slice(0, 2)
  return (
    <div className="space-y-1">
      {visibleLabels.map(label => (
        <p key={label} className={changeToneClass(label)}>{label}</p>
      ))}
      {labels.length > visibleLabels.length ? (
        <p className="text-secondary">+{labels.length - visibleLabels.length} more changes</p>
      ) : null}
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  current,
  direction,
  onSort,
  infoText,
}: {
  label: string
  sortKey: EvidenceSortKey
  current: EvidenceSortKey
  direction: SortDirection
  onSort: (key: EvidenceSortKey) => void
  infoText?: string
}) {
  const active = current === sortKey
  const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown

  return (
    <th scope="col" aria-sort={ariaSort}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className="inline-flex min-h-6 items-center gap-1 rounded text-left hover:text-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-400"
          aria-label={`Sort by ${label}${active ? `, currently ${ariaSort}` : ''}`}
        >
          {label}
          <Icon aria-hidden="true" className={`size-3 ${active ? 'text-secondary' : 'text-faint'}`} />
        </button>
        {infoText ? (
          <span className="inline-flex [&_.info-tooltip-trigger]:size-6 [&_.info-tooltip-trigger]:p-0">
            <InfoTooltip text={infoText} />
          </span>
        ) : null}
      </div>
    </th>
  )
}

export function EvidenceTable({
  evidence,
  compareLocations = false,
  hasTrackedQueries = evidence.length > 0,
}: {
  evidence: CitationInsightVm[]
  compareLocations?: boolean
  hasTrackedQueries?: boolean
}) {
  const { openEvidence } = useDrawer()
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [quickView, setQuickView] = useState<EvidenceQuickView>('all')
  const [sortKey, setSortKey] = useState<EvidenceSortKey>('attention')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const groups = useMemo(() => {
    const map = new Map<string, Omit<EvidenceGroup, 'summary'>>()
    for (const item of evidence) {
      const phrase = item.query
      const location = compareLocations ? (item.location ?? null) : null
      const key = compareLocations ? JSON.stringify([phrase, location]) : phrase
      const existing = map.get(key) ?? {
        key,
        domId: `query-evidence-${map.size + 1}`,
        phrase,
        location,
        items: [],
      }
      existing.items.push(item)
      map.set(key, existing)
    }
    return [...map.values()].map(group => ({
      ...group,
      summary: summarizeEvidenceGroup(group.items),
    }))
  }, [evidence, compareLocations])

  const displayedGroups = useMemo(() => groups
    .filter(group => matchesQuickView(group.summary, quickView))
    .sort((left, right) => compareGroups(left, right, sortKey, sortDirection)),
  [groups, quickView, sortKey, sortDirection])

  const groupsTable = useClientTable({
    rows: displayedGroups,
    getSearchText: evidenceGroupSearchText,
  })

  const searchMatchedGroups = useMemo(
    () => filterClientTableRows(groups, groupsTable.query, evidenceGroupSearchText),
    [groups, groupsTable.query],
  )

  const quickViewCounts = useMemo(() => Object.fromEntries(
    QUICK_VIEWS.map(view => [
      view,
      searchMatchedGroups.filter(group => matchesQuickView(group.summary, view)).length,
    ]),
  ) as Record<EvidenceQuickView, number>, [searchMatchedGroups])

  const toggleRow = (key: string) => {
    setExpandedRows(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleSort = (nextKey: EvidenceSortKey) => {
    groupsTable.setPage(1)
    if (sortKey === nextKey) {
      setSortDirection(previous => previous === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(nextKey)
    setSortDirection(nextKey === 'query' ? 'asc' : 'desc')
  }

  const handleQuickView = (nextView: EvidenceQuickView) => {
    setQuickView(nextView)
    groupsTable.setPage(1)
  }

  const clearFilters = () => {
    setQuickView('all')
    groupsTable.setQuery('')
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-default bg-surface/40 px-5 py-8 text-center">
        <p className="text-sm font-medium text-strong">
          {hasTrackedQueries ? 'No query evidence matches these filters' : 'No queries tracked yet'}
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-secondary">
          {hasTrackedQueries
            ? 'Choose another location or clear the competitor filter to see tracked query evidence.'
            : 'Add queries with Manage queries, then run a sweep to collect mention and citation evidence.'}
        </p>
      </div>
    )
  }

  const hasVisibleRows = groupsTable.totalRows > 0

  return (
    <div>
      <div className="mb-4 grid gap-3">
        <DataTableSearch
          value={groupsTable.query}
          onChange={groupsTable.setQuery}
          label="Search queries, locations, or engines"
          placeholder="Search queries, locations, or engines"
          className="max-w-xl"
        />
        <div className="evidence-quick-views" role="group" aria-label="Query evidence quick views">
          <span className="evidence-quick-views-label">Quick views</span>
          <div className="evidence-quick-view-list">
            {QUICK_VIEWS.map(view => {
              const active = quickView === view
              return (
                <button
                  key={view}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${quickViewAccessibleLabel(view)}, ${quickViewCounts[view]} ${
                    quickViewCounts[view] === 1 ? 'query' : 'queries'
                  }`}
                  disabled={quickViewCounts[view] === 0}
                  onClick={() => handleQuickView(view)}
                  className={`evidence-quick-view ${active ? 'evidence-quick-view--active' : ''}`}
                >
                  <span>{quickViewLabel(view)}</span>
                  <span className="evidence-quick-view-count">
                    {quickViewCounts[view]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {hasVisibleRows ? (
        <div className="evidence-table-wrap" role="region" aria-label="Query evidence table" tabIndex={0}>
          <table className="evidence-table min-w-[980px]">
            <caption className="sr-only">
              Mention and citation results by tracked query. Counts use the most recent recorded
              provider and location result available; results may come from different sweeps.
              Change comparisons use the day's latest result and the most recent result from an
              earlier UTC calendar date. Expanded engine rows show up to 12 recorded UTC dates
              on a shared axis. Within-day reruns are collapsed. Pending results and results from
              different locations are not compared.
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
                <SortHeader
                  label="Mentioned"
                  sortKey="mentioned"
                  current={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                  infoText="Brand or domain appears in the answer text. Counts use each engine and location's most recent recorded result."
                />
                <SortHeader
                  label="Cited"
                  sortKey="cited"
                  current={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                  infoText="Your domain appears in source links. Counts use each engine and location's most recent recorded result."
                />
                <SortHeader
                  label="Change / recent history"
                  sortKey="attention"
                  current={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                  infoText="Query rows compare the latest result with the latest result on the prior recorded UTC date. Engine strips show up to 12 recorded UTC dates. Each column is an observation date, not an elapsed-time interval. Filled square means yes; dash means no; hollow square means pending; blank means no result."
                />
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {groupsTable.rows.map(group => {
                const isExpanded = expandedRows.has(group.key)
                const resultCount = group.items.filter(item => item.provider).length
                const engineCount = new Set(group.items.map(item => item.provider).filter(Boolean)).size
                const recentHistoryById = new Map<string, EvidenceHistoryMatrixData>(
                  group.items.map(item => [
                    item.id,
                    buildRecentRecordedDays(item.runHistory, item.location ?? null, 12),
                  ]),
                )
                const historyDateKeys = recentRecordedDateAxis(
                  [...recentHistoryById.values()],
                  12,
                )
                const detailIds = group.items.map(item => `${group.domId}-${item.id}-engine`)

                return (
                  <Fragment key={group.key}>
                    <tr className="evidence-phrase-row hover:bg-surface">
                      <th scope="row" className="evidence-query-cell min-w-[16rem] text-left">
                        <span className="font-medium text-heading">{group.phrase}</span>
                        <p className="mt-1 text-[11px] text-secondary">
                          {[
                            compareLocations ? (group.location ?? 'No location') : null,
                            resultCount > 0
                              ? resultCount === engineCount
                                ? `${engineCount} ${engineCount === 1 ? 'engine' : 'engines'}`
                                : `${resultCount} results across ${engineCount} ${engineCount === 1 ? 'engine' : 'engines'}`
                              : 'Awaiting first sweep',
                          ].filter(Boolean).join(' · ')}
                        </p>
                      </th>
                      <td>
                        <p
                          className="font-mono text-sm font-semibold tabular-nums text-strong"
                          title={coverageDescription(group.summary.mentioned, 'mentioned')}
                        >
                          {coverageText(group.summary.mentioned)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-secondary">
                          {coverageReportingText(group.summary.mentioned)}
                        </p>
                      </td>
                      <td>
                        <p
                          className="font-mono text-sm font-semibold tabular-nums text-strong"
                          title={coverageDescription(group.summary.cited, 'cited')}
                        >
                          {coverageText(group.summary.cited)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-secondary">
                          {coverageReportingText(group.summary.cited)}
                        </p>
                      </td>
                      <td className="evidence-change-cell min-w-[14rem]">
                        <ChangeSummary
                          labels={group.summary.changeLabels}
                          hasPriorDateComparison={group.summary.hasPriorDateComparison}
                        />
                      </td>
                      <td className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          aria-expanded={isExpanded}
                          aria-controls={detailIds.join(' ')}
                          aria-label={`${isExpanded ? 'Hide' : 'Review'} engines for ${group.phrase}`}
                          onClick={() => toggleRow(group.key)}
                          className="whitespace-nowrap"
                        >
                          {isExpanded ? 'Hide engines' : 'Review engines'}
                          <ChevronRight
                            aria-hidden="true"
                            className={`ml-1 size-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          />
                        </Button>
                      </td>
                    </tr>
                    {isExpanded ? group.items.map(item => {
                      const mentionState = deriveStateForMode(item, 'mentions')
                      const citationState = deriveStateForMode(item, 'citations')
                      const recentHistory = recentHistoryById.get(item.id)!
                      const canReview = item.provider.length > 0 && item.runHistory.length > 0
                      const provider = providerLabel(item.provider)
                      const engineRowId = `${group.domId}-${item.id}-engine`
                      return (
                        <tr
                          key={item.id}
                          id={engineRowId}
                          aria-label={`${provider} result for ${group.phrase}`}
                          className="evidence-engine-row bg-surface-subtle"
                        >
                          <th scope="row" className="evidence-engine-cell min-w-[16rem] text-left">
                            {item.provider ? (
                              <ProviderBadge provider={item.provider} />
                            ) : (
                              <span className="text-xs text-secondary">Awaiting first sweep</span>
                            )}
                            {(item.model || item.location) ? (
                              <p className="mt-1 font-mono text-[10px] text-secondary">
                                {[item.model, item.location].filter(Boolean).join(' · ')}
                              </p>
                            ) : null}
                          </th>
                          <td>
                            <EvidenceSignalValue state={mentionState} mode="mentions" />
                          </td>
                          <td>
                            <EvidenceSignalValue state={citationState} mode="citations" />
                          </td>
                          <td className="evidence-history-cell min-w-[14rem]">
                            <EvidenceHistoryStrip
                              provider={provider}
                              data={recentHistory}
                              dateKeys={historyDateKeys}
                            />
                          </td>
                          <td className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              disabled={!canReview}
                              aria-label={canReview
                                ? `Review ${provider} answer and history for ${group.phrase}`
                                : `No answer available for ${group.phrase}`}
                              onClick={() => { if (canReview) void openEvidence(item.id) }}
                              className="whitespace-nowrap"
                            >
                              Answer + history
                            </Button>
                          </td>
                        </tr>
                      )
                    }) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-default bg-surface/30 px-5 py-8 text-center">
          <p className="text-sm font-medium text-strong">No queries match this view</p>
          <p className="mt-1 text-xs text-secondary">Clear the search or quick view to see all tracked queries.</p>
          <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}

      <DataTablePagination
        page={groupsTable.page}
        pageSize={groupsTable.pageSize}
        visibleRows={groupsTable.rows.length}
        totalRows={groupsTable.totalRows}
        onPageChange={groupsTable.setPage}
        itemLabel={groupsTable.hasQuery || quickView !== 'all'
          ? 'matches'
          : compareLocations
            ? 'query locations with evidence'
            : 'queries with evidence'}
      />
      <p className="sr-only" aria-live="polite">
        Showing {groupsTable.totalRows} of {groups.length}{' '}
        {compareLocations ? 'query locations' : 'queries'} with evidence.
      </p>
    </div>
  )
}
