import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MeasurementOverviewResponse,
  MeasurementPlanResponse,
  MeasurementReportResponse,
} from '@ainyc/canonry-api-client'

import { AdvancedMeasurementOverview } from '../src/components/project/advanced-measurement/AdvancedMeasurementOverview.js'
import {
  adaptV2MeasurementOverview,
  areV2OverviewPagesCompatible,
} from '../src/components/project/advanced-measurement/v2-overview-adapter.js'

afterEach(cleanup)

type ActivePlan = NonNullable<MeasurementPlanResponse['active']>

function fixture(count = 213): { activePlan: ActivePlan; overview: MeasurementOverviewResponse } {
  const targets = Array.from({ length: count }, (_, index) => ({
    stableKey: `property-${index + 1}`,
    label: `Property ${index + 1}`,
    aliases: [`Property ${index + 1}`],
    urlMatchers: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: `/properties/${index + 1}`, pathCase: 'insensitive' as const }],
    mentionNotApplicable: false,
    discoveryIdentity: `sitemap:${index + 1}`,
  }))
  const querySnapshots = [{
    queryId: 'query-nearby',
    queryText: 'apartments near downtown',
    provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-08-02T12:00:00.000Z' },
  }]
  const executionNodes = [{
    stableKey: 'execution-nearby',
    queryId: 'query-nearby',
    queryText: 'apartments near downtown',
    context: { providers: ['openai'], models: { openai: 'model-a' }, location: null },
    expectedSnapshots: 1,
  }]
  const assignments = targets.map(target => ({
    targetKey: target.stableKey,
    queryId: 'query-nearby',
    queryClass: 'non-brand' as const,
    executionNodeKey: 'execution-nearby',
  }))
  const usageEdges = assignments.map(assignment => ({
    executionNodeKey: assignment.executionNodeKey,
    targetKey: assignment.targetKey,
    queryId: assignment.queryId,
  }))
  const activePlan: ActivePlan = {
    revision: 2,
    checksum: 'a'.repeat(64),
    createdAt: '2026-08-02T12:00:00.000Z',
    plan: {
      schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'northstar.example', ownedHosts: ['northstar.example'], names: ['Northstar'] } },
      targets,
      groups: [{ stableKey: 'downtown', label: 'Downtown', targetKeys: targets.slice(0, 12).map(target => target.stableKey), competitors: [] }],
      querySnapshots,
      assignments,
      executionNodes,
      usageEdges,
      compiledChecksum: 'b'.repeat(64),
    },
  }
  const overview: MeasurementOverviewResponse = {
    mode: 'active-v2',
    scope: { kind: 'all', label: 'All Properties' },
    queryClass: 'non-brand',
    measurement: { state: 'not_measured', completed: 0, expected: 213 },
    nextAction: { kind: 'run_measurement' },
    metrics: {
      propertiesMentioned: { state: 'unavailable', reason: 'no_completed_run' },
      mentionCoverage: { state: 'unavailable', reason: 'no_completed_run' },
      citationCoverage: { state: 'unavailable', reason: 'no_completed_run' },
      brandPresence: { state: 'unavailable', reason: 'no_completed_run' },
      sov: { state: 'unavailable', reason: 'no_completed_run' },
    },
    properties: {
      items: targets.slice(0, 50).map(target => ({
        targetKey: target.stableKey,
        label: target.label,
        mentionCoverage: { state: 'unavailable' as const, reason: 'no_completed_run' as const },
        citationCoverage: { state: 'unavailable' as const, reason: 'no_completed_run' as const },
        flags: 0,
      })),
      nextCursor: 'page-2',
      totalEstimate: count,
    },
    flags: { total: 0 },
  }
  return { activePlan, overview }
}

