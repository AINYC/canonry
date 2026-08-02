import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AdvancedMeasurementSetupWizard } from '../src/components/project/advanced-measurement/AdvancedMeasurementSetupWizard.js'

afterEach(cleanup)

describe('advanced measurement setup shell', () => {
  it('shows the five customer-facing steps in order', () => {
    render(
      <AdvancedMeasurementSetupWizard currentStep="properties" hasDraft canEdit onDiscard={vi.fn()}>
        <p>Step content</p>
      </AdvancedMeasurementSetupWizard>,
    )

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Import',
      'Properties',
      'Queries',
      'Groups (optional)',
      'Review and publish',
    ])
    expect(screen.getByText('Properties').getAttribute('aria-current')).toBe('step')
    expect(screen.getByRole('group', { name: 'Advanced measurement setup progress' })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Advanced measurement setup progress' })).toBeNull()

    const heading = screen.getByRole('heading', { name: 'Advanced measurement setup' })
    expect(heading.parentElement?.parentElement?.className).toContain('flex-wrap')
  })

  it('moves focus to the new step heading after a step change', async () => {
    const view = render(
      <AdvancedMeasurementSetupWizard currentStep="import" hasDraft={false} canEdit>
        <section><h2>Import Properties</h2><button type="button">Review sitemap</button></section>
      </AdvancedMeasurementSetupWizard>,
    )
    screen.getByRole('button', { name: 'Review sitemap' }).focus()

    view.rerender(
      <AdvancedMeasurementSetupWizard currentStep="properties" hasDraft={false} canEdit>
        <section><h2>Properties</h2><button type="button">Continue</button></section>
      </AdvancedMeasurementSetupWizard>,
    )

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Properties' })))
    expect(screen.getByRole('heading', { name: 'Properties' }).getAttribute('tabindex')).toBe('-1')
  })

  it('shows draft state and requires an explicit discard confirmation', () => {
    const onDiscard = vi.fn()
    render(
      <AdvancedMeasurementSetupWizard currentStep="import" hasDraft canEdit onDiscard={onDiscard}>
        <p>Step content</p>
      </AdvancedMeasurementSetupWizard>,
    )

    expect(screen.getByText('Unpublished changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.getByText('Discard all unpublished changes?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Discard all unpublished changes?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft visible but removes mutation controls for a viewer', () => {
    render(
      <AdvancedMeasurementSetupWizard currentStep="review" hasDraft canEdit={false}>
        <p>Read-only setup</p>
      </AdvancedMeasurementSetupWizard>,
    )

    expect(screen.getByText('Unpublished changes')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
