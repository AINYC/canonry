/**
 * Pure sitemap classifier for a later measurement-target route. It deliberately
 * accepts only literal path templates: caller input is never compiled as regex.
 */

import { measurementStableKeySchema, normalizeMeasurementHost } from '@ainyc/canonry-contracts'

export type MeasurementDiscoveryReasonCode =
  | 'primary-match'
  | 'alias-coverage'
  | 'excluded-slug'
  | 'shared-path'
  | 'unmatched-path'
  | 'alias-without-primary'
  | 'unsupported-slug'
  | 'invalid-url'
  | 'unowned-host'
  | 'duplicate-url'
  | 'url-cap-reached'

export type MeasurementDiscoverySlugPatternKind = 'exact' | 'prefix' | 'suffix' | 'contains'

/** A safe, declarative slug matcher. `value` is matched as text, never as regex. */
export interface MeasurementDiscoverySlugPattern {
  kind: MeasurementDiscoverySlugPatternKind
  value: string
}

/** A literal host plus a path template containing exactly one `{slug}` segment. */
export interface MeasurementDiscoveryRouteRule {
  host: string
  pathTemplate: string
}

export interface MeasurementDiscoveryRules {
  primary: MeasurementDiscoveryRouteRule
  aliases?: readonly MeasurementDiscoveryRouteRule[]
  /** Simple suffix exclusions such as `-metro`. */
  excludedSlugSuffixes?: readonly string[]
  /** Bounded text matching for exclusions that are not suffixes. */
  excludedSlugPatterns?: readonly MeasurementDiscoverySlugPattern[]
}

export interface MeasurementDiscoveryInput {
  /** Base domains or exact hosts that this instance is allowed to classify. */
  ownedHosts: readonly string[]
  rules: MeasurementDiscoveryRules
  /** Sitemap URLs already collected by the caller. This function performs no I/O. */
  urls: readonly string[]
  /** Maximum number of unique canonical URLs to classify. Remaining URLs are reported as truncated. */
  maxUrls: number
}

export interface MeasurementDiscoveryItem {
  /** Canonical URL when it could be parsed; otherwise the original input string. */
  url: string
  canonicalUrl: string | null
  reasonCodes: MeasurementDiscoveryReasonCode[]
}

export interface MeasurementDiscoveryDuplicateItem extends MeasurementDiscoveryItem {
  duplicateOf: string
}

export interface MeasurementDiscoveryCandidate {
  stableKey: string
  slug: string
  label: string
  primaryUrl: string
  aliasCoverageUrls: string[]
  status: 'proposed'
  reasonCodes: MeasurementDiscoveryReasonCode[]
}

export interface MeasurementDiscoveryResult {
  candidates: MeasurementDiscoveryCandidate[]
  shared: MeasurementDiscoveryItem[]
  unmatched: MeasurementDiscoveryItem[]
  invalid: MeasurementDiscoveryItem[]
  duplicates: MeasurementDiscoveryDuplicateItem[]
  truncated: MeasurementDiscoveryItem[]
}

export class MeasurementDiscoveryConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MeasurementDiscoveryConfigurationError'
  }
}

interface CompiledRouteRule {
  host: string
  segments: string[]
  slugIndex: number
}

interface CompiledRules {
  primary: CompiledRouteRule
  aliases: CompiledRouteRule[]
  excludedSlugSuffixes: string[]
  excludedSlugPatterns: MeasurementDiscoverySlugPattern[]
}

interface ParsedSitemapUrl {
  sourceUrl: string
  canonicalUrl: string
  host: string
  pathSegments: string[]
}

interface PrimaryMatch {
  slug: string
  stableKey: string
  url: string
}

interface AliasMatch {
  slug: string
  url: string
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function normalizeDeclaredHost(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '')
  if (!normalized || normalized.includes('://') || normalized.includes('/') || normalized.includes('@')) {
    throw new MeasurementDiscoveryConfigurationError(`${label} must be a hostname`)
  }

