/**
 * Location redirects: the responses whose meaning is "the content is at a
 * different URL, go there". These are the only statuses where the visitor
 * received nothing at the requested URL and a follow-on request happens
 * somewhere else.
 *
 * Deliberately NOT the whole 3xx band. 304 Not Modified is a served page view:
 * the browser revalidated its cache and showed the full page, with no
 * follow-on request to any other URL — on live data 122 of 248 "3xx" AI
 * referral hits were 304s, i.e. real returning visitors. 300 Multiple Choices
 * carries a body the client renders, and 305/306 are reserved/deprecated.
 */
export const LOCATION_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** True when this status tells the client to fetch a DIFFERENT URL. */
export function isLocationRedirectStatus(status: number): boolean {
  return LOCATION_REDIRECT_STATUSES.has(status)
}
