import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import {
  brandLabelFromDomain,
  effectiveDomains,
  normalizeProjectDomain,
} from '@ainyc/canonry-contracts'

import { Drawer } from './Drawer.js'
import { Button } from '../ui/button.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
import {
  QueryEvidenceHistory,
  type QueryHistorySelection,
  type QueryHistorySeries,
  type QueryHistorySignal,
} from '../project/QueryEvidenceHistory.js'
import { highlightTermsInText, type HighlightTermGroup } from '../../lib/highlight.js'
import { safeExternalUrl } from '../../lib/safe-url.js'
import {
  fetchRunDetail,
  fetchTimeline,
  type ApiTimelineEntry,
  type ApiTimelineRunEntry,
  type GroundingSource,
} from '../../api.js'
import type {
  CitationInsightVm,
  ProjectCommandCenterVm,
  RunHistoryPoint,
} from '../../view-models.js'

export interface EvidenceDisplayData {
  citationState: string
  answerMentioned?: boolean
  mentionState?: string
  visibilityState?: string
  provider: string
  model: string | null
  answerSnippet: string
  citedDomains: string[]
  competitorDomains: string[]
  recommendedCompetitors: string[]
  matchedTerms: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  evidenceUrls: string[]
  summary: string
}

export type MentionResult = 'mentioned' | 'not-mentioned' | 'pending' | 'unknown'
type CitationResult = 'cited' | 'not-cited' | 'pending' | 'unknown'
type DetailTab = 'mentions' | 'sources'

export function resolveMentionResult(
  input: Pick<EvidenceDisplayData, 'answerMentioned' | 'mentionState' | 'visibilityState'>,
): MentionResult {
  if (input.mentionState === 'mentioned') return 'mentioned'
  if (input.mentionState === 'not-mentioned') return 'not-mentioned'
  if (input.mentionState === 'pending') return 'pending'
  if (input.visibilityState === 'pending') return 'pending'
  if (input.visibilityState === 'visible') return 'mentioned'
  if (input.visibilityState === 'not-visible') return 'not-mentioned'
  if (input.answerMentioned === true) return 'mentioned'
  if (input.answerMentioned === false) return 'not-mentioned'
  return 'unknown'
}

function resolveCitationResult(state: string): CitationResult {
  if (state === 'cited' || state === 'emerging') return 'cited'
  if (state === 'not-cited' || state === 'lost') return 'not-cited'
  if (state === 'pending') return 'pending'
  return 'unknown'
}

function mentionLabel(result: MentionResult): string {
  if (result === 'mentioned') return 'Mentioned'
  if (result === 'not-mentioned') return 'Not mentioned'
  if (result === 'pending') return 'Pending'
  return 'Not recorded'
}

function citationLabel(result: CitationResult): string {
  if (result === 'cited') return 'Cited'
  if (result === 'not-cited') return 'Not cited'
  if (result === 'pending') return 'Pending'
  return 'Not recorded'
}

function normalizeLocation(location?: string | null): string | null {
  return location?.trim() || null
}

function seriesKey(provider: string, location?: string | null): string {
  return `${provider.trim().toLocaleLowerCase()}::${normalizeLocation(location) ?? ''}`
}

function toRunHistoryPoint(run: ApiTimelineRunEntry): RunHistoryPoint {
  return {
    runId: run.runId,
    citationState: run.citationState,
    createdAt: run.createdAt,
    location: run.location ?? null,
    answerMentioned: run.answerMentioned,
    visibilityState: run.visibilityState as RunHistoryPoint['visibilityState'] | undefined,
    visibilityTransition: run.visibilityTransition,
    mentionState: run.mentionState as RunHistoryPoint['mentionState'] | undefined,
    mentionTransition: run.mentionTransition,
  }
}

