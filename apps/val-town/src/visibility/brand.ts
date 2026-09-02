import type { VisibilityProbeTarget, VisibilitySource } from './contracts.ts'
import { cleanText, MAX_BRAND_NAME_CHARS, MAX_BRAND_NAMES, MAX_DOMAIN_CHARS, uniqueStable } from './runtime.ts'

/**
 * Exact brand identity matching, kept Val-local so the probe core has no
 * dependency on Canonry's private workspace contracts at runtime. The behavior
 * deliberately mirrors Canonry's approved-alias model: adjacent
 * complete words only, never substring or edit-distance guesses.
 */
const WORD_SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' })
const NON_WORD = /[^\p{L}\p{N}]+/gu
const WORD_RUNS = /[\p{L}\p{N}]+/gu
const ACCENT_BEARING_SCRIPT = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u
const NON_ASCII = /\P{ASCII}/u
const WRITTEN_URL_OR_DOMAIN =
  /(?:https?:\/\/|www\.)[^\s<>(){}]+|\b(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[a-z]{2,63}(?:[/?#][^\s<>(){}]*)?/giu

export interface NormalizedTarget {
  canonicalDomain: string
  /** Explicit caller-approved names, safe to return on the public report. */
  brandNames: string[]
  /** Exact-match aliases. These are caller-approved names only. */
  aliases: string[]
}

export interface MentionEvidence {
  mentioned: boolean
  matchedTerms: string[]
}

export interface CitationEvidence {
  cited: boolean
  citedDomains: string[]
  citedUrls: string[]
  matchedCitationDomains: string[]
  matchedCitationUrls: string[]
  sources: NormalizedSource[]
}

export interface NormalizedSource {
  url: string
  title: string | null
  domain: string | null
  targetDomainMatch: boolean
}

function foldAccents(value: string): string {
  if (!NON_ASCII.test(value)) return value
  let folded = ''
  for (const character of value) {
    if (character.charCodeAt(0) < 0x80) {
      folded += character
      continue
    }
    const decomposed = character.normalize('NFD')
    const base = decomposed[0]!
    folded += decomposed.length > 1 && ACCENT_BEARING_SCRIPT.test(base) ? base : character
  }
  return folded
}

function normalizedWords(value: string): string[] {
  const normalized = foldAccents(value.normalize('NFKC')).toLocaleLowerCase('en')
  const words: string[] = []
  for (const segment of WORD_SEGMENTER.segment(normalized)) {
    if (!segment.isWordLike) continue
    for (const word of segment.segment.match(WORD_RUNS) ?? []) words.push(word)
  }
  return words
}

export function brandKey(value: string): string {
  return normalizedWords(value).join('')
}

function matchedAliasKeys(text: string, aliases: readonly string[]): Set<string> {
  const keys = new Set(aliases.map(brandKey).filter(Boolean))
  if (keys.size === 0) return new Set()
  const normalized = foldAccents(text.normalize('NFKC')).toLocaleLowerCase('en')
  const compact = normalized.replace(NON_WORD, '')
  const reachable = new Set([...keys].filter((key) => compact.includes(key)))
  if (reachable.size === 0) return new Set()

  const longest = Math.max(...[...reachable].map((key) => key.length))
  const found = new Set<string>()
  const words = normalizedWords(text)
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (reachable.has(candidate)) found.add(candidate)
      if (candidate.length >= longest) break
    }
    if (found.size === reachable.size) break
  }
  return found
}

/** Normalize only a hostname / http(s) URL; output never retains credentials. */
export function hostOf(value: string | null | undefined): string | null {
  const candidate = cleanText(value)
  // A source URL can legitimately be longer than its hostname. Bound the
  // parser input, then validate the resulting hostname independently.
  if (!candidate || candidate.length > 8_192) return null
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`
  try {
    const hostname = new URL(withScheme).hostname.replace(/^www\./i, '').replace(/\.$/, '').toLowerCase()
    return hostname && hostname.length <= MAX_DOMAIN_CHARS ? hostname : null
  } catch {
    return null
  }
}

export function hostMatchesDomain(candidate: string | null | undefined, domain: string): boolean {
  const candidateHost = hostOf(candidate)
  // Normalize the target the same way as the candidate (strip `www.`, lowercase),
  // so a `www.`-prefixed input domain still matches its own `www.`-stripped cited
  // hosts. `hostOf` is idempotent, so an already-normalized `canonicalDomain`
  // passed here is unchanged.
  const targetHost = hostOf(domain) ?? domain
  return candidateHost === targetHost || Boolean(candidateHost?.endsWith(`.${targetHost}`))
}

export function normalizeTarget(target: VisibilityProbeTarget): NormalizedTarget {
  const canonicalDomain = hostOf(target.canonicalDomain)
  if (!canonicalDomain || !canonicalDomain.includes('.')) {
    throw new Error('target.canonicalDomain must be a valid public hostname')
  }
  if (!Array.isArray(target.brandNames)) throw new Error('target.brandNames must be an array')
  if (target.brandNames.length > MAX_BRAND_NAMES) {
    throw new Error(`target.brandNames may contain at most ${MAX_BRAND_NAMES} entries`)
  }

  const explicitNames = target.brandNames.map(cleanText).filter(Boolean)
  if (explicitNames.some((name) => name.length > MAX_BRAND_NAME_CHARS)) {
    throw new Error(`target.brandNames entries must be at most ${MAX_BRAND_NAME_CHARS} characters`)
  }
  const brandNames = uniqueStable(explicitNames)
  return { canonicalDomain, brandNames, aliases: brandNames }
}

function normalizeSourceUrl(value: string): string | null {
  const raw = cleanText(value)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return null
  }
}

/** Find explicit written URLs/domains in answer prose, not fuzzy word fragments. */
function writtenHosts(text: string): string[] {
  const hosts: string[] = []
  for (const match of text.matchAll(WRITTEN_URL_OR_DOMAIN)) {
    const candidate = match[0]!.replace(/[.,;:!?]+$/, '')
    const host = hostOf(candidate)
    if (host) hosts.push(host)
  }
  return uniqueStable(hosts)
}

/**
 * Which of `names` the text literally writes, by the same exact-alias rule the
 * target's own mention verdict uses: adjacent complete words, accent-folded,
 * never a substring or an edit-distance guess.
 *
 * This is the arbiter for model-proposed brand names. A name the model returns
 * that is not written in the prose is dropped, so the extraction can suggest
 * but never assert: the metric still rests on exact matching.
 */
export function namesWrittenIn(text: string, names: readonly string[]): string[] {
  const cleaned = uniqueStable(names.map(cleanText).filter(Boolean))
  if (cleaned.length === 0) return []
  const matched = matchedAliasKeys(text, cleaned)
  return cleaned.filter((name) => matched.has(brandKey(name)))
}

export function detectMention(answerText: string, target: NormalizedTarget): MentionEvidence {
  const matchedTerms: string[] = []
  if (writtenHosts(answerText).some((host) => hostMatchesDomain(host, target.canonicalDomain))) {
    matchedTerms.push(target.canonicalDomain)
  }

  const matchedKeys = matchedAliasKeys(answerText, target.aliases)
  for (const alias of target.aliases) {
    if (matchedKeys.has(brandKey(alias))) matchedTerms.push(alias)
  }
  const unique = uniqueStable(matchedTerms)
  return {
    mentioned: unique.length > 0,
    matchedTerms: unique,
  }
}

/**
 * Derive citation evidence strictly from the source list. This intentionally
 * does not inspect answer prose: a mention without a source is not a citation.
 */
export function detectCitation(
  inputSources: readonly VisibilitySource[] | undefined,
  target: NormalizedTarget,
): CitationEvidence {
  const sourceMap = new Map<string, NormalizedSource>()
  for (const source of inputSources ?? []) {
    const url = normalizeSourceUrl(source.url)
    if (!url || sourceMap.has(url)) continue
    // An adapter may explicitly set `domain: null` for an opaque provider
    // redirect. Do not turn that infrastructure hostname into a citation.
    const domain = source.domain === undefined ? hostOf(url) : hostOf(source.domain)
    sourceMap.set(url, {
      url,
      title: cleanText(source.title) || null,
      domain,
      targetDomainMatch: domain ? hostMatchesDomain(domain, target.canonicalDomain) : false,
    })
  }
  const sources = [...sourceMap.values()]
  const citedDomains = uniqueStable(sources.flatMap((source) => source.domain ? [source.domain] : []))
  const citedUrls = sources.map((source) => source.url)
  const matchedSources = sources.filter((source) => source.targetDomainMatch)
  return {
    cited: matchedSources.length > 0,
    citedDomains,
    citedUrls,
    matchedCitationDomains: uniqueStable(matchedSources.flatMap((source) => source.domain ? [source.domain] : [])),
    matchedCitationUrls: matchedSources.map((source) => source.url),
    sources,
  }
}