  try {
    const parsed = new URL(`https://${normalized}`)
    if (parsed.hostname !== normalized || parsed.port || parsed.username || parsed.password) {
      throw new MeasurementDiscoveryConfigurationError(`${label} must be a hostname without a port`)
    }
    return normalizeMeasurementHost(parsed.hostname)
  } catch (error) {
    if (error instanceof MeasurementDiscoveryConfigurationError) throw error
    throw new MeasurementDiscoveryConfigurationError(`${label} must be a valid hostname`)
  }
}

function isOwnedHost(host: string, ownedHosts: readonly string[]): boolean {
  return ownedHosts.some((ownedHost) => host === ownedHost || host.endsWith(`.${ownedHost}`))
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.includes('/') ? null : decoded
  } catch {
    return null
  }
}

function compilePathTemplate(pathTemplate: string, label: string): { segments: string[]; slugIndex: number } {
  if (!pathTemplate.startsWith('/') || pathTemplate.includes('?') || pathTemplate.includes('#')) {
    throw new MeasurementDiscoveryConfigurationError(`${label} must be an absolute path template`)
  }

  const rawSegments = pathTemplate.split('/').slice(1)
  while (rawSegments.at(-1) === '') rawSegments.pop()
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment === '')) {
    throw new MeasurementDiscoveryConfigurationError(`${label} must not contain empty path segments`)
  }

  const slugIndexes = rawSegments
    .map((segment, index) => (segment === '{slug}' ? index : -1))
    .filter((index) => index >= 0)
  if (slugIndexes.length !== 1) {
    throw new MeasurementDiscoveryConfigurationError(`${label} must contain exactly one {slug} path segment`)
  }

  const segments = rawSegments.map((segment) => {
    if (segment === '{slug}') return segment
    const decoded = decodeSegment(segment)
    if (decoded === null || decoded.length === 0) {
      throw new MeasurementDiscoveryConfigurationError(`${label} contains an invalid literal path segment`)
    }
    return decoded
  })
  return { segments, slugIndex: slugIndexes[0]! }
}

function compileRouteRule(
  rule: MeasurementDiscoveryRouteRule,
  label: string,
  ownedHosts: readonly string[],
): CompiledRouteRule {
  const host = normalizeDeclaredHost(rule.host, `${label}.host`)
  if (!isOwnedHost(host, ownedHosts)) {
    throw new MeasurementDiscoveryConfigurationError(`${label}.host must be within ownedHosts`)
  }
  const template = compilePathTemplate(rule.pathTemplate, `${label}.pathTemplate`)
  return { host, ...template }
}

function normalizePatternValue(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) throw new MeasurementDiscoveryConfigurationError(`${label} must not be empty`)
  return normalized
}

function compileRules(input: MeasurementDiscoveryInput): { ownedHosts: string[]; rules: CompiledRules } {
  const ownedHosts = sortedUnique(input.ownedHosts.map((host, index) => normalizeDeclaredHost(host, `ownedHosts[${index}]`)))
  if (ownedHosts.length === 0) {
    throw new MeasurementDiscoveryConfigurationError('ownedHosts must contain at least one hostname')
  }

  const primary = compileRouteRule(input.rules.primary, 'rules.primary', ownedHosts)
  const aliases = (input.rules.aliases ?? []).map((rule, index) =>
    compileRouteRule(rule, `rules.aliases[${index}]`, ownedHosts),
  )
  if (aliases.some((alias) => alias.host === primary.host)) {
    throw new MeasurementDiscoveryConfigurationError('alias rules must use another owned host')
  }

  const excludedSlugSuffixes = sortedUnique(
    (input.rules.excludedSlugSuffixes ?? []).map((value, index) =>
      normalizePatternValue(value, `rules.excludedSlugSuffixes[${index}]`),
    ),
  )
  const excludedSlugPatterns = (input.rules.excludedSlugPatterns ?? [])
    .map((pattern, index) => ({
      kind: pattern.kind,
      value: normalizePatternValue(pattern.value, `rules.excludedSlugPatterns[${index}].value`),
    }))
    .sort((a, b) => compareText(`${a.kind}:${a.value}`, `${b.kind}:${b.value}`))

  return { ownedHosts, rules: { primary, aliases, excludedSlugSuffixes, excludedSlugPatterns } }
}

