/**
 * What THIS val's check produces, and the reuse namespace that retires it.
 *
 * `@canonry/val-kit` is opaque to both: a `CheckRecord<CheckResult>` carries
 * this schema through the kit's admission, lease, quota, and storage machinery
 * without the kit ever reading inside it, and `checkFingerprint` takes the
 * namespace as its first argument rather than inventing one. That is what lets
 * a second val store an entirely different result in the same table without
 * either product being able to serve the other's cached work.
 */
import type { VisibilityReport } from 'npm:@canonry/val-kit@0.1.0/visibility'
import type { SiteHealthSample } from '../site-health/types.ts'

/**
 * The reuse namespace for this product. It is the FIRST field of every
 * fingerprint, which is both the 24h cache key and the one-active-check index.
 *
 * Bump it — and only it — when a change adds or removes a measured signal, so
 * records that lack the new signal stop satisfying new requests at the moment
 * the signal set changed rather than at their own TTL. `v3` is current because
 * checks now measure the brands each answer names. Never bump another
 * product's namespace, and never reuse one: two products keyed alike would
 * serve each other's results as cache hits.
 */
export const CHECK_FINGERPRINT_NAMESPACE = 'visibility-v3'

export const CHECK_RESULT_SCHEMA_VERSION = '1.0' as const

export interface CheckResult {
  schemaVersion: typeof CHECK_RESULT_SCHEMA_VERSION
  domain: string
  generatedAt: string
  visibility: VisibilityReport | null
  siteHealth: SiteHealthSample | null
  errors: Array<{ area: 'visibility' | 'site-health'; code: string; message: string }>
}