function sortedUniqueHistory(history: RunHistoryPoint[]): RunHistoryPoint[] {
  const byRun = new Map<string, RunHistoryPoint>()
  for (const run of history) {
    byRun.set(`${run.runId}::${run.createdAt}`, run)
  }
  return [...byRun.values()].sort((left, right) => (
    Date.parse(left.createdAt) - Date.parse(right.createdAt)
  ))
}

function recentSeries(items: CitationInsightVm[]): QueryHistorySeries[] {
  const bySeries = new Map<string, QueryHistorySeries>()
  for (const item of items) {
    if (!item.provider.trim()) continue
    if (item.runHistory.length === 0) {
      const location = normalizeLocation(item.location)
      const key = seriesKey(item.provider, location)
      if (!bySeries.has(key)) {
        bySeries.set(key, {
          key,
          provider: item.provider,
          location,
          history: [],
        })
      }
      continue
    }
    for (const run of item.runHistory) {
      const location = normalizeLocation(run.location)
      const key = seriesKey(item.provider, location)
      const existing = bySeries.get(key)
      if (existing) {
        existing.history = sortedUniqueHistory([...existing.history, run])
      } else {
        bySeries.set(key, {
          key,
          provider: item.provider,
          location,
          history: [run],
        })
      }
    }
  }
  return [...bySeries.values()].sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || (left.location ?? '').localeCompare(right.location ?? '')
  ))
}

function fullSeries(entry: ApiTimelineEntry): QueryHistorySeries[] {
  const bySeries = new Map<string, QueryHistorySeries>()
  for (const [provider, runs] of Object.entries(entry.providerRuns ?? {})) {
    for (const apiRun of runs) {
      const run = toRunHistoryPoint(apiRun)
      const location = normalizeLocation(run.location)
      const key = seriesKey(provider, location)
      const existing = bySeries.get(key)
      if (existing) {
        existing.history.push(run)
      } else {
        bySeries.set(key, {
          key,
          provider,
          location,
          history: [run],
        })
      }
    }
  }
  return [...bySeries.values()]
    .map(series => ({ ...series, history: sortedUniqueHistory(series.history) }))
    .sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || (left.location ?? '').localeCompare(right.location ?? '')
    ))
}

function latestRun(history: RunHistoryPoint[]): RunHistoryPoint | null {
  return [...history]
    .filter(run => Number.isFinite(Date.parse(run.createdAt)))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .at(-1) ?? null
}

function latestRunForLocation(
  history: RunHistoryPoint[],
  location: string | null,
): RunHistoryPoint | null {
  return latestRun(history.filter(
    run => normalizeLocation(run.location) === normalizeLocation(location),
  ))
}

function displayFromEvidence(evidence: CitationInsightVm): EvidenceDisplayData {
  return {
    citationState: evidence.citationState,
    answerMentioned: evidence.answerMentioned,
    visibilityState: evidence.visibilityState,
    provider: evidence.provider,
    model: evidence.model,
    answerSnippet: evidence.answerSnippet,
    citedDomains: evidence.citedDomains,
    competitorDomains: evidence.competitorDomains,
    recommendedCompetitors: evidence.recommendedCompetitors ?? [],
    matchedTerms: evidence.matchedTerms ?? [],
    groundingSources: evidence.groundingSources,
    searchQueries: evidence.searchQueries ?? [],
    evidenceUrls: evidence.evidenceUrls,
    summary: evidence.summary,
  }
}

function emptyDisplay(
  provider: string,
  run: RunHistoryPoint,
  summary: string,
): EvidenceDisplayData {
  return {
    citationState: run.citationState,
    answerMentioned: run.answerMentioned,
    mentionState: run.mentionState,
    visibilityState: run.visibilityState,
    provider,
    model: run.model ?? null,
    answerSnippet: '',
    citedDomains: [],
    competitorDomains: [],
    recommendedCompetitors: [],
    matchedTerms: [],
    groundingSources: [],
    searchQueries: [],
    evidenceUrls: [],
    summary,
  }
}

function utcDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Date not recorded'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)
}

function utcTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Time not recorded'
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)
}

function runDateKey(run: RunHistoryPoint): string {
  const timestamp = Date.parse(run.createdAt)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : ''
}

function evidenceForSeries(
  items: CitationInsightVm[],
  provider: string,
  location: string | null,
): CitationInsightVm | null {
  return items.find(item => (
    item.provider.toLocaleLowerCase() === provider.toLocaleLowerCase()
    && normalizeLocation(item.location) === normalizeLocation(location)
  )) ?? null
}

function signalStateClass(value: MentionResult | CitationResult): string {
  if (value === 'mentioned' || value === 'cited') return 'evidence-signal-result--present'
  if (value === 'not-mentioned' || value === 'not-cited') return 'evidence-signal-result--absent'
  return 'evidence-signal-result--missing'
}

export function EvidenceDetailModal({
  evidence,
  evidenceGroup: evidenceGroupProp,
  initialSignal = 'citations',
  locationScope,
  project,
  onClose,
}: {
  evidence: CitationInsightVm
  evidenceGroup?: CitationInsightVm[]
  initialSignal?: QueryHistorySignal
  locationScope?: string
  project: ProjectCommandCenterVm
  onClose: () => void
}) {
  const evidenceGroup = useMemo(
    () => evidenceGroupProp ?? [evidence],
    [evidenceGroupProp, evidence],
  )
  const initialSeries = useMemo(() => recentSeries(evidenceGroup), [evidenceGroup])
  const initialRun = latestRunForLocation(
    evidence.runHistory,
    normalizeLocation(evidence.location),
  ) ?? latestRun(evidence.runHistory)
  const initialLocation = initialRun
    ? normalizeLocation(initialRun.location)
    : normalizeLocation(evidence.location)
  const initialSeriesKey = seriesKey(evidence.provider, initialLocation)

  const [signal, setSignal] = useState<QueryHistorySignal>(initialSignal)
  const [detailTab, setDetailTab] = useState<DetailTab>(
    initialSignal === 'citations' ? 'sources' : 'mentions',
  )
  const [series, setSeries] = useState<QueryHistorySeries[]>(initialSeries)
  const [selectedSeriesKey, setSelectedSeriesKey] = useState(initialSeriesKey)
  const [selectedProvider, setSelectedProvider] = useState(evidence.provider)
  const [selectedLocation, setSelectedLocation] = useState<string | null>(initialLocation)
  const [selectedRun, setSelectedRun] = useState<RunHistoryPoint | null>(initialRun)
  const [selectedDateKey, setSelectedDateKey] = useState(
    initialRun ? runDateKey(initialRun) : '',
  )
  const [display, setDisplay] = useState<EvidenceDisplayData>(() => displayFromEvidence(evidence))
  const [runLoading, setRunLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runErrorTone, setRunErrorTone] = useState<'notice' | 'error'>('error')
  const [runLoadAttempt, setRunLoadAttempt] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [fullHistoryLoaded, setFullHistoryLoaded] = useState(false)
  const [showFullAnswer, setShowFullAnswer] = useState(false)

  useEffect(() => {
    const nextSeries = recentSeries(evidenceGroup)
    const nextRun = latestRunForLocation(
      evidence.runHistory,
      normalizeLocation(evidence.location),
    ) ?? latestRun(evidence.runHistory)
    const nextLocation = nextRun
      ? normalizeLocation(nextRun.location)
      : normalizeLocation(evidence.location)
    setSignal(initialSignal)
    setDetailTab(initialSignal === 'citations' ? 'sources' : 'mentions')
    setSeries(nextSeries)
    setSelectedSeriesKey(seriesKey(evidence.provider, nextLocation))
    setSelectedProvider(evidence.provider)
    setSelectedLocation(nextLocation)
    setSelectedRun(nextRun)
    setSelectedDateKey(nextRun ? runDateKey(nextRun) : '')
    setDisplay(displayFromEvidence(evidence))
    setRunError(null)
    setRunErrorTone('error')
    setRunLoadAttempt(0)
    setHistoryError(null)
    setFullHistoryLoaded(false)
    setShowFullAnswer(false)
  }, [evidence.id, evidence, evidenceGroup, initialSignal])

  useEffect(() => {
    if (!selectedRun) return
    let cancelled = false
    const matchingEvidence = evidenceForSeries(
      evidenceGroup,
      selectedProvider,
      selectedLocation,
    )
    const isMatchingLatest = matchingEvidence
      ? latestRunForLocation(
        matchingEvidence.runHistory,
        selectedLocation,
      )?.runId === selectedRun.runId
      : false
    if (matchingEvidence && isMatchingLatest) {
      setDisplay(displayFromEvidence(matchingEvidence))
    }
    setRunLoading(true)
    setRunError(null)
    setRunErrorTone('error')

    fetchRunDetail(selectedRun.runId)
      .then(runDetail => {
        if (cancelled) return
        const snapshot = runDetail.snapshots?.find(candidate => (
          candidate.query === evidence.query
          && candidate.provider.toLocaleLowerCase() === selectedProvider.toLocaleLowerCase()
          && normalizeLocation(candidate.location) === selectedLocation
        ))
        if (!snapshot) {
          setDisplay(emptyDisplay(
            selectedProvider,
            selectedRun,
            'No answer was recorded for this engine and run.',
          ))
          return
        }
        setDisplay({
          citationState: snapshot.citationState,
          answerMentioned: snapshot.answerMentioned,
          mentionState: snapshot.mentionState,
          visibilityState: snapshot.visibilityState,
          provider: snapshot.provider,
          model: snapshot.model ?? null,
          answerSnippet: snapshot.answerText ?? '',
          citedDomains: snapshot.citedDomains ?? [],
          competitorDomains: snapshot.competitorOverlap ?? [],
          recommendedCompetitors: snapshot.recommendedCompetitors ?? [],
          matchedTerms: snapshot.matchedTerms ?? [],
          groundingSources: snapshot.groundingSources ?? [],
          searchQueries: snapshot.searchQueries ?? [],
          evidenceUrls: [],
          summary: '',
        })
      })
      .catch(() => {
        if (cancelled) return
        setRunError(isMatchingLatest
          ? 'Showing the saved answer. A fresh copy could not be loaded.'
          : 'The exact answer could not be loaded. The recorded signal is still shown.')
        setRunErrorTone(isMatchingLatest ? 'notice' : 'error')
        if (!isMatchingLatest) {
          setDisplay(emptyDisplay(
            selectedProvider,
            selectedRun,
            'The exact answer could not be loaded for this run.',
          ))
        }
      })
      .finally(() => {
        if (!cancelled) setRunLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [
    evidence.query,
    evidenceGroup,
    selectedLocation,
    selectedProvider,
    selectedRun,
    runLoadAttempt,
  ])

  const loadFullHistory = async () => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const entries = locationScope === undefined
        ? await fetchTimeline(project.project.name)
        : await fetchTimeline(project.project.name, locationScope)
      const entry = entries.find(candidate => candidate.query === evidence.query)
      if (!entry) {
        setHistoryError('No additional history was found for this query.')
        return
      }
      const loadedSeries = fullSeries(entry)
      if (loadedSeries.length === 0) {
        setHistoryError('No additional engine history was found for this query.')
        return
      }
      setSeries(loadedSeries)
      setFullHistoryLoaded(true)
    } catch {
      setHistoryError('Full history could not be loaded. Recent results remain available.')
    } finally {
      setHistoryLoading(false)
    }
  }

  const selectHistory = (selection: QueryHistorySelection) => {
    setSelectedSeriesKey(selection.seriesKey)
    setSelectedProvider(selection.provider)
    setSelectedLocation(selection.location)
    setSelectedDateKey(selection.dateKey)
    setSelectedRun(selection.run)
    setDisplay(emptyDisplay(
      selection.provider,
      selection.run,
      'Loading the exact answer for this result.',
    ))
    setRunLoading(true)
    setRunError(null)
    setShowFullAnswer(false)
  }

  const selectedSeries = series.find(item => item.key === selectedSeriesKey) ?? null
  const sameDayRuns = selectedSeries
    ? selectedSeries.history
      .filter(run => runDateKey(run) === selectedDateKey)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    : []

  const mentionResult = resolveMentionResult(display)
  const citationResult = resolveCitationResult(display.citationState)

  const projectDomains = effectiveDomains(project.project)
  const myDomains = new Set(projectDomains.map(normalizeProjectDomain))
  const projectDisplayName = project.project.displayName || project.project.name
  const brandTerms = [
    ...projectDomains.map(normalizeProjectDomain),
    projectDisplayName,
    projectDisplayName.split(' ').slice(0, 2).join(' '),
    ...display.matchedTerms,
  ].filter(term => term.trim().length > 2)
  const competitorHighlightTerms = [
    ...display.competitorDomains.flatMap(domain => {
      const brand = brandLabelFromDomain(domain)
      return brand.length >= 4 ? [brand] : []
    }),
    ...display.recommendedCompetitors,
  ].filter(term => term.trim().length > 2)
  const highlightTermGroups: HighlightTermGroup[] = [
    { terms: brandTerms, className: 'answer-highlight-brand' },
    ...(competitorHighlightTerms.length > 0
      ? [{ terms: competitorHighlightTerms, className: 'answer-highlight-competitor' }]
      : []),
  ]

  const renderHighlightedAnswer = () => {
    if (!display.answerSnippet) return null
    const lines = display.answerSnippet.split('\n')
    const elements: ReactNode[] = []
    let paragraph: string[] = []
    let key = 0

    const flushParagraph = () => {
      if (paragraph.length === 0) return
      const text = paragraph.join(' ').trim()
      if (text) {
        elements.push(
          <p key={key++} className={elements.length > 0 ? 'mt-2.5' : ''}>
            {highlightTermsInText(text, highlightTermGroups)}
          </p>,
        )
      }
      paragraph = []
    }

    for (const raw of lines) {
      const line = raw.trim()
      const heading = line.match(/^#{1,3}\s+(\S.*)$/)
      if (heading) {
        flushParagraph()
        elements.push(
          <p key={key++} className="mt-3 text-xs font-semibold text-strong">
            {highlightTermsInText(heading[1], highlightTermGroups)}
          </p>,
        )
      } else if (line === '') {
        flushParagraph()
      } else {
        paragraph.push(line)
      }
    }
    flushParagraph()
    return elements
  }

  const competitorEvidence = [...new Set([
    ...display.recommendedCompetitors,
    ...display.competitorDomains.map(domain => domain.replace(/^www\./, '')),
  ])]

  return (
    <Drawer
      open
      title={evidence.query}
      subtitle={`${project.project.name} · Query evidence`}
      onClose={onClose}
      className="query-evidence-drawer"
    >
      <section className="query-evidence-history" aria-labelledby="query-history-heading">
        <div className="query-evidence-history-head">
          <div>
            <p id="query-history-heading" className="drawer-section-label mb-1">History</p>
            <p className="text-xs text-secondary">
              Compare engines on the same dated axis. Times are shown in UTC.
            </p>
          </div>
          <div className="query-signal-selector" role="group" aria-label="History signal">
            {(['citations', 'mentions'] as const).map(nextSignal => (
              <button
                key={nextSignal}
                type="button"
                className={`query-signal-option ${signal === nextSignal ? 'query-signal-option--active' : ''}`}
                aria-pressed={signal === nextSignal}
                onClick={() => {
                  setSignal(nextSignal)
                }}
              >
                {nextSignal === 'citations' ? 'Citation history' : 'Mention history'}
              </button>
            ))}
          </div>
        </div>

        <QueryEvidenceHistory
          series={series}
          signal={signal}
          maxDays={12}
          canNavigateHistory={fullHistoryLoaded}
          selectedSeriesKey={selectedSeriesKey}
          selectedRunId={selectedRun?.runId ?? null}
          onSelect={selectHistory}
        />

        <div className="query-history-actions">
          {!fullHistoryLoaded ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={historyLoading}
              onClick={() => { void loadFullHistory() }}
            >
              {historyLoading ? 'Loading full history…' : 'Load full history'}
            </Button>
          ) : (
            <span className="text-xs text-secondary">Full history loaded</span>
          )}
          {historyError ? (
            <span className="text-xs text-negative" role="alert">{historyError}</span>
          ) : null}
        </div>
      </section>

      {sameDayRuns.length > 1 ? (
        <section className="same-day-runs" aria-label="Runs recorded on selected date">
          <span className="same-day-runs-label">Runs on this date</span>
          {sameDayRuns.map(run => (
            <button
              key={`${run.runId}:${run.createdAt}`}
              type="button"
              className={`same-day-run ${selectedRun?.runId === run.runId ? 'same-day-run--active' : ''}`}
              aria-pressed={selectedRun?.runId === run.runId}
              onClick={() => {
                setSelectedRun(run)
                setDisplay(emptyDisplay(
                  selectedProvider,
                  run,
                  'Loading the exact answer for this result.',
                ))
                setRunLoading(true)
                setRunError(null)
                setShowFullAnswer(false)
              }}
            >
              {utcTime(run.createdAt)}
            </button>
          ))}
        </section>
      ) : null}

      <section className="query-evidence-selection" aria-busy={runLoading}>
        <div className="query-evidence-selection-head">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderBadge provider={selectedProvider} />
            <span className="truncate text-xs text-secondary">
              {[
                display.model,
                selectedLocation,
                selectedRun ? utcDateTime(selectedRun.createdAt) : null,
              ].filter(Boolean).join(' · ')}
            </span>
          </div>
          {runLoading ? (
            <span className="text-xs text-secondary" role="status">Loading exact answer…</span>
          ) : null}
        </div>

        {runError ? (
          <div
            className={runErrorTone === 'notice'
              ? 'query-evidence-inline-notice'
              : 'query-evidence-inline-error'}
            role={runErrorTone === 'notice' ? 'status' : 'alert'}
          >
            <span>{runError}</span>
            <button type="button" onClick={() => setRunLoadAttempt(previous => previous + 1)}>
              Retry
            </button>
          </div>
        ) : null}

        <div className="query-evidence-detail-grid">
          <div className="query-evidence-answer">
            <p className="drawer-section-label">Full answer</p>
            {runLoading ? (
              <div className="query-evidence-no-answer" role="status">
                Loading exact answer…
              </div>
            ) : display.answerSnippet ? (
              <>
                <div className={`answer-snippet-block ${showFullAnswer ? 'evidence-answer-expanded' : 'evidence-answer-collapsed'}`}>
                  {renderHighlightedAnswer()}
                </div>
                {display.answerSnippet.length > 280 ? (
                  <button
                    type="button"
                    className="mt-2 text-xs text-secondary transition-colors hover:text-strong"
                    onClick={() => setShowFullAnswer(previous => !previous)}
                  >
                    {showFullAnswer ? 'Collapse answer' : 'Show full answer'}
                  </button>
                ) : null}
              </>
            ) : (
              <div className="query-evidence-no-answer">
                No answer recorded for this engine and run.
              </div>
            )}

            {display.searchQueries.length > 0 ? (
              <div className="query-evidence-searches">
                <div className="drawer-section-label flex items-center">
                  <span>Web searches used</span>
                  <InfoTooltip text="Searches this engine issued while researching the query." />
                </div>
                <ul>
                  {display.searchQueries.map((query, index) => (
                    <li key={`${index}:${query}`}>
                      <Search className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
                      <span>{query}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <aside className="query-evidence-breakdown" aria-label="Selected answer breakdown">
            <div>
              <p className="drawer-section-label">Signal results</p>
              <dl className="evidence-signal-results">
                <div>
                  <dt>Mention</dt>
                  <dd className={signalStateClass(mentionResult)}>
                    {mentionLabel(mentionResult)}
                  </dd>
                </div>
                <div>
                  <dt>Citation</dt>
                  <dd className={signalStateClass(citationResult)}>
                    {citationLabel(citationResult)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="evidence-detail-tabs" role="group" aria-label="Evidence breakdown">
              <button
                type="button"
                aria-pressed={detailTab === 'mentions'}
                className={`evidence-detail-tab ${detailTab === 'mentions' ? 'evidence-detail-tab--active' : ''}`}
                onClick={() => setDetailTab('mentions')}
              >
                Answer mentions
              </button>
              <button
                type="button"
                aria-pressed={detailTab === 'sources'}
                className={`evidence-detail-tab ${detailTab === 'sources' ? 'evidence-detail-tab--active' : ''}`}
                onClick={() => setDetailTab('sources')}
              >
                Source links
              </button>
            </div>

            {detailTab === 'mentions' ? (
              <div className="query-evidence-tab-panel">
                {display.matchedTerms.length > 0 ? (
                  <>
                    <p className="drawer-section-label">Matched in answer</p>
                    <ul className="query-evidence-simple-list">
                      {display.matchedTerms.map(term => <li key={term}>{term}</li>)}
                    </ul>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-secondary">
                    {mentionResult === 'not-mentioned'
                      ? 'No tracked brand or owned-domain term was found in this answer.'
                      : mentionResult === 'unknown'
                        ? 'Mention data was not recorded for this run.'
                        : 'No matched terms were recorded.'}
                  </p>
                )}
              </div>
            ) : (
              <div className="query-evidence-tab-panel">
                {display.citedDomains.length > 0 ? (
                  <>
                    <p className="drawer-section-label">Domains from source links</p>
                    <ol className="query-evidence-domain-list">
                      {display.citedDomains.map((domain, index) => {
                        const normalized = normalizeProjectDomain(domain)
                        return (
                          <li key={`${index}:${domain}`}>
                            <span>{domain}</span>
                            {myDomains.has(normalized) ? <span className="text-positive">Your domain</span> : null}
                          </li>
                        )
                      })}
                    </ol>
                  </>
                ) : null}

                {display.groundingSources.length > 0 ? (
                  <>
                    <p className="drawer-section-label mt-4">Source links</p>
                    <ul className="query-evidence-source-list">
                      {display.groundingSources.map((source, index) => {
                        const href = safeExternalUrl(source.uri)
                        const label = source.title || source.uri
                        return (
                          <li key={`${index}:${source.uri}`}>
                            {href ? (
                              <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                            ) : (
                              <span>{label}</span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                ) : null}

                {display.citedDomains.length === 0 && display.groundingSources.length === 0 ? (
                  <p className="text-xs leading-relaxed text-secondary">
                    No source links were recorded for this engine and run.
                  </p>
                ) : null}
              </div>
            )}

            {competitorEvidence.length > 0 ? (
              <div>
                <p className="drawer-section-label">Competitor evidence</p>
                <ul className="query-evidence-simple-list">
                  {competitorEvidence.map(item => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ) : null}
          </aside>
        </div>

        {display.summary ? (
          <p className="border-t border-subtle pt-3 text-xs text-secondary">{display.summary}</p>
        ) : null}
      </section>
    </Drawer>
  )
}
