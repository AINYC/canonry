import { expect, test } from 'vitest'

import {
  summarizeEvidenceGroup,
  summarizeSignalHistory,
} from '../src/components/project/EvidenceTable.js'
import {
  buildRecentRecordedDays,
  recentRecordedDateAxis,
} from '../src/components/project/EvidenceHistoryMatrix.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'

function point(overrides: Partial<RunHistoryPoint>): RunHistoryPoint {
  return {
    runId: overrides.runId ?? 'run',
    createdAt: overrides.createdAt ?? '2026-06-01T00:00:00Z',
    citationState: overrides.citationState ?? 'not-cited',
    answerMentioned: overrides.answerMentioned,
    visibilityState: overrides.visibilityState,
    ...overrides,
  }
}

function item(
  history: RunHistoryPoint[],
  overrides: Partial<CitationInsightVm> = {},
): CitationInsightVm {
  const latest = history.at(-1)
  return {
    id: crypto.randomUUID(),
    query: 'test query',
    provider: 'gemini',
    model: null,
    location: null,
    citationState: latest?.citationState ?? 'pending',
    answerMentioned: latest?.answerMentioned,
    visibilityState: latest?.visibilityState,
    changeLabel: '',
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    runHistory: history,
    ...overrides,
  } as CitationInsightVm
}

test('summarizeSignalHistory detects a new mention independently from citation state', () => {
  const history = [
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'not-cited', answerMentioned: true }),
  ]

  expect(summarizeSignalHistory(history, 'mentions')).toMatchObject({ label: 'New mention', tone: 'positive' })
  expect(summarizeSignalHistory(history, 'citations')).toMatchObject({ label: 'No citation', tone: 'neutral' })
})

test('summarizeSignalHistory detects a new citation without treating it as a mention', () => {
  const history = [
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'cited', answerMentioned: false }),
  ]

  expect(summarizeSignalHistory(history, 'mentions')).toMatchObject({ label: 'No mention', tone: 'neutral' })
  expect(summarizeSignalHistory(history, 'citations')).toMatchObject({ label: 'New citation', tone: 'positive' })
})

test('summarizeSignalHistory reads canonical mention state without citation inference', () => {
  const history = [
    point({
      runId: 'r1',
      citationState: 'cited',
      mentionState: 'not-mentioned',
      answerMentioned: undefined,
      visibilityState: undefined,
    }),
    point({
      runId: 'r2',
      createdAt: '2026-06-02T00:00:00Z',
      citationState: 'cited',
      mentionState: 'mentioned',
      answerMentioned: undefined,
      visibilityState: undefined,
    }),
  ]

  expect(summarizeSignalHistory(history, 'mentions')).toMatchObject({ label: 'New mention', tone: 'positive' })
  expect(summarizeSignalHistory(history, 'citations')).toMatchObject({ label: 'Still cited', tone: 'neutral' })
})

test('summarizeEvidenceGroup keeps mention and citation changes explicit by engine', () => {
  const losingGemini = item([
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'cited', answerMentioned: true }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
  ])
  const gainingOpenAi = item([
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'cited', answerMentioned: true }),
  ], { provider: 'openai' })

  const summary = summarizeEvidenceGroup([losingGemini, gainingOpenAi])

  expect(summary.mentioned).toMatchObject({ present: 1, observed: 2, expected: 2 })
  expect(summary.cited).toMatchObject({ present: 1, observed: 2, expected: 2 })
  expect(summary.mentionLostProviders).toEqual(['gemini'])
  expect(summary.citationLostProviders).toEqual(['gemini'])
  expect(summary.mentionGainedProviders).toEqual(['openai'])
  expect(summary.citationGainedProviders).toEqual(['openai'])
  expect(summary.changeLabels).toEqual([
    'Mention lost on Gemini',
    'Citation lost on Gemini',
    'Mention gained on OpenAI',
    'Citation gained on OpenAI',
  ])
})

