import { describe, expect, it, vi } from 'vitest'
import { runRefresh } from '../scripts/refresh-ip-ranges.js'
import type { FetchResult, Source } from '../scripts/refresh-ip-ranges.js'

describe('refresh-ip-ranges', () => {
  it('returns a failing exit code after retaining successful source results', async () => {
    const sources: Source[] = [
      { file: 'fresh.json', url: 'https://example.test/fresh.json', label: 'Fresh' },
      { file: 'stale.json', url: 'https://example.test/stale.json', label: 'Stale' },
    ]
    const completed: string[] = []
    const refresh = vi.fn(async (source: Source): Promise<FetchResult> => {
      completed.push(source.file)
      return source.file === 'fresh.json'
        ? { source, ok: true, prefixCount: 2 }
        : { source, ok: false, error: 'HTTP 503' }
    })
    const output: string[] = []

    const exitCode = await runRefresh(sources, refresh, message => output.push(message))

    expect(exitCode).toBe(1)
    expect(completed).toEqual(['fresh.json', 'stale.json'])
    expect(output.join('')).toContain('fresh.json  (2 prefixes)')
    expect(output.join('')).toContain('stale.json  HTTP 503')
    expect(output.join('')).toContain('Done. 1 updated, 1 failed.')
    expect(output.join('')).toContain('Failed sources kept their previous JSON')
  })

  it('returns success only when every source refresh succeeds', async () => {
    const source: Source = {
      file: 'fresh.json',
      url: 'https://example.test/fresh.json',
      label: 'Fresh',
    }

    await expect(runRefresh(
      [source],
      async () => ({ source, ok: true, prefixCount: 1 }),
      () => undefined,
    )).resolves.toBe(0)
  })
})
