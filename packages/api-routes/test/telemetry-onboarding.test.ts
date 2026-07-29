import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { OnboardingTelemetryEvent } from '@ainyc/canonry-contracts'
import { telemetryRoutes } from '../src/telemetry.js'

async function buildApp(recordOnboardingEvent?: (event: OnboardingTelemetryEvent) => void) {
  const app = Fastify()
  await app.register(telemetryRoutes, { recordOnboardingEvent })
  await app.ready()
  return app
}

describe('onboarding telemetry route', () => {
  const eventId = '30ed4717-c740-433f-9d37-05421e3f1a75'
  const onboardingSessionId = '02db91c9-98d6-4826-b2cf-a9d4bec84768'

  it('accepts and forwards an allowlisted event', async () => {
    const events: OnboardingTelemetryEvent[] = []
    const app = await buildApp(event => events.push(event))

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/onboarding',
      payload: {
        event: 'onboarding.started',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'project',
        resumed: true,
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    expect(events).toEqual([{
      event: 'onboarding.started',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'project',
      resumed: true,
    }])
    await app.close()
  })

  it('is a safe no-op when the deployment does not collect telemetry', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/onboarding',
      payload: {
        event: 'onboarding.started',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'system',
        resumed: false,
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: false })
    await app.close()
  })

  it('rejects unknown fields before they can reach the collector', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/onboarding',
      payload: {
        event: 'onboarding.blocked',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'run',
        action: 'launch_run',
        reasonCode: 'run_failed',
        rawError: 'credential leaked here',
      },
    })

    expect(response.statusCode).toBe(400)
    await app.close()
  })
})
