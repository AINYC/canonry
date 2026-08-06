import { expect, test } from 'vitest'

import {
  DEFAULT_MEASUREMENT_VIEW,
  measurementViewSearch,
  parseMeasurementViewSearch,
} from '../src/lib/measurement-view-url.js'

test('reads a group scope and a query class out of the URL', () => {
  expect(parseMeasurementViewSearch({ scope: 'group:north', class: 'branded' }))
    .toEqual({ scope: 'group', groupKey: 'north', queryClass: 'branded' })
})

test('an absent search is the default view, not an error', () => {
  expect(parseMeasurementViewSearch({})).toEqual(DEFAULT_MEASUREMENT_VIEW)
})

test('a malformed scope degrades to all properties rather than throwing', () => {
  // These arrive from hand-edited links and months-old bookmarks. Each must
  // land on the default; none may throw.
  for (const scope of ['', 'group:', 'group', 'nonsense', 'all', 'GROUP:north']) {
    expect(parseMeasurementViewSearch({ scope }).scope).toBe('all')
  }
})

test('a malformed class degrades to non-brand, which is never pooled with branded', () => {
  for (const cls of ['', 'BRANDED', 'nonbrand', 'both']) {
    expect(parseMeasurementViewSearch({ class: cls }).queryClass).toBe('non-brand')
  }
})

test('a group key containing a colon survives the round trip', () => {
  // Stable keys are slugs today, but the format must not silently truncate a
  // key that happens to contain the separator.
  const view = parseMeasurementViewSearch({ scope: 'group:north:west' })
  expect(view.groupKey).toBe('north:west')
  expect(measurementViewSearch(view).scope).toBe('group:north:west')
})

test('defaults are written as absent, so the common case leaves a clean URL', () => {
  expect(measurementViewSearch(DEFAULT_MEASUREMENT_VIEW)).toEqual({ scope: undefined, class: undefined })
})

test('a deliberate choice is written, and only that choice', () => {
  expect(measurementViewSearch({ scope: 'group', groupKey: 'north', queryClass: 'non-brand' }))
    .toEqual({ scope: 'group:north', class: undefined })
  expect(measurementViewSearch({ scope: 'all', queryClass: 'branded' }))
    .toEqual({ scope: undefined, class: 'branded' })
})

test('every state survives a URL round trip', () => {
  const states = [
    DEFAULT_MEASUREMENT_VIEW,
    { scope: 'all' as const, queryClass: 'branded' as const },
    { scope: 'group' as const, groupKey: 'north', queryClass: 'all' as const },
    { scope: 'group' as const, groupKey: 'south', queryClass: 'branded' as const },
  ]
  for (const state of states) {
    expect(parseMeasurementViewSearch(measurementViewSearch(state))).toEqual(state)
  }
})
