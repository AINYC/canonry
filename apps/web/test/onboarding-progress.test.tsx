import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

import { OnboardingProgress } from '../src/components/shared/OnboardingProgress.js'

afterEach(cleanup)

test('communicates completed, current, and optional onboarding stages', () => {
  render(<OnboardingProgress current="fixes" />)

  const progress = screen.getByRole('list', { name: 'Onboarding progress' })
  const siteAudit = within(progress).getByText('Site audit').closest('li')
  const fixes = within(progress).getByText('Review fixes').closest('li')
  const visibility = within(progress).getByText('AI Visibility').closest('li')

  expect(siteAudit?.textContent).toContain('Done')
  expect(fixes?.getAttribute('aria-current')).toBe('step')
  expect(fixes?.textContent).toContain('Current')
  expect(visibility?.textContent).toContain('Optional')
})
