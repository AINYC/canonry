import { expect, test } from 'vitest'

import {
  buildHighlightGroups,
  isCitedCompetitorDomain,
  summarizeSignalHistory,
  summarizeSignalsForItems,
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

function item(history: RunHistoryPoint[], overrides: Partial<CitationInsightVm> = {}): CitationInsightVm {
  return {
    id: crypto.randomUUID(),
    query: 'test query',
    provider: 'gemini',
    model: null,
    location: null,
    citationState: 'not-cited',
    answerMentioned: history.at(-1)?.answerMentioned,
    changeLabel: '',
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: [],
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

test('summarizeSignalsForItems aggregates provider rows into latest-run chips', () => {
  const stableProvider = item([
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
  ])
  const gainingProvider = item([
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'cited', answerMentioned: true }),
  ])

  expect(summarizeSignalsForItems([stableProvider, gainingProvider])).toEqual([
    { key: 'mentions', label: 'New mention', tone: 'positive' },
    { key: 'citations', label: 'New citation', tone: 'positive' },
  ])
})

test('answer highlighting consumes mentioned competitors only', () => {
  const citationOnly = item([], {
    citedCompetitorDomains: ['rival.example'],
    mentionedCompetitorDomains: [],
    competitorDomains: ['rival.example'],
  })
  const mentionOnly = item([], {
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: ['rival.example'],
    competitorDomains: ['rival.example'],
  })

  expect(buildHighlightGroups(citationOnly)).toEqual([])
  expect(buildHighlightGroups(mentionOnly)).toEqual([
    { terms: ['rival'], className: 'answer-highlight-competitor' },
  ])
})

test('source competitor tagging consumes cited competitors only', () => {
  const citationOnly = item([], {
    citedCompetitorDomains: ['www.rival.example'],
    mentionedCompetitorDomains: [],
  })
  const mentionOnly = item([], {
    citedCompetitorDomains: [],
    mentionedCompetitorDomains: ['rival.example'],
  })

  expect(isCitedCompetitorDomain(citationOnly, 'rival.example')).toBe(true)
  expect(isCitedCompetitorDomain(mentionOnly, 'rival.example')).toBe(false)
})
