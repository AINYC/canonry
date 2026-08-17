import { describe, expect, it } from 'vitest'
import {
  buildSignedGoogleOAuthState,
  GOOGLE_OAUTH_STATE_MAX_AGE_MS,
  verifySignedGoogleOAuthState,
} from '../src/google-oauth-state.js'

describe('Google OAuth state', () => {
  const secret = 'test-secret-at-least-long-enough'
  const now = Date.UTC(2026, 7, 14, 12)

  it('round-trips a fresh project-bound state', () => {
    const encoded = buildSignedGoogleOAuthState({ projectId: 'project-1', integration: 'gtm' }, secret, now)
    expect(verifySignedGoogleOAuthState(encoded, secret, now)).toMatchObject({
      projectId: 'project-1',
      integration: 'gtm',
      issuedAt: now,
    })
  })

  it('rejects expired, future, tampered, and malformed states', () => {
    const expired = buildSignedGoogleOAuthState({}, secret, now - GOOGLE_OAUTH_STATE_MAX_AGE_MS - 1)
    const future = buildSignedGoogleOAuthState({}, secret, now + 1)
    const valid = buildSignedGoogleOAuthState({}, secret, now)
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`

    expect(verifySignedGoogleOAuthState(expired, secret, now)).toBeNull()
    expect(verifySignedGoogleOAuthState(future, secret, now)).toBeNull()
    expect(verifySignedGoogleOAuthState(tampered, secret, now)).toBeNull()
    expect(verifySignedGoogleOAuthState('not-an-envelope', secret, now)).toBeNull()
  })
})
