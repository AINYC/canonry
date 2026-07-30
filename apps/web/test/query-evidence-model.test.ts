import { describe, expect, test } from 'vitest'

import {
  buildQueryEvidenceGroups,
  type QueryEvidenceChange,
} from '../src/components/project/query-evidence-model.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'

function point(overrides: Partial<RunHistoryPoint> = {}): RunHistoryPoint {
  return {
    runId: overrides.runId ?? crypto.randomUUID(),
    citationState: overrides.citationState ?? 'not-cited',
    createdAt: overrides.createdAt ?? '2026-03-01T12:00:00Z',
    ...overrides,
  }
}

function evidence(
  history: RunHistoryPoint[],
  overrides: Partial<CitationInsightVm> = {},
): CitationInsightVm {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    query: overrides.query ?? 'best dentist near me',
    provider: overrides.provider ?? 'gemini',
    model: null,
    location: null,
    citationState: 'not-cited',
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

function copies(changes: QueryEvidenceChange[]): string[] {
  return changes.map(change => change.copy)
}

describe('buildQueryEvidenceGroups', () => {
  test('groups evidence by query and reports the latest observed time in UTC', () => {
    const groups = buildQueryEvidenceGroups([
      evidence([
        point({ createdAt: '2026-03-02T22:30:00-05:00' }),
      ], { query: 'z query' }),
      evidence([
        point({ createdAt: '2026-03-01T09:00:00Z' }),
      ], { query: 'a query', provider: 'openai' }),
      evidence([
        point({ createdAt: 'not-a-date' }),
      ], { query: 'a query', provider: 'claude' }),
    ])

    expect(groups.map(group => group.query)).toEqual(['a query', 'z query'])
    expect(groups[0]).toMatchObject({
      latestObservedAt: '2026-03-01T09:00:00.000Z',
      changed: false,
      eventCopy: 'First recorded result',
    })
    expect(groups[0]!.items).toHaveLength(2)
    expect(groups[1]!.latestObservedAt).toBe('2026-03-03T03:30:00.000Z')
  })

  test('reports a citation gain without inferring a mention gain', () => {
    const item = evidence([
      point({
        createdAt: '2026-03-01T12:00:00Z',
        citationState: 'not-cited',
        mentionState: 'not-mentioned',
      }),
      point({
        createdAt: '2026-03-02T12:00:00Z',
        citationState: 'cited',
        mentionState: 'not-mentioned',
      }),
    ], { id: 'openai-evidence', provider: 'openai' })

    const group = buildQueryEvidenceGroups([item])[0]!

    expect(copies(group.changes)).toEqual(['OpenAI now cites your site'])
    expect(group).toMatchObject({
      changed: true,
      hasLoss: false,
      representativeEvidenceId: 'openai-evidence',
      representativeProvider: 'openai',
      representativeProviderLabel: 'OpenAI',
      representativeSignal: 'citation',
      representativeDirection: 'gained',
      eventCopy: 'OpenAI now cites your site',
    })
  })

  test('reports a mention loss without inferring a citation loss', () => {
    const item = evidence([
      point({
        createdAt: '2026-03-01T12:00:00Z',
        citationState: 'cited',
        mentionState: 'mentioned',
      }),
      point({
        createdAt: '2026-03-02T12:00:00Z',
        citationState: 'cited',
        mentionState: 'not-mentioned',
      }),
    ])

    const group = buildQueryEvidenceGroups([item])[0]!

    expect(copies(group.changes)).toEqual(['Gemini no longer mentions your brand'])
    expect(group).toMatchObject({
      changed: true,
      hasLoss: true,
      lossCount: 1,
      representativeSignal: 'mention',
      representativeDirection: 'lost',
      eventCopy: 'Gemini no longer mentions your brand',
    })
  })

  test('summarizes multiple changes deterministically with losses first', () => {
    const changes = [
      evidence([
        point({ citationState: 'not-cited', mentionState: 'not-mentioned' }),
        point({
          createdAt: '2026-03-02T12:00:00Z',
          citationState: 'cited',
          mentionState: 'not-mentioned',
        }),
      ], { id: 'openai', provider: 'openai' }),
      evidence([
        point({ citationState: 'cited', mentionState: 'mentioned' }),
        point({
          createdAt: '2026-03-03T12:00:00Z',
          citationState: 'not-cited',
          mentionState: 'not-mentioned',
        }),
      ], { id: 'gemini', provider: 'gemini' }),
      evidence([
        point({ citationState: 'not-cited', mentionState: 'not-mentioned' }),
        point({
          createdAt: '2026-03-04T12:00:00Z',
          citationState: 'not-cited',
          mentionState: 'mentioned',
        }),
      ], { id: 'claude', provider: 'claude' }),
    ]

    const forward = buildQueryEvidenceGroups(changes)[0]!
    const reversed = buildQueryEvidenceGroups([...changes].reverse())[0]!
    const expectedCopies = [
      'Gemini no longer cites your site',
      'Gemini no longer mentions your brand',
      'Claude now mentions your brand',
      'OpenAI now cites your site',
    ]

    expect(copies(forward.changes)).toEqual(expectedCopies)
    expect(copies(reversed.changes)).toEqual(expectedCopies)
    expect(forward).toMatchObject({
      lossCount: 2,
      changeCount: 4,
      representativeEvidenceId: 'gemini',
      representativeProvider: 'gemini',
      representativeSignal: 'citation',
      representativeDirection: 'lost',
      eventCopy: 'Gemini no longer cites your site; Gemini no longer mentions your brand; 2 more changes',
    })
  })

  test('does not compare same-day reruns or cross-location observations', () => {
    const sameDay = evidence([
      point({
        createdAt: '2026-03-01T09:00:00Z',
        citationState: 'not-cited',
        answerMentioned: false,
      }),
      point({
        createdAt: '2026-03-01T17:00:00Z',
        citationState: 'cited',
        answerMentioned: true,
      }),
    ], { provider: 'openai' })
    const changedLocation = evidence([
      point({
        createdAt: '2026-03-01T12:00:00Z',
        citationState: 'cited',
        answerMentioned: true,
        location: null,
      }),
      point({
        createdAt: '2026-03-02T12:00:00Z',
        citationState: 'not-cited',
        answerMentioned: false,
        location: 'florida',
      }),
    ], { provider: 'gemini' })

    const group = buildQueryEvidenceGroups([sameDay, changedLocation])[0]!

    expect(group.changes).toEqual([])
    expect(group.eventCopy).toBe('First recorded result')
  })

  test('does not infer a mention change when mention data was not recorded', () => {
    const item = evidence([
      point({
        createdAt: '2026-03-01T12:00:00Z',
        citationState: 'not-cited',
      }),
      point({
        createdAt: '2026-03-02T12:00:00Z',
        citationState: 'cited',
      }),
    ], { provider: 'openai' })

    const group = buildQueryEvidenceGroups([item])[0]!

    expect(group.changes).toHaveLength(1)
    expect(group.changes[0]).toMatchObject({
      signal: 'citation',
      direction: 'gained',
      copy: 'OpenAI now cites your site',
    })
  })

  test('deduplicates repeated provider signal changes while keeping the newest evidence', () => {
    const older = evidence([
      point({ createdAt: '2026-03-01T12:00:00Z', citationState: 'cited' }),
      point({ createdAt: '2026-03-02T12:00:00Z', citationState: 'not-cited' }),
    ], { id: 'older', provider: 'gemini' })
    const newer = evidence([
      point({ createdAt: '2026-03-02T12:00:00Z', citationState: 'cited' }),
      point({ createdAt: '2026-03-03T12:00:00Z', citationState: 'not-cited' }),
    ], { id: 'newer', provider: 'gemini' })

    const group = buildQueryEvidenceGroups([older, newer])[0]!

    expect(group.changes).toHaveLength(1)
    expect(group.changes[0]).toMatchObject({
      evidenceId: 'newer',
      copy: 'Gemini no longer cites your site',
    })
  })

  test('does not call pending-only or missing-only dates unchanged', () => {
    const pending = evidence([
      point({ createdAt: '2026-03-01T12:00:00Z', citationState: 'pending', mentionState: 'pending' }),
      point({ createdAt: '2026-03-02T12:00:00Z', citationState: 'pending', mentionState: 'pending' }),
    ], { provider: 'openai' })
    const missing = evidence([
      point({ createdAt: '2026-03-01T12:00:00Z', citationState: 'unknown' }),
      point({ createdAt: '2026-03-02T12:00:00Z', citationState: 'unknown' }),
    ], { provider: 'gemini' })

    const group = buildQueryEvidenceGroups([pending, missing])[0]!

    expect(group).toMatchObject({
      changed: false,
      hasPriorComparison: false,
      eventCopy: 'Awaiting completed result',
    })
  })

  test('keeps simultaneous location changes distinct and names their scope', () => {
    const florida = evidence([
      point({
        createdAt: '2026-03-01T12:00:00Z',
        citationState: 'cited',
        location: 'Florida',
      }),
      point({
        createdAt: '2026-03-02T12:00:00Z',
        citationState: 'not-cited',
        location: 'Florida',
      }),
    ], { id: 'florida', provider: 'gemini', location: 'Florida' })
    const michigan = evidence([
      point({
        createdAt: '2026-03-01T12:00:00Z',
        citationState: 'not-cited',
        location: 'Michigan',
      }),
      point({
        createdAt: '2026-03-02T12:00:00Z',
        citationState: 'cited',
        location: 'Michigan',
      }),
    ], { id: 'michigan', provider: 'gemini', location: 'Michigan' })

    const group = buildQueryEvidenceGroups([florida, michigan])[0]!

    expect(copies(group.changes)).toEqual([
      'Gemini no longer cites your site in Florida',
      'Gemini now cites your site in Michigan',
    ])
  })

  test('selects the latest valid fallback evidence deterministically', () => {
    const invalid = evidence([
      point({ createdAt: 'not-a-date' }),
    ], { id: 'invalid', provider: 'gemini' })
    const valid = evidence([
      point({ createdAt: '2026-03-02T12:00:00Z' }),
    ], { id: 'valid', provider: 'openai' })

    const group = buildQueryEvidenceGroups([invalid, valid])[0]!

    expect(group.representativeEvidenceId).toBe('valid')
    expect(group.representativeProvider).toBe('openai')
  })
})
