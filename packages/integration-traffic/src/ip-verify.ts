/**
 * IP-range verification for bot operators that publish their crawler IPs.
 *
 * **Why this exists.** UA-string classification (`classifyCrawler`) is
 * spoofable per-request — any scraper can send
 * `User-Agent: Googlebot/2.1`. Operators that care about being
 * trustworthy publish the IP ranges their crawlers operate from; we use
 * those to promote `claimed_unverified` → `verified` when the request's
 * source IP falls in the published range.
 *
 * **Coverage today.** Operators with ranges bundled under
 * `./ip-ranges/<operator>.json`:
 *   - Googlebot              (developers.google.com/static/search/apis/ipranges/googlebot.json)
 *   - bingbot                (www.bing.com/toolbox/bingbot.json)
 *   - OpenAI GPTBot          (openai.com/gptbot.json)
 *   - OpenAI ChatGPT-User    (openai.com/chatgpt-user.json)
 *   - OpenAI OAI-SearchBot   (openai.com/searchbot.json)
 *   - PerplexityBot          (www.perplexity.ai/perplexitybot.json)
 *   - Perplexity-User        (www.perplexity.ai/perplexity-user.json)
 *   - ClaudeBot, Claude-SearchBot, Claude-User
 *                            (claude.com/crawling/bots.json — Anthropic's
 *                             shared crawler-origin manifest does not split
 *                             ranges by bot, so every Claude-* rule verifies
 *                             against the same published set.)
 *   - Google-Agent           (developers.google.com/static/crawling/ipranges/user-triggered-agents.json
 *                             — Google's shared list covering every
 *                             user-triggered fetcher.)
 *
 * **Not covered (yet).** Meta, ByteDance, Apple, DeepSeek, Mistral,
 * DuckDuckGo, Yandex, Baidu, Amazon — these either don't publish a
 * public IP-range JSON or only publish via PDF/docs pages that need
 * parsing. Add them by dropping a JSON file alongside the existing
 * ones (same shape: `{ prefixes: [{ ipv4Prefix } | { ipv6Prefix }] }`)
 * and adding the rule-id mapping below.
 *
 * **User-fetch agents and on-device fetches.** A user-triggered fetch
 * (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, …) does not always
 * leave the operator's servers. Some surfaces fetch the URL server-side,
 * so it egresses from the operator's cloud IP and verifies here. A local
 * app can instead fetch straight from the user's device, egressing from
 * the user's own residential or cellular IP, which no operator publishes
 * and never could. That on-device case is structurally unverifiable: a
 * genuine user fetch then stays `claimed_unverified` permanently, and
 * that is correct, not a coverage gap. Treat the `ai_user_fetch` channel
 * count as the signal; an IP-confirmed `verified` is a bonus subset.
 *
 * **Refresh.** Run `scripts/refresh-ip-ranges.ts` to re-fetch all
 * bundled lists from the publishers. The script is git-friendly: it
 * writes pretty-printed JSON so diffs show exactly which prefixes the
 * operator added/removed.
 */
import type { TrafficVerificationManifest } from '@ainyc/canonry-contracts'
import anthropicRaw from './ip-ranges/anthropic.json' with { type: 'json' }
import bingbotRaw from './ip-ranges/bingbot.json' with { type: 'json' }
import chatgptUserRaw from './ip-ranges/chatgpt-user.json' with { type: 'json' }
import googleUserTriggeredRaw from './ip-ranges/google-user-triggered-agents.json' with { type: 'json' }
import googlebotRaw from './ip-ranges/googlebot.json' with { type: 'json' }
import gptbotRaw from './ip-ranges/gptbot.json' with { type: 'json' }
import oaiSearchbotRaw from './ip-ranges/oai-searchbot.json' with { type: 'json' }
import perplexityUserRaw from './ip-ranges/perplexity-user.json' with { type: 'json' }
import perplexitybotRaw from './ip-ranges/perplexitybot.json' with { type: 'json' }

interface RawIpRanges {
  _source?: string
  creationTime?: string
  prefixes: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }>
}

export interface IpVerificationDecision {
  verified: boolean
  /** Exact vendored publisher snapshot consulted for this decision. */
  manifest: TrafficVerificationManifest | null
}

/** CIDR pre-parsed into the form needed for fast membership checks. */
interface ParsedCidr {
  readonly version: 4 | 6
  /** Network address as a BigInt (IPv6) or number (IPv4-as-BigInt for uniformity). */
  readonly network: bigint
  /** Mask as a BigInt — `network & mask === addr & mask` proves membership. */
  readonly mask: bigint
}

