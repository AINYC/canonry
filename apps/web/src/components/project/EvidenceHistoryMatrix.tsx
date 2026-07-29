import { Check, Clock3, Minus } from 'lucide-react'

import type { CitationState } from '../../view-models.js'

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
  const Icon = status.tone === 'present' ? Check : status.tone === 'pending' ? Clock3 : Minus
  const toneClass = status.tone === 'present'
    ? 'text-positive'
    : status.tone === 'pending'
      ? 'text-faint'
      : 'text-muted'

  return (
    <span className="inline-grid grid-cols-[1rem_auto] items-center gap-1.5 text-xs text-secondary">
      <Icon aria-hidden="true" className={`size-3.5 ${toneClass}`} />
      <span className="sr-only">{status.label}</span>
      <span aria-hidden="true">{status.short}</span>
    </span>
  )
}

function unavailableMessage(status: EvidenceHistoryMatrixData['status']): string | null {
  if (status === 'mixed-locations') return 'Choose a location to view comparable history.'
  if (status === 'no-comparable-history') return 'No comparable dated history for this location.'
  return null
}

export function EvidenceHistoryMatrix({
  id,
  provider,
  data,
}: {
  id: string
  provider: string
  data: EvidenceHistoryMatrixData
}) {
  if (data.status === 'empty') return null

  if (data.status !== 'ready') {
    return (
      <div id={id} className="col-span-5 ml-3 border-t border-mono-800/40 pt-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-secondary">
          Recent recorded days
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
  const titleId = `${id}-title`
  const noteId = `${id}-note`
  const gridStyle = {
    gridTemplateColumns: `minmax(6.5rem, 1fr) repeat(${days.length}, minmax(5.25rem, 6.5rem))`,
  }

  return (
    <figure id={id} className="col-span-5 ml-3 border-t border-mono-800/40 pt-3">
      <figcaption>
        <p id={titleId} className="text-xs font-semibold uppercase tracking-[0.14em] text-secondary">
          Recent recorded days
        </p>
        <p id={noteId} className="mt-0.5 text-xs text-secondary">
          {range} · latest result per day · {shownText}
        </p>
      </figcaption>
      <div className="mt-2 max-w-2xl overflow-x-auto pb-1">
        <div
          role="table"
          aria-label={`Recent recorded days for ${provider}${data.location ? `, ${data.location}` : ''}`}
          aria-describedby={noteId}
          className="min-w-[28rem]"
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
