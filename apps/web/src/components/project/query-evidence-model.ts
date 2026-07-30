import type { CitationInsightVm, RunHistoryPoint } from '../../view-models.js'

export type QueryEvidenceSignal = 'citation' | 'mention'
export type QueryEvidenceChangeDirection = 'gained' | 'lost'

export interface QueryEvidenceChange {
  evidenceId: string
  provider: string
  providerLabel: string
  location: string | null
  signal: QueryEvidenceSignal
  direction: QueryEvidenceChangeDirection
  observedAt: string
  copy: string
}

export interface QueryEvidenceGroupModel {
  key: string
  query: string
  location: string | null
  items: CitationInsightVm[]
  latestObservedAt: string | null
  hasPriorComparison: boolean
  changed: boolean
  hasLoss: boolean
  changeCount: number
  lossCount: number
  changes: QueryEvidenceChange[]
  representativeEvidenceId: string | null
  representativeProvider: string | null
  representativeProviderLabel: string | null
  representativeSignal: QueryEvidenceSignal | null
  representativeDirection: QueryEvidenceChangeDirection | null
  eventCopy: string
}

type ObservedState = 'present' | 'absent' | 'pending' | 'unavailable'

interface DatedHistoryPoint {
  point: RunHistoryPoint
  timestamp: number
  dateKey: string
}

function normalizedLocation(location?: string | null): string | null {
  return location?.trim() || null
}

function providerDisplayName(provider: string): string {
  const normalized = provider.trim().toLocaleLowerCase()
  const knownLabels: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Gemini',
    claude: 'Claude',
    perplexity: 'Perplexity',
    local: 'Local',
    zai: 'Z.ai',
    deepinfra: 'DeepInfra',
  }
  if (knownLabels[normalized]) return knownLabels[normalized]!
  if (!normalized) return 'Unknown engine'
  const trimmed = provider.trim()
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1)
}

function citationState(point: RunHistoryPoint): ObservedState {
  if (point.citationState === 'cited' || point.citationState === 'emerging') return 'present'
  if (point.citationState === 'not-cited' || point.citationState === 'lost') return 'absent'
  if (point.citationState === 'pending') return 'pending'
  return 'unavailable'
}

function mentionState(point: RunHistoryPoint): ObservedState {
  if (point.mentionState === 'mentioned') return 'present'
  if (point.mentionState === 'not-mentioned') return 'absent'
  if (point.mentionState === 'pending') return 'pending'
  if (point.visibilityState === 'visible') return 'present'
  if (point.visibilityState === 'not-visible') return 'absent'
  if (point.visibilityState === 'pending') return 'pending'
  if (point.answerMentioned === true) return 'present'
  if (point.answerMentioned === false) return 'absent'
  return 'unavailable'
}

function datedHistory(history: RunHistoryPoint[]): DatedHistoryPoint[] {
  return history
    .map((point, index) => {
      const timestamp = Date.parse(point.createdAt)
      return {
        index,
        point,
        timestamp,
        dateKey: Number.isFinite(timestamp)
          ? new Date(timestamp).toISOString().slice(0, 10)
          : '',
      }
    })
    .filter((entry): entry is DatedHistoryPoint & { index: number } => (
      Number.isFinite(entry.timestamp)
    ))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
}

function compareRecordedDays(
  history: RunHistoryPoint[],
): { latest: DatedHistoryPoint; previous: DatedHistoryPoint } | null {
  const dated = datedHistory(history)
  const latest = dated.at(-1)
  if (!latest) return null

  let previous: DatedHistoryPoint | undefined
  for (let index = dated.length - 2; index >= 0; index -= 1) {
    const candidate = dated[index]!
    if (candidate.dateKey !== latest.dateKey) {
      previous = candidate
      break
    }
  }
  if (!previous) return null

  if (normalizedLocation(previous.point.location) !== normalizedLocation(latest.point.location)) {
    return null
  }
  return { latest, previous }
}

function changeDirection(
  comparison: { latest: DatedHistoryPoint; previous: DatedHistoryPoint },
  signal: QueryEvidenceSignal,
): QueryEvidenceChangeDirection | null {
  const stateForSignal = signal === 'citation' ? citationState : mentionState
  const latest = stateForSignal(comparison.latest.point)
  const previous = stateForSignal(comparison.previous.point)
  if (
    (latest !== 'present' && latest !== 'absent')
    || (previous !== 'present' && previous !== 'absent')
  ) {
    return null
  }
  if (previous === 'present' && latest === 'absent') return 'lost'
  if (previous === 'absent' && latest === 'present') return 'gained'
  return null
}

function eventCopy(
  providerLabel: string,
  location: string | null,
  signal: QueryEvidenceSignal,
  direction: QueryEvidenceChangeDirection,
): string {
  const target = signal === 'citation' ? 'your site' : 'your brand'
  const verb = signal === 'citation' ? 'cites' : 'mentions'
  const timing = direction === 'lost' ? `no longer ${verb}` : `now ${verb}`
  return `${providerLabel} ${timing} ${target}${location ? ` in ${location}` : ''}`
}

function changesForItem(item: CitationInsightVm): QueryEvidenceChange[] {
  const comparison = compareRecordedDays(item.runHistory)
  if (!comparison || !item.provider.trim()) return []

  const providerLabel = providerDisplayName(item.provider)
  const location = normalizedLocation(comparison.latest.point.location)
  return (['citation', 'mention'] as const).flatMap(signal => {
    const direction = changeDirection(comparison, signal)
    if (!direction) return []
    return [{
      evidenceId: item.id,
      provider: item.provider,
      providerLabel,
      location,
      signal,
      direction,
      observedAt: new Date(comparison.latest.timestamp).toISOString(),
      copy: eventCopy(providerLabel, location, signal, direction),
    }]
  })
}

