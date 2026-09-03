/**
 * What THIS val's check produces, and the reuse namespace that retires it.
 *
 * `@canonry/val-kit` is opaque to both: a `CheckRecord<PerceptionCheckResult>`
 * carries this schema through the kit's admission, lease, quota, and storage
 * machinery without the kit ever reading inside it, and `checkFingerprint` takes
 * the namespace as its first argument rather than inventing one. That is what
 * lets this val and the AI Visibility Check val store entirely different results
 * in the same table without either serving the other's cached work.
 */
import type { PerceptionReport } from 'npm:@canonry/val-kit@0.1.0/perception'

/**
 * The reuse namespace for this product. It is the FIRST field of every
 * fingerprint, which is both the 24h cache key and the one-active-check index.
 *
 * Bump it — and only it — when a change adds or removes a measured signal, so
 * records that lack the new signal stop satisfying new requests at the moment
 * the signal set changed rather than at their own TTL. Never bump another
 * product's namespace, and never reuse one: two products keyed alike would
 * serve each other's results as cache hits, and a perception check and a
 * visibility check for one domain measure entirely different things.
 */
export const CHECK_FINGERPRINT_NAMESPACE = 'perception-v1'

export const CHECK_RESULT_SCHEMA_VERSION = '1.0' as const

export interface PerceptionCheckResult {
  schemaVersion: typeof CHECK_RESULT_SCHEMA_VERSION
  domain: string
  generatedAt: string
  /** Null when the one phase produced nothing at all. */
  perception: PerceptionReport | null
  errors: Array<{ area: 'perception'; message: string }>
}
