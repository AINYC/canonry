import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AdvancedMeasurementOverview,
  type AdvancedMeasurementMetric,
  type AdvancedMeasurementOverviewProps,
  type AdvancedMeasurementOverviewReport,
  type AdvancedMeasurementProperty,
} from '../src/components/project/advanced-measurement/AdvancedMeasurementOverview.js'

afterEach(cleanup)

function ratio(numerator: number, denominator: number): AdvancedMeasurementMetric {
  return { numerator, denominator }
}

function unavailable(reason: string): AdvancedMeasurementMetric {
  return { numerator: null, denominator: null, reason }
}

function property(
  id: string,
  name: string,
  overrides: Partial<AdvancedMeasurementProperty> = {},
): AdvancedMeasurementProperty {
  return {
    id,
    name,
    mentionCoverage: ratio(3, 4),
    citationCoverage: ratio(2, 4),
    status: { label: 'Measured', tone: 'positive' },
    assignedQueries: ['best office space downtown'],
    urls: ['https://example.com/downtown'],
    evidence: [
      { id: `${id}-1`, kind: 'this-property', query: 'best office space downtown', url: 'https://example.com/downtown', tone: 'positive' },
      { id: `${id}-2`, kind: 'another-property', query: 'best office space downtown', url: 'https://example.com/uptown', tone: 'caution' },
      { id: `${id}-3`, kind: 'owned-unassigned', query: 'best office space downtown', url: 'https://example.com/other', tone: 'caution' },
      { id: `${id}-4`, kind: 'external', query: 'best office space downtown', url: 'https://rival.example/listing', tone: 'neutral' },
      { id: `${id}-5`, kind: 'multiple-properties', query: 'best office space downtown', url: 'https://example.com/shared', tone: 'caution' },
      { id: `${id}-6`, kind: 'invalid-url', query: 'best office space downtown', url: 'not a URL', tone: 'negative' },
    ],
    ...overrides,
  }
}

function report(overrides: Partial<AdvancedMeasurementOverviewReport> = {}): AdvancedMeasurementOverviewReport {
  const downtown = property('downtown', 'Downtown Office')
  const uptown = property('uptown', 'Uptown Office', {
    mentionCoverage: ratio(1, 4),
    citationCoverage: ratio(1, 4),
  })

  const nonBrand = {
    aggregate: {
      metrics: {
        propertiesMentioned: ratio(3, 4),
        mentionCoverage: ratio(6, 8),
        citationCoverage: ratio(2, 8),
      },
      properties: [downtown, uptown],
    },
    groups: [
      {
        id: 'metro',
        label: 'Metro offices',
        confirmedCompetitorCount: 1,
        aggregate: {
          metrics: {
            propertiesMentioned: ratio(1, 2),
            mentionCoverage: ratio(1, 2),
            citationCoverage: ratio(1, 2),
          },
          properties: [downtown],
          shareOfVoice: [
            { name: 'Example Co.', coverage: ratio(5, 8) },
            { name: 'Rival Co.', coverage: ratio(3, 8) },
          ],
        },
      },
    ],
  }

  const branded = {
    aggregate: {
      metrics: {
        propertiesMentioned: ratio(2, 2),
        mentionCoverage: ratio(7, 8),
        citationCoverage: ratio(6, 8),
      },
      properties: [downtown, uptown],
    },
    groups: [
      {
        id: 'metro',
        label: 'Metro offices',
        confirmedCompetitorCount: 1,
        aggregate: {
          metrics: {
            propertiesMentioned: ratio(1, 1),
            mentionCoverage: ratio(4, 4),
            citationCoverage: ratio(3, 4),
          },
          properties: [downtown],
          shareOfVoice: [{ name: 'Example Co.', coverage: ratio(4, 4) }],
        },
      },
    ],
  }

  return {
    classReporting: 'available',
    latestMeasurement: {
      status: { label: 'Complete', tone: 'positive' },
      completedSlots: 8,
      totalSlots: 8,
      date: 'Aug 2, 2026',
    },
    overall: nonBrand,
    classScopes: { nonBrand, branded },
    flaggedResults: [{ id: 'flag-1', property: 'Downtown Office', summary: 'One URL needs review.', tone: 'caution' }],
    ...overrides,
  }
}

