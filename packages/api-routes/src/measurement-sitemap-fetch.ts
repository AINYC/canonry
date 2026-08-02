import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import http from 'node:http'
import https from 'node:https'
import type { SafeWebhookTarget, ResolveWebhookTargetResult } from './webhooks.js'
import { resolveWebhookTarget } from './webhooks.js'

const gunzipAsync = promisify(gunzip)

export const DEFAULT_MEASUREMENT_SITEMAP_LIMITS = {
  timeoutMs: 10_000,
  maxBodyBytes: 1_000_000,
  maxDepth: 3,
  maxUrls: 10_000,
  maxSitemaps: 100,
  maxRedirects: 3,
} as const

export interface MeasurementSitemapHttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/**
 * This seam exists so every unit test can exercise the exact SSRF and redirect
 * control flow without opening a socket. Production callers use the pinned
 * Node transport below.
 */
export type MeasurementSitemapTransport = (
  target: SafeWebhookTarget,
  limits: Pick<MeasurementSitemapFetchLimits, 'timeoutMs' | 'maxBodyBytes'>,
) => Promise<MeasurementSitemapHttpResponse>

export interface MeasurementSitemapFetchLimits {
  timeoutMs: number
  maxBodyBytes: number
  maxDepth: number
  maxUrls: number
  maxSitemaps: number
  maxRedirects: number
}

export interface MeasurementSitemapFetchOptions {
  limits?: Partial<MeasurementSitemapFetchLimits>
  transport?: MeasurementSitemapTransport
  resolveTarget?: (url: string) => Promise<ResolveWebhookTargetResult>
}

export interface MeasurementSitemapFetchResult {
  urls: string[]
  fetchedSitemaps: number
}

/**
 * Fetch a public sitemap with DNS-rebinding protection. Every request is first
 * resolved through `resolveWebhookTarget`, then connected to that exact IP
 * while retaining the original Host header and TLS SNI name. Redirect targets
 * repeat the same validation; they are never followed by the HTTP client.
 */
