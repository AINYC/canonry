import { expect, test } from 'vitest'
import { ProviderRegistry } from '../src/provider-registry.js'
import { fakeAdapter } from './fake-measurement-provider.js'

test('generic text routes are excluded from both default and explicit sweeps', () => {
  const registry = new ProviderRegistry()
  for (const name of ['openai', 'route:text']) {
    registry.register(fakeAdapter({ name, calls: [] }), {
      provider: name,
      apiKey: 'test',
      measurementReady: name !== 'route:text',
      quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 },
    })
  }
  expect(registry.getMeasurableAll().map(entry => entry.adapter.name)).toEqual(['openai'])
  expect(registry.getMeasurableForProject([]).map(entry => entry.adapter.name)).toEqual(['openai'])
  expect(registry.getMeasurableForProject(['openai', 'openai', 'route:text']).map(entry => entry.adapter.name)).toEqual(['openai'])
  expect(registry.getMeasurableForProject(['route:text'])).toEqual([])
})

test('a gateway-only install does not fall back to all text routes', () => {
  const registry = new ProviderRegistry()
  registry.register(fakeAdapter({ name: 'route:text', calls: [] }), {
    provider: 'route:text',
    apiKey: 'test',
    measurementReady: false,
    quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 },
  })
  expect(registry.getMeasurableForProject([])).toEqual([])
})
