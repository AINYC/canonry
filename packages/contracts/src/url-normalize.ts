/**
 * URL path canonicalization. Used to give every captured URL a stable
 * identity for joins, aggregation, and de-duplication. The strip-list is
 * deliberately conservative: only parameters that we know don't change the
 * page identity are removed.
 */

import { LinkifyIt } from 'linkify-it'
import tlds from 'tlds'
import { getDomain, getDomainWithoutSuffix, getHostname } from 'tldts'

const DOMAIN_PARSE_OPTIONS = { allowPrivateDomains: true } as const
const LINKIFY = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: false }).tlds(tlds)

const STRIP_KEYS: ReadonlySet<string> = new Set([
  // Click identifiers
  'fbclid',
  'gclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'yclid',
  'dclid',
  'gbraid',
  'wbraid',
  'bingid',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // Google Analytics linkers
  '_ga',
  '_gl',
  // Google Tag Manager debug
  'gtm_latency',
  'gtm_debug',
  // WordPress internal noise
  'preview',
  'preview_id',
  'preview_nonce',
  '_thumbnail_id',
  // Common cache-busters/versioning
  'v',
  'ver',
  'version',
])

interface QueryPair {
  key: string
  /** null for flag-style params with no `=` (e.g. `?flag`); '' for `?flag=` */
  value: string | null
}

function shouldStrip(key: string): boolean {
  if (STRIP_KEYS.has(key)) return true
  if (key.startsWith('utm_')) return true
  return false
}

function parseQuery(query: string): QueryPair[] {
  if (query === '') return []
  return query.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq === -1) return { key: pair, value: null }
    return { key: pair.slice(0, eq), value: pair.slice(eq + 1) }
  })
}

function encodeQuery(pairs: readonly QueryPair[]): string {
  return pairs.map((p) => (p.value === null ? p.key : `${p.key}=${p.value}`)).join('&')
}

function collapseRootIndex(path: string): string {
  if (path === '/index.html' || path === '/index.php') return '/'
  return path
}

function dropTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '')
  }
  return path
}

/**
 * Build an absolute URL for a path stored against a project domain. GSC
 * returns most landing pages as path-only strings (`/blog/foo`), and storing
 * them that way is correct — but rendering them as `<a href="/blog/foo">` in
 * a report HTML file makes the browser resolve the path against whatever host
 * the file is served from (often the canonry dashboard host or `file://`).
 * This helper prepends `https://<canonicalDomain>` so the link resolves to
 * the project's actual site instead. Already-absolute URLs (http/https) and
 * protocol-relative URLs (`//host/...`) are returned unchanged. Returns the
 * input as-is when it can't be confidently absolutized.
 */
export function absolutizeProjectUrl(
  url: string | null | undefined,
  canonicalDomain: string,
): string {
  if (!url) return ''
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  const host = canonicalDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!host) return trimmed
  if (trimmed.startsWith('/')) return `https://${host}${trimmed}`
  // Bare paths or domain-prefixed strings are ambiguous — treat as paths.
  return `https://${host}/${trimmed}`
}

/**
 * Extract the normalized host from a URL or bare hostname: lowercased, with a
 * leading `www.` stripped and the scheme/path/query discarded. Accepts both
 * full URLs (`https://www.Example.com/x`) and bare hosts (`Example.com`).
 * Returns null when the input is empty or can't be parsed as a URL. This is the
 * canonical host extractor for grouping/deduping by registrable-ish host.
 */
export function hostOf(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const hostname = getHostname(trimmed)
  return hostname ? hostname.replace(/^www\./i, '').toLowerCase() : null
}

/**
 * Reduce a URL or hostname to its registrable domain (eTLD+1) using the
 * maintained Public Suffix List bundled by `tldts`. Private suffixes are
 * enabled so independently-owned sites such as `tenant.github.io` and
 * `tenant.vercel.app` remain separate identities.
 */
export function registrableDomain(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return ''
  return getDomain(value, DOMAIN_PARSE_OPTIONS)?.toLowerCase() ?? ''
}

/** The registrable domain without its public suffix. */
export function brandLabelFromDomain(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return ''
  return getDomainWithoutSuffix(value, DOMAIN_PARSE_OPTIONS)?.toLowerCase() ?? ''
}

/**
 * True when `candidate` is the same host as `domain`, or a subdomain of it.
 * Both inputs may be bare hosts or full URLs.
 */
export function hostMatchesDomain(
  candidate: string | null | undefined,
  domain: string | null | undefined,
): boolean {
  const candidateHost = hostOf(candidate)
  const domainHost = hostOf(domain)
  if (!candidateHost || !domainHost) return false
  return candidateHost === domainHost || candidateHost.endsWith(`.${domainHost}`)
}

/** True when a host/URL belongs to any domain in `domains`. */
export function hostMatchesAnyDomain(
  candidate: string | null | undefined,
  domains: readonly string[],
): boolean {
  return domains.some(domain => hostMatchesDomain(candidate, domain))
}

/**
 * Extract normalized domain hosts from prose using `linkify-it` for text
 * recognition and `tldts` for hostname/PSL validation.
 */