function parseSitemapUrl(value: string): ParsedSitemapUrl | null {
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.port) return null

    const rawSegments = parsed.pathname.split('/').slice(1)
    while (rawSegments.at(-1) === '') rawSegments.pop()
    if (rawSegments.some((segment) => segment === '')) return null

    const pathSegments: string[] = []
    for (const rawSegment of rawSegments) {
      const decoded = decodeSegment(rawSegment)
      if (decoded === null) return null
      pathSegments.push(decoded)
    }
    const path = pathSegments.length === 0 ? '/' : `/${pathSegments.map(encodeURIComponent).join('/')}`
    const host = normalizeMeasurementHost(parsed.hostname)
    const canonicalUrl = `${parsed.protocol}//${host}${path}`
    return { sourceUrl: value, canonicalUrl, host, pathSegments }
  } catch {
    return null
  }
}

function slugForRule(url: ParsedSitemapUrl, rule: CompiledRouteRule): string | null {
  if (url.host !== rule.host || url.pathSegments.length !== rule.segments.length) return null
  for (let index = 0; index < rule.segments.length; index += 1) {
    if (index === rule.slugIndex) continue
    if (url.pathSegments[index] !== rule.segments[index]) return null
  }
  const slug = url.pathSegments[rule.slugIndex]!.trim().toLowerCase()
  return slug ? slug : null
}

function isExcludedSlug(slug: string, rules: CompiledRules): boolean {
  if (rules.excludedSlugSuffixes.some((suffix) => slug.endsWith(suffix))) return true
  return rules.excludedSlugPatterns.some((pattern) => {
    switch (pattern.kind) {
      case 'exact':
        return slug === pattern.value
      case 'prefix':
        return slug.startsWith(pattern.value)
      case 'suffix':
        return slug.endsWith(pattern.value)
      case 'contains':
        return slug.includes(pattern.value)
    }
  })
}

