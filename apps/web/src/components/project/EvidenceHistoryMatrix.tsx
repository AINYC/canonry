import type { CitationState, RunHistoryPoint } from '../../view-models.js'

export interface EvidenceHistoryDay {
  dateKey: string
  resultCount: number
  mentionState: CitationState
  citationState: CitationState
}

export type EvidenceHistoryMatrixData =
  | {
      status: 'ready'
      days: EvidenceHistoryDay[]
      totalRecordedDays: number
      location: string | null
    }
  | {
      status: 'mixed-locations' | 'no-comparable-history' | 'empty'
      days: []
      totalRecordedDays: 0
    }

function normalizedHistoryLocation(location?: string | null): string | null {
  return location?.trim() || null
}

function deriveHistoryState(
  input: {
    citationState: string
    answerMentioned?: boolean
    mentionState?: string
    visibilityState?: string
  },
  mode: 'mentions' | 'citations',
): CitationState {
  if (mode === 'citations') return input.citationState as CitationState
  if (input.mentionState === 'mentioned') return 'cited'
  if (input.mentionState === 'not-mentioned') return 'not-cited'
  if (input.mentionState === 'pending') return 'pending'
  if (input.visibilityState === 'pending') return 'pending'
  if (input.answerMentioned == null && input.mentionState == null && input.visibilityState == null) {
    return 'pending'
  }
  return input.visibilityState === 'visible' || input.answerMentioned === true
    ? 'cited'
    : 'not-cited'
}

