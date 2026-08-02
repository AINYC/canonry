import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PortfolioReport } from '../src/components/project/PortfolioSection'
import type { MeasurementReportResponse } from '@ainyc/canonry-contracts'

// The report is the screen whose whole job is proving the numbers, so what it
// withholds matters as much as what it shows. These pin the three ways it was
// overstating: a rate without its basis, joined history badged as a fresh
// measurement, and a truncated list that reads as the whole list.

// This suite does not auto-clean between tests, so without this a later
// negative assertion reads an earlier test's DOM and passes or fails for the
// wrong reason.
afterEach(cleanup)

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  rate: numerator / denominator,
})

const completeness = (executed: number, expected: number) => ({
  executed,
  expected,
  complete: executed === expected,
  sourceComplete: true,
  sourceCompleteObservations: executed,
  answerComplete: true,
})

function target(id: string, over: Partial<MeasurementReportResponse['targets'][number]> = {}) {
  return {
    id,
    label: `Target ${id}`,
    completeness: completeness(200, 200),
    citationCoverage: rate(1, 200),
    mentionCoverage: rate(1, 200),
    providers: [],
    ...over,
  } as MeasurementReportResponse['targets'][number]
}

function evidence(over: Partial<MeasurementReportResponse['evidence'][number]> = {}) {
  return {
    observationId: 'obs-1',
    expectedSlotId: 'slot-1',
    executionId: 'exec-1',
    usageEdgeId: 'edge-1',
    usageEdgeType: 'target' as const,
    provider: 'openai' as const,
    queryText: 'a tracked query',
    location: null,
    sourceUrl: 'https://northstar.example/homes/harbor',
    bridged: false,
    historical: false,
    evidenceComplete: true,
    classification: 'assigned' as const,
    normalizedUrl: 'northstar.example/homes/harbor',
    matchedTargetIds: ['harbor'],
    matchedUrlIds: ['url-1'],
    ...over,
  } as MeasurementReportResponse['evidence'][number]
}

function report(over: Partial<MeasurementReportResponse> = {}): MeasurementReportResponse {
  return {
    revision: 1,
    run: { id: 'run-1', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null },
    targets: [target('harbor')],
    groups: [],
    evidence: [],
    diagnostics: {
      bridgedObservationIds: [],
      historicalObservationIds: [],
      evidenceIncompleteObservationIds: [],
      ambiguousObservationIds: [],
      unmatchedObservationIds: [],
    },
    ...over,
  } as MeasurementReportResponse
}

const renderReport = (value: MeasurementReportResponse) => render(
  <PortfolioReport
    activePlan={{ revision: 1, checksum: 'abc123', plan: { schemaVersion: 1, targets: [], groups: [], targetQuerySelections: [] } as never }}
    report={value}
    isLoading={false}
    isError={false}
  />,
)

describe('report rates carry their basis', () => {
  it('shows the count a rate stands on, not a bare percentage', () => {
    renderReport(report())
    // 1/200 and 1/2 both round to a percentage that reads with equal
    // confidence; only the count separates them.
    expect(screen.getAllByText(/1 of 200/).length).toBeGreaterThan(0)
  })

  it('still reports an incomplete run as incomplete rather than as a rate', () => {
    renderReport(report({
      targets: [target('harbor', {
        completeness: completeness(37, 200),
        citationCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' } as never,
        mentionCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' } as never,
      })],
    }))
    expect(screen.getAllByText(/Incomplete: 37\/200/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\bof 200 \(/)).toBeNull()
  })
})

describe('bridged history is labelled as history', () => {
  it('marks a report that leans on pre-plan rows', () => {
    renderReport(report({
      evidence: [evidence({ bridged: true })],
      diagnostics: {
        bridgedObservationIds: ['obs-1'],
        historicalObservationIds: [],
        evidenceIncompleteObservationIds: [],
        ambiguousObservationIds: [],
        unmatchedObservationIds: [],
      },
    }))
    expect(screen.getByText(/Includes bridged history/)).toBeTruthy()
  })

  it('marks the individual Target whose evidence is bridged', () => {
    renderReport(report({
      evidence: [evidence({ bridged: true })],
      diagnostics: {
        bridgedObservationIds: ['obs-1'],
        historicalObservationIds: [],
        evidenceIncompleteObservationIds: [],
        ambiguousObservationIds: [],
        unmatchedObservationIds: [],
      },
    }))
    expect(screen.getAllByText(/200\/200 \(bridged\)/).length).toBeGreaterThan(0)
  })

  it('leaves a freshly measured report unbadged', () => {
    renderReport(report({ evidence: [evidence()] }))
    expect(screen.queryByText(/bridged/i)).toBeNull()
  })
})

describe('long lists say how much they are hiding', () => {
  it('caps the Target table and reports the true total', () => {
    const many = Array.from({ length: 213 }, (_, index) => target(`t${index}`))
    renderReport(report({ targets: many }))
    expect(screen.getByText('Showing 50 of 213')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show all 213' })).toBeTruthy()
  })

  it('does not announce truncation when nothing is truncated', () => {
    renderReport(report())
    expect(screen.queryByText(/^Showing \d+ of \d+$/)).toBeNull()
  })
})
