import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MetricsWindowPicker } from '../src/components/shared/MetricsWindowPicker.js'

afterEach(cleanup)

describe('MetricsWindowPicker', () => {
  test('marks only the selected window as pressed', () => {
    render(
      <MetricsWindowPicker windows={['7d', '14d', '30d'] as const} value="14d" onChange={() => {}} label="Google Ads time period" />,
    )

    expect(screen.getByRole('button', { name: '14d' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '7d' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('group', { name: 'Google Ads time period' })).toBeTruthy()
  })

  test('reports the chosen window', () => {
    const onChange = vi.fn()
    render(
      <MetricsWindowPicker windows={['7d', '14d', '30d'] as const} value="7d" onChange={onChange} label="Google Ads time period" />,
    )

    fireEvent.click(screen.getByRole('button', { name: '30d' }))
    expect(onChange).toHaveBeenCalledWith('30d')
  })

  test('renders the option label a surface supplies rather than the raw token', () => {
    // Search Console carries an 'all' window that must not read as "all" in
    // lowercase beside 7d/30d/90d.
    render(
      <MetricsWindowPicker
        windows={['7d', 'all'] as const}
        value="7d"
        onChange={() => {}}
        label="Search Console time period"
        formatOption={(w) => (w === 'all' ? 'All' : w)}
      />,
    )

    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()
  })
})
