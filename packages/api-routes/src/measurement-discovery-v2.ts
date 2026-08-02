import type { FastifyInstance } from 'fastify'
import { notImplemented } from '@ainyc/canonry-contracts'

/**
 * Sitemap import and identity rebinding against a setup draft.
 *
 * These are draft actions, but they belong here rather than in
 * `measurement-draft.ts` because the fetch they perform is the hardened one:
 * the server dereferences an operator-supplied URL while sitting on a tailnet
 * beside internal services. Both produce review proposals only — neither
 * publishes a plan nor starts a run.
 *
 * Registered now, with the bodies landing alongside the hardened fetch.
 */
export async function measurementDiscoveryV2Routes(app: FastifyInstance) {
  const pending = (action: string): never => {
    throw notImplemented(`Measurement ${action} is not available yet.`)
  }

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/import-sitemap', async () => pending('sitemap import'))

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/apply-sitemap-selection', async () => pending('sitemap selection'))
}
