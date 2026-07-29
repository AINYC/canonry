import { describe, expect, it } from 'vitest'
import {
  bucketOnboardingCount,
  isGhostTelemetryEvent,
  onboardingTelemetryEventSchema,
} from '../src/telemetry.js'

describe('isGhostTelemetryEvent', () => {
  it('flags no-provider run.completed / run.aborted from every test location', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: 'nyc' })).toBe(true)
    expect(isGhostTelemetryEvent('run.aborted', { providerCount: 0, location: 'lax' })).toBe(true)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: 'chi' })).toBe(true)
  })

  it('normalizes location case and surrounding whitespace', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: '  LAX  ' })).toBe(true)
    expect(isGhostTelemetryEvent('run.aborted', { providerCount: 0, location: 'NyC' })).toBe(true)
  })

  it('keeps real runs: any provider, an unknown location, or a non-run event', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 1, location: 'nyc' })).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: 'sfo' })).toBe(false)
    expect(isGhostTelemetryEvent('cli.init', { providerCount: 0, location: 'nyc' })).toBe(false)
  })

  it('treats missing properties or a missing location as a real event', () => {
    expect(isGhostTelemetryEvent('run.completed')).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', null)).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', {})).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0 })).toBe(false)
  })

  it('requires providerCount to be exactly 0, not merely falsy', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: undefined, location: 'nyc' })).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: '0', location: 'nyc' })).toBe(false)
  })
})

describe('onboardingTelemetryEventSchema', () => {
  const eventId = '30ed4717-c740-433f-9d37-05421e3f1a75'
  const onboardingSessionId = '02db91c9-98d6-4826-b2cf-a9d4bec84768'

  it('accepts an allowlisted, versioned milestone', () => {
    expect(onboardingTelemetryEventSchema.parse({
      event: 'onboarding.step_completed',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'queries',
      method: 'generated',
      countBucket: '4-5',
    })).toEqual({
      event: 'onboarding.step_completed',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'queries',
      method: 'generated',
      countBucket: '4-5',
    })
  })

  it('rejects raw user content and unrecognized reason codes', () => {
    expect(onboardingTelemetryEventSchema.safeParse({
      event: 'onboarding.blocked',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'run',
      action: 'launch_run',
      reasonCode: 'sk-live-secret',
      domain: 'customer.example',
      error: 'raw provider response',
    }).success).toBe(false)
  })

  it('rejects unknown flow versions', () => {
    expect(onboardingTelemetryEventSchema.safeParse({
      event: 'onboarding.started',
      eventId,
      flowVersion: 2,
      onboardingSessionId,
      step: 'system',
      resumed: false,
    }).success).toBe(false)
  })
})

describe('bucketOnboardingCount', () => {
  it('coarsens counts without exposing exact large baskets', () => {
    expect(bucketOnboardingCount(0)).toBe('0')
    expect(bucketOnboardingCount(1)).toBe('1')
    expect(bucketOnboardingCount(3)).toBe('2-3')
    expect(bucketOnboardingCount(5)).toBe('4-5')
    expect(bucketOnboardingCount(10)).toBe('6-10')
    expect(bucketOnboardingCount(11)).toBe('11+')
  })
})