describe('version-two measurement overview adapter', () => {
  it('refuses to merge pages that crossed from no run to a newly completed run', () => {
    const { overview } = fixture(2)
    const nextPage = structuredClone(overview)
    nextPage.measurement.displayedRunId = 'run-new'
    expect(areV2OverviewPagesCompatible([overview, nextPage])).toBe(false)
    overview.measurement.displayedRunId = 'run-new'
    expect(areV2OverviewPagesCompatible([overview, nextPage])).toBe(true)
  })

  it('renders the first bounded page immediately and requests server views and later pages', () => {
    const { activePlan, overview } = fixture()
    const report = adaptV2MeasurementOverview({ overview, activePlan })
    const onViewChange = vi.fn()
    const onLoadMore = vi.fn()
    const onPropertyExpand = vi.fn()

    render(
      <AdvancedMeasurementOverview
        report={report}
        canEdit
        onViewChange={onViewChange}
        onLoadMore={onLoadMore}
        onPropertyExpand={onPropertyExpand}
      />,
    )

    expect(screen.getByText('Ready to measure.')).toBeTruthy()
    expect(screen.queryByText('Date unavailable')).toBeNull()
    expect(screen.getByText('Showing 50 of 213')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
    expect(onLoadMore).toHaveBeenCalledWith('page-2')

    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'downtown' } })
    expect(onViewChange).toHaveBeenCalledWith({ scope: 'group', groupKey: 'downtown', queryClass: 'non-brand' })

    const row = screen.getByRole('button', { name: 'Show details for Property 1' }).closest('tr')!
    fireEvent.click(row)
    expect(onPropertyExpand).toHaveBeenCalledWith('property-1')
    expect(screen.getByText('No source evidence is available.')).toBeTruthy()
  })

  it('indexes evidence once by its assigned Property and translates sibling language', () => {
    const { activePlan, overview } = fixture(2)
    if (activePlan.plan.schemaVersion !== 2) throw new Error('Expected a version-two fixture.')
    activePlan.plan.assignments.push({
      ...activePlan.plan.assignments[0]!,
      executionNodeKey: 'execution-nearby-second-location',
    })
    activePlan.plan.targets[0]!.urlMatchers.push({ kind: 'host', host: 'homes.northstar.example' })
    overview.properties = { items: overview.properties.items.slice(0, 2), nextCursor: null, totalEstimate: 2 }
    const evidenceReport = {
      revision: 2,
      run: null,
      groups: [],
      targets: [],
      diagnostics: {
        bridgedObservationIds: [], historicalObservationIds: [], evidenceIncompleteObservationIds: [], ambiguousObservationIds: [], unmatchedObservationIds: [],
      },
      evidence: [{
        observationId: 'observation-1', expectedSlotId: 'slot-1', executionId: 'execution-nearby',
        usageEdgeId: 'target:property-1:query-nearby:execution-nearby', usageEdgeType: 'target', provider: 'openai',
        queryText: 'apartments near downtown', location: null, sourceUrl: 'https://northstar.example/properties/2',
        bridged: false, historical: false, evidenceComplete: true, classification: 'sibling',
        normalizedUrl: 'https://northstar.example/properties/2', matchedTargetIds: ['property-2'], matchedUrlIds: ['property-2:url:0'],
      }],
    } as MeasurementReportResponse
    const report = adaptV2MeasurementOverview({ overview, activePlan, report: evidenceReport })

    expect(report.currentView?.aggregate.properties[0]?.evidence).toHaveLength(1)
    expect(report.currentView?.aggregate.properties[0]?.evidence[0]?.kind).toBe('another-property')
    expect(report.currentView?.aggregate.properties[0]?.evidence[0]?.provider).toBe('openai')
    expect(report.currentView?.aggregate.properties[0]?.assignedQueries).toEqual(['apartments near downtown'])
    expect(report.currentView?.aggregate.properties[0]?.urls).toEqual([
      'https://northstar.example/properties/1/*',
      'https://homes.northstar.example/*',
    ])
    expect(report.currentView?.aggregate.properties[1]?.evidence).toHaveLength(0)
  })

  it('rejects the API property scope instead of relabeling it as All Properties', () => {
    const { activePlan, overview } = fixture(1)
    overview.scope = { kind: 'property', key: 'property-1', label: 'Property 1' }
    expect(() => adaptV2MeasurementOverview({ overview, activePlan })).toThrow('All Properties or group scope')
  })

  it('keeps server-wide flagged totals visible before the flagged Property page is loaded', () => {
    const { activePlan, overview } = fixture()
    overview.flags.total = 3
    overview.nextAction = { kind: 'review_flags', count: 3 }
    const onLoadMore = vi.fn()

    render(
      <AdvancedMeasurementOverview
        report={adaptV2MeasurementOverview({ overview, activePlan })}
        canEdit
        onLoadMore={onLoadMore}
      />,
    )

    expect(screen.getByText('3 flagged results need review.')).toBeTruthy()
    fireEvent.click(screen.getByText('Flagged results (3)'))
    expect(screen.getByText('Showing details for 0 of 3 flagged results')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more Properties' }))
    expect(onLoadMore).toHaveBeenCalledWith('page-2')
  })

  it('shows an honest evidence error when the deep report fails or belongs to another run', () => {
    const { activePlan, overview } = fixture(1)
    overview.properties = { items: overview.properties.items.slice(0, 1), nextCursor: null, totalEstimate: 1 }
    overview.measurement.displayedRunId = 'run-a'
    const onRetryEvidence = vi.fn()

    const loading = adaptV2MeasurementOverview({ overview, activePlan, reportState: 'loading' })
    render(<AdvancedMeasurementOverview report={loading} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Property 1' }))
    expect(screen.getByText('Loading evidence…')).toBeTruthy()
    cleanup()

    const failed = adaptV2MeasurementOverview({ overview, activePlan, reportState: 'error' })
    render(<AdvancedMeasurementOverview report={failed} canEdit onRetryEvidence={onRetryEvidence} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Property 1' }))
    expect(screen.getByText('Evidence could not be loaded.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry evidence' }))
    expect(onRetryEvidence).toHaveBeenCalledOnce()
    cleanup()

    const mismatched = adaptV2MeasurementOverview({
      overview,
      activePlan,
      report: { ...({} as MeasurementReportResponse), revision: 2, run: { id: 'run-b' } } as MeasurementReportResponse,
    })
    render(<AdvancedMeasurementOverview report={mismatched} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Property 1' }))
    expect(screen.getByText('Evidence could not be loaded.')).toBeTruthy()
  })
})
