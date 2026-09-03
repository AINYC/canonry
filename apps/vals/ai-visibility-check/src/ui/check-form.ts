import type { ValTownConfig } from 'npm:@canonry/val-kit@0.2.0/config'
import type { CheckFormViewModel } from './types.ts'

type PublicCheckFormConfig = Pick<
  ValTownConfig,
  | 'publicChecksEnabled'
  | 'publicChecksUnavailableMessage'
  | 'humanVerificationStatus'
  | 'turnstileSiteKey'
>

/** Builds the public form from the complete admission capability, not CAPTCHA alone. */
export function createPublicCheckForm(config: PublicCheckFormConfig): CheckFormViewModel {
  const unavailable = !config.publicChecksEnabled
  return {
    action: '/check',
    method: 'post',
    verificationFieldName: 'cf-turnstile-response',
    turnstileSiteKey: unavailable ? null : config.turnstileSiteKey,
    turnstileAction: 'audit',
    verificationStatus: unavailable ? 'unavailable' : config.humanVerificationStatus,
    verificationUnavailableMessage: unavailable
      ? config.publicChecksUnavailableMessage ?? 'Public checks are temporarily unavailable.'
      : 'Human verification is not configured. Public checks are disabled.',
    submitLabel: 'Check a domain',
  }
}
