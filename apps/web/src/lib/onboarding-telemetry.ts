import type { OnboardingBlockReason, OnboardingStep } from '@ainyc/canonry-contracts'
import type { HealthSnapshot } from '../view-models.js'

const SESSION_KEY = 'canonry.onboarding-session.v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const STEP_NAMES: readonly OnboardingStep[] = [
  'system',
  'project',
  'queries',
  'competitors',
  'run',
]

export function onboardingStepFromIndex(index: number): OnboardingStep {
  return STEP_NAMES[index] ?? 'system'
}

export function onboardingSystemBlockReason(input: {
  apiReady: boolean
  databaseConfigured?: boolean
  workerReady: boolean
  providerReady: boolean
}): OnboardingBlockReason | undefined {
  if (!input.apiReady) return 'api_unavailable'
  if (input.databaseConfigured === false) return 'database_unavailable'
  if (!input.workerReady) return 'worker_unavailable'
  if (!input.providerReady) return 'no_provider'
  return undefined
}

export function isOnboardingHealthSettled(snapshot: HealthSnapshot): boolean {
  return snapshot.apiStatus.state !== 'checking'
    && snapshot.workerStatus.state !== 'checking'
}

export function onboardingErrorReason(
  error: unknown,
  fallback: OnboardingBlockReason,
): OnboardingBlockReason {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
  if (code === 'NO_PROVIDER') return 'no_provider'
  if (code === 'NO_QUERIES') return 'no_queries'
  return fallback
}

export function getOrCreateOnboardingSessionId(): string {
  try {
    const existing = typeof window !== 'undefined'
      ? window.sessionStorage.getItem(SESSION_KEY)
      : null
    if (existing && UUID_PATTERN.test(existing)) return existing

    const id = createUuid()
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return createUuid()
  }
}

export function createOnboardingEventId(): string {
  return createUuid()
}

function createUuid(): string {
  const cryptoApi = globalThis.crypto as Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>
  if (cryptoApi.randomUUID) return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (cryptoApi.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
