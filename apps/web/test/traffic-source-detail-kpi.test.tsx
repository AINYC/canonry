import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { TrafficKpi } from '../src/pages/TrafficSourceDetailPage.js'

afterEach(cleanup)

test('renders an optional accessible methodology tooltip beside a traffic KPI label', () => {
  render(
    <TrafficKpi
      label="Content crawls"
      value={1234}
      tooltip="Content and document paths only. Excludes sitemap 10, robots 2, assets 8, and 4 other requests such as feeds, API paths, or downloads. Total crawler hits: 1,258."
    />,
  )

  expect(screen.getByText('Content crawls')).toBeTruthy()
  expect(screen.getByText('1,234')).toBeTruthy()
  expect(screen.getByRole('button', { name: /content and document paths only/i })).toBeTruthy()
})

test('does not render a tooltip trigger when a KPI has no methodology text', () => {
  render(<TrafficKpi label="AI user fetches" value={5} />)

  expect(screen.queryByRole('button')).toBeNull()
})