test('never-mentioned and never-cited exclude queries awaiting their first result', () => {
  const pending = item([], {
    provider: '',
    citationState: 'pending',
    visibilityState: 'pending',
  })
  const neverPresent = item([
    point({ runId: 'r1', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
  ])

  expect(summarizeEvidenceGroup([pending]).mentioned.never).toBe(false)
  expect(summarizeEvidenceGroup([pending]).cited.never).toBe(false)
  expect(summarizeEvidenceGroup([neverPresent]).mentioned.never).toBe(true)
  expect(summarizeEvidenceGroup([neverPresent]).cited.never).toBe(true)
})

test('coverage counts reporting engines without treating unknown results as absent', () => {
  const reported = item([
    point({ citationState: 'cited', answerMentioned: true }),
  ], { provider: 'gemini' })
  const unknown = item([
    point({ citationState: 'pending', visibilityState: 'pending' }),
  ], { provider: 'openai', answerMentioned: undefined })

  const summary = summarizeEvidenceGroup([reported, unknown])

  expect(summary.mentioned).toEqual({ present: 1, observed: 1, expected: 2, never: false })
  expect(summary.cited).toEqual({ present: 1, observed: 1, expected: 2, never: false })
})

test('pending observations do not create false mention or citation changes', () => {
  const awaitingLatest = item([
    point({ runId: 'r1', citationState: 'cited', answerMentioned: true }),
    point({
      runId: 'r2',
      createdAt: '2026-06-02T00:00:00Z',
      citationState: 'pending',
      visibilityState: 'pending',
    }),
  ])

  const summary = summarizeEvidenceGroup([awaitingLatest])

  expect(summary.changeLabels).toEqual([])
  expect(summary.changed).toBe(false)
  expect(summarizeSignalHistory(awaitingLatest.runHistory, 'mentions')).toMatchObject({
    label: 'Mention pending',
    tone: 'pending',
  })
  expect(summarizeSignalHistory(awaitingLatest.runHistory, 'citations')).toMatchObject({
    label: 'Citation pending',
    tone: 'pending',
  })
})

test('cross-location provider history does not create false sequential changes', () => {
  const mixedLocations = item([
    point({
      runId: 'r1',
      citationState: 'cited',
      answerMentioned: true,
      location: 'florida',
    }),
    point({
      runId: 'r2',
      createdAt: '2026-06-01T00:00:00Z',
      citationState: 'not-cited',
      answerMentioned: false,
      location: 'michigan',
    }),
  ])

  expect(summarizeEvidenceGroup([mixedLocations]).changeLabels).toEqual([])
})

test.each([
  ['unscoped to scoped', null, 'florida'],
  ['scoped to unscoped', 'florida', null],
] as const)('%s history does not create false changes', (_label, from, to) => {
  const mixedLocations = item([
    point({
      runId: 'r1',
      createdAt: '2026-06-01T00:00:00Z',
      citationState: 'cited',
      answerMentioned: true,
      location: from,
    }),
    point({
      runId: 'r2',
      createdAt: '2026-06-02T00:00:00Z',
      citationState: 'not-cited',
      answerMentioned: false,
      location: to,
    }),
  ])

  const summary = summarizeEvidenceGroup([mixedLocations])
  expect(summary.changeLabels).toEqual([])
  expect(summary.changed).toBe(false)
  expect(summary.hasPriorDateComparison).toBe(false)
})

test('a legacy location transition does not suppress later same-location comparisons', () => {
  const stableScopedHistory = item([
    point({
      runId: 'legacy-unscoped',
      createdAt: '2026-06-01T00:00:00Z',
      citationState: 'cited',
      answerMentioned: true,
      location: null,
    }),
    point({
      runId: 'prior-scoped',
      createdAt: '2026-06-02T00:00:00Z',
      citationState: 'cited',
      answerMentioned: true,
      location: 'florida',
    }),
    point({
      runId: 'latest-scoped',
      createdAt: '2026-06-03T00:00:00Z',
      citationState: 'not-cited',
      answerMentioned: false,
      location: 'florida',
    }),
  ])

  const summary = summarizeEvidenceGroup([stableScopedHistory])
  expect(summary.changeLabels).toEqual([
    'Mention lost on Gemini',
    'Citation lost on Gemini',
  ])
  expect(summary.hasPriorDateComparison).toBe(true)
})

test('same-day reruns do not create a prior-day comparison', () => {
  const sameDayNoise = item([
    point({
      runId: 'r1',
      createdAt: '2026-06-02T17:39:00Z',
      citationState: 'cited',
      answerMentioned: true,
    }),
    point({
      runId: 'r2',
      createdAt: '2026-06-02T17:51:00Z',
      citationState: 'not-cited',
      answerMentioned: false,
    }),
  ])

  const summary = summarizeEvidenceGroup([sameDayNoise])
  expect(summary.changeLabels).toEqual([])
  expect(summary.changed).toBe(false)
  expect(summary.hasPriorDateComparison).toBe(false)
})

test('latest state is compared with the prior recorded day, not the previous run', () => {
  const revertedWithinDay = item([
    point({
      runId: 'prior-day',
      createdAt: '2026-06-01T17:39:00Z',
      citationState: 'not-cited',
      answerMentioned: false,
    }),
    point({
      runId: 'same-day-gain',
      createdAt: '2026-06-02T17:39:00Z',
      citationState: 'cited',
      answerMentioned: true,
    }),
    point({
      runId: 'same-day-loss',
      createdAt: '2026-06-02T17:51:00Z',
      citationState: 'lost',
      answerMentioned: false,
    }),
  ])

  const summary = summarizeEvidenceGroup([revertedWithinDay])
  expect(summary.changeLabels).toEqual([])
  expect(summary.changed).toBe(false)
  expect(summary.hasPriorDateComparison).toBe(true)
})

test('recent recorded days collapse same-day results and keep mention and citation independent', () => {
  const history = [
    point({
      runId: 'latest',
      createdAt: '2026-06-29T17:51:00Z',
      citationState: 'not-cited',
      answerMentioned: true,
    }),
    point({
      runId: 'first-day',
      createdAt: '2026-06-22T17:39:00Z',
      citationState: 'not-cited',
      answerMentioned: false,
    }),
    point({
      runId: 'same-day-earlier',
      createdAt: '2026-06-29T17:39:00Z',
      citationState: 'cited',
      answerMentioned: false,
    }),
  ]

  const result = buildRecentRecordedDays(history, null)
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error('Expected comparable history')
  expect(result.totalRecordedDays).toBe(2)
  expect(result.days).toEqual([
    {
      dateKey: '2026-06-22',
      resultCount: 1,
      mentionState: 'not-cited',
      citationState: 'not-cited',
    },
    {
      dateKey: '2026-06-29',
      resultCount: 2,
      mentionState: 'cited',
      citationState: 'not-cited',
    },
  ])
})

test('recent recorded days show only the current location when legacy history mixes scopes', () => {
  const history = [
    point({
      runId: 'legacy-unscoped',
      createdAt: '2026-06-01T00:00:00Z',
      location: null,
    }),
    point({
      runId: 'florida-one',
      createdAt: '2026-06-02T00:00:00Z',
      location: 'florida',
    }),
    point({
      runId: 'florida-two',
      createdAt: '2026-06-03T00:00:00Z',
      location: 'florida',
    }),
  ]

  const scoped = buildRecentRecordedDays(history, 'florida')
  expect(scoped.status).toBe('ready')
  if (scoped.status !== 'ready') throw new Error('Expected scoped history')
  expect(scoped.location).toBe('florida')
  expect(scoped.days.map(day => day.dateKey)).toEqual(['2026-06-02', '2026-06-03'])

  expect(buildRecentRecordedDays(history, null)).toEqual({
    status: 'mixed-locations',
    days: [],
    totalRecordedDays: 0,
  })
})

test('recent recorded days retain only the latest bounded date columns', () => {
  const history = Array.from({ length: 6 }, (_, index) => point({
    runId: `r${index + 1}`,
    createdAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    citationState: index % 2 === 0 ? 'cited' : 'not-cited',
    answerMentioned: index % 2 === 0,
  }))

  const result = buildRecentRecordedDays(history, null, 4)
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error('Expected recent history')
  expect(result.totalRecordedDays).toBe(6)
  expect(result.days.map(day => day.dateKey)).toEqual([
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-06',
  ])
})

test('recent recorded day axes align engines and preserve missing observation columns', () => {
  const gemini = buildRecentRecordedDays([
    point({ runId: 'g1', createdAt: '2026-06-01T00:00:00Z' }),
    point({ runId: 'g3', createdAt: '2026-06-03T00:00:00Z' }),
  ], null)
  const openai = buildRecentRecordedDays([
    point({ runId: 'o2', createdAt: '2026-06-02T00:00:00Z' }),
    point({ runId: 'o3', createdAt: '2026-06-03T00:00:00Z' }),
  ], null)

  expect(recentRecordedDateAxis([gemini, openai])).toEqual([
    '2026-06-01',
    '2026-06-02',
    '2026-06-03',
  ])
})
