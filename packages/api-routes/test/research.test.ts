import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries, researchRuns, runs } from '@ainyc/canonry-db'
import { ResearchRunStatuses } from '@ainyc/canonry-contracts'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

function harness(options: Partial<ApiRoutesOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', providers: ['openai'], locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York', createdAt: now, updatedAt: now }).run()
  const app = Fastify(); const requested: string[] = []
  app.register(apiRoutes, { db, skipAuth: true, onResearchRunRequested: id => requested.push(id), providerSummary: [{ name: 'openai', configured: true }], providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: ['gpt-4.1'], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }], ...options } satisfies ApiRoutesOptions)
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { app, db, requested }
}

describe('research routes', () => {
  it('does not inherit location for text-only research and rejects explicit unsupported context', async () => {
    const { app, db, requested } = harness({
      getResearchProviderAdapters: () => [{
        name: 'route:text', displayName: 'Text', mode: 'api', modelConfigurable: true,
        defaultModel: 'text-model', knownModels: [], modelValidationPattern: /.+/, modelValidationHint: 'model id',
      }],
      getResearchConfiguredProviderNames: () => ['route:text'],
    })
    const location = { label: 'New York', city: 'New York', region: 'NY', country: 'US' }
    const rejected = await app.inject({
      method: 'POST', url: '/api/v1/projects/alpha/research/runs',
      payload: { queries: ['best agencies'], provider: 'route:text', location },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error.message).toContain('do not support location context')
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
    expect(requested).toHaveLength(0)

    for (const locationInput of [{}, { location: null }]) {
      const accepted = await app.inject({
        method: 'POST', url: '/api/v1/projects/alpha/research/runs',
        payload: { queries: ['best agencies'], provider: 'route:text', ...locationInput },
      })
      expect(accepted.statusCode).toBe(202)
      expect(accepted.json().location).toBeNull()
    }
    expect(db.select().from(researchRuns).all().every(run => run.location === null)).toBe(true)
    expect(requested).toHaveLength(2)
    await app.close()
  })

  it('still inherits the project location for native research', async () => {
    const { app } = harness()
    const response = await app.inject({
      method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['best agencies'] },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json().location).toEqual({ label: 'New York', city: 'New York', region: 'NY', country: 'US' })
    await app.close()
  })

  it('persists an isolated batch, lists/details it, and protects retry/project boundaries', async () => {
    const { app, db, requested } = harness()
    const payload = { queries: ['best solar installer', 'solar cost'], provider: 'openai', model: 'gpt-4.1', location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, idempotencyKey: 'retry-1' }
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(created.statusCode).toBe(202); const body = created.json(); expect(body.queries).toHaveLength(2); expect(body.queries[0]).toMatchObject({ namedCompetitors: [], citedCompetitorDomains: [] }); expect(requested).toHaveLength(1)
    expect(db.select().from(queries).all()).toHaveLength(0); expect(db.select().from(runs).all()).toHaveLength(0)
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json().runs).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/beta/research/runs/${body.id}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })).statusCode).toBe(200)
    expect(requested).toEqual([body.id, body.id])
    db.update(researchRuns).set({ status: ResearchRunStatuses.running }).run()
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })).statusCode).toBe(200)
    expect(requested).toEqual([body.id, body.id])
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, queries: ['different'] } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, queries: ['same', 'same'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, provider: 'claude' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, model: 'not-a-gpt-model' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, location: { ...payload.location, city: 'Boston' } } })).statusCode).toBe(400)
    expect(db.select().from(researchRuns).all()).toHaveLength(1)
  })

  it('rejects an unavailable executor before creating research rows', async () => {
    const { db } = harness()
    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      providerSummary: [{ name: 'openai', configured: true }],
      providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: ['gpt-4.1'], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }],
    } satisfies ApiRoutesOptions)
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['test'], provider: 'openai' } })
    expect(response.statusCode).toBe(422)
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
  })
})
