import { describe, expect, it } from 'vitest'
import { LOCATION_REDIRECT_STATUSES, isLocationRedirectStatus } from '../src/http-status.js'

describe('isLocationRedirectStatus', () => {
  it('accepts exactly the five Location redirects', () => {
    for (const s of [301, 302, 303, 307, 308]) expect(isLocationRedirectStatus(s)).toBe(true)
  })

  /**
   * The band deliberately excludes the rest of 3xx: a 304 is a served page
   * view from cache (no follow-on request), 300 carries a rendered body, and
   * 305/306 are reserved. Treating them as redirects drops real visits.
   */
  it('rejects the non-redirect 3xx statuses', () => {
    for (const s of [300, 304, 305, 306]) expect(isLocationRedirectStatus(s)).toBe(false)
  })

  it('rejects everything outside 3xx, including the unobserved 0', () => {
    for (const s of [0, 200, 204, 299, 400, 404, 500]) expect(isLocationRedirectStatus(s)).toBe(false)
  })

  it('set and predicate agree', () => {
    for (let s = 0; s <= 599; s++) {
      expect(isLocationRedirectStatus(s)).toBe(LOCATION_REDIRECT_STATUSES.has(s))
    }
  })
})
