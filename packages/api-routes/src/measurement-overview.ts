import type { FastifyInstance } from 'fastify'
import { notImplemented } from '@ainyc/canonry-contracts'

/**
 * Scoped Advanced aggregates over one run's evidence.
 *
 * Run selection, the `brandPresence`/`sov` pair and group-only Named Share of
 * Voice all land with the reporting slice. The route is registered now so the
 * generated client carries the shape from the start.
 */
export async function measurementOverviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>('/projects/:name/measurement-overview', async () => {
    throw notImplemented('Measurement overview is not available yet.')
  })
}
