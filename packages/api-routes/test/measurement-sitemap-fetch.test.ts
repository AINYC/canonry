import { expect, test, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { SafeWebhookTarget } from '../src/webhooks.js'
import {
  fetchMeasurementSitemap,
  type MeasurementSitemapHttpResponse,
  type MeasurementSitemapTransport,
} from '../src/measurement-sitemap-fetch.js'

const publicTarget = (raw: string): SafeWebhookTarget => ({ url: new URL(raw), address: '203.0.113.9', family: 4 })
const allowPublic = async (raw: string) => ({ ok: true as const, target: publicTarget(raw) })
const xml = (body: string): MeasurementSitemapHttpResponse => ({ status: 200, headers: {}, body: Buffer.from(body) })

test('fetches a synthetic public urlset through the injected pinned transport', async () => {
  const transport = vi.fn<MeasurementSitemapTransport>(async (target) => {
    expect(target.address).toBe('203.0.113.9')
    expect(target.url.host).toBe('public.example.test')
    return xml('<urlset><url><loc>https://public.example.test/b</loc></url><url><loc>https://public.example.test/a</loc></url></urlset>')
  })

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', { resolveTarget: allowPublic, transport }))
    .resolves.toEqual({ urls: ['https://public.example.test/a', 'https://public.example.test/b'], fetchedSitemaps: 1 })
  expect(transport).toHaveBeenCalledOnce()
})

test('accepts a gzip-compressed sitemap body within the decoded body cap', async () => {
  const result = await fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    resolveTarget: allowPublic,
    transport: async () => ({
      status: 200,
      headers: { 'content-encoding': 'gzip' },
      body: gzipSync('<urlset><url><loc>https://public.example.test/covered</loc></url></urlset>'),
    }),
  })
  expect(result.urls).toEqual(['https://public.example.test/covered'])
})

test('recursively reads a nested sitemap index in deterministic order', async () => {
  const transport = vi.fn<MeasurementSitemapTransport>(async (target) => {
    if (target.url.pathname === '/root.xml') return xml('<sitemapindex><sitemap><loc>https://public.example.test/z.xml</loc></sitemap><sitemap><loc>https://public.example.test/a.xml</loc></sitemap></sitemapindex>')
    if (target.url.pathname === '/a.xml') return xml('<urlset><url><loc>https://public.example.test/a</loc></url></urlset>')
    return xml('<urlset><url><loc>https://public.example.test/z</loc></url></urlset>')
  })

  const result = await fetchMeasurementSitemap('https://public.example.test/root.xml', { resolveTarget: allowPublic, transport })
  expect(result).toEqual({ urls: ['https://public.example.test/a', 'https://public.example.test/z'], fetchedSitemaps: 3 })
  expect(transport.mock.calls.map(([target]) => target.url.pathname)).toEqual(['/root.xml', '/a.xml', '/z.xml'])
})

test('deduplicates repeated URLs before enforcing the unique URL cap', async () => {
  const result = await fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    resolveTarget: allowPublic,
    transport: async () => xml('<urlset><url><loc>https://public.example.test/one</loc></url><url><loc>https://public.example.test/one</loc></url></urlset>'),
    limits: { maxUrls: 1 },
  })
  expect(result.urls).toEqual(['https://public.example.test/one'])
})

test('rejects a successful response that is not a sitemap document', async () => {
  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    resolveTarget: allowPublic,
    transport: async () => xml('<html><body>Not a sitemap</body></html>'),
  })).rejects.toThrow('not a sitemap document')
})

test('rejects private and loopback URLs before the outbound seam', async () => {
  const transport = vi.fn<MeasurementSitemapTransport>()
  for (const raw of ['http://127.0.0.1/sitemap.xml', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/sitemap.xml']) {
    await expect(fetchMeasurementSitemap(raw, { transport })).rejects.toThrow('Sitemap URL rejected')
  }
  expect(transport).not.toHaveBeenCalled()
})

test('revalidates each redirect before connecting to its pinned target', async () => {
  const resolved: string[] = []
  const resolveTarget = async (raw: string) => {
    resolved.push(raw)
    if (raw.includes('private.example.test')) return { ok: false as const, message: '"url" must not resolve to a private or loopback address' }
    return allowPublic(raw)
  }
  const transport = vi.fn<MeasurementSitemapTransport>(async () => ({ status: 302, headers: { location: 'https://private.example.test/sitemap.xml' }, body: Buffer.alloc(0) }))

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', { resolveTarget, transport })).rejects.toThrow('Sitemap URL rejected')
  expect(resolved).toEqual(['https://public.example.test/sitemap.xml', 'https://private.example.test/sitemap.xml'])
  expect(transport).toHaveBeenCalledOnce()
})

test('enforces body, recursion depth, and URL-count caps', async () => {
  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    resolveTarget: allowPublic,
    transport: async () => xml('<urlset><url><loc>https://public.example.test/long</loc></url></urlset>'),
    limits: { maxBodyBytes: 20 },
  })).rejects.toThrow('Sitemap body exceeds')

  await expect(fetchMeasurementSitemap('https://public.example.test/root.xml', {
    resolveTarget: allowPublic,
    transport: async (target) => xml(`<sitemapindex><sitemap><loc>https://public.example.test${target.url.pathname === '/root.xml' ? '/child.xml' : '/grandchild.xml'}</loc></sitemap></sitemapindex>`),
    limits: { maxDepth: 1 },
  })).rejects.toThrow('Sitemap nesting exceeds')

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    resolveTarget: allowPublic,
    transport: async () => xml('<urlset><url><loc>https://public.example.test/one</loc></url><url><loc>https://public.example.test/two</loc></url></urlset>'),
    limits: { maxUrls: 1 },
  })).rejects.toThrow('Sitemap URL count exceeds')
})

test('shares one operation deadline across every sitemap and redirect', async () => {
  let now = 1_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const seenTimeouts: number[] = []
  try {
    await expect(fetchMeasurementSitemap('https://public.example.test/root.xml', {
      resolveTarget: allowPublic,
      transport: async (target, limits) => {
        seenTimeouts.push(limits.timeoutMs)
        now += 6
        if (target.url.pathname === '/root.xml') {
          return xml('<sitemapindex><sitemap><loc>https://public.example.test/child.xml</loc></sitemap></sitemapindex>')
        }
        return xml('<urlset><url><loc>https://public.example.test/covered</loc></url></urlset>')
      },
      limits: { timeoutMs: 10 },
    })).rejects.toThrow('operation deadline')
    expect(seenTimeouts).toEqual([10, 4])
  } finally {
    clock.mockRestore()
  }
})