function compareChanges(left: QueryEvidenceChange, right: QueryEvidenceChange): number {
  if (left.direction !== right.direction) return left.direction === 'lost' ? -1 : 1
  const timeDifference = Date.parse(right.observedAt) - Date.parse(left.observedAt)
  if (timeDifference !== 0) return timeDifference
  const providerDifference = left.providerLabel.localeCompare(right.providerLabel)
  if (providerDifference !== 0) return providerDifference
  const locationDifference = (left.location ?? '').localeCompare(right.location ?? '')
  if (locationDifference !== 0) return locationDifference
  if (left.signal !== right.signal) return left.signal === 'citation' ? -1 : 1
  return left.evidenceId.localeCompare(right.evidenceId)
}

function distinctSortedChanges(items: CitationInsightVm[]): QueryEvidenceChange[] {
  const sorted = items.flatMap(changesForItem).sort(compareChanges)
  const seen = new Set<string>()
  return sorted.filter(change => {
    const key = [
      change.provider.trim().toLocaleLowerCase(),
      change.location ?? '',
      change.signal,
      change.direction,
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function summarizeChanges(changes: QueryEvidenceChange[]): string {
  if (changes.length === 0) return ''
  if (changes.length === 1) return changes[0]!.copy
  if (changes.length === 2) return `${changes[0]!.copy}; ${changes[1]!.copy}`
  const remaining = changes.length - 2
  return `${changes[0]!.copy}; ${changes[1]!.copy}; ${remaining} more ${
    remaining === 1 ? 'change' : 'changes'
  }`
}

function hasPriorComparison(items: CitationInsightVm[]): boolean {
  return items.some(item => {
    const comparison = compareRecordedDays(item.runHistory)
    if (!comparison) return false
    return (['citation', 'mention'] as const).some(signal => {
      const stateForSignal = signal === 'citation' ? citationState : mentionState
      const latest = stateForSignal(comparison.latest.point)
      const previous = stateForSignal(comparison.previous.point)
      return (latest === 'present' || latest === 'absent')
        && (previous === 'present' || previous === 'absent')
    })
  })
}

function hasCompletedObservation(items: CitationInsightVm[]): boolean {
  return items.some(item => {
    const latest = datedHistory(item.runHistory).at(-1)
    if (!latest) return false
    return [citationState(latest.point), mentionState(latest.point)].some(
      state => state === 'present' || state === 'absent',
    )
  })
}

function latestObservedAt(items: CitationInsightVm[]): string | null {
  const timestamps = items.flatMap(item => (
    item.runHistory
      .map(point => Date.parse(point.createdAt))
      .filter(Number.isFinite)
  ))
  if (timestamps.length === 0) return null
  return new Date(Math.max(...timestamps)).toISOString()
}

function fallbackRepresentative(items: CitationInsightVm[]): CitationInsightVm | null {
  return [...items]
    .filter(item => item.id && item.provider.trim() && item.runHistory.length > 0)
    .sort((left, right) => {
      const leftTimestamp = Date.parse(latestObservedAt([left]) ?? '')
      const rightTimestamp = Date.parse(latestObservedAt([right]) ?? '')
      const leftRank = Number.isFinite(leftTimestamp) ? leftTimestamp : -1
      const rightRank = Number.isFinite(rightTimestamp) ? rightTimestamp : -1
      return rightRank - leftRank
        || left.provider.localeCompare(right.provider)
        || left.id.localeCompare(right.id)
    })[0] ?? items.find(item => item.id) ?? null
}

export function buildQueryEvidenceGroups(
  evidence: CitationInsightVm[],
  options: { compareLocations?: boolean } = {},
): QueryEvidenceGroupModel[] {
  const byQuery = new Map<string, {
    key: string
    query: string
    location: string | null
    items: CitationInsightVm[]
  }>()
  for (const item of evidence) {
    const location = options.compareLocations ? normalizedLocation(item.location) : null
    const key = options.compareLocations
      ? JSON.stringify([item.query, location])
      : item.query
    const group = byQuery.get(key) ?? {
      key,
      query: item.query,
      location,
      items: [],
    }
    group.items.push(item)
    byQuery.set(key, group)
  }

  return [...byQuery.values()]
    .sort((left, right) => (
      left.query.localeCompare(right.query)
      || (left.location ?? '').localeCompare(right.location ?? '')
    ))
    .map(({ key, query, location, items }) => {
      const changes = distinctSortedChanges(items)
      const representativeChange = changes[0] ?? null
      const fallback = fallbackRepresentative(items)
      const lossCount = changes.filter(change => change.direction === 'lost').length
      const latest = latestObservedAt(items)
      const priorComparison = hasPriorComparison(items)
      const completedObservation = hasCompletedObservation(items)
      const eventCopy = changes.length > 0
        ? summarizeChanges(changes)
        : latest === null
          ? 'Awaiting first result'
          : priorComparison
            ? 'No change from previous result'
            : completedObservation
              ? 'First recorded result'
              : 'Awaiting completed result'
      return {
        key,
        query,
        location,
        items,
        latestObservedAt: latest,
        hasPriorComparison: priorComparison,
        changed: changes.length > 0,
        hasLoss: lossCount > 0,
        changeCount: changes.length,
        lossCount,
        changes,
        representativeEvidenceId: representativeChange?.evidenceId ?? fallback?.id ?? null,
        representativeProvider: representativeChange?.provider ?? fallback?.provider ?? null,
        representativeProviderLabel: representativeChange?.providerLabel
          ?? (fallback ? providerDisplayName(fallback.provider) : null),
        representativeSignal: representativeChange?.signal ?? null,
        representativeDirection: representativeChange?.direction ?? null,
        eventCopy,
      }
    })
}
