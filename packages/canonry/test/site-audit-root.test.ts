import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import {
  buildSiteAuditRootRequestOptions,
  resolveSiteAuditRootUrl,
  type SiteAuditRootResolveTarget,
  type SiteAuditRootTransport,
} from '../src/site-audit-root.js'

function resolvedTarget(rawUrl: string, address = '203.0.113.10') {
  return {
    ok: true as const,
    target: { url: new URL(rawUrl), address, family: 4 as const },
  }
}

function redirect(location: string) {
  return { status: 301, headers: { location } satisfies IncomingHttpHeaders }
}

const ok = { status: 200, headers: {} satisfies IncomingHttpHeaders }

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveSiteAuditRootUrl', () => {
  it.each([
    ['https://example.test/', 'https://www.example.test/'],
    ['https://www.example.test/', 'https://example.test/'],
  ])('follows and revalidates one leading-www alias (%s -> %s)', async (requestedUrl, effectiveUrl) => {
    const resolved: string[] = []
    const requested: string[] = []
    const resolveTarget: SiteAuditRootResolveTarget = async (url) => {
      resolved.push(url)
      return resolvedTarget(url, resolved.length === 1 ? '203.0.113.10' : '203.0.113.11')
    }
    const transport: SiteAuditRootTransport = async (target) => {
      requested.push(`${target.address} ${target.url.href}`)
      return target.url.href === requestedUrl ? redirect(effectiveUrl) : ok
    }

    const result = await resolveSiteAuditRootUrl(requestedUrl, { resolveTarget, transport })

    expect(result).toEqual({
      requestedUrl,
      effectiveUrl,
      redirects: [{ status: 301, from: requestedUrl, to: effectiveUrl }],
    })
    expect(resolved).toEqual([requestedUrl, effectiveUrl])
    expect(requested).toEqual([
      `203.0.113.10 ${requestedUrl}`,
      `203.0.113.11 ${effectiveUrl}`,
    ])
  })

  it('allows an HTTP root to upgrade to HTTPS', async () => {
    const resolveTarget: SiteAuditRootResolveTarget = async (url) => resolvedTarget(url)
    const transport: SiteAuditRootTransport = async (target) => (
      target.url.protocol === 'http:' ? redirect('https://www.example.test/') : ok
    )

    await expect(resolveSiteAuditRootUrl('http://example.test/', { resolveTarget, transport })).resolves.toMatchObject({
      effectiveUrl: 'https://www.example.test/',
    })
  })

  it.each([
    ['https://example.test/', 'https://other.test/', 'outside the approved site'],
    ['https://example.test:8443/', 'https://www.example.test:9443/', 'changes port'],
    ['https://example.test/', 'http://www.example.test/', 'downgrade'],
  ])('refuses %s -> %s before resolving or requesting the target', async (requestedUrl, blockedUrl, message) => {
    const resolved: string[] = []
    const requested: string[] = []
    const resolveTarget: SiteAuditRootResolveTarget = async (url) => {
      resolved.push(url)
      return resolvedTarget(url)
    }
    const transport: SiteAuditRootTransport = async (target) => {
      requested.push(target.url.href)
      return redirect(blockedUrl)
    }

    await expect(resolveSiteAuditRootUrl(requestedUrl, { resolveTarget, transport })).rejects.toThrow(message)
    expect(resolved).toEqual([requestedUrl])
    expect(requested).toEqual([requestedUrl])
  })

  it('allows at most five redirects and never resolves or requests the sixth target', async () => {
    const resolved: string[] = []
    const requested: string[] = []
    const resolveTarget: SiteAuditRootResolveTarget = async (url) => {
      resolved.push(url)
      return resolvedTarget(url)
    }
    const transport: SiteAuditRootTransport = async (target) => {
      requested.push(target.url.href)
      const step = Number(target.url.pathname.slice(1))
      return redirect(`https://example.test/${step + 1}`)
    }

    await expect(resolveSiteAuditRootUrl('https://example.test/0', { resolveTarget, transport })).rejects.toThrow(
      'more than 5 redirects',
    )
    expect(resolved).toEqual(Array.from({ length: 6 }, (_, step) => `https://example.test/${step}`))
    expect(requested).toEqual(resolved)
    expect(resolved).not.toContain('https://example.test/6')
  })

  it('uses one shared timeout across target validation and every GET', async () => {
    vi.useFakeTimers()
    const timeouts: number[] = []
    const resolveTarget: SiteAuditRootResolveTarget = async (url) => resolvedTarget(url)
    const transport: SiteAuditRootTransport = async (_target, options) => {
      timeouts.push(options.timeoutMs)
      return await new Promise(() => {})
    }

    const operation = resolveSiteAuditRootUrl('https://example.test/', {
      resolveTarget,
      transport,
      timeoutMs: 50,
    })
    const rejection = expect(operation).rejects.toThrow('exceeded its 50ms deadline')
    await vi.advanceTimersByTimeAsync(51)
    await rejection

    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]).toBeGreaterThan(0)
    expect(timeouts[0]).toBeLessThanOrEqual(50)
  })

  it('forwards cancellation to the pinned request', async () => {
    const controller = new AbortController()
    const resolveTarget = vi.fn<SiteAuditRootResolveTarget>(async (url) => resolvedTarget(url))
    const transport = vi.fn<SiteAuditRootTransport>(async (_target, options) => {
      expect(options.signal).toBe(controller.signal)
      return ok
    })

    await resolveSiteAuditRootUrl('https://example.test/', {
      resolveTarget,
      transport,
      signal: controller.signal,
    })

    expect(resolveTarget).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledOnce()
  })

  it('stops while target validation is still pending', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel root resolution')
    const resolveTarget: SiteAuditRootResolveTarget = async () => await new Promise(() => {})

    const operation = resolveSiteAuditRootUrl('https://example.test/', {
      resolveTarget,
      signal: controller.signal,
    })
    controller.abort(reason)

    await expect(operation).rejects.toBe(reason)
  })

  it('rejects a target resolver that returns a different URL than it validated', async () => {
    const transport = vi.fn<SiteAuditRootTransport>()
    const resolveTarget: SiteAuditRootResolveTarget = async () => resolvedTarget('https://other.test/')

    await expect(resolveSiteAuditRootUrl('https://example.test/', { resolveTarget, transport })).rejects.toThrow(
      'different URL',
    )
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('buildSiteAuditRootRequestOptions', () => {
  it('dials the pinned address with the original Host and TLS SNI, without credentials', () => {
    const options = buildSiteAuditRootRequestOptions({
      url: new URL('https://www.example.test:8443/path?q=1'),
      address: '203.0.113.10',
      family: 4,
    })

    expect(options).toMatchObject({
      hostname: '203.0.113.10',
      family: 4,
      port: 8443,
      method: 'GET',
      path: '/path?q=1',
      servername: 'www.example.test',
      headers: {
        Host: 'www.example.test:8443',
        Accept: 'text/html,*/*;q=0.1',
        'User-Agent': 'Canonry/1.0 (site-health)',
      },
    })
    expect(options.headers).not.toHaveProperty('Cookie')
    expect(options.headers).not.toHaveProperty('Authorization')
  })

  it('uses the pinned address for HTTP without TLS SNI', () => {
    const options = buildSiteAuditRootRequestOptions({
      url: new URL('http://example.test/root'),
      address: '2001:db8::10',
      family: 6,
    })

    expect(options).toMatchObject({ hostname: '2001:db8::10', family: 6, port: 80, method: 'GET', path: '/root' })
    expect(options).not.toHaveProperty('servername')
  })
})
