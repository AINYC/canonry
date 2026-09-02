const MAX_DOMAIN_INPUT_LENGTH = 253

export class PublicUrlError extends Error {
  override name = 'PublicUrlError'
}

export interface NormalizedPublicDomain {
  domain: string
  rootUrl: string
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const a = parts[0]!
  const b = parts[1]!
  const c = parts[2]!
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
}

/** `URL.hostname` retains brackets around an IPv6 literal. */
function normalizedIpv6Literal(host: string): string | null {
  const value = host.toLowerCase()
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  // A parsed URL hostname contains a colon only for an IPv6 literal. Do not
  // run IPv6 prefix checks against DNS names such as fda.gov or fc2.com.
  return unbracketed.includes(':') ? unbracketed : null
}

function isBlockedIpv6(value: string): boolean {
  return value === '::1' ||
    value === '::' ||
    value.startsWith('fe80:') ||
    value.startsWith('fc') ||
    value.startsWith('fd')
}

/**
 * Normalizes a user domain to a HTTPS root. This is a first-line guard; the
 * crawler still performs DNS and per-hop SSRF validation before every fetch.
 */
export function normalizePublicDomain(input: unknown): NormalizedPublicDomain {
  if (typeof input !== 'string') throw new PublicUrlError('Enter a domain.')
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > MAX_DOMAIN_INPUT_LENGTH) throw new PublicUrlError('Enter a valid public domain.')

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new PublicUrlError('Enter a valid public domain.')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicUrlError('Only HTTP(S) domains can be checked.')
  }
  if (url.username || url.password) throw new PublicUrlError('Credentials are not allowed in a domain.')
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new PublicUrlError('Only standard web ports can be checked.')
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new PublicUrlError('Enter a domain, not a page URL.')

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new PublicUrlError('Private and local hosts cannot be checked.')
  }
  if (isBlockedIpv4(hostname)) {
    throw new PublicUrlError('Private and local hosts cannot be checked.')
  }

  const ipv6 = normalizedIpv6Literal(hostname)
  if (ipv6) {
    if (isBlockedIpv6(ipv6)) throw new PublicUrlError('Private and local hosts cannot be checked.')
    throw new PublicUrlError('IPv6 literal domains are not supported.')
  }

  // URL already performs IDNA conversion. IPv6 literals were rejected above;
  // require a DNS-looking name or a public IPv4 literal.
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  if (!isIpv4 && (!hostname.includes('.') || hostname.length > MAX_DOMAIN_INPUT_LENGTH)) {
    throw new PublicUrlError('Enter a public domain with a valid hostname.')
  }

  return { domain: hostname, rootUrl: `https://${hostname}/` }
}

/** The sole alternate hostname the public host may attempt after a failed root crawl. */
export function wwwAlternate(domain: string): string | null {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) || domain.includes(':')) return null
  return domain.startsWith('www.') ? domain.slice(4) : `www.${domain}`
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