export function extractDomainsFromText(text: string | null | undefined): string[] {
  if (!text) return []
  const domains = new Set<string>()
  for (const match of LINKIFY.match(text) ?? []) {
    if (match.schema === 'mailto:') continue
    const host = hostOf(match.url)
    if (!host || !registrableDomain(host)) continue
    domains.add(host)
  }
  return [...domains]
}

/** True when prose contains `domain` itself or one of its subdomains. */
export function textContainsDomain(
  text: string | null | undefined,
  domain: string | null | undefined,
): boolean {
  return extractDomainsFromText(text).some(candidate => hostMatchesDomain(candidate, domain))
}

export function normalizeUrlPath(input: string | null | undefined): string | null {
  if (input == null) return null
  let trimmed = input.trim()
  if (trimmed === '') return null

  // Pre-normalization artifact cleanup (GA artifacts, Slack/doc copy-paste)
  trimmed = trimmed
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (trimmed === '' || trimmed === '/') return '/'
  if (trimmed === '(not set)') return null

  // Strip trailing punctuation that likely isn't part of a slug (e.g. trailing dot or parenthesis)
  // but only if it's not a root / and it's not preceded by another punctuation (avoid stripping actual file extensions)
  trimmed = trimmed.replace(/([a-z0-9])[).]+$/i, '$1')

  // Special case for artifacts like "/) open" -> "/"
  if (trimmed.startsWith('/)') || trimmed.startsWith('/ ')) {
    trimmed = '/'
  }
  if (trimmed.includes(' ')) {
    trimmed = trimmed.split(' ')[0]
  }
  if (trimmed === '' || trimmed === '/') return '/'

  let pathPart: string
  let queryPart: string

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    pathPart = url.pathname || '/'
    queryPart = url.search.startsWith('?') ? url.search.slice(1) : url.search
  } else {
    let raw = trimmed
    const hashIdx = raw.indexOf('#')
    if (hashIdx !== -1) raw = raw.slice(0, hashIdx)
    const qIdx = raw.indexOf('?')
    if (qIdx === -1) {
      pathPart = raw
      queryPart = ''
    } else {
      pathPart = raw.slice(0, qIdx)
      queryPart = raw.slice(qIdx + 1)
    }
  }

  if (pathPart === '') pathPart = '/'
  pathPart = collapseRootIndex(pathPart)
  pathPart = dropTrailingSlash(pathPart)

  const pairs = parseQuery(queryPart).filter((p) => !shouldStrip(p.key))
  pairs.sort((a, b) => {
    if (a.key < b.key) return -1
    if (a.key > b.key) return 1
    return 0
  })

  if (pairs.length === 0) return pathPart
  return `${pathPart}?${encodeQuery(pairs)}`
}

/**
 * Resolve landing paths that are truncated forms of a real page.
 *
 * Analytics landing paths arrive cut short when a URL was line-wrapped in a
 * plain-text context or pasted out of chat output: `/aeo-met`, `/aeo-meth` and
 * `/aeo-methodolo` all standing in for `/aeo-methodology`, each carrying a
 * slice of that page's sessions. Nothing in the string itself distinguishes a
 * truncation from a genuine 404, so this resolves only against a list of pages
 * known to exist, and only when the answer is unambiguous:
 *
 *   - the observed path is not itself a known page — a real page keeps its own
 *     identity even when it prefixes others;
 *   - it is a STRICT prefix of exactly one known page;
 *   - both have the same number of path segments, so a section root never
 *     folds into one of its children.
 *
 * Everything else is left alone. Two known pages sharing a prefix, or an empty
 * known list, produce no folds at all.
 *
 * Returns observed → known for the paths that fold; a path absent from the map
 * keeps its own identity.
 */
export function resolveTruncatedPaths(
  observed: Iterable<string>,
  knownPaths: Iterable<string>,
): Map<string, string> {
  const folds = new Map<string, string>()

  const known = new Set<string>()
  for (const path of knownPaths) {
    if (path) known.add(path)
  }
  if (known.size === 0) return folds

  // Sorted, so every page sharing a given prefix forms one contiguous run that
  // a binary search can jump straight to. Comparing each observed path against
  // the whole page list instead is quadratic: on a store with a few thousand of
  // each it cost ~220ms per request, which is not a price a dashboard read
  // should pay.
  const sorted = [...known].sort()

  const depthOf = (path: string): number => path.split('/').filter(Boolean).length

  /** Index of the first known path that is not ordered before `prefix`. */
  const lowerBound = (prefix: string): number => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid]! < prefix) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  for (const path of observed) {
    if (!path || known.has(path)) continue

    const depth = depthOf(path)
    let match: string | null = null
    let ambiguous = false

    for (let i = lowerBound(path); i < sorted.length; i++) {
      const candidate = sorted[i]!
      // The prefix run is contiguous, so the first miss ends it.
      if (!candidate.startsWith(path)) break
      // Strict prefix: a candidate no longer than the observed path cannot be
      // the fuller form of it.
      if (candidate.length <= path.length) continue
      if (depthOf(candidate) !== depth) continue

      if (match !== null) {
        ambiguous = true
        break
      }
      match = candidate
    }

    if (match !== null && !ambiguous) folds.set(path, match)
  }

  return folds
}
