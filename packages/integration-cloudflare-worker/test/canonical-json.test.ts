import { describe, expect, it } from 'vitest'
import { canonicalizeCloudflareJson } from '../src/canonical-json.js'

describe('canonicalizeCloudflareJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalizeCloudflareJson({
      z: [{ b: 2, a: 1 }],
      a: true,
    })).toBe('{"a":true,"z":[{"a":1,"b":2}]}')
  })

  it('produces the same bytes for insertion-order variants', () => {
    const first = { schemaVersion: 1, workerVersion: '1.0.0', events: [{ path: '/', eventId: 'ray' }] }
    const second = { events: [{ eventId: 'ray', path: '/' }], workerVersion: '1.0.0', schemaVersion: 1 }
    expect(canonicalizeCloudflareJson(first)).toBe(canonicalizeCloudflareJson(second))
  })

  it('uses JSON scalar escaping and omits undefined object fields', () => {
    expect(canonicalizeCloudflareJson({ omitted: undefined, text: 'a\n"b"', value: null }))
      .toBe('{"text":"a\\n\\"b\\"","value":null}')
  })

  it('rejects values that cannot appear in the edge-event JSON contract', () => {
    expect(() => canonicalizeCloudflareJson(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalizeCloudflareJson(1n)).toThrow(/bigint/)
  })
})
