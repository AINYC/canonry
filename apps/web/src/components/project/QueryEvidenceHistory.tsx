import { useEffect, useRef, useState } from 'react'

import { ProviderBadge } from '../shared/ProviderBadge.js'
import type { RunHistoryPoint } from '../../view-models.js'

export type QueryHistorySignal = 'mentions' | 'citations'
export type QueryHistoryObservation = 'present' | 'absent' | 'pending' | 'not-recorded'

export interface QueryHistorySeries {
  key: string
  provider: string
  location: string | null
  history: RunHistoryPoint[]
}

export interface QueryHistorySelection {
  seriesKey: string
  provider: string
  location: string | null
  dateKey: string
  run: RunHistoryPoint
}

interface DatedRun {
  run: RunHistoryPoint
  timestamp: number
}

interface RecordedDay {
  dateKey: string
  runs: DatedRun[]
  latest: DatedRun
}

function normalizeLocation(location?: string | null): string | null {
  return location?.trim() || null
}

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`)
}

function shortUtcDate(key: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(key))
}

function fullUtcDate(key: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(key))
}

export function historyObservation(
  run: RunHistoryPoint,
  signal: QueryHistorySignal,
): QueryHistoryObservation {
  if (signal === 'citations') {
    if (run.citationState === 'cited' || run.citationState === 'emerging') return 'present'
    if (run.citationState === 'not-cited' || run.citationState === 'lost') return 'absent'
    if (run.citationState === 'pending') return 'pending'
    return 'not-recorded'
  }

  if (run.mentionState === 'mentioned') return 'present'
  if (run.mentionState === 'not-mentioned') return 'absent'
  if (run.mentionState === 'pending') return 'pending'
  if (run.visibilityState === 'visible') return 'present'
  if (run.visibilityState === 'not-visible') return 'absent'
  if (run.visibilityState === 'pending') return 'pending'
  if (run.answerMentioned === true) return 'present'
  if (run.answerMentioned === false) return 'absent'
  return 'not-recorded'
}

function observationLabel(
  observation: QueryHistoryObservation,
  signal: QueryHistorySignal,
): string {
  if (observation === 'pending') return 'Pending'
  if (observation === 'not-recorded') return 'Not recorded'
  if (signal === 'mentions') return observation === 'present' ? 'Mentioned' : 'Not mentioned'
  return observation === 'present' ? 'Cited' : 'Not cited'
}

function recordedDays(history: RunHistoryPoint[]): RecordedDay[] {
  const dated = history
    .map((run, index) => ({
      index,
      run,
      timestamp: Date.parse(run.createdAt),
    }))
    .filter(entry => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)

  const byDate = new Map<string, DatedRun[]>()
  for (const entry of dated) {
    const key = dateKey(entry.timestamp)
    const runs = byDate.get(key) ?? []
    runs.push({ run: entry.run, timestamp: entry.timestamp })
    byDate.set(key, runs)
  }

  return [...byDate.entries()].map(([key, runs]) => ({
    dateKey: key,
    runs,
    latest: runs.at(-1)!,
  }))
}

export function queryHistoryDateAxis(
  series: QueryHistorySeries[],
  maxDays: number,
  offsetFromLatest = 0,
): {
  dateKeys: string[]
  hiddenDayCount: number
  hiddenEarlierDayCount: number
  hiddenLaterDayCount: number
  totalDayCount: number
} {
  const allKeys = [...new Set(
    series.flatMap(item => recordedDays(item.history).map(day => day.dateKey)),
  )].sort()
  const windowSize = Math.max(1, maxDays)
  const offset = Math.min(
    Math.max(0, offsetFromLatest),
    Math.max(0, allKeys.length - 1),
  )
  const end = Math.max(0, allKeys.length - offset)
  const start = Math.max(0, end - windowSize)
  const hiddenEarlierDayCount = start
  const hiddenLaterDayCount = allKeys.length - end
  return {
    dateKeys: allKeys.slice(start, end),
    hiddenDayCount: hiddenEarlierDayCount + hiddenLaterDayCount,
    hiddenEarlierDayCount,
    hiddenLaterDayCount,
    totalDayCount: allKeys.length,
  }
}

function seriesLabel(series: QueryHistorySeries): string {
  return [
    series.provider || 'Unknown engine',
    normalizeLocation(series.location),
  ].filter(Boolean).join(', ')
}

export function QueryEvidenceHistory({
  series,
  signal,
  maxDays,
  canNavigateHistory = false,
  selectedSeriesKey,
  selectedRunId,
  onSelect,
}: {
  series: QueryHistorySeries[]
  signal: QueryHistorySignal
  maxDays: number
  canNavigateHistory?: boolean
  selectedSeriesKey: string | null
  selectedRunId: string | null
  onSelect: (selection: QueryHistorySelection) => void
}) {
  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const [offsetFromLatest, setOffsetFromLatest] = useState(0)
  const allDateKeys = queryHistoryDateAxis(
    series,
    Number.MAX_SAFE_INTEGER,
  ).dateKeys
  const allDatesKey = allDateKeys.join('|')
  const {
    dateKeys,
    hiddenDayCount,
    hiddenEarlierDayCount,
    hiddenLaterDayCount,
    totalDayCount,
  } = queryHistoryDateAxis(series, maxDays, offsetFromLatest)
  const dateAxisKey = dateKeys.join('|')
  const daysBySeries = new Map(
    series.map(item => [
      item.key,
      new Map(recordedDays(item.history).map(day => [day.dateKey, day])),
    ]),
  )

  useEffect(() => {
    setOffsetFromLatest(0)
  }, [allDatesKey, maxDays])

  useEffect(() => {
    const selected = scrollRegionRef.current?.querySelector<HTMLElement>(
      '.query-history-value--selected',
    )
    if (typeof selected?.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [dateAxisKey, selectedRunId, selectedSeriesKey])

  if (dateKeys.length === 0) {
    return (
      <div className="query-history-empty">
        No dated engine results have been recorded for this query.
      </div>
    )
  }

  const signalLabel = signal === 'mentions' ? 'Mention history' : 'Citation history'

  return (
    <div
      ref={scrollRegionRef}
      className="query-history-table-wrap"
      role="region"
      aria-label={`${signalLabel} by engine`}
      tabIndex={0}
    >
      <table className="query-history-table">
        <caption className="sr-only">
          {signalLabel}. Dates and times are shown in UTC. Each cell uses the latest
          result recorded for that engine on that date. Select a cell to inspect the
          exact answer and source evidence; dates with multiple runs expose each run
          after selection.
        </caption>
        <thead>
          <tr>
            <th scope="col">Engine</th>
            {dateKeys.map(key => (
              <th key={key} scope="col">
                <span>{shortUtcDate(key)}</span>
                <span className="query-history-timezone">UTC</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map(item => {
            const days = daysBySeries.get(item.key)!
            return (
              <tr key={item.key}>
                <th scope="row">
                  <ProviderBadge provider={item.provider} />
                  {normalizeLocation(item.location) ? (
                    <span className="query-history-location">{item.location}</span>
                  ) : null}
                </th>
                {dateKeys.map(key => {
                  const day = days.get(key)
                  if (!day) {
                    return (
                      <td key={key}>
                        <span
                          className="query-history-value query-history-value--not-recorded"
                          aria-label={`${seriesLabel(item)}, ${fullUtcDate(key)}: not recorded`}
                        >
                          Not recorded
                        </span>
                      </td>
                    )
                  }

                  const observation = historyObservation(day.latest.run, signal)
                  const label = observationLabel(observation, signal)
                  const selected = item.key === selectedSeriesKey && day.runs.some(
                    entry => entry.run.runId === selectedRunId,
                  )
                  const runCount = day.runs.length
                  return (
                    <td key={key}>
                      <button
                        type="button"
                        className={[
                          'query-history-value',
                          `query-history-value--${observation}`,
                          selected ? 'query-history-value--selected' : '',
                        ].filter(Boolean).join(' ')}
                        aria-pressed={selected}
                        aria-label={[
                          seriesLabel(item),
                          `${fullUtcDate(key)} UTC`,
                          label,
                          `${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
                        ].join(', ')}
                        onClick={() => onSelect({
                          seriesKey: item.key,
                          provider: item.provider,
                          location: normalizeLocation(item.location),
                          dateKey: key,
                          run: day.latest.run,
                        })}
                      >
                        <span>{label}</span>
                        {runCount > 1 ? (
                          <span className="query-history-run-count">
                            {runCount} runs
                          </span>
                        ) : null}
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      {hiddenDayCount > 0 ? (
        <p className="sr-only">
          {hiddenEarlierDayCount} earlier and {hiddenLaterDayCount} later dates are
          currently outside this view.
        </p>
      ) : null}
      {canNavigateHistory && totalDayCount > dateKeys.length ? (
        <div className="query-history-pagination" aria-label="Navigate recorded dates">
          <button
            type="button"
            disabled={hiddenEarlierDayCount === 0}
            onClick={() => setOffsetFromLatest(previous => previous + maxDays)}
          >
            Earlier dates
          </button>
          <span>
            {fullUtcDate(dateKeys[0]!)}–{fullUtcDate(dateKeys.at(-1)!)}
          </span>
          <button
            type="button"
            disabled={hiddenLaterDayCount === 0}
            onClick={() => setOffsetFromLatest(previous => Math.max(0, previous - maxDays))}
          >
            Later dates
          </button>
        </div>
      ) : null}
    </div>
  )
}
