import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { assertNotProjectScoped } from '../src/auth.js'

/**
 * The guard for routes whose RESPONSE spans more than the scoped project.
 *
 * Four routes enumerate an upstream principal's account tree — GSC properties,
 * GBP accounts, Bing sites, GA4 properties — so each names every client on the
 * instance regardless of the project in the URL. `assertProjectScope` cannot
 * express that: it compares ONE entity against the key's project, while here
 * the whole response exceeds the boundary.
 *
 * The end-to-end behavior is covered through the real auth plugin in
 * `api-key-project-scope.test.ts` for the two routes that harness mounts.
 * This pins the shared decision itself.
 */
function req(projectId?: string): FastifyRequest {
  return { apiKey: projectId ? { id: 'k', name: 'k', scopes: ['read'], projectId } : undefined } as FastifyRequest
}

describe('assertNotProjectScoped', () => {
  it('throws for a project-scoped key', () => {
    expect(() => assertNotProjectScoped(req('proj-a'), 'listing things')).toThrow(/scoped to a single project/)
  })

  it('names what the caller was refused, so the message is actionable', () => {
    expect(() => assertNotProjectScoped(req('proj-a'), 'listing Bing Webmaster sites'))
      .toThrow(/listing Bing Webmaster sites/)
  })

  it('passes a full-instance key (no projectId)', () => {
    expect(() => assertNotProjectScoped({ apiKey: { id: 'k', name: 'k', scopes: ['*'] } } as FastifyRequest, 'x')).not.toThrow()
  })

  it('passes a signed-in person (no apiKey on the request)', () => {
    expect(() => assertNotProjectScoped(req(), 'x')).not.toThrow()
  })
})
