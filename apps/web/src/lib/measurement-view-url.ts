/**
 * The advanced-measurement view state as URL search params.
 *
 * Scale is why this is in the URL at all. With a handful of properties an
 * operator can re-pick a market after every reload; with hundreds of markets
 * that re-pick IS the interaction, and a scope held only in component state
 * cannot be linked, bookmarked, reloaded, or reported in a bug.
 *
 * Defaults are written as ABSENT rather than as `scope=all&class=non-brand`,
 * so the common case leaves a clean URL and only a deliberate choice shows up.
 */

export type MeasurementQueryClass = 'all' | 'non-brand' | 'branded'

export interface MeasurementViewState {
  scope: 'all' | 'group'
  groupKey?: string
  queryClass: MeasurementQueryClass
}

export const DEFAULT_MEASUREMENT_VIEW: MeasurementViewState = { scope: 'all', queryClass: 'non-brand' }

const QUERY_CLASSES: readonly MeasurementQueryClass[] = ['all', 'non-brand', 'branded']

function isQueryClass(value: unknown): value is MeasurementQueryClass {
  return typeof value === 'string' && (QUERY_CLASSES as readonly string[]).includes(value)
}

/**
 * Read view state out of the URL. Anything unrecognised degrades to the
 * default rather than throwing: these values arrive from a bookmark a person
 * saved months ago, or from a link someone edited by hand, and a malformed one
 * must not be able to break the page.
 */
export function parseMeasurementViewSearch(search: { scope?: string; class?: string }): MeasurementViewState {
  const queryClass = isQueryClass(search.class) ? search.class : DEFAULT_MEASUREMENT_VIEW.queryClass
  const raw = search.scope
  if (typeof raw !== 'string' || raw === 'all' || raw.length === 0) {
    return { scope: 'all', queryClass }
  }
  const groupKey = raw.startsWith('group:') ? raw.slice('group:'.length) : ''
  // `group:` with nothing after it names no group, so it is not a group scope.
  if (!groupKey) return { scope: 'all', queryClass }
  return { scope: 'group', groupKey, queryClass }
}

/**
 * Write view state back to the URL, omitting every default. Returns the two
 * keys only, for spreading over the rest of the existing search params.
 */
export function measurementViewSearch(view: MeasurementViewState): { scope?: string; class?: string } {
  return {
    scope: view.scope === 'group' && view.groupKey ? `group:${view.groupKey}` : undefined,
    class: view.queryClass === DEFAULT_MEASUREMENT_VIEW.queryClass ? undefined : view.queryClass,
  }
}
