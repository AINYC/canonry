import http, { type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5
const USER_AGENT = 'Canonry/1.0 (site-health)'

export interface SiteAuditRootTarget {
  url: URL
  address: string
  family: 4 | 6
}

export type SiteAuditRootResolveTargetResult =
  | { ok: true; target: SiteAuditRootTarget }
  | { ok: false; message: string }

/** Inject the shared SSRF/DNS gate; it must return the address the transport may dial. */
export type SiteAuditRootResolveTarget = (url: string) => Promise<SiteAuditRootResolveTargetResult>

export interface SiteAuditRootHttpResponse {
  status: number
  headers: IncomingHttpHeaders
}

/** Injectable so redirect policy is testable without opening a socket. */
export type SiteAuditRootTransport = (
  target: SiteAuditRootTarget,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<SiteAuditRootHttpResponse>

export interface SiteAuditRootRedirect {
  status: number
  from: string
  to: string
}

export interface SiteAuditRootResult {
  requestedUrl: string
  effectiveUrl: string
  redirects: SiteAuditRootRedirect[]
}

export interface SiteAuditRootOptions {
  resolveTarget: SiteAuditRootResolveTarget
  transport?: SiteAuditRootTransport
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Resolve the public root Canonry will hand to the crawl engine.
 *
 * Redirects are manual. Every allowed hop is revalidated and then fetched by
 * dialing only the returned address. A host change is limited to one leading
 * `www.` alias; ports may not change and TLS may not be downgraded.
 */
export async function resolveSiteAuditRootUrl(
  rawUrl: string,
  options: SiteAuditRootOptions,
): Promise<SiteAuditRootResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Site audit root timeout must be positive')

  const requested = parseHttpUrl(rawUrl)
  let current = requested
  const redirects: SiteAuditRootRedirect[] = []
  const deadlineAt = Date.now() + timeoutMs
  const transport = options.transport ?? requestPinnedSiteAuditRoot

  for (;;) {
    throwIfAborted(options.signal)
    const checked = await beforeDeadline(
      () => options.resolveTarget(current.href),
      deadlineAt,
      timeoutMs,
      options.signal,
    )
    if (!checked.ok) throw new Error(`Site audit root URL rejected: ${checked.message}`)

    const checkedUrl = parseHttpUrl(checked.target.url.href)
    if (checkedUrl.href !== current.href) {
      throw new Error('Site audit root target resolver returned a different URL than it validated')
    }

    const response = await beforeDeadline(
      () => transport(checked.target, { timeoutMs: remainingTime(deadlineAt, timeoutMs), signal: options.signal }),
      deadlineAt,
      timeoutMs,
      options.signal,
    )
    if (!isRedirect(response.status)) {
      return { requestedUrl: requested.href, effectiveUrl: current.href, redirects }
    }
    if (redirects.length >= MAX_REDIRECTS) {
      throw new Error(`Site audit root has more than ${MAX_REDIRECTS} redirects`)
    }

    const location = firstHeader(response.headers.location)
    if (!location) throw new Error('Site audit root redirect response has no Location header')

    let next: URL
    try {
      next = parseHttpUrl(new URL(location, current).href)
    } catch {
      throw new Error('Site audit root redirect has an invalid Location header')
    }
    assertAllowedRedirect(current, next)
    redirects.push({ status: response.status, from: current.href, to: next.href })
    current = next
  }
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Site audit root must be a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Site audit root must use HTTP or HTTPS')
  }
  if (url.username || url.password) throw new Error('Site audit root must not include credentials')
  url.hash = ''
  return url
}

function canonicalHostAlias(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

function assertAllowedRedirect(current: URL, next: URL): void {
  if (current.protocol === 'https:' && next.protocol === 'http:') {
    throw new Error('Site audit root redirect would downgrade HTTPS to HTTP')
  }
  if (current.port !== next.port) throw new Error('Site audit root redirect changes port')
  if (canonicalHostAlias(current.hostname) !== canonicalHostAlias(next.hostname)) {
    throw new Error('Site audit root redirect points outside the approved site')
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function remainingTime(deadlineAt: number, timeoutMs: number): number {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error(`Site audit root resolution exceeded its ${timeoutMs}ms deadline`)
  return remaining
}

async function beforeDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)
  const remaining = remainingTime(deadlineAt, timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  try {
    const value = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Site audit root resolution exceeded its ${timeoutMs}ms deadline`)),
          remaining,
        )
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return
        abortListener = () => reject(abortReason(signal))
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) abortListener()
      }),
    ])
    remainingTime(deadlineAt, timeoutMs)
    return value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener) signal?.removeEventListener('abort', abortListener)
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Build the exact socket request; exported so pinning and credential absence stay testable. */
export function buildSiteAuditRootRequestOptions(target: SiteAuditRootTarget): https.RequestOptions {
  const secure = target.url.protocol === 'https:'
  const requestOptions: https.RequestOptions = {
    hostname: target.address,
    family: target.family,
    port: target.url.port ? Number(target.url.port) : secure ? 443 : 80,
    method: 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: {
      Host: target.url.host,
      Accept: 'text/html,*/*;q=0.1',
      'User-Agent': USER_AGENT,
    },
  }
  if (secure) requestOptions.servername = stripIpv6Brackets(target.url.hostname)
  return requestOptions
}

/** Production manual-redirect transport: direct IP dial with original Host and SNI. */
export async function requestPinnedSiteAuditRoot(
  target: SiteAuditRootTarget,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SiteAuditRootHttpResponse> {
  throwIfAborted(options.signal)
  const secure = target.url.protocol === 'https:'
  const requestOptions = buildSiteAuditRootRequestOptions(target)

  return await new Promise((resolve, reject) => {
    let settled = false
    let abortListener: (() => void) | undefined
    const cleanup = () => {
      clearTimeout(timer)
      if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    }
    const succeed = (response: SiteAuditRootHttpResponse) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const request = (secure ? https.request : http.request)(requestOptions, (response) => {
      // Root resolution needs headers only. Stop before downloading the page;
      // the crawl engine will perform the bounded body read once this URL wins.
      response.destroy()
      succeed({ status: response.statusCode ?? 0, headers: response.headers })
    })
    const timer = setTimeout(
      () => request.destroy(new Error(`Site audit root request timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    )
    if (options.signal) {
      abortListener = () => request.destroy(abortReason(options.signal!))
      options.signal.addEventListener('abort', abortListener, { once: true })
      if (options.signal.aborted) abortListener()
    }
    request.on('error', fail)
    request.end()
  })
}