export async function fetchMeasurementSitemap(
  sitemapUrl: string,
  options: MeasurementSitemapFetchOptions = {},
): Promise<MeasurementSitemapFetchResult> {
  const limits = { ...DEFAULT_MEASUREMENT_SITEMAP_LIMITS, ...options.limits }
  assertLimits(limits)
  const resolveTarget = options.resolveTarget ?? resolveWebhookTarget
  const transport = options.transport ?? requestPinnedSitemap
  const urls = new Set<string>()
  const visited = new Set<string>()
  const deadlineAt = Date.now() + limits.timeoutMs

  async function visit(rawUrl: string, depth: number): Promise<void> {
    assertBeforeDeadline(deadlineAt)
    if (depth > limits.maxDepth) throw new Error(`Sitemap nesting exceeds the maximum depth of ${limits.maxDepth}`)
    const sitemap = normalizeSitemapUrl(rawUrl)
    if (visited.has(sitemap)) return
    if (visited.size >= limits.maxSitemaps) throw new Error(`Sitemap count exceeds the maximum of ${limits.maxSitemaps}`)
    visited.add(sitemap)

    const response = await requestFollowingValidatedRedirects(sitemap, resolveTarget, transport, limits, deadlineAt)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sitemap request failed with HTTP ${response.status}`)
    }
    const xml = await decodeSitemapBody(response.body, response.headers, limits.maxBodyBytes)
    const sitemapIndex = /<(?:[\w-]+:)?sitemapindex\b/i.test(xml)
    const urlSet = /<(?:[\w-]+:)?urlset\b/i.test(xml)
    if (!sitemapIndex && !urlSet) throw new Error('Sitemap response is not a sitemap document')
    const childSitemaps = sitemapIndexLocations(xml)
    if (childSitemaps.length > 0) {
      for (const child of childSitemaps) await visit(child, depth + 1)
      return
    }
    for (const url of urlSetLocations(xml)) {
      if (urls.has(url)) continue
      if (urls.size >= limits.maxUrls) throw new Error(`Sitemap URL count exceeds the maximum of ${limits.maxUrls}`)
      urls.add(url)
    }
  }

  await visit(sitemapUrl, 0)
  return { urls: [...urls].sort(compareText), fetchedSitemaps: visited.size }
}

async function requestFollowingValidatedRedirects(
  startUrl: string,
  resolveTarget: (url: string) => Promise<ResolveWebhookTargetResult>,
  transport: MeasurementSitemapTransport,
  limits: MeasurementSitemapFetchLimits,
  deadlineAt: number,
): Promise<MeasurementSitemapHttpResponse> {
  let current = startUrl
  for (let redirects = 0; ; redirects += 1) {
    const check = await beforeDeadline(() => resolveTarget(current), deadlineAt)
    if (!check.ok) throw new Error(`Sitemap URL rejected: ${check.message}`)
    const response = await beforeDeadline(() => transport(check.target, {
      timeoutMs: remainingTime(deadlineAt),
      maxBodyBytes: limits.maxBodyBytes,
    }), deadlineAt)
    if (!isRedirect(response.status)) return response
    if (redirects >= limits.maxRedirects) throw new Error(`Sitemap redirect count exceeds the maximum of ${limits.maxRedirects}`)
    const location = firstHeader(response.headers.location)
    if (!location) throw new Error('Sitemap redirect response has no Location header')
    try {
      current = new URL(location, check.target.url).href
    } catch {
      throw new Error('Sitemap redirect has an invalid Location header')
    }
  }
}

function remainingTime(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error('Sitemap fetch exceeded its operation deadline')
  return remaining
}

function assertBeforeDeadline(deadlineAt: number): void {
  remainingTime(deadlineAt)
}

async function beforeDeadline<T>(start: () => Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = remainingTime(deadlineAt)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const operation = start()
    const value = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Sitemap fetch exceeded its operation deadline')), remaining)
      }),
    ])
    assertBeforeDeadline(deadlineAt)
    return value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function requestPinnedSitemap(
  target: SafeWebhookTarget,
  limits: Pick<MeasurementSitemapFetchLimits, 'timeoutMs' | 'maxBodyBytes'>,
): Promise<MeasurementSitemapHttpResponse> {
  const secure = target.url.protocol === 'https:'
  const port = target.url.port ? Number(target.url.port) : secure ? 443 : 80
  const requestOptions: https.RequestOptions = {
    hostname: target.address,
    family: target.family,
    port,
    method: 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: { Host: target.url.host, Accept: 'application/xml,text/xml,*/*;q=0.1', 'Accept-Encoding': 'gzip' },
  }
  if (secure) requestOptions.servername = target.url.hostname.replace(/^\[|\]$/g, '')

  return await new Promise((resolve, reject) => {
    let settled = false
    const succeed = (response: MeasurementSitemapHttpResponse) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(response)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      reject(error)
    }
    const request = (secure ? https.request : http.request)(requestOptions, (response) => {
      const chunks: Buffer[] = []
      let byteLength = 0
      response.on('data', (chunk: Buffer) => {
        byteLength += chunk.length
        if (byteLength > limits.maxBodyBytes) {
          response.destroy(new Error(`Sitemap body exceeds the maximum of ${limits.maxBodyBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => succeed({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('Sitemap response ended before completion')))
    })
    const deadline = setTimeout(
      () => request.destroy(new Error(`Sitemap request timed out after ${limits.timeoutMs}ms`)),
      limits.timeoutMs,
    )
    request.on('error', fail)
    request.end()
  })
}

async function decodeSitemapBody(body: Buffer, headers: http.IncomingHttpHeaders, maxBodyBytes: number): Promise<string> {
  const contentEncoding = firstHeader(headers['content-encoding'])?.toLowerCase()
  const gzipped = contentEncoding === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b)
  const bytes = gzipped ? await gunzipAsync(body, { maxOutputLength: maxBodyBytes }) : body
  if (bytes.length > maxBodyBytes) throw new Error(`Sitemap body exceeds the maximum of ${maxBodyBytes} bytes`)
  return new TextDecoder().decode(bytes)
}

