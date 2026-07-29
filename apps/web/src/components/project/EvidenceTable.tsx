import { Fragment, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from 'lucide-react'

import { Button } from '../ui/button.js'
import { CitationBadge } from '../shared/CitationBadge.js'
import {
  DataTablePagination,
  DataTableSearch,
  useClientTable,
} from '../shared/DataTableControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
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
type SignalChange = 'gained' | 'lost' | 'none'

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

function summarizeProjectedSignalHistory(projected: RunHistoryPoint[], mode: CoverageMode): EvidenceSignalSummary {
  const subject = mode === 'mentions' ? 'mention' : 'citation'
  const subjectCap = mode === 'mentions' ? 'Mention' : 'Citation'
  if (projected.length === 0) {
    return { key: mode, label: `${subjectCap} pending`, tone: 'pending' }
  }

  const latest = projected[projected.length - 1]!.citationState
  const previous = projected.length >= 2 ? projected[projected.length - 2]!.citationState : null
  if (latest === 'pending') {
    return { key: mode, label: `${subjectCap} pending`, tone: 'pending' }
  }
  const isPresent = isPresentState(latest)
  const wasPresent = previous !== null && isPresentState(previous)

  if (latest === 'lost' || (previous !== null && wasPresent && !isPresent)) {
    return { key: mode, label: `Lost ${subject}`, tone: 'negative' }
  }
  if (latest === 'emerging' || (previous !== null && !wasPresent && isPresent)) {
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
  if (projected.length < 2) return 'none'
  const scopedLocations = new Set(
    projected
      .map(point => point.location)
      .filter((location): location is string => Boolean(location)),
  )
  if (scopedLocations.size > 1) return 'none'

  const latest = projected[projected.length - 1]!.citationState
  const previous = projected[projected.length - 2]!.citationState
  if (latest === 'pending' || previous === 'pending') return 'none'
  const isPresent = isPresentState(latest)
  const wasPresent = isPresentState(previous)

  if (latest === 'lost' || (wasPresent && !isPresent)) return 'lost'
  if (latest === 'emerging' || (!wasPresent && isPresent)) return 'gained'
  return 'none'
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
  change: Exclude<SignalChange, 'none'>,
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
    case 'changed': return 'Changed'
    case 'mention-lost': return 'Mention lost'
    case 'citation-lost': return 'Citation lost'
    case 'never-mentioned': return 'No recent mentions'
    case 'never-cited': return 'No recent citations'
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

function changeToneClass(label: string): string {
  if (label.includes('lost')) return 'text-negative'
  if (label.includes('gained')) return 'text-positive'
  return 'text-secondary'
}

function ChangeSummary({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-secondary">No change</span>
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

function providerChangeLabels(item: CitationInsightVm): string[] {
  const provider = providerLabel(item.provider)
  return [
    classifySignalChange(item.runHistory, 'mentions') === 'lost' ? `Mention lost on ${provider}` : null,
    classifySignalChange(item.runHistory, 'citations') === 'lost' ? `Citation lost on ${provider}` : null,
    classifySignalChange(item.runHistory, 'mentions') === 'gained' ? `Mention gained on ${provider}` : null,
    classifySignalChange(item.runHistory, 'citations') === 'gained' ? `Citation gained on ${provider}` : null,
  ].filter((label): label is string => label !== null)
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

  const quickViewCounts = useMemo(() => Object.fromEntries(
    QUICK_VIEWS.map(view => [view, groups.filter(group => matchesQuickView(group.summary, view)).length]),
  ) as Record<EvidenceQuickView, number>, [groups])

  const displayedGroups = useMemo(() => groups
    .filter(group => matchesQuickView(group.summary, quickView))
    .sort((left, right) => compareGroups(left, right, sortKey, sortDirection)),
  [groups, quickView, sortKey, sortDirection])

  const groupsTable = useClientTable({
    rows: displayedGroups,
    getSearchText: evidenceGroupSearchText,
  })

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
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Query evidence quick views">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-secondary">Quick views</span>
          {QUICK_VIEWS.map(view => {
            const active = quickView === view
            return (
              <button
                key={view}
                type="button"
                aria-pressed={active}
                aria-label={`${quickViewLabel(view)}, ${quickViewCounts[view]} ${
                  quickViewCounts[view] === 1 ? 'query' : 'queries'
                }`}
                onClick={() => handleQuickView(view)}
                className={`filter-chip inline-flex items-center gap-1.5 text-secondary ${active ? 'filter-chip-active' : ''}`}
              >
                {quickViewLabel(view)}
                <span className={`tabular-nums ${active ? 'text-strong' : 'text-secondary'}`}>
                  {quickViewCounts[view]}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {hasVisibleRows ? (
        <div className="evidence-table-wrap" role="region" aria-label="Query evidence table" tabIndex={0}>
          <table className="evidence-table min-w-[860px]">
            <caption className="sr-only">
              Mention and citation results by tracked query. Counts use the most recent recorded
              provider and location result available; results may come from different sweeps.
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
                  label="Change since previous"
                  sortKey="attention"
                  current={sortKey}
                  direction={sortDirection}
                  onSort={handleSort}
                />
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {groupsTable.rows.map(group => {
                const isExpanded = expandedRows.has(group.key)
                const resultCount = group.items.filter(item => item.provider).length
                const engineCount = new Set(group.items.map(item => item.provider).filter(Boolean)).size
                const detailId = `${group.domId}-engines`

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
                        <ChangeSummary labels={group.summary.changeLabels} />
                      </td>
                      <td className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          aria-expanded={isExpanded}
                          aria-controls={detailId}
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
                    {isExpanded ? (
                      <tr id={detailId} className="bg-surface-subtle">
                        <td colSpan={5} className="!p-0">
                          <div role="list" aria-label={`Engine results for ${group.phrase}`} className="divide-y divide-mono-800/40">
                            {group.items.map(item => {
                              const mentionState = deriveStateForMode(item, 'mentions')
                              const citationState = deriveStateForMode(item, 'citations')
                              const changes = providerChangeLabels(item)
                              const canReview = item.provider.length > 0 && item.runHistory.length > 0
                              return (
                                <div
                                  key={item.id}
                                  role="listitem"
                                  className="grid min-w-[820px] grid-cols-[minmax(11rem,1fr)_minmax(8rem,.7fr)_minmax(8rem,.7fr)_minmax(14rem,1.2fr)_auto] items-center gap-4 px-4 py-3"
                                >
                                  <div className="pl-3">
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
                                  </div>
                                  <div>
                                    <CitationBadge
                                      state={mentionState}
                                      label={currentStatusLabel(mentionState, 'mentions')}
                                    />
                                  </div>
                                  <div>
                                    <CitationBadge
                                      state={citationState}
                                      label={currentStatusLabel(citationState, 'citations')}
                                    />
                                  </div>
                                  <div className="text-xs">
                                    <ChangeSummary labels={changes} />
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    disabled={!canReview}
                                    aria-label={canReview
                                      ? `Review ${providerLabel(item.provider)} answer for ${group.phrase}`
                                      : `No answer available for ${group.phrase}`}
                                    onClick={() => { if (canReview) void openEvidence(item.id) }}
                                    className="whitespace-nowrap"
                                  >
                                    Review answer
                                  </Button>
                                </div>
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    ) : null}
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
        itemLabel={groupsTable.hasQuery || quickView !== 'all' ? 'matches' : 'queries'}
      />
      <p className="sr-only" aria-live="polite">
        Showing {groupsTable.totalRows} of {groups.length} tracked queries.
      </p>
    </div>
  )
}
