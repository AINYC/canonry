import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeSourcePayload,
  manifestNeedsUpdate,
  runRefresh,
  SOURCES,
} from '../scripts/refresh-ip-ranges.js'
import type { FetchResult, Source } from '../scripts/refresh-ip-ranges.js'
import { validateIpRangeManifestPayload } from '../src/ip-range-manifest.js'

const rangesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ip-ranges')

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
    expect(output.join('')).toContain('Done. 1 updated, 0 unchanged, 1 failed.')
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

  it('reports a successful metadata-only refresh as unchanged', async () => {
    const source: Source = {
      file: 'same.json',
      url: 'https://example.test/same.json',
      label: 'Same',
    }
    const output: string[] = []

    await expect(runRefresh(
      [source],
      async () => ({ source, ok: true, prefixCount: 1, changed: false }),
      message => output.push(message),
    )).resolves.toBe(0)

    expect(output.join('')).toContain('same.json  (1 prefixes, unchanged)')
    expect(output.join('')).toContain('Done. 0 updated, 1 unchanged, 0 failed.')
  })
})

describe('publisher payload normalization', () => {
  it('normalizes Amazon embedded JSON, legacy fields, and bare host addresses', () => {
    const source: Source = {
      file: 'amazon.json',
      url: 'https://developer.amazon.com/example',
      label: 'Amazon',
      format: 'amazon-html',
    }
    const body = `<html><pre><code class="container">${JSON.stringify({
      creationTime: 'version-1',
      prefixes: [
        { ipv4Prefix: '192.0.2.10' },
        { ip_prefix: '198.51.100.0/24' },
        { ipv6Prefix: '2001:db8::1' },
      ],
    })}</code></pre></html>`

    expect(decodeSourcePayload(source, body)).toEqual({
      creationTime: 'version-1',
      prefixes: [
        { ipv4Prefix: '192.0.2.10/32' },
        { ipv4Prefix: '198.51.100.0/24' },
        { ipv6Prefix: '2001:db8::1/128' },
      ],
    })
  })

  it('ignores version and ordering churn when executable prefixes are unchanged', () => {
    const source: Source = {
      file: 'same.json',
      url: 'https://example.test/same.json',
      label: 'Same',
    }
    const current = {
      _source: source.url,
      creationTime: 'old-version',
      prefixes: [
        { ipv4Prefix: '192.0.2.99/24' },
        { ipv6Prefix: '2001:DB8::1/32' },
      ],
    }
    const equivalent = {
      creationTime: 'new-version',
      prefixes: [
        { ipv6Prefix: '2001:db8::/32' } as const,
        { ipv4Prefix: '192.0.2.0/24' } as const,
      ],
    }

    expect(manifestNeedsUpdate(source, current, equivalent)).toBe(false)
    expect(manifestNeedsUpdate({ ...source, url: 'https://example.test/new.json' }, current, equivalent))
      .toBe(true)
    expect(manifestNeedsUpdate(source, current, {
      creationTime: 'new-version',
      prefixes: [{ ipv4Prefix: '203.0.113.0/24' }],
    })).toBe(true)
  })
})

describe('publisher source catalog', () => {
  it('has unique URLs/files backed by valid non-empty vendored manifests', () => {
    expect(new Set(SOURCES.map(source => source.file)).size).toBe(SOURCES.length)
    expect(new Set(SOURCES.map(source => source.url)).size).toBe(SOURCES.length)

    for (const source of SOURCES) {
      const raw = JSON.parse(fs.readFileSync(path.join(rangesDirectory, source.file), 'utf-8')) as unknown
      expect(raw).toMatchObject({ _source: source.url })
      const validation = validateIpRangeManifestPayload(raw)
      expect(validation, source.file).toMatchObject({ ok: true })
      if (validation.ok) expect(validation.value.prefixes.length, source.file).toBeGreaterThan(0)
    }
  })
})
