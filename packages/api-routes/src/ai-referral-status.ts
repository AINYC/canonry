import { sql } from 'drizzle-orm'
import { aiReferralEventsHourly } from '@ainyc/canonry-db'

/**
 * An AI referral row records a REQUEST carrying AI-origin evidence, together
 * with the status the server answered it with. Not every such request is a
 * visit, and the status is what separates them.
 *
 * A 3xx is a redirect hop. The visitor received no content at that URL; their
 * browser was sent somewhere else, and the destination raises its own row when
 * it carries the same evidence. Counting the hop as an arrival therefore counts
 * one person twice on any site that redirects, and counts them at least once on
 * a site whose redirect target drops the evidence, where the arrival is never
 * observed at all.
 *
 * This is not hypothetical. Across five live projects 248 of 1,572 referral
 * hits (15.8%) were 3xx, and on one of them every single referral hit was a
 * redirect: 120 hops reported as 120 visitors to a site whose own analytics
 * recorded 2 sessions.
 *
 * 4xx and 5xx are deliberately KEPT. Someone did arrive; they landed on a
 * broken or missing page, which is a real finding rather than a miscount, and
 * suppressing it would hide exactly the pages worth fixing.
 */
export const AI_REFERRAL_REDIRECT_MIN = 300
export const AI_REFERRAL_REDIRECT_MAX = 399

/** True when this status is a redirect hop rather than a served response. */
export function isReferralRedirectStatus(status: number): boolean {
  return status >= AI_REFERRAL_REDIRECT_MIN && status <= AI_REFERRAL_REDIRECT_MAX
}

/**
 * Rows where the visitor actually received a response at the URL they landed
 * on. Use for any figure presented as visits, visitors, sessions or arrivals.
 */
export function referralLandedCondition() {
  return sql`(${aiReferralEventsHourly.status} < ${AI_REFERRAL_REDIRECT_MIN}
    OR ${aiReferralEventsHourly.status} > ${AI_REFERRAL_REDIRECT_MAX})`
}

/** The complement: redirect hops only, for reporting them in their own right. */
export function referralRedirectedCondition() {
  return sql`(${aiReferralEventsHourly.status} >= ${AI_REFERRAL_REDIRECT_MIN}
    AND ${aiReferralEventsHourly.status} <= ${AI_REFERRAL_REDIRECT_MAX})`
}
