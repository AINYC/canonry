import { expect, test } from 'vitest'

import {
  historyObservation,
  queryHistoryDateAxis,
} from '../src/components/project/QueryEvidenceHistory.js'
import {
  buildQueryEvidenceGroups,
} from '../src/components/project/query-evidence-model.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'

function point(overrides: Partial<RunHistoryPoint> = {}): RunHistoryPoint {
  return {
    runId: overrides.runId ?? 'run',
    createdAt: overrides.createdAt ?? '2026-06-01T12:00:00Z',
    citationState: overrides.citationState ?? 'not-cited',
    ...overrides,
  }
}

function item(history: RunHistoryPoint[], overrides: Partial<CitationInsightVm> = {}): CitationInsightVm {
  return {
    id: overrides.id ?? 'evidence',
    query: overrides.query ?? 'best local dentist',
    provider: overrides.provider ?? 'gemini',
    model: null,
    location: overrides.location ?? null,
    citationState: overrides.citationState ?? 'not-cited',
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

test('history keeps mention and citation observations independent', () => {
  const run = point({
    citationState: 'cited',
    mentionState: 'not-mentioned',
    answerMentioned: false,
  })

  expect(historyObservation(run, 'citations')).toBe('present')
  expect(historyObservation(run, 'mentions')).toBe('absent')
})

test('missing mention data is not coerced into pending or absent', () => {
  const run = point({ citationState: 'cited' })

  expect(historyObservation(run, 'mentions')).toBe('not-recorded')
  expect(historyObservation(run, 'citations')).toBe('present')
})

test('explicit pending data remains pending', () => {
  const run = point({
    citationState: 'pending',
    mentionState: 'pending',
  })

  expect(historyObservation(run, 'mentions')).toBe('pending')
  expect(historyObservation(run, 'citations')).toBe('pending')
})

test('shared history axis aligns engines and retains only the requested recent dates', () => {
  const axis = queryHistoryDateAxis([
    {
      key: 'gemini',
      provider: 'gemini',
      location: null,
      history: [
        point({ runId: 'g1', createdAt: '2026-06-01T12:00:00Z' }),
        point({ runId: 'g3', createdAt: '2026-06-03T12:00:00Z' }),
      ],
    },
    {
      key: 'openai',
      provider: 'openai',
      location: null,
      history: [
        point({ runId: 'o2', createdAt: '2026-06-02T12:00:00Z' }),
        point({ runId: 'o3', createdAt: '2026-06-03T18:00:00Z' }),
      ],
    },
  ], 2)

  expect(axis).toEqual({
    dateKeys: ['2026-06-02', '2026-06-03'],
    hiddenDayCount: 1,
    hiddenEarlierDayCount: 1,
    hiddenLaterDayCount: 0,
    totalDayCount: 3,
  })

  expect(queryHistoryDateAxis([
    {
      key: 'gemini',
      provider: 'gemini',
      location: null,
      history: [
        point({ runId: 'g1', createdAt: '2026-06-01T12:00:00Z' }),
        point({ runId: 'g2', createdAt: '2026-06-02T12:00:00Z' }),
        point({ runId: 'g3', createdAt: '2026-06-03T12:00:00Z' }),
      ],
    },
  ], 2, 2)).toMatchObject({
    dateKeys: ['2026-06-01'],
    hiddenEarlierDayCount: 0,
    hiddenLaterDayCount: 2,
  })
})

test.each([
  ['unscoped to scoped', null, 'florida'],
  ['scoped to unscoped', 'florida', null],
] as const)('%s history never creates a false change', (_label, from, to) => {
  const groups = buildQueryEvidenceGroups([
    item([
      point({
        runId: 'prior',
        citationState: 'cited',
        mentionState: 'mentioned',
        location: from,
      }),
      point({
        runId: 'latest',
        createdAt: '2026-06-02T12:00:00Z',
        citationState: 'not-cited',
        mentionState: 'not-mentioned',
        location: to,
      }),
    ]),
  ])

  expect(groups[0]).toMatchObject({
    changed: false,
    hasPriorComparison: false,
    eventCopy: 'First recorded result',
  })
})

test('the latest result is compared with an earlier UTC day, not a same-day rerun', () => {
  const groups = buildQueryEvidenceGroups([
    item([
      point({
        runId: 'prior-day',
        createdAt: '2026-06-01T17:39:00Z',
        citationState: 'not-cited',
        mentionState: 'not-mentioned',
      }),
      point({
        runId: 'same-day-gain',
        createdAt: '2026-06-02T17:39:00Z',
        citationState: 'cited',
        mentionState: 'mentioned',
      }),
      point({
        runId: 'same-day-latest',
        createdAt: '2026-06-02T17:51:00Z',
        citationState: 'not-cited',
        mentionState: 'not-mentioned',
      }),
    ]),
  ])

  expect(groups[0]).toMatchObject({
    changed: false,
    hasPriorComparison: true,
    eventCopy: 'No change from previous result',
  })
})
