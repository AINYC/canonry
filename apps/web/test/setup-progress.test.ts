import { describe, expect, it } from 'vitest'

import { deriveSetupStep, isSuccessfulSetupRun } from '../src/pages/SetupPage.js'

describe('setup durable progress', () => {
  it('returns the first incomplete durable setup stage', () => {
    expect(deriveSetupStep({
      launchReady: false,
      hasProject: true,
      queryCount: 3,
      competitorCount: 1,
      hasRunAttempt: true,
    })).toBe(0)

    expect(deriveSetupStep({
      launchReady: true,
      hasProject: false,
      queryCount: 0,
      competitorCount: 0,
      hasRunAttempt: false,
    })).toBe(1)

    expect(deriveSetupStep({
      launchReady: true,
      hasProject: true,
      queryCount: 0,
      competitorCount: 0,
      hasRunAttempt: false,
    })).toBe(2)

    expect(deriveSetupStep({
      launchReady: true,
      hasProject: true,
      queryCount: 3,
      competitorCount: 0,
      hasRunAttempt: false,
    })).toBe(3)

    expect(deriveSetupStep({
      launchReady: true,
      hasProject: true,
      queryCount: 3,
      competitorCount: 0,
      hasRunAttempt: true,
    })).toBe(4)
  })

  it('requires snapshots from a completed or partial run for activation', () => {
    expect(isSuccessfulSetupRun('completed', 2)).toBe(true)
    expect(isSuccessfulSetupRun('partial', 1)).toBe(true)
    expect(isSuccessfulSetupRun('completed', 0)).toBe(false)
    expect(isSuccessfulSetupRun('failed', 2)).toBe(false)
    expect(isSuccessfulSetupRun('cancelled', 2)).toBe(false)
  })
})
