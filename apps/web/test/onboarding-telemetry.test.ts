import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearOnboardingRunLaunched,
  getOrCreateOnboardingSessionId,
  isOnboardingHealthSettled,
  markOnboardingRunLaunched,
  onboardingErrorReason,
  onboardingStepFromIndex,
  onboardingSystemBlockReason,
  readOnboardingLaunchedRunId,
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

  it('names the provider failures the query-generation step actually hits', () => {
    // Generating queries calls a provider, so its failures are provider
    // failures. Reporting all of them as `unknown` made the step with the worst
    // recovery the one step nobody could diagnose.
    expect(onboardingErrorReason({ code: 'RATE_LIMITED' }, 'unknown')).toBe('rate_limited')
    expect(onboardingErrorReason({ code: 'QUOTA_EXCEEDED' }, 'unknown')).toBe('rate_limited')
    expect(onboardingErrorReason({ code: 'PROVIDER_AUTH' }, 'unknown')).toBe('provider_auth')
    expect(onboardingErrorReason({ code: 'AUTH_INVALID' }, 'unknown')).toBe('provider_auth')
    expect(onboardingErrorReason({ code: 'CONNECTION_ERROR' }, 'unknown')).toBe('network')
    expect(onboardingErrorReason({ code: 'NETWORK' }, 'unknown')).toBe('network')
    // A code we have never seen still falls back rather than guessing.
    expect(onboardingErrorReason({ code: 'SOMETHING_NEW' }, 'unknown')).toBe('unknown')
  })
})

describe('onboarding launched-run marker', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('remembers the launched run across a remount and clears exactly once', () => {
    // The wizard's run-step completion depends on the component still polling
    // when a 30-second-plus sweep lands. Component state does not survive a
    // reload, so without this marker a slow SUCCESS is unrecordable while a
    // sub-second FAILURE always records: the funnel could only count failures.
    expect(readOnboardingLaunchedRunId()).toBeNull()

    markOnboardingRunLaunched('run-42')
    expect(readOnboardingLaunchedRunId()).toBe('run-42')

    clearOnboardingRunLaunched()
    expect(readOnboardingLaunchedRunId()).toBeNull()
  })

  it('survives a page reload but not a new browser session', () => {
    markOnboardingRunLaunched('run-42')
    // sessionStorage is the same scope the onboarding session id uses, so the
    // marker and the session it belongs to expire together.
    expect(window.sessionStorage.getItem('canonry.onboarding-launched-run.v1')).toBe('run-42')
    window.sessionStorage.clear()
    expect(readOnboardingLaunchedRunId()).toBeNull()
  })
})
