import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'

afterEach(() => vi.unstubAllGlobals())

describe('ApiClient competitor landscape reads', () => {
  it.each([
    { scope: 'project' as const },
    { groupKey: 'north' },
    { scope: 'all-markets' as const },
  ])('preserves model and portfolio filters in one read: %j', async (scope) => {
    let received: Request | undefined
    const payload = { modelComparison: { basis: 'requested-model', groups: [], totalGroups: 0, truncated: false } }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })
    const result = await client.getCompetitorLandscape('acme', {
      ...scope, groupBy: 'model', provider: 'gemini', model: 'vendor/model:2026-09+beta',
      queryClass: 'non-brand', location: 'New York', runId: 'run-1', window: '30d',
    })

    expect(received?.method).toBe('GET')
    const url = new URL(received!.url)
    expect(url.pathname).toBe('/api/v1/projects/acme/analytics/competitors')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...scope, groupBy: 'model', provider: 'gemini', model: 'vendor/model:2026-09+beta',
      queryClass: 'non-brand', location: 'New York', runId: 'run-1', window: '30d',
    })
    expect(result).toEqual(payload)
    expect(received?.headers.get('authorization')).toBe('Bearer cnry_test')
  })

  it('does not add model parameters to the default read', async () => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })
    await client.getCompetitorLandscape('acme')
    expect(new URL(received!.url).search).toBe('')
  })
})