function sitemapIndexLocations(xml: string): string[] {
  if (!hasXmlElement(xml, 'sitemapindex')) return []
  return sortedUniqueUrls(xmlElementContents(xml, 'sitemap').flatMap(extractLocation))
}

function urlSetLocations(xml: string): string[] {
  if (!hasXmlElement(xml, 'urlset')) return []
  return sortedUniqueUrls(xmlElementContents(xml, 'url').flatMap(extractLocation))
}

function extractLocation(xml: string): string[] {
  const value = xmlElementContents(xml, 'loc')[0]?.trim()
  return value ? [normalizeSitemapUrl(decodeXmlEntities(value))] : []
}

/**
 * Purpose-built, non-validating XML tag scanner. It deliberately reads only
 * the sitemap element names we need and never applies an unbounded regular
 * expression to network input. Sitemap XML is small and this transport's body
 * cap keeps the scan linear and bounded.
 */
function hasXmlElement(xml: string, elementName: string): boolean {
  for (let offset = 0; ; ) {
    const tag = nextXmlTag(xml, offset)
    if (!tag) return false
    if (!tag.closing && tag.localName === elementName) return true
    offset = tag.end
  }
}

function xmlElementContents(xml: string, elementName: string): string[] {
  const contents: string[] = []
  let depth = 0
  let contentStart = -1
  for (let offset = 0; ; ) {
    const tag = nextXmlTag(xml, offset)
    if (!tag) return contents
    if (tag.localName === elementName) {
      if (tag.closing) {
        depth -= 1
        if (depth === 0 && contentStart >= 0) {
          contents.push(xml.slice(contentStart, tag.start))
          contentStart = -1
        }
      } else if (!tag.selfClosing) {
        if (depth === 0) contentStart = tag.end
        depth += 1
      }
    }
    offset = tag.end
  }
}

interface XmlTag {
  start: number
  end: number
  localName: string
  closing: boolean
  selfClosing: boolean
}

function nextXmlTag(xml: string, from: number): XmlTag | null {
  const start = xml.indexOf('<', from)
  if (start < 0) return null
  if (xml.startsWith('<!--', start)) {
    const endComment = xml.indexOf('-->', start + 4)
    return endComment < 0 ? null : nextXmlTag(xml, endComment + 3)
  }
  if (xml.startsWith('<![CDATA[', start)) {
    const endCdata = xml.indexOf(']]>', start + 9)
    return endCdata < 0 ? null : nextXmlTag(xml, endCdata + 3)
  }
  if (xml.startsWith('<?', start) || xml.startsWith('<!', start)) {
    const endDeclaration = xml.indexOf('>', start + 2)
    return endDeclaration < 0 ? null : nextXmlTag(xml, endDeclaration + 1)
  }
  const end = xml.indexOf('>', start + 1)
  if (end < 0) return null
  let nameOffset = start + 1
  while (xml[nameOffset] === ' ' || xml[nameOffset] === '\t' || xml[nameOffset] === '\r' || xml[nameOffset] === '\n') nameOffset += 1
  const closing = xml[nameOffset] === '/'
  if (closing) nameOffset += 1
  while (xml[nameOffset] === ' ' || xml[nameOffset] === '\t' || xml[nameOffset] === '\r' || xml[nameOffset] === '\n') nameOffset += 1
  const nameEnd = (() => {
    let index = nameOffset
    while (index < end && !isTagNameSeparator(xml[index]!)) index += 1
    return index
  })()
  const fullName = xml.slice(nameOffset, nameEnd)
  const localName = fullName.slice(fullName.lastIndexOf(':') + 1).toLowerCase()
  return { start, end: end + 1, localName, closing, selfClosing: !closing && xml.slice(start, end).trimEnd().endsWith('/') }
}

function isTagNameSeparator(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n' || value === '/' || value === '>'
}

function normalizeSitemapUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Sitemap contains an invalid URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Sitemap URL must use http or https: ${value}`)
  if (parsed.username || parsed.password) throw new Error(`Sitemap URL must not include credentials: ${value}`)
  return parsed.href
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]!)
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedUniqueUrls(values: string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function assertLimits(limits: MeasurementSitemapFetchLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Sitemap ${name} must be a positive safe integer`)
  }
}
