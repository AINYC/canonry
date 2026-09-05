import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildEngineRoutePublicDto,
  buildImplicitNativeEngineRoute,
  engineConnectionModelCatalogResponseSchema,
  engineRouteConfigSchema,
  normalizeEngineConnection,
  upsertEngineConnection,
  type EngineConnectionConfig,
  type EngineRouteConfig,
} from '@ainyc/canonry-contracts'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const directory of tmpDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-routes-settings-'))
  tmpDirs.push(tmpDir)
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const connections: EngineConnectionConfig[] = []
  const routes: EngineRouteConfig[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    engineConnections: () => connections.map(buildEngineRoutePublicDto),
    engineRoutes: () => routes,
    onEngineConnectionUpsert: input => {
      const index = connections.findIndex(connection => connection.id === input.id)
      const next = upsertEngineConnection(index >= 0 ? connections[index] : undefined, input)
      if (index >= 0) connections[index] = next
      else connections.push(next)
      return buildEngineRoutePublicDto(next)
    },
    onEngineRouteUpsert: route => {
      const index = routes.findIndex(candidate => candidate.id === route.id)
      if (index >= 0) routes[index] = route
      else routes.push(route)
      return route
    },
    getEngineConnectionModelCatalog: async connectionId => engineConnectionModelCatalogResponseSchema.parse({
      connectionId,
      state: 'available',
      manualModelIdAllowed: true,
      fetchedAt: '2026-09-01T00:00:00.000Z',
      models: [
        { id: 'openai/gpt-5.4', displayName: 'GPT 5.4', provider: 'openai' },
        { id: 'anthropic/claude-sonnet', displayName: 'Claude Sonnet', provider: 'anthropic' },
      ],
    }),
  } satisfies ApiRoutesOptions)
  return { app, connections, routes }
}

