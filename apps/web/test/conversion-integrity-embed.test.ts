import { expect, test } from 'vitest'

import { filterEmbedProjectTabs, resolveEmbedProjectTab } from '../src/embed.js'

test('Conversion Integrity remains operator-only in read-only embeds', () => {
  const allowed = filterEmbedProjectTabs(['overview', 'conversions', 'report'])

  expect(allowed).toEqual(['overview', 'report'])
  expect(resolveEmbedProjectTab('conversions', allowed)).toBe('overview')
})
