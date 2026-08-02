import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { AdvancedMeasurementLanding } from '../src/components/project/advanced-measurement/AdvancedMeasurementLanding.js'
import type { AdvancedMeasurementOverviewReport } from '../src/components/project/advanced-measurement/AdvancedMeasurementOverview.js'

afterEach(cleanup)

const unavailable = { numerator: null, denominator: null, reason: 'plan_v1' } as const

const report: AdvancedMeasurementOverviewReport = {
  classReporting: 'plan-v1',
  latestMeasurement: {
    status: { label: 'Complete', tone: 'positive' },
    completedSlots: 4,
    totalSlots: 4,
    date: 'Aug 2, 2026',
  },
  overall: {
    aggregate: {
      metrics: {
        propertiesMentioned: unavailable,
        mentionCoverage: unavailable,
        citationCoverage: unavailable,
      },
      properties: [],
    },
    groups: [],
  },
  flaggedResults: [],
}

const availableReport: AdvancedMeasurementOverviewReport = {
  ...report,
  classReporting: 'available',
  classScopes: {
    nonBrand: report.overall,
    branded: report.overall,
  },
}

describe('advanced measurement landing', () => {
  it('keeps the existing overview for a Simple project and opens setup explicitly', () => {
    const onOpenSetup = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'simple-overview', setupAction: 'set-up' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        onOpenSetup={onOpenSetup}
      />,
    )

    expect(screen.getByText('Existing project overview')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up advanced measurement' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
  })

  it('keeps a draft-only project on the existing overview with a Continue action', () => {
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'simple-overview', setupAction: 'continue' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        onOpenSetup={vi.fn()}
      />,
    )

    expect(screen.getByText('Existing project overview')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue advanced setup' })).toBeTruthy()
  })

  it('replaces the existing overview when a published setup is active', () => {
    const onOpenSetup = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview-v1', setupAction: 'republish' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        report={report}
        onOpenSetup={onOpenSetup}
      />,
    )

    expect(screen.queryByText('Existing project overview')).toBeNull()
    expect(screen.getByText('Setup update required.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Republish setup' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
  })

  it('shows the same landing to a viewer without setup actions', () => {
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'simple-overview', setupAction: 'set-up' }}
        canEdit={false}
        simpleOverview={<p>Existing project overview</p>}
      />,
    )

    expect(screen.getByText('Existing project overview')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the active current setup with Run measurement and a secondary Edit setup action', () => {
    const onOpenSetup = vi.fn()
    const onRunMeasurement = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        report={availableReport}
        onOpenSetup={onOpenSetup}
        onRunMeasurement={onRunMeasurement}
      />,
    )

    expect(screen.queryByText('Existing project overview')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run measurement' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
    expect(onRunMeasurement).toHaveBeenCalledTimes(1)
  })

  it('distinguishes loading from failure and preserves the setup action', () => {
    const onOpenSetup = vi.fn()
    const view = render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={null}
        reportState="loading"
        onOpenSetup={onOpenSetup}
      />,
    )

    expect(screen.getByLabelText('Loading advanced measurement report')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)

    const onRetryReport = vi.fn()
    view.rerender(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={null}
        reportState="error"
        onOpenSetup={onOpenSetup}
        onRetryReport={onRetryReport}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('Could not load the advanced measurement report.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry report' }))
    expect(onRetryReport).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Edit setup' })).toBeTruthy()
  })
})
