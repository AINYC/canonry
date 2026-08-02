import type { FastifyInstance } from 'fastify'
import { notImplemented } from '@ainyc/canonry-contracts'

/**
 * Server-side setup draft and the query assets it authors from.
 *
 * The routes are registered and fully described in `openapi.ts` so the
 * generated client and every parity gate already know the surface; the handler
 * bodies, their scope checks and their ETag/idempotency enforcement land with
 * the draft service. Until then each one answers 501 rather than 404, so a
 * caller can tell "not built yet" from "wrong URL".
 */
export async function measurementDraftRoutes(app: FastifyInstance) {
  const pending = (action: string): never => {
    throw notImplemented(`Measurement ${action} is not available yet.`)
  }

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-setup', async () => pending('setup state'))

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft', async () => pending('draft reads'))

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/targets', async () => pending('draft Target paging'))

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/assignments', async () => pending('draft assignment paging'))

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/groups', async () => pending('draft group paging'))

  for (const action of [
    'create',
    'upsert-target',
    'rename-target',
    'merge-targets',
    'exclude-target',
    'rebind-target',
    'apply-assignments',
    'remove-assignment',
    'clear-assignments',
    'classify-assignments',
    'upsert-group',
    'remove-group',
    'upsert-competitor',
    'remove-competitor',
    'publish',
    'discard',
  ]) {
    app.post<{ Params: { name: string } }>(`/projects/:name/measurement-plan/draft/actions/${action}`, async () => pending(`draft action "${action}"`))
  }

  // Both previews are POSTs only because the draft they compile is far too
  // large for a URL, and neither writes a row — see `readSemantic` in `auth.ts`.
  for (const action of ['compile-preview', 'diff-preview']) {
    app.post<{ Params: { name: string } }>(`/projects/:name/measurement-plan/draft/actions/${action}`, {
      config: { readSemantic: true },
    }, async () => pending(`draft action "${action}"`))
  }

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/actions/deactivate', async () => pending('plan deactivation'))

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-query-sets', async () => pending('query sets'))

  app.get<{ Params: { name: string; setId: string } }>('/projects/:name/measurement-query-sets/:setId', async () => pending('query sets'))

  app.put<{ Params: { name: string; setId: string } }>('/projects/:name/measurement-query-sets/:setId', async () => pending('query sets'))

  app.delete<{ Params: { name: string; setId: string } }>('/projects/:name/measurement-query-sets/:setId', async () => pending('query sets'))

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-query-templates', async () => pending('query templates'))

  app.put<{ Params: { name: string; templateId: string } }>('/projects/:name/measurement-query-templates/:templateId', async () => pending('query templates'))

  app.delete<{ Params: { name: string; templateId: string } }>('/projects/:name/measurement-query-templates/:templateId', async () => pending('query templates'))

  app.post<{ Params: { name: string; templateId: string } }>('/projects/:name/measurement-query-templates/:templateId/apply', async () => pending('query template expansion'))
}