function labelForSlug(slug: string): string {
  return slug
    .split('-')
    .flatMap((word) => word.split('_'))
    .filter(Boolean)
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function stableKeyForSlug(slug: string): string | null {
  const stableKey = `target-${slug}`
  return measurementStableKeySchema.safeParse(stableKey).success ? stableKey : null
}

function item(url: string, reasonCodes: MeasurementDiscoveryReasonCode[]): MeasurementDiscoveryItem {
  return { url, canonicalUrl: url, reasonCodes }
}

/**
 * Classify already-collected sitemap URLs into deterministic, reviewable target
 * proposals. The function is pure: it does not inspect a database, fetch a
 * sitemap, generate queries, or infer routes beyond the supplied literal rules.
 */
export function classifyMeasurementSitemapUrls(input: MeasurementDiscoveryInput): MeasurementDiscoveryResult {
  if (!Number.isSafeInteger(input.maxUrls) || input.maxUrls < 0) {
    throw new MeasurementDiscoveryConfigurationError('maxUrls must be a non-negative safe integer')
  }
  const { ownedHosts, rules } = compileRules(input)

  const canonicalGroups = new Map<string, ParsedSitemapUrl[]>()
  const invalid: MeasurementDiscoveryItem[] = []
  for (const sourceUrl of input.urls) {
    const parsed = parseSitemapUrl(sourceUrl)
    if (!parsed) {
      invalid.push({ url: sourceUrl, canonicalUrl: null, reasonCodes: ['invalid-url'] })
      continue
    }
    const group = canonicalGroups.get(parsed.canonicalUrl)
    if (group) group.push(parsed)
    else canonicalGroups.set(parsed.canonicalUrl, [parsed])
  }

  const candidatesBySlug = new Map<string, PrimaryMatch>()
  const aliasesBySlug = new Map<string, AliasMatch[]>()
  const shared: MeasurementDiscoveryItem[] = []
  const unmatched: MeasurementDiscoveryItem[] = []
  const duplicates: MeasurementDiscoveryDuplicateItem[] = []
  const truncated: MeasurementDiscoveryItem[] = []
  const canonicalEntries = [...canonicalGroups.entries()].sort(([a], [b]) => compareText(a, b))
  let classifiedUrlCount = 0

  for (const [canonicalUrl, group] of canonicalEntries) {
    const orderedGroup = [...group].sort((a, b) => compareText(a.sourceUrl, b.sourceUrl))
    const representative = orderedGroup[0]!
    for (let index = 1; index < orderedGroup.length; index += 1) {
      duplicates.push({
        ...item(orderedGroup[index]!.sourceUrl, ['duplicate-url']),
        canonicalUrl,
        duplicateOf: canonicalUrl,
      })
    }

    if (classifiedUrlCount >= input.maxUrls) {
      truncated.push(item(canonicalUrl, ['url-cap-reached']))
      continue
    }
    classifiedUrlCount += 1
    if (!isOwnedHost(representative.host, ownedHosts)) {
      invalid.push(item(canonicalUrl, ['unowned-host']))
      continue
    }

    const primarySlug = slugForRule(representative, rules.primary)
    if (primarySlug !== null) {
      if (isExcludedSlug(primarySlug, rules)) {
        shared.push(item(canonicalUrl, ['excluded-slug', 'shared-path']))
      } else {
        const stableKey = stableKeyForSlug(primarySlug)
        if (!stableKey) {
          unmatched.push(item(canonicalUrl, ['unsupported-slug']))
        } else if (!candidatesBySlug.has(primarySlug)) {
          candidatesBySlug.set(primarySlug, { slug: primarySlug, stableKey, url: canonicalUrl })
        }
      }
      continue
    }

    let aliasSlug: string | null = null
    for (const aliasRule of rules.aliases) {
      const matchedSlug = slugForRule(representative, aliasRule)
      if (matchedSlug !== null) {
        aliasSlug = matchedSlug
        break
      }
    }
    if (aliasSlug !== null) {
      if (isExcludedSlug(aliasSlug, rules)) {
        shared.push(item(canonicalUrl, ['excluded-slug', 'shared-path']))
      } else if (!stableKeyForSlug(aliasSlug)) {
        unmatched.push(item(canonicalUrl, ['unsupported-slug']))
      } else {
        const matches = aliasesBySlug.get(aliasSlug) ?? []
        matches.push({ slug: aliasSlug, url: canonicalUrl })
        aliasesBySlug.set(aliasSlug, matches)
      }
      continue
    }

    unmatched.push(item(canonicalUrl, ['unmatched-path']))
  }

  const candidates = [...candidatesBySlug.values()]
    .map(({ slug, stableKey, url }) => {
      const aliasCoverageUrls = sortedUnique((aliasesBySlug.get(slug) ?? []).map((match) => match.url))
      const reasonCodes: MeasurementDiscoveryReasonCode[] =
        aliasCoverageUrls.length > 0 ? ['primary-match', 'alias-coverage'] : ['primary-match']
      return {
        stableKey,
        slug,
        label: labelForSlug(slug),
        primaryUrl: url,
        aliasCoverageUrls,
        status: 'proposed' as const,
        reasonCodes,
      }
    })
    .sort((a, b) => compareText(a.stableKey, b.stableKey))

  for (const [slug, matches] of aliasesBySlug) {
    if (candidatesBySlug.has(slug)) continue
    for (const match of matches) unmatched.push(item(match.url, ['alias-without-primary']))
  }

  const sortItems = <T extends MeasurementDiscoveryItem>(items: T[]): T[] =>
    items.sort((a, b) => compareText(a.url, b.url))
  return {
    candidates,
    shared: sortItems(shared),
    unmatched: sortItems(unmatched),
    invalid: sortItems(invalid),
    duplicates: sortItems(duplicates),
    truncated: sortItems(truncated),
  }
}
