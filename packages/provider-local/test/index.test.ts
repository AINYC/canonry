import { describe, it, expect } from 'vitest'
import { validateConfig, normalizeResult } from '../src/normalize.js'

describe('provider-local validateConfig', () => {
  it('rejects missing base URL', () => {
    const result = validateConfig({
      baseUrl: '',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/missing base URL/)
  })

  it('accepts valid config without apiKey', () => {
    const result = validateConfig({
      baseUrl: 'http://localhost:11434/v1',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 },
    })
    expect(result.ok).toBe(true)
  })
})

describe('provider-local normalizeResult', () => {
  it('keeps answer-text domains separate from structured citations', () => {
    const raw = {
      provider: 'local' as const,
      model: 'llama3',
      rawResponse: {
        choices: [{ message: { content: 'Check out example.com and https://test.org' } }]
      },
      groundingSources: [],
      searchQueries: []
    }
    const result = normalizeResult(raw)
    expect(result.citedDomains).toEqual([])
    expect(result.groundingSources).toEqual([])
  })
})