interface VerificationData {
  readonly ranges: ParsedCidr[]
  readonly manifest: TrafficVerificationManifest | null
}

/**
 * Maps a classifier rule id (the `id` field on `AiCrawlerRule` in
 * `rules.ts`) to the ranges file for that operator. Rules with no
 * entry here can't be verified by IP — they stay
 * `claimed_unverified` after UA classification. Missing entries are
 * intentional (no publisher data) and should be added the moment an
 * operator publishes ranges.
 */
const RULE_ID_TO_RANGES: Record<string, RawIpRanges> = {
  // OpenAI — three separate published lists (training crawler vs
  // user-on-behalf fetcher vs search engine; OpenAI maintains the
  // split because the IPs really do differ between products).
  // src: https://openai.com/gptbot.json
  'openai-gptbot': gptbotRaw as RawIpRanges,
  // src: https://openai.com/chatgpt-user.json
  'openai-chatgpt-user': chatgptUserRaw as RawIpRanges,
  // src: https://openai.com/searchbot.json
  'openai-searchbot': oaiSearchbotRaw as RawIpRanges,

  // Search engines.
  // src: https://developers.google.com/static/search/apis/ipranges/googlebot.json
  // (also covers Gemini grounding — Google doesn't publish a
  // separate Gemini list; Google-Extended traffic comes from the
  // same Googlebot ranges)
  'googlebot': googlebotRaw as RawIpRanges,
  // src: https://www.bing.com/toolbox/bingbot.json
  // (also covers Copilot grounding — Microsoft routes Copilot's
  // web fetches through bingbot infrastructure)
  'bingbot': bingbotRaw as RawIpRanges,

  // Google-Agent — Google's agentic user-triggered fetcher (Project
  // Mariner et al.). Verified against Google's user-triggered-agents
  // list, which covers every Google user-triggered fetcher collectively
  // (Google publishes no per-fetcher split).
  // src: https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json
  'google-agent': googleUserTriggeredRaw as RawIpRanges,

  // Perplexity — split between crawler and user-on-behalf fetcher,
  // same shape as OpenAI's split.
  // src: https://www.perplexity.ai/perplexitybot.json
  'perplexity-bot': perplexitybotRaw as RawIpRanges,
  // src: https://www.perplexity.ai/perplexity-user.json
  'perplexity-user': perplexityUserRaw as RawIpRanges,

  // Anthropic publishes one shared crawler-origin manifest. It confirms
  // Anthropic origin but does not attribute a prefix to ClaudeBot,
  // Claude-SearchBot, or Claude-User individually, so both classifier rules
  // map to the same file and the UA remains the product discriminator.
  // src: https://claude.com/crawling/bots.json
  'anthropic-claudebot': anthropicRaw as RawIpRanges,
  'claude-user': anthropicRaw as RawIpRanges,
}

/**
 * Parses every operator's prefixes into the BigInt form at module-load
 * time. Roughly 700 prefixes today, parsed once per process boot; all
 * subsequent verifications are O(N) bigint AND comparisons. Could be O(log
 * N) with a sorted-range search if hot — not needed yet. The publisher
 * metadata is cached beside the ranges so every classification can retain
 * the exact vendored snapshot used without any runtime I/O.
 */
const CACHE: Map<string, VerificationData> = (() => {
  const cache = new Map<string, VerificationData>()
  for (const [ruleId, raw] of Object.entries(RULE_ID_TO_RANGES)) {
    const parsed: ParsedCidr[] = []
    for (const entry of raw.prefixes) {
      const cidr = entry.ipv4Prefix ?? entry.ipv6Prefix
      if (!cidr) continue
      const p = parseCidr(cidr)
      if (p) parsed.push(p)
    }
    const source = raw._source?.trim()
    const version = raw.creationTime?.trim()
    const manifest = source && version
      ? { id: `${source}#${version}`, source, version }
      : null
    cache.set(ruleId, { ranges: parsed, manifest })
  }
  return cache
})()

/**
 * Parse an IPv4 or IPv6 address into a BigInt. Returns null on malformed
 * input (callers treat null as "can't verify, stay unverified").
 *
 * IPv4: 4 octets → 32-bit BigInt
 * IPv6: 8 groups, supports `::` zero-compression. Returns 128-bit BigInt.
 */