export function buildRecentRecordedDays(
  history: RunHistoryPoint[],
  currentLocation: string | null,
  maxDays = 12,
): EvidenceHistoryMatrixData {
  const datedPoints = history
    .map((point, index) => ({
      index,
      point,
      timestamp: Date.parse(point.createdAt),
      location: normalizedHistoryLocation(point.location),
    }))
    .filter(point => Number.isFinite(point.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)

  if (datedPoints.length === 0) {
    return { status: 'empty', days: [], totalRecordedDays: 0 }
  }

  const targetLocation = normalizedHistoryLocation(currentLocation)
  const locations = new Set(datedPoints.map(point => point.location))
  let comparablePoints = datedPoints

  if (targetLocation !== null) {
    comparablePoints = datedPoints.filter(point => point.location === targetLocation)
    if (comparablePoints.length === 0) {
      return { status: 'no-comparable-history', days: [], totalRecordedDays: 0 }
    }
  } else if (locations.size > 1) {
    return { status: 'mixed-locations', days: [], totalRecordedDays: 0 }
  }

  const byDate = new Map<string, {
    dateKey: string
    resultCount: number
    latest: RunHistoryPoint
  }>()
  for (const entry of comparablePoints) {
    const dateKey = new Date(entry.timestamp).toISOString().slice(0, 10)
    const existing = byDate.get(dateKey)
    byDate.set(dateKey, {
      dateKey,
      resultCount: (existing?.resultCount ?? 0) + 1,
      latest: entry.point,
    })
  }

  const allDays = [...byDate.values()]
  const shownDays = allDays.slice(-Math.max(1, maxDays))
  const resolvedLocation = targetLocation
    ?? (locations.size === 1 ? [...locations][0]! : null)
  return {
    status: 'ready',
    totalRecordedDays: allDays.length,
    location: resolvedLocation,
    days: shownDays.map(day => ({
      dateKey: day.dateKey,
      resultCount: day.resultCount,
      mentionState: deriveHistoryState(day.latest, 'mentions'),
      citationState: deriveHistoryState(day.latest, 'citations'),
    })),
  }
}

export function recentRecordedDateAxis(
  histories: EvidenceHistoryMatrixData[],
  maxDays = 12,
): string[] {
  return [...new Set(
    histories.flatMap(history => history.status === 'ready'
      ? history.days.map(day => day.dateKey)
      : []),
  )].sort().slice(-Math.max(1, maxDays))
}

function dateFromKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`)
}

function shortDate(dateKey: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(dateKey))
}

function fullDate(dateKey: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromKey(dateKey))
}

function historyStatus(
  state: CitationState,
  mode: 'mentions' | 'citations',
): {
  short: 'Yes' | 'No' | 'Pending'
  label: string
  tone: 'present' | 'absent' | 'pending'
} {
  if (state === 'pending') {
    return {
      short: 'Pending',
      label: mode === 'mentions' ? 'Mention result pending' : 'Citation result pending',
      tone: 'pending',
    }
  }
  const present = state === 'cited' || state === 'emerging'
  if (present) {
    return {
      short: 'Yes',
      label: mode === 'mentions' ? 'Mentioned' : 'Cited',
      tone: 'present',
    }
  }
  return {
    short: 'No',
    label: mode === 'mentions' ? 'Not mentioned' : 'Not cited',
    tone: 'absent',
  }
}

function HistoryValue({
  state,
  mode,
}: {
  state: CitationState
  mode: 'mentions' | 'citations'
}) {
  const status = historyStatus(state, mode)
  const toneClass = status.tone === 'present'
    ? 'text-strong'
    : status.tone === 'pending'
      ? 'text-faint'
      : 'text-muted'

  return (
    <span aria-label={status.label} className={`text-xs ${toneClass}`}>
      <span aria-hidden="true">{status.short}</span>
    </span>
  )
}

function unavailableMessage(status: EvidenceHistoryMatrixData['status']): string | null {
  if (status === 'mixed-locations') return 'Choose a location to view comparable history.'
  if (status === 'no-comparable-history') return 'No comparable dated history for this location.'
  return null
}

function stripStatusLabel(state: CitationState, mode: 'mentions' | 'citations'): string {
  return historyStatus(state, mode).label
}

function StripTrack({
  label,
  mode,
  daysByDate,
  dateKeys,
}: {
  label: string
  mode: 'mentions' | 'citations'
  daysByDate: Map<string, EvidenceHistoryDay>
  dateKeys: string[]
}) {
  return (
    <div className="evidence-history-strip-track" aria-hidden="true">
      <span className="evidence-history-strip-label">{label}</span>
      <span className="evidence-history-strip-marks">
        {dateKeys.map(dateKey => {
          const day = daysByDate.get(dateKey)
          const state = day?.[mode === 'mentions' ? 'mentionState' : 'citationState']
          const symbol = state === undefined
            ? ''
            : state === 'pending'
              ? '□'
              : state === 'cited' || state === 'emerging'
                ? '■'
                : '–'
          const title = day
            ? `${fullDate(dateKey)}: ${stripStatusLabel(state!, mode)}; ${day.resultCount} ${day.resultCount === 1 ? 'result' : 'results'}`
            : `${fullDate(dateKey)}: no result`
          return (
            <span
              key={dateKey}
              title={title}
              className={`evidence-history-strip-mark ${
                state === undefined
                  ? 'evidence-history-strip-mark--missing'
                  : state === 'pending'
                    ? 'evidence-history-strip-mark--pending'
                    : state === 'cited' || state === 'emerging'
                      ? 'evidence-history-strip-mark--present'
                      : 'evidence-history-strip-mark--absent'
              }`}
            >
              {symbol}
            </span>
          )
        })}
      </span>
    </div>
  )
}

export function EvidenceHistoryStrip({
  provider,
  data,
  dateKeys,
}: {
  provider: string
  data: EvidenceHistoryMatrixData
  dateKeys: string[]
}) {
  if (data.status !== 'ready' || dateKeys.length === 0) {
    return (
      <span className="text-[11px] text-secondary">
        {unavailableMessage(data.status) ?? 'No recorded history'}
      </span>
    )
  }

  const daysByDate = new Map(data.days.map(day => [day.dateKey, day]))
  const summary = dateKeys.map(dateKey => {
    const day = daysByDate.get(dateKey)
    if (!day) return `${fullDate(dateKey)}: no result`
    return [
      `${fullDate(dateKey)}: ${stripStatusLabel(day.mentionState, 'mentions')}`,
      stripStatusLabel(day.citationState, 'citations'),
      `${day.resultCount} ${day.resultCount === 1 ? 'result' : 'results'}`,
    ].join(', ')
  }).join('; ')

  return (
    <div
      role="img"
      aria-label={`Recent recorded days for ${provider}. ${summary}`}
      className="evidence-history-strip"
    >
      <StripTrack
        label="Mention"
        mode="mentions"
        daysByDate={daysByDate}
        dateKeys={dateKeys}
      />
      <StripTrack
        label="Cited"
        mode="citations"
        daysByDate={daysByDate}
        dateKeys={dateKeys}
      />
    </div>
  )
}

export function EvidenceHistoryMatrix({
  id,
  provider,
  data,
  title = 'Recorded-day trend',
  className,
}: {
  id: string
  provider: string
  data: EvidenceHistoryMatrixData
  title?: string
  className?: string
}) {
  if (data.status === 'empty') return null

  if (data.status !== 'ready') {
    return (
      <div id={id} className={className}>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-secondary">
          {title}
        </p>
        <p className="mt-1 text-xs text-secondary">{unavailableMessage(data.status)}</p>
      </div>
    )
  }

  const days = data.days
  const latestIndex = days.length - 1
  const firstDate = shortDate(days[0]!.dateKey)
  const lastDate = shortDate(days[latestIndex]!.dateKey)
  const range = firstDate === lastDate ? `${firstDate} UTC` : `${firstDate} to ${lastDate} UTC`
  const shownText = data.totalRecordedDays > days.length
    ? `showing ${days.length} of ${data.totalRecordedDays} recorded days`
    : `${data.totalRecordedDays} recorded ${data.totalRecordedDays === 1 ? 'day' : 'days'}`
  const noteId = `${id}-note`
  const gridStyle = {
    gridTemplateColumns: `minmax(6rem, 1fr) repeat(${days.length}, minmax(3.75rem, 1fr))`,
  }

  return (
    <figure id={id} className={className}>
      <figcaption>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-secondary">
          {title}
        </p>
        <p id={noteId} className="mt-0.5 text-xs text-secondary">
          {range} · latest result per UTC date · same-day runs collapsed · {shownText}
        </p>
      </figcaption>
      <div className="mt-2 overflow-x-auto pb-1">
        <div
          role="table"
          aria-label={`${title} for ${provider}${data.location ? `, ${data.location}` : ''}`}
          aria-describedby={noteId}
          className="min-w-[22rem]"
        >
          <div role="rowgroup">
            <div role="row" className="grid items-end" style={gridStyle}>
              <span role="columnheader">
                <span className="sr-only">Signal</span>
              </span>
              {days.map((day, index) => (
                <span
                  key={day.dateKey}
                  role="columnheader"
                  className="border-l border-mono-800/50 px-3 pb-1.5 text-left"
                >
                  <time
                    dateTime={day.dateKey}
                    aria-label={`${fullDate(day.dateKey)} UTC`}
                    className="block text-xs font-medium text-strong"
                  >
                    {shortDate(day.dateKey)}
                  </time>
                  <span className="mt-0.5 block text-xs font-normal text-secondary">
                    {day.resultCount} {day.resultCount === 1 ? 'result' : 'results'}
                    {index === latestIndex ? ' · Latest' : ''}
                  </span>
                </span>
              ))}
            </div>
          </div>
          <div role="rowgroup" className="border-t border-mono-800/40">
            <div role="row" className="grid items-center" style={gridStyle}>
              <span role="rowheader" className="py-1.5 text-xs font-medium text-secondary">
                Mentioned
              </span>
              {days.map(day => (
                <span
                  key={day.dateKey}
                  role="cell"
                  className="border-l border-mono-800/50 px-3 py-1.5"
                >
                  <HistoryValue state={day.mentionState} mode="mentions" />
                </span>
              ))}
            </div>
            <div role="row" className="grid items-center border-t border-mono-800/30" style={gridStyle}>
              <span role="rowheader" className="py-1.5 text-xs font-medium text-secondary">
                Cited
              </span>
              {days.map(day => (
                <span
                  key={day.dateKey}
                  role="cell"
                  className="border-l border-mono-800/50 px-3 py-1.5"
                >
                  <HistoryValue state={day.citationState} mode="citations" />
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </figure>
  )
}
