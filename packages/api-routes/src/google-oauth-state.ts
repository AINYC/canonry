import crypto from 'node:crypto'

/**
 * A Google OAuth state is short-lived because it can leak through browser
 * history, referrers, or reverse-proxy access logs.
 */
export const GOOGLE_OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000

function signState(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

export function buildSignedGoogleOAuthState(
  data: Record<string, unknown>,
  secret: string,
  nowMs = Date.now(),
): string {
  const payload = JSON.stringify({ ...data, issuedAt: nowMs })
  const sig = signState(payload, secret)
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url')
}

export function verifySignedGoogleOAuthState(
  encoded: string,
  secret: string,
  nowMs = Date.now(),
): Record<string, unknown> | null {
  try {
    if (!/^[\w-]+$/.test(encoded)) return null
    const decoded = Buffer.from(encoded, 'base64url')
    // Node accepts non-canonical base64url encodings whose unused trailing
    // bits decode to the same bytes. Refuse aliases so changing any encoded
    // character is always observable to the verifier and to security logs.
    if (decoded.toString('base64url') !== encoded) return null
    const parsedEnvelope = JSON.parse(decoded.toString()) as {
      payload?: unknown
      sig?: unknown
    }
    if (typeof parsedEnvelope.payload !== 'string' || typeof parsedEnvelope.sig !== 'string') return null
    if (!/^[a-f0-9]{64}$/.test(parsedEnvelope.sig)) return null

    const expected = signState(parsedEnvelope.payload, secret)
    const actualBuffer = Buffer.from(parsedEnvelope.sig, 'hex')
    const expectedBuffer = Buffer.from(expected, 'hex')
    if (actualBuffer.length !== expectedBuffer.length) return null
    if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null

    const parsed = JSON.parse(parsedEnvelope.payload) as Record<string, unknown>
    const issuedAt = typeof parsed.issuedAt === 'number' ? parsed.issuedAt : null
    if (issuedAt === null || issuedAt > nowMs || nowMs - issuedAt > GOOGLE_OAUTH_STATE_MAX_AGE_MS) return null
    return parsed
  } catch {
    return null
  }
}