export function parseIp(ip: string): { version: 4 | 6; addr: bigint } | null {
  if (!ip) return null
  // IPv4-mapped IPv6 (e.g. ::ffff:192.0.2.1) — strip prefix and treat as IPv4.
  // Common for clients that hit IPv6-only edges but originate from IPv4.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mappedMatch) return parseIp(mappedMatch[1]!)
  if (ip.includes(':')) {
    // IPv6
    const sides = ip.split('::')
    if (sides.length > 2) return null
    const left = sides[0]!.length > 0 ? sides[0]!.split(':') : []
    const right = sides.length === 2 && sides[1]!.length > 0 ? sides[1]!.split(':') : []
    const groupCount = left.length + right.length
    if (groupCount > 8) return null
    if (sides.length === 1 && groupCount !== 8) return null
    const fill = 8 - groupCount
    const groups: string[] = [...left, ...new Array<string>(fill).fill('0'), ...right]
    let addr = 0n
    for (const g of groups) {
      if (g.length === 0 || g.length > 4) return null
      const n = Number.parseInt(g, 16)
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
      addr = (addr << 16n) | BigInt(n)
    }
    return { version: 6, addr }
  }
  // IPv4
  const octets = ip.split('.')
  if (octets.length !== 4) return null
  let addr = 0n
  for (const o of octets) {
    if (o.length === 0 || o.length > 3) return null
    const n = Number.parseInt(o, 10)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    addr = (addr << 8n) | BigInt(n)
  }
  return { version: 4, addr }
}

/** Parse `1.2.3.0/24` or `2001:db8::/32` into a `ParsedCidr`. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const [ipPart, prefixStr] = cidr.split('/')
  if (!ipPart || !prefixStr) return null
  const prefix = Number.parseInt(prefixStr, 10)
  if (!Number.isInteger(prefix)) return null
  const parsed = parseIp(ipPart)
  if (!parsed) return null
  const totalBits = parsed.version === 4 ? 32 : 128
  if (prefix < 0 || prefix > totalBits) return null
  // Build the mask: top `prefix` bits set, rest zero.
  // `(1 << totalBits) - 1` = all-ones; right-shift the network suffix off,
  // then left-shift back to leave the prefix bits on top.
  const allOnes = (1n << BigInt(totalBits)) - 1n
  const mask = (allOnes >> BigInt(totalBits - prefix)) << BigInt(totalBits - prefix)
  return {
    version: parsed.version,
    network: parsed.addr & mask,
    mask,
  }
}

/**
 * True if `ip` falls inside `cidr`'s network. Both must be the same
 * IP version (matching v4-in-v4 / v6-in-v6); cross-version returns false.
 */
export function ipInCidr(ip: string, cidr: ParsedCidr): boolean {
  const parsed = parseIp(ip)
  if (!parsed) return false
  if (parsed.version !== cidr.version) return false
  return (parsed.addr & cidr.mask) === cidr.network
}

/**
 * Decide whether an IP falls in the published ranges for a crawler rule and
 * return the exact vendored manifest consulted. A known rule retains manifest
 * provenance even when the IP is absent, malformed, or outside the ranges;
 * callers can then distinguish "rejected by snapshot X" from "no publisher
 * manifest exists" without performing runtime I/O.
 */
export function verifyIpForRuleDecision(
  ip: string | null | undefined,
  ruleId: string,
): IpVerificationDecision {
  const data = CACHE.get(ruleId)
  if (!data || data.ranges.length === 0) return { verified: false, manifest: null }
  if (!ip) return { verified: false, manifest: data.manifest }
  const parsed = parseIp(ip)
  if (!parsed) return { verified: false, manifest: data.manifest }
  for (const cidr of data.ranges) {
    if (parsed.version !== cidr.version) continue
    if ((parsed.addr & cidr.mask) === cidr.network) {
      return { verified: true, manifest: data.manifest }
    }
  }
  return { verified: false, manifest: data.manifest }
}

/**
 * Boolean-compatible verification API retained for existing callers. Use
 * `verifyIpForRuleDecision` when the publisher snapshot must be persisted.
 */
export function verifyIpForRule(ip: string | null | undefined, ruleId: string): boolean {
  return verifyIpForRuleDecision(ip, ruleId).verified
}

/** Whether a rule id has any verification data available at all. */
export function hasVerificationDataFor(ruleId: string): boolean {
  const data = CACHE.get(ruleId)
  return !!data && data.ranges.length > 0
}
