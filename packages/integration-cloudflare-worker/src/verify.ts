import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalizeCloudflareJson } from './canonical-json.js'

const DEFAULT_MAX_AGE_SECONDS = 300

export type VerifyRequestSignatureFailureReason =
  | 'timestamp_invalid'
  | 'timestamp_expired'
  | 'signature_invalid'
  | 'signature_mismatch'

export type VerifyRequestSignatureResult =
  | { ok: true }
  | { ok: false; reason: VerifyRequestSignatureFailureReason }

interface VerifyRequestSignatureBaseOptions {
  timestamp: string
  signature: string
  secret: string
  /** Override for tests; defaults to `Date.now() / 1000`. */
  nowSeconds?: number
  /** Acceptable clock skew on either side of `nowSeconds`. */
  maxAgeSeconds?: number
}

export type VerifyRequestSignatureOptions = VerifyRequestSignatureBaseOptions & (
  | {
    /** Legacy/raw signing input. Preserved for already-deployed Workers. */
    body: string
  }
  | {
    /** Parsed payload. Canonicalized before verification. */
    payload: unknown
    /** Disable only after every pre-canonical Worker has been replaced. Default: true. */
    acceptLegacyJson?: boolean
  }
)

/**
 * Verify the HMAC-SHA256 signature on a Cloudflare Worker → canonry ingest
 * request. New Workers sign `timestamp + "." + canonicalJson(payload)`. When
 * a parsed `payload` is supplied, the verifier also accepts its ordinary
 * `JSON.stringify` representation by default so Workers generated before the
 * canonical encoding rollout do not fail immediately. Callers can remove the
 * bridge with `acceptLegacyJson: false` after those Workers are replaced.
 *
 * Failure reasons are intentionally specific (`timestamp_invalid` vs
 * `timestamp_expired` vs `signature_invalid` vs `signature_mismatch`) so
 * the receiver can log and rate-limit appropriately, but the caller MUST
 * NOT echo the reason back to the Worker — exposing whether the failure
 * was bearer/HMAC/timestamp lets an attacker enumerate which leg of the
 * auth they're missing.
 */
export function verifyRequestSignature(opts: VerifyRequestSignatureOptions): VerifyRequestSignatureResult {
  const { timestamp, signature, secret } = opts
  if (timestamp === '' || !/^-?\d+$/.test(timestamp)) {
    return { ok: false, reason: 'timestamp_invalid' }
  }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp_invalid' }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  if (Math.abs(now - ts) > maxAge) return { ok: false, reason: 'timestamp_expired' }

  if (signature === '' || !/^[0-9a-f]+$/i.test(signature)) {
    return { ok: false, reason: 'signature_invalid' }
  }
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'hex')
  } catch {
    return { ok: false, reason: 'signature_invalid' }
  }

  let bodies: string[]
  try {
    if ('body' in opts) {
      bodies = [opts.body]
    } else {
      const canonical = canonicalizeCloudflareJson(opts.payload)
      const legacy = JSON.stringify(opts.payload)
      bodies = [canonical]
      if (opts.acceptLegacyJson !== false && typeof legacy === 'string' && legacy !== canonical) {
        bodies.push(legacy)
      }
    }
  } catch {
    return { ok: false, reason: 'signature_invalid' }
  }

  let comparableLength = false
  for (const body of bodies) {
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
    if (provided.length !== expected.length) continue
    comparableLength = true
    if (timingSafeEqual(provided, expected)) return { ok: true }
  }
  if (!comparableLength) return { ok: false, reason: 'signature_invalid' }
  return { ok: false, reason: 'signature_mismatch' }
}
