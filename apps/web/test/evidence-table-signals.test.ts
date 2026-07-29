import { expect, test } from 'vitest'

import {
  summarizeEvidenceGroup,
  summarizeSignalHistory,
} from '../src/components/project/EvidenceTable.js'
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
