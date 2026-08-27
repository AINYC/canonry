import type { FastifyInstance } from 'fastify'
import {
  notImplemented,
  normalizeOnboardingEventForCollection,
  onboardingTelemetryEventSchema,
  validationError,
  type OnboardingTelemetryEvent,
} from '@ainyc/canonry-contracts'

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => { enabled: boolean; anonymousId?: string }
  setTelemetryEnabled?: (enabled: boolean) => void
  recordOnboardingEvent?: (event: OnboardingTelemetryEvent) => void
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async () => {
    if (!opts.getTelemetryStatus) {
      throw notImplemented('Telemetry status is not available in this deployment')
    }

    const status = opts.getTelemetryStatus()
    return {
      enabled: status.enabled,
      anonymousId: status.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })

  app.put<{ Body: { enabled: boolean } }>('/telemetry', async (request) => {
    if (!opts.setTelemetryEnabled) {
      throw notImplemented('Telemetry configuration is not available in this deployment')
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      throw validationError('enabled (boolean) is required')
    }

    opts.setTelemetryEnabled(enabled)
    const status = opts.getTelemetryStatus?.()
    return {
      enabled: status?.enabled ?? enabled,
      anonymousId: status?.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })

  app.post<{ Body: unknown }>('/telemetry/onboarding', async (request, reply) => {
    const parsed = onboardingTelemetryEventSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid onboarding telemetry event', {
        issues: parsed.error.issues.map(issue => ({
          code: issue.code,
          path: issue.path.join('.'),
        })),
      })
    }

    // Missing wiring is a supported deployment posture. The dashboard should
    // never fail onboarding because its host does not collect product
    // telemetry (for example, apps/api or an opted-out local instance).
    opts.recordOnboardingEvent?.(normalizeOnboardingEventForCollection(parsed.data))
    return reply.status(202).send({ accepted: Boolean(opts.recordOnboardingEvent) })
  })
}