function renderOverview(overrides: Partial<AdvancedMeasurementOverviewProps> = {}) {
  const onRunMeasurement = vi.fn()
  const onRepublishSetup = vi.fn()
  const props: AdvancedMeasurementOverviewProps = {
    report: report(),
    canEdit: true,
    onRunMeasurement,
    onRepublishSetup,
    ...overrides,
  }
  render(<AdvancedMeasurementOverview {...props} />)
  return { onRunMeasurement, onRepublishSetup }
}

describe('AdvancedMeasurementOverview', () => {
  it('shows truthful ratios for the three headline metrics', () => {
    renderOverview()

    expect(screen.getByText('Properties mentioned')).toBeTruthy()
    expect(screen.getByText('Mention coverage')).toBeTruthy()
    expect(screen.getByText('Citation coverage')).toBeTruthy()
    expect(screen.getAllByText('3 of 4 (75%)').length).toBeGreaterThan(0)
    expect(screen.getByText('6 of 8 (75%)')).toBeTruthy()
    expect(screen.getByText('2 of 8 (25%)')).toBeTruthy()
    expect(screen.getByText('8 of 8')).toBeTruthy()
    expect(screen.getByText('Aug 2, 2026')).toBeTruthy()
  })

  it('keeps unavailable measurements unavailable instead of rendering zero or repeating their reason', () => {
    const current = report()
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              metrics: {
                ...current.classScopes!.nonBrand.aggregate.metrics,
                mentionCoverage: unavailable('No complete source evidence is available.'),
                citationCoverage: unavailable('No complete source evidence is available.'),
              },
            },
          },
        },
      },
    })

    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No complete source evidence is available.')).toHaveLength(1)
    expect(screen.queryByText('0 of 0 (0%)')).toBeNull()
  })

  it('keeps measurement status and the next action on one concise line', () => {
    renderOverview()

    const statusLine = screen.getByLabelText('Measurement status and next action')
    expect(statusLine.textContent).toContain('Complete')
    expect(statusLine.textContent).toContain('8 of 8')
    expect(statusLine.textContent).not.toContain('slots completed')
    expect(statusLine.textContent).toContain('Aug 2, 2026')
    expect(statusLine.textContent).toContain('1 flagged result needs review.')
  })

  it('does not render an unavailable slot denominator as zero', () => {
    renderOverview({
      report: {
        ...report(),
        latestMeasurement: {
          ...report().latestMeasurement,
          completedSlots: 0,
          totalSlots: 0,
        },
      },
    })

    expect(screen.queryByText('Measurement progress unavailable')).toBeNull()
    expect(screen.queryByText('0 of 0 slots completed')).toBeNull()
  })

  it('swaps to the selected group precomputed aggregate', () => {
    renderOverview()

    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'metro' } })

    expect(screen.getAllByText('1 of 2 (50%)').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Show details for Downtown Office' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show details for Uptown Office' })).toBeNull()
  })

  it('filters only table rows when searching', () => {
    renderOverview()

    fireEvent.change(screen.getByLabelText('Search properties'), { target: { value: 'uptown' } })

    expect(screen.getAllByText('3 of 4 (75%)').length).toBeGreaterThan(0)
    expect(screen.getByText('6 of 8 (75%)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show details for Uptown Office' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show details for Downtown Office' })).toBeNull()
  })

  it('reveals inline drill-down evidence with customer-facing labels', () => {
    renderOverview()

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))

    expect(screen.getByText('Assigned queries')).toBeTruthy()
    expect(screen.getAllByText('best office space downtown').length).toBeGreaterThan(0)
    expect(screen.getByText('URLs')).toBeTruthy()
    expect(screen.getByText('Matches this Property')).toBeTruthy()
    expect(screen.getByText('Matches another Property')).toBeTruthy()
    expect(screen.getByText('Site URL not included in a Property')).toBeTruthy()
    expect(screen.getByText('External URL')).toBeTruthy()
    expect(screen.getByText('Matches multiple Properties')).toBeTruthy()
    expect(screen.getByText('Invalid URL')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Sibling')
    expect(document.body.textContent).not.toContain('owned-unassigned')
    expect(document.body.textContent).not.toContain('Owned URL without an assignment')
  })

  it('expands a Property by clicking anywhere on its row', () => {
    renderOverview()

    const details = screen.getByRole('button', { name: 'Show details for Downtown Office' })
    const row = details.closest('tr')
    expect(row).toBeTruthy()

    fireEvent.click(row!)

    expect(screen.getByText('Assigned queries')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide details for Downtown Office' })).toBeTruthy()
  })

  it('badges bridged property and evidence rows as Historical', () => {
    const current = report()
    const first = current.classScopes!.nonBrand.aggregate.properties[0]!
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              properties: [{
                ...first,
                historical: true,
                evidence: [{ ...first.evidence[0]!, historical: true }],
              }],
            },
          },
        },
      },
    })

    expect(screen.getByText('Historical')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))
    expect(screen.getAllByText('Historical')).toHaveLength(2)
  })

  it('shows competitor share of voice only for a selected non-brand group', () => {
    renderOverview()

    expect(screen.getByText('Query type')).toBeTruthy()
    expect(screen.queryByText('Competitor share of voice')).toBeNull()
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'metro' } })
    expect(screen.getByText('Competitor share of voice')).toBeTruthy()
    expect(screen.getByText('Example Co.')).toBeTruthy()
    expect(screen.getByText('Rival Co.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Branded'))
    expect(screen.queryByText('Competitor share of voice')).toBeNull()
    expect((screen.getByText('Flagged results (1)').closest('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('hides competitor share of voice when a group has no confirmed competitors', () => {
    const current = report()
    const nonBrand = current.classScopes!.nonBrand
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...nonBrand,
            groups: nonBrand.groups.map(group => ({ ...group, confirmedCompetitorCount: 0 })),
          },
        },
      },
    })

    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'metro' } })
    expect(screen.queryByText('Competitor share of voice')).toBeNull()
  })

  it('treats an invalid metric denominator as unavailable', () => {
    const current = report()
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              metrics: {
                ...current.classScopes!.nonBrand.aggregate.metrics,
                mentionCoverage: { numerator: 2, denominator: 1 },
              },
            },
          },
        },
      },
    })

    expect(screen.getByText('N/A')).toBeTruthy()
  })

  it('makes version-one class reporting visibly unavailable and offers republish to editors', () => {
    const { onRepublishSetup } = renderOverview({
      report: {
        ...report(),
        classReporting: 'plan-v1',
        classScopes: undefined,
        latestMeasurement: {
          status: { label: 'Not measured', tone: 'neutral' },
          completedSlots: 0,
          totalSlots: 0,
          date: 'Date unavailable',
        },
      },
    })

    expect(screen.getByText('Setup update required.')).toBeTruthy()
    expect(screen.queryByText('Republish setup to enable Non-brand and Branded reporting.')).toBeNull()
    expect(screen.queryByText('Measurement progress unavailable')).toBeNull()
    expect(screen.queryByText('Date unavailable')).toBeNull()
    expect((screen.getByLabelText('Non-brand') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Republish setup' }))
    expect(onRepublishSetup).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Run measurement' })).toBeNull()
  })

  it('keeps the report visible to viewers without mutation buttons', () => {
    renderOverview({ canEdit: false })

    expect(screen.getAllByText('3 of 4 (75%)').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Run measurement' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Republish setup' })).toBeNull()
  })

  it('does not show a disabled or misleading action before the scoped runner is wired', () => {
    renderOverview({ onRunMeasurement: undefined })

    expect(screen.queryByRole('button', { name: 'Run measurement' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Republish setup' })).toBeNull()
  })

  it('guards measurement and republish actions while they are pending', () => {
    const running = render(
      <AdvancedMeasurementOverview
        report={report()}
        canEdit
        isRunningMeasurement
        onRunMeasurement={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Starting measurement…' })).toHaveProperty('disabled', true)
    running.unmount()

    render(
      <AdvancedMeasurementOverview
        report={{ ...report(), classReporting: 'plan-v1', classScopes: undefined }}
        canEdit
        isRepublishingSetup
        onRepublishSetup={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Opening setup…' })).toHaveProperty('disabled', true)
  })

  it('labels every capped property list with its shown and total counts', () => {
    const current = report()
    const properties = Array.from({ length: 51 }, (_, index) => property(`property-${index}`, `Property ${index + 1}`))
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              properties,
            },
          },
        },
      },
    })

    expect(screen.getByText('Showing 50 of 51')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show all 51 properties' })).toBeTruthy()
  })
})
