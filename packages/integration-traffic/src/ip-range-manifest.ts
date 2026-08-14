import { createHash } from 'node:crypto'

/** A publisher IP-range entry. Exactly one address-family field is present. */
export type IpRangePrefix =
  | { ipv4Prefix: string; ipv6Prefix?: never }
  | { ipv4Prefix?: never; ipv6Prefix: string }

export interface ValidatedIpRangeManifestPayload {
  creationTime: string
  prefixes: IpRangePrefix[]
}

export type IpRangeManifestValidationResult =
  | { ok: true; value: ValidatedIpRangeManifestPayload }
  | { ok: false; error: string }

export interface ParsedIp {
  readonly version: 4 | 6
  readonly addr: bigint
}

/** CIDR pre-parsed into the form needed for fast membership checks. */
export interface ParsedCidr {
  readonly version: 4 | 6
  /** Network address as a BigInt (IPv6) or IPv4-as-BigInt for uniformity. */
  readonly network: bigint
  /** Mask as a BigInt — `network & mask === addr & mask` proves membership. */
  readonly mask: bigint
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
  }
  if (typeof value !== 'object') return JSON.stringify(`[${typeof value}]`)
  if (seen.has(value)) return '"[circular]"'

  seen.add(value)
  const result = Array.isArray(value)
    ? `[${value.map(entry => stableJson(entry, seen)).join(',')}]`
    : `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key], seen)}`)
      .join(',')}}`
  seen.delete(value)
  return result
}

/**
 * Parse an IPv4 or IPv6 address into a BigInt. The entire string must be a
 * valid address; partial numeric parses and whitespace are rejected.
 */
export function parseIp(ip: string): ParsedIp | null {
  if (typeof ip !== 'string' || ip.length === 0) return null

  // IPv4-mapped IPv6 (e.g. ::ffff:192.0.2.1) is treated as IPv4 so it can
  // match the publishers' IPv4 lists.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mappedMatch) return parseIp(mappedMatch[1]!)

  if (ip.includes(':')) {
    const sides = ip.split('::')
    if (sides.length > 2) return null
    const left = sides[0]!.length > 0 ? sides[0]!.split(':') : []
    const right = sides.length === 2 && sides[1]!.length > 0 ? sides[1]!.split(':') : []
    const groupCount = left.length + right.length
    if (sides.length === 1 && groupCount !== 8) return null
    // `::` must compress at least one 16-bit group.
    if (sides.length === 2 && groupCount >= 8) return null

    const fill = 8 - groupCount
    const groups: string[] = [...left, ...new Array<string>(fill).fill('0'), ...right]
    let addr = 0n
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      addr = (addr << 16n) | BigInt(Number.parseInt(group, 16))
    }
    return { version: 6, addr }
  }

  const octets = ip.split('.')
  if (octets.length !== 4) return null
  let addr = 0n
  for (const octet of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return null
    const value = Number(octet)
    if (value > 255) return null
    addr = (addr << 8n) | BigInt(value)
  }
  return { version: 4, addr }
}

/** Parse a full `1.2.3.0/24` or `2001:db8::/32` CIDR string. */
export function parseCidr(cidr: string): ParsedCidr | null {
  if (typeof cidr !== 'string') return null
  const slash = cidr.indexOf('/')
  if (slash <= 0 || slash !== cidr.lastIndexOf('/') || slash === cidr.length - 1) return null
  const ipPart = cidr.slice(0, slash)
  const prefixStr = cidr.slice(slash + 1)
  if (!/^(?:0|[1-9]\d{0,2})$/.test(prefixStr)) return null

  const parsed = parseIp(ipPart)
  if (!parsed) return null
  const prefix = Number(prefixStr)
  const totalBits = parsed.version === 4 ? 32 : 128
  if (prefix > totalBits) return null

  const allOnes = (1n << BigInt(totalBits)) - 1n
  const mask = (allOnes >> BigInt(totalBits - prefix)) << BigInt(totalBits - prefix)
  return {
    version: parsed.version,
    network: parsed.addr & mask,
    mask,
  }
}

function canonicalPrefixKey(entry: unknown): string {
  if (isRecord(entry)) {
    const hasIpv4 = Object.hasOwn(entry, 'ipv4Prefix')
    const hasIpv6 = Object.hasOwn(entry, 'ipv6Prefix')
    if (hasIpv4 !== hasIpv6) {
      const value = entry[hasIpv4 ? 'ipv4Prefix' : 'ipv6Prefix']
      if (typeof value === 'string') {
        const parsed = parseCidr(value)
        const expectedVersion = hasIpv4 ? 4 : 6
        if (parsed?.version === expectedVersion) {
          const hexWidth = parsed.version === 4 ? 8 : 32
          const network = parsed.network.toString(16).padStart(hexWidth, '0')
          const mask = parsed.mask.toString(16).padStart(hexWidth, '0')
          return `cidr:${parsed.version}:${network}:${mask}`
        }
      }
    }
  }
  return `invalid:${stableJson(entry)}`
}

/**
 * SHA-256 of the executable prefix content. Valid CIDRs are normalized to
 * address family, network, and mask, then sorted so publisher reordering does
 * not create a new snapshot identity. Invalid payloads still receive a stable
 * fail-closed identity for provenance.
 */
export function ipRangeManifestContentHash(value: unknown): string {
  const prefixes = isRecord(value) ? value.prefixes : undefined
  const canonical = Array.isArray(prefixes)
    ? prefixes.map(canonicalPrefixKey).sort()
    : [`invalid-prefixes:${stableJson(prefixes)}`]
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** True when `ip` falls inside a same-address-family CIDR. */
export function ipInCidr(ip: string, cidr: ParsedCidr): boolean {
  const parsed = parseIp(ip)
  if (!parsed || parsed.version !== cidr.version) return false
  return (parsed.addr & cidr.mask) === cidr.network
}

/**
 * Validate and normalize a publisher response before it becomes executable
 * verification data. Every entry must name exactly one address family and
 * contain one fully valid CIDR.
 */
export function validateIpRangeManifestPayload(value: unknown): IpRangeManifestValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'response must be a JSON object' }

  const creationTime = value.creationTime
  if (typeof creationTime !== 'string' || creationTime.trim().length === 0) {
    return { ok: false, error: 'response missing `creationTime` version' }
  }
  if (!Array.isArray(value.prefixes)) {
    return { ok: false, error: 'response missing `prefixes` array' }
  }

  const prefixes: IpRangePrefix[] = []
  for (const [index, entry] of value.prefixes.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, error: `prefixes[${index}] must be an object` }
    }

    const hasIpv4 = Object.hasOwn(entry, 'ipv4Prefix')
    const hasIpv6 = Object.hasOwn(entry, 'ipv6Prefix')
    if (hasIpv4 === hasIpv6) {
      return { ok: false, error: `prefixes[${index}] must contain exactly one IP prefix` }
    }

    const field = hasIpv4 ? 'ipv4Prefix' : 'ipv6Prefix'
    const cidr = entry[field]
    if (typeof cidr !== 'string') {
      return { ok: false, error: `prefixes[${index}].${field} must be a string` }
    }
    const parsed = parseCidr(cidr)
    const expectedVersion = hasIpv4 ? 4 : 6
    if (!parsed || parsed.version !== expectedVersion) {
      return { ok: false, error: `prefixes[${index}].${field} is not a valid IPv${expectedVersion} CIDR` }
    }

    prefixes.push(hasIpv4 ? { ipv4Prefix: cidr } : { ipv6Prefix: cidr })
  }

  return {
    ok: true,
    value: {
      creationTime: creationTime.trim(),
      prefixes,
    },
  }
}
