export class HumanVerificationError extends Error {
  override name = 'HumanVerificationError'
  constructor(message: string, readonly code: 'unavailable' | 'invalid' | 'transport' = 'invalid') {
    super(message)
  }
}

export interface HumanVerificationInput {
  token: string | null
  remoteIp: string | null
}

export interface HumanVerifier {
  verify(input: HumanVerificationInput): Promise<void>
}

export interface TurnstileVerifierOptions {
  secret: string
  allowedHostnames: readonly string[]
  fetchImpl?: typeof fetch
}

/** One public form, one server-enforced action. Do not make this client/env configurable. */
export const TURNSTILE_AUDIT_ACTION = 'audit'

interface TurnstileResponse {
  success?: boolean
  action?: string
  hostname?: string
  ['error-codes']?: string[]
}

/** Server-side only Turnstile verification. Tokens never become stored check data. */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): HumanVerifier {
  const allowedHostnames = new Set(options.allowedHostnames.map((hostname) => hostname.toLowerCase()))
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    async verify({ token, remoteIp }) {
      if (!token || token.length > 2048) throw new HumanVerificationError('Complete the human verification challenge.')
      const form = new URLSearchParams({
        secret: options.secret,
        response: token,
        idempotency_key: crypto.randomUUID(),
      })
      if (remoteIp) form.set('remoteip', remoteIp)

      let response: Response
      try {
        response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new HumanVerificationError('Human verification is temporarily unavailable.', 'transport')
      }
      if (!response.ok) throw new HumanVerificationError('Human verification is temporarily unavailable.', 'transport')

      let payload: TurnstileResponse
      try {
        payload = await response.json() as TurnstileResponse
      } catch {
        throw new HumanVerificationError('Human verification is temporarily unavailable.', 'transport')
      }
      if (!payload.success) throw new HumanVerificationError('Complete the human verification challenge.')
      if (payload.action !== TURNSTILE_AUDIT_ACTION) {
        throw new HumanVerificationError('Human verification did not match this check.')
      }
      if (allowedHostnames.size > 0 && (!payload.hostname || !allowedHostnames.has(payload.hostname.toLowerCase()))) {
        throw new HumanVerificationError('Human verification did not match this site.')
      }
    },
  }
}

/** Production deliberately fails closed until a real Turnstile secret is configured. */
export class UnavailableHumanVerifier implements HumanVerifier {
  verify(): Promise<void> {
    return Promise.reject(new HumanVerificationError('Human verification is not configured.', 'unavailable'))
  }
}

/** Development/test-only seam. It is never selected by a production configuration. */
export class LocalBypassHumanVerifier implements HumanVerifier {
  verify(): Promise<void> {
    return Promise.resolve()
  }
}
