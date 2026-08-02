import http from 'node:http'
import { expect, test, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { SafeWebhookTarget } from '../src/webhooks.js'
import {
  fetchMeasurementSitemap,
  requestPinnedSitemap,
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
    .resolves.toEqual({
      urls: ['https://public.example.test/a', 'https://public.example.test/b'],
      fetchedSitemaps: 1,
      bytesChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
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
  expect(result).toEqual({
    urls: ['https://public.example.test/a', 'https://public.example.test/z'],
    fetchedSitemaps: 3,
    bytesChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
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

/**
 * The tests below drive the real transport over a socket. The injected seam
 * cannot show what goes on the wire, and "we dial the address we checked", "we
 * send no credentials" and "we stop reading past the cap" are claims about
 * exactly that.
 */
async function withLocalServer<T>(
  handler: http.RequestListener,
  run: (target: SafeWebhookTarget) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('local server has no port')
  try {
    return await run({ url: new URL(`http://127.0.0.1:${address.port}/sitemap.xml`), address: '127.0.0.1', family: 4 })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('sends no cookie, authorization or instance header to an operator-supplied host', async () => {
  let seen: http.IncomingHttpHeaders = {}
  let host = ''
  const response = await withLocalServer((request, reply) => {
    seen = request.headers
    reply.writeHead(200, { 'content-type': 'application/xml' })
    reply.end('<urlset/>')
  }, target => {
    host = target.url.host
    return requestPinnedSitemap(target, { timeoutMs: 5_000, maxBodyBytes: 1_000_000 })
  })

  expect(response.status).toBe(200)
  expect(Object.keys(seen).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host'])
  // Host still names the operator's URL even though the socket went to the
  // address that was validated.
  expect(seen.host).toBe(host)
})

test('dials the validated address even when the hostname does not resolve', async () => {
  let seenHost = ''
  let expectedHost = ''
  const response = await withLocalServer((request, reply) => {
    seenHost = request.headers.host ?? ''
    reply.writeHead(200, { 'content-type': 'application/xml' })
    reply.end('<urlset/>')
  }, target => {
    // Only the address is dialable. A transport that re-resolved the name
    // instead of using the checked answer could not reach this server at all.
    const url = new URL(`http://pinned.example.test:${target.url.port}/sitemap.xml`)
    expectedHost = url.host
    return requestPinnedSitemap({ ...target, url }, { timeoutMs: 5_000, maxBodyBytes: 1_000_000 })
  })

  expect(response.status).toBe(200)
  expect(seenHost).toBe(expectedHost)
})

test('refuses a body whose announced length is over the cap', async () => {
  await expect(withLocalServer((_request, reply) => {
    const body = Buffer.alloc(64_000, 'a')
    reply.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(body.length) })
    reply.on('error', () => {})
    reply.end(body)
  }, target => requestPinnedSitemap(target, { timeoutMs: 5_000, maxBodyBytes: 1_000 })))
    .rejects.toThrow('Sitemap body exceeds the maximum of 1000 bytes')
})

/**
 * The pre-check is about the announced length, not the delivered one. This host
 * announces megabytes, sends a handful of bytes and never ends the response, so
 * the streaming cap can never fire: only reading Content-Length up front
 * refuses it, which is the whole point of checking before the body is read.
 */
test('refuses an announced length over the cap before reading the body', async () => {
  await expect(withLocalServer((_request, reply) => {
    reply.on('error', () => {})
    reply.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(5_000_000) })
    reply.write(Buffer.alloc(16, 'a'))
  }, target => requestPinnedSitemap(target, { timeoutMs: 2_000, maxBodyBytes: 1_000 })))
    .rejects.toThrow('Sitemap body exceeds the maximum of 1000 bytes')
})

test('aborts an unannounced body past the cap instead of buffering it', async () => {
  const total = 8 * 1024 * 1024
  let sent = 0
  await expect(withLocalServer((_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/xml' })
    reply.on('error', () => {})
    const chunk = Buffer.alloc(64 * 1024, 'a')
    const pump = () => {
      while (sent < total) {
        if (reply.destroyed) return
        sent += chunk.length
        if (!reply.write(chunk)) {
          reply.once('drain', pump)
          return
        }
      }
      reply.end()
    }
    pump()
  }, target => requestPinnedSitemap(target, { timeoutMs: 5_000, maxBodyBytes: 1_000 })))
    .rejects.toThrow('Sitemap body exceeds the maximum of 1000 bytes')
  expect(sent).toBeLessThan(total)
})

test('digests equal documents to equal checksums and a changed document to a different one', async () => {
  const document = (body: string) => fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    resolveTarget: allowPublic,
    transport: async () => xml(body),
  })

  const first = await document('<urlset><url><loc>https://public.example.test/a</loc></url></urlset>')
  const again = await document('<urlset><url><loc>https://public.example.test/a</loc></url></urlset>')
  const changed = await document('<urlset><url><loc>https://public.example.test/b</loc></url></urlset>')

  expect(first.bytesChecksum).toBe(again.bytesChecksum)
  expect(changed.bytesChecksum).not.toBe(first.bytesChecksum)
})

test('keys the digest by the URL a document was served from, not by its bytes alone', async () => {
  // Byte-for-byte the same document at a second address on the site. Content
  // alone cannot tell the two runs apart, so a digest that ignored the URL
  // would call a moved sitemap an unchanged input and rerun to a no-op.
  const body = '<urlset><url><loc>https://public.example.test/a</loc></url></urlset>'
  const servedAt = (path: string) => fetchMeasurementSitemap(`https://public.example.test/${path}`, {
    resolveTarget: allowPublic,
    transport: async () => xml(body),
  })

  const original = await servedAt('sitemap.xml')
  const moved = await servedAt('sitemap-2.xml')

  expect(moved.urls).toEqual(original.urls)
  expect(moved.bytesChecksum).not.toBe(original.bytesChecksum)
})
