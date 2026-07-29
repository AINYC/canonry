import { describe, expect, it } from 'vitest'

import {
  getOrCreateOnboardingSessionId,
  isOnboardingHealthSettled,
  onboardingErrorReason,
  onboardingStepFromIndex,
  onboardingSystemBlockReason,
} from '../src/lib/onboarding-telemetry.js'

describe('onboarding telemetry classification', () => {
  it('keeps one anonymous flow id across setup reloads', () => {
    window.sessionStorage.clear()
    const first = getOrCreateOnboardingSessionId()
    const second = getOrCreateOnboardingSessionId()

    expect(first).toMatch(/^[0-9a-f-]{36}$/i)
    expect(second).toBe(first)
  })

  it('maps setup progress to stable step names', () => {
    expect(onboardingStepFromIndex(0)).toBe('system')
    expect(onboardingStepFromIndex(4)).toBe('run')
  })

  it('reports the first actionable system blocker', () => {
    expect(onboardingSystemBlockReason({
      apiReady: false,
      databaseConfigured: false,
      workerReady: false,
      providerReady: false,
    })).toBe('api_unavailable')
    expect(onboardingSystemBlockReason({
      apiReady: true,
      databaseConfigured: false,
      workerReady: true,
      providerReady: true,
    })).toBe('database_unavailable')
    expect(onboardingSystemBlockReason({
      apiReady: true,
      databaseConfigured: true,
      workerReady: false,
      providerReady: false,
    })).toBe('worker_unavailable')
    expect(onboardingSystemBlockReason({
      apiReady: true,
      databaseConfigured: true,
      workerReady: true,
      providerReady: false,
    })).toBe('no_provider')
  })

  it('does not classify health as blocked while checks are still loading', () => {
    expect(isOnboardingHealthSettled({
      apiStatus: { label: 'API', state: 'checking', detail: 'Checking' },
      workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking' },
    })).toBe(false)
    expect(isOnboardingHealthSettled({
      apiStatus: { label: 'API', state: 'ok', detail: 'Ready' },
      workerStatus: { label: 'Worker', state: 'ok', detail: 'Ready' },
    })).toBe(true)
  })

  it('uses structured API codes without leaking raw errors', () => {
    expect(onboardingErrorReason({ code: 'NO_PROVIDER' }, 'run_rejected')).toBe('no_provider')
    expect(onboardingErrorReason({ code: 'NO_QUERIES' }, 'run_rejected')).toBe('no_queries')
    expect(onboardingErrorReason(new Error('secret'), 'run_rejected')).toBe('run_rejected')
  })
})