describe('engine route settings API', () => {
  it('reports invalid connection and route path IDs as client errors without writing', async () => {
    const { app, connections, routes } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'gateway-main', label: 'Gateway', preset: 'litellm',
      quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
    }))
    const before = structuredClone(connections)
    await app.ready()
    try {
      const connection = await app.inject({
        method: 'PUT', url: '/api/v1/settings/engine-connections/invalid%20id',
        payload: { label: 'Invalid', preset: 'litellm', quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 } },
      })
      expect(connection.statusCode, connection.body).toBe(400)
      const route = await app.inject({
        method: 'PUT', url: '/api/v1/settings/engine-routes/route:invalid%20id',
        payload: { label: 'Invalid', connectionId: 'gateway-main', modelId: 'model' },
      })
      expect(route.statusCode, route.body).toBe(400)
      expect(connections).toEqual(before)
      expect(routes).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('rejects a create-only route collision but keeps explicit edits available', async () => {
    const { app, connections, routes } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'gateway-main', label: 'Gateway', preset: 'litellm',
      quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
    }))
    await app.ready()
    try {
      const url = '/api/v1/settings/engine-routes/route:shared-id'
      const payload = { label: 'Original route', connectionId: 'gateway-main', modelId: 'original-model' }
      const created = await app.inject({ method: 'PUT', url, headers: { 'If-None-Match': '*' }, payload })
      expect(created.statusCode, created.body).toBe(200)
      const original = structuredClone(routes[0])
      const collision = await app.inject({
        method: 'PUT', url, headers: { 'If-None-Match': '*' }, payload: { ...payload, modelId: 'replacement-model' },
      })
      expect(collision.statusCode, collision.body).toBe(412)
      expect(routes).toEqual([original])
      const edited = await app.inject({ method: 'PUT', url, payload: { ...payload, modelId: 'replacement-model' } })
      expect(edited.statusCode, edited.body).toBe(200)
      expect(routes[0]).toMatchObject({ modelId: 'replacement-model', revision: 2 })
    } finally {
      await app.close()
    }
  })

  it('rejects a create-only collision without changing the existing endpoint or key', async () => {
    const { app, connections } = buildApp()
    await app.ready()
    try {
      const payload = { label: 'Original', preset: 'litellm', apiKey: 'original-test-key', quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 } }
      const url = '/api/v1/settings/engine-connections/connection:gateway'
      expect((await app.inject({ method: 'PUT', url, headers: { 'If-None-Match': '*' }, payload })).statusCode).toBe(200)
      const original = structuredClone(connections[0])
      const collision = await app.inject({ method: 'PUT', url, headers: { 'If-None-Match': '*' }, payload: { ...payload, label: 'Replacement', apiKey: 'replacement-test-key' } })
      expect(collision.statusCode).toBe(412)
      expect(connections).toEqual([original])
      expect((await app.inject({ method: 'PUT', url, payload: { ...payload, label: 'Explicit edit' } })).statusCode).toBe(200)
      expect(connections[0]?.label).toBe('Explicit edit')
    } finally {
      await app.close()
    }
  })

  it('writes a generic connection but returns only redacted settings metadata', async () => {
    const { app, connections } = buildApp()
    await app.ready()
    try {
      const write = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/litellm-main',
        payload: {
          label: 'LiteLLM', preset: 'litellm', apiKey: 'never-in-a-read',
          quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
        },
      })
      expect(write.statusCode).toBe(200)
      expect(connections).toHaveLength(1)
      expect(write.json()).toMatchObject({ id: 'litellm-main', secretConfigured: true })
      expect(write.body).not.toContain('never-in-a-read')

      const read = await app.inject({ method: 'GET', url: '/api/v1/settings' })
      expect(read.statusCode).toBe(200)
      expect(read.json().engineConnections).toEqual([expect.objectContaining({ id: 'litellm-main', secretConfigured: true })])
      expect(read.body).not.toContain('never-in-a-read')

      const redactedUpdate = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/litellm-main',
        payload: {
          label: 'LiteLLM production', preset: 'litellm',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
        },
      })
      expect(redactedUpdate.statusCode).toBe(200)
      expect(connections[0]?.apiKey).toBe('never-in-a-read')
      expect(redactedUpdate.body).not.toContain('never-in-a-read')

      const repointedWithoutReplacement = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/litellm-main',
        payload: {
          label: 'Replacement gateway', preset: 'custom-openai-compatible', baseUrl: 'https://gateway.example/v1',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
        },
      })
      expect(repointedWithoutReplacement.statusCode).toBe(400)
      expect(repointedWithoutReplacement.json().error.message).toMatch(/explicit apiKey/i)
      expect(connections[0]).toMatchObject({ baseUrl: 'http://localhost:4000', apiKey: 'never-in-a-read' })

      const clientOwnedId = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-connections/litellm-main',
        payload: {
          id: 'try-to-replace-id',
          label: 'LiteLLM production', preset: 'litellm',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
        },
      })
      expect(clientOwnedId.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('accepts text-only routes and rejects a client claim of measurement evidence', async () => {
    const { app, routes, connections } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'gateway-main', label: 'Gateway', preset: 'custom-openai-compatible',
      baseUrl: 'https://gateway.example/v1', apiKey: 'secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
    }))
    await app.ready()
    try {
      const route = {
        label: 'Analysis', connectionId: 'gateway-main', modelId: 'openai/gpt-5.4',
      }
      const accepted = await app.inject({
        method: 'PUT', url: '/api/v1/settings/engine-routes/route:gateway-main', payload: route,
      })
      expect(accepted.statusCode).toBe(200)
      expect(routes).toEqual([engineRouteConfigSchema.parse({
        id: 'route:gateway-main', ...route, revision: 1, source: 'configured', capabilities: { kind: 'text-only' },
      })])

      const unsafe = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/engine-routes/route:gateway-main',
        payload: {
          ...route,
          revision: 999,
        },
      })
      expect(unsafe.statusCode).toBe(400)
      expect(unsafe.json().error.message).toMatch(/invalid engine route configuration/i)
    } finally {
      await app.close()
    }
  })

  it('rejects removed OpenRouter preset and measurement policy payloads', async () => {
    const { app, routes, connections } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'gateway-main', label: 'Gateway', preset: 'custom-openai-compatible',
      baseUrl: 'https://gateway.example/v1', apiKey: 'secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
    }))
    await app.ready()
    try {
      const removedPreset = await app.inject({
        method: 'PUT', url: '/api/v1/settings/engine-connections/legacy-router',
        payload: {
          label: 'Legacy router', preset: 'openrouter', apiKey: 'secret',
          quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
        },
      })
      expect(removedPreset.statusCode).toBe(400)

      const removedMeasurement = await app.inject({
        method: 'PUT', url: '/api/v1/settings/engine-routes/route:legacy-search',
        payload: {
          label: 'Legacy search', connectionId: 'gateway-main', modelId: 'vendor/model',
          measurement: { kind: 'openrouter-web-search', engine: 'native' },
        },
      })
      expect(removedMeasurement.statusCode).toBe(400)
      expect(routes).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('keeps a route with a missing connection visible but does not mark virtual native routes unavailable', async () => {
    const { app, routes } = buildApp()
    routes.push(engineRouteConfigSchema.parse({
      id: 'route:orphaned', label: 'Saved route', connectionId: 'missing-connection', modelId: 'openai/gpt-5.4',
      revision: 3, source: 'configured', capabilities: { kind: 'text-only' },
    }))
    routes.push(buildImplicitNativeEngineRoute({
      provider: 'openai', displayName: 'OpenAI', defaultModel: 'gpt-5.4',
      capabilities: {
        kind: 'verified-measurement', retrieval: true, citations: true,
        location: true, servedModel: true, fallback: 'disabled',
      },
    }))
    await app.ready()
    try {
      const summary = await app.inject({ method: 'GET', url: '/api/v1/settings/engine-routes' })
      expect(summary.statusCode).toBe(200)
      expect(summary.json()).toEqual({
        routes: [{
          id: 'native:openai', label: 'OpenAI', modelId: 'gpt-5.4', revision: 1, source: 'implicit-native',
          readiness: { state: 'measurement-ready', measurementReady: true },
        }, {
          id: 'route:orphaned', label: 'Saved route', modelId: 'openai/gpt-5.4', revision: 3, source: 'configured',
          readiness: { state: 'unavailable', measurementReady: false },
        }],
      })
      expect(summary.body).not.toContain('missing-connection')
    } finally {
      await app.close()
    }
  })

  it('returns a bounded credential-redacted model catalog without starting inference', async () => {
    const { app, connections } = buildApp()
    connections.push(normalizeEngineConnection({
      id: 'gateway-main', label: 'Gateway', preset: 'custom-openai-compatible',
      baseUrl: 'https://gateway.example/v1', apiKey: 'catalog-secret',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
    }))
    await app.ready()
    try {
      const catalog = await app.inject({ method: 'GET', url: '/api/v1/settings/engine-connections/gateway-main/models' })
      expect(catalog.statusCode).toBe(200)
      expect(catalog.json()).toMatchObject({
        connectionId: 'gateway-main',
        state: 'available',
        manualModelIdAllowed: true,
        models: expect.arrayContaining([expect.objectContaining({ id: 'openai/gpt-5.4' })]),
      })
      expect(catalog.body).not.toContain('catalog-secret')

      const unknown = await app.inject({ method: 'GET', url: '/api/v1/settings/engine-connections/missing/models' })
      expect(unknown.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
