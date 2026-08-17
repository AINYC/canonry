import { describe, expect, it } from 'vitest'
import amazonbotRaw from '../src/ip-ranges/amazonbot.json' with { type: 'json' }
import amznSearchbotRaw from '../src/ip-ranges/amzn-searchbot.json' with { type: 'json' }
import amznUserRaw from '../src/ip-ranges/amzn-user.json' with { type: 'json' }
import anthropicRaw from '../src/ip-ranges/anthropic.json' with { type: 'json' }
import applebotRaw from '../src/ip-ranges/applebot.json' with { type: 'json' }
import ccbotRaw from '../src/ip-ranges/ccbot.json' with { type: 'json' }
import chatgptConnectorsRaw from '../src/ip-ranges/chatgpt-connectors.json' with { type: 'json' }
import duckassistbotRaw from '../src/ip-ranges/duckassistbot.json' with { type: 'json' }
import duckduckbotRaw from '../src/ip-ranges/duckduckbot.json' with { type: 'json' }
import googleUserFetchersRaw from '../src/ip-ranges/google-user-triggered-fetchers.json' with { type: 'json' }
import googlebotRaw from '../src/ip-ranges/googlebot.json' with { type: 'json' }
import mistralAiIndexRaw from '../src/ip-ranges/mistral-ai-index.json' with { type: 'json' }
import mistralAiUserRaw from '../src/ip-ranges/mistral-ai-user.json' with { type: 'json' }
import oaiAdsbotRaw from '../src/ip-ranges/oai-adsbot.json' with { type: 'json' }
import parallelShapbotRaw from '../src/ip-ranges/parallel-shapbot.json' with { type: 'json' }
import {
  hasVerificationDataFor,
  ipRangeManifestContentHash,
  ipInCidr,
  parseCidr,
  parseIp,
  validateIpRangeManifestPayload,
  verifyIpAgainstManifest,
  verifyIpForRule,
  verifyIpForRuleDecision,
} from '../src/index.js'

const ANTHROPIC_MANIFEST = {
  id: `${anthropicRaw._source}#${anthropicRaw.creationTime}#sha256:${ipRangeManifestContentHash(anthropicRaw)}`,
  source: anthropicRaw._source,
  version: anthropicRaw.creationTime,
}

interface TestManifest {
  prefixes: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }>
}

function firstPublishedIp(raw: TestManifest): string {
  const first = raw.prefixes[0]
  const prefix = first?.ipv4Prefix ?? first?.ipv6Prefix
  if (!prefix) throw new Error('test manifest has no prefixes')
  return prefix.split('/')[0]!
}

describe('parseIp', () => {
  it('parses IPv4 to a 32-bit BigInt', () => {
    expect(parseIp('1.2.3.4')).toEqual({ version: 4, addr: BigInt(0x01020304) })
    expect(parseIp('0.0.0.0')).toEqual({ version: 4, addr: 0n })
    expect(parseIp('255.255.255.255')).toEqual({ version: 4, addr: BigInt(0xffffffff) })
  })

  it('rejects malformed IPv4', () => {
    expect(parseIp('1.2.3')).toBeNull()
    expect(parseIp('1.2.3.4.5')).toBeNull()
    expect(parseIp('1.2.3.256')).toBeNull()
    expect(parseIp('1.2.3.-1')).toBeNull()
    expect(parseIp('a.b.c.d')).toBeNull()
    expect(parseIp('1.2.3.4x')).toBeNull()
    expect(parseIp('01.2.3.4')).toBeNull()
    expect(parseIp(' 1.2.3.4')).toBeNull()
    expect(parseIp('')).toBeNull()
  })

  it('parses full IPv6', () => {
    const parsed = parseIp('2001:db8::1')
    expect(parsed?.version).toBe(6)
    expect(parsed?.addr).toBe(0x20010db8000000000000000000000001n)
  })

  it('handles IPv6 :: zero-compression', () => {
    expect(parseIp('::')?.addr).toBe(0n)
    expect(parseIp('::1')?.addr).toBe(1n)
    // `ff::` is the address with `ff` in the FIRST 16-bit group and
    // zeros everywhere else, i.e. 0xff << 112 in the 128-bit address.
    expect(parseIp('ff::')?.addr).toBe(0xffn << 112n)
  })

  it('handles IPv4-mapped IPv6 (::ffff:1.2.3.4)', () => {
    // Common when an IPv6-only edge forwards an IPv4 client — the
    // ::ffff: prefix is stripped and the address is treated as IPv4
    // so CIDR matches on either family work.
    const parsed = parseIp('::ffff:1.2.3.4')
    expect(parsed).toEqual({ version: 4, addr: BigInt(0x01020304) })
  })

  it('rejects malformed IPv6', () => {
    expect(parseIp('1::2::3')).toBeNull()  // two zero-compressions
    expect(parseIp('xyz::1')).toBeNull()
    expect(parseIp('2001:db8:ffz::1')).toBeNull()
    expect(parseIp('1:2:3:4:5:6:7:8::')).toBeNull()
    expect(parseIp(':::')).toBeNull()       // three colons
  })
})

describe('parseCidr', () => {
  it('parses IPv4 CIDR and computes the mask correctly', () => {
    const cidr = parseCidr('1.2.3.0/24')
    expect(cidr).not.toBeNull()
    expect(cidr!.version).toBe(4)
    expect(cidr!.network).toBe(BigInt(0x01020300))
    // /24 mask = 0xffffff00
    expect(cidr!.mask).toBe(BigInt(0xffffff00))
  })

  it('parses /0 (match everything)', () => {
    const cidr = parseCidr('0.0.0.0/0')
    expect(cidr!.mask).toBe(0n)
    expect(cidr!.network).toBe(0n)
  })

  it('parses /32 (single host)', () => {
    const cidr = parseCidr('1.2.3.4/32')
    expect(cidr!.mask).toBe(BigInt(0xffffffff))
    expect(cidr!.network).toBe(BigInt(0x01020304))
  })

  it('parses IPv6 /64', () => {
    const cidr = parseCidr('2001:db8::/64')
    expect(cidr!.version).toBe(6)
    expect(cidr!.network).toBe(0x20010db8000000000000000000000000n)
    // Top 64 bits set, bottom 64 zero.
    expect(cidr!.mask).toBe(0xffffffffffffffff0000000000000000n)
  })

  it('rejects out-of-range prefix length', () => {
    expect(parseCidr('1.2.3.4/33')).toBeNull()
    expect(parseCidr('1.2.3.4/-1')).toBeNull()
    expect(parseCidr('2001:db8::/129')).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(parseCidr('1.2.3.4')).toBeNull()  // no /
    expect(parseCidr('/24')).toBeNull()      // no ip
    expect(parseCidr('xyz/24')).toBeNull()
    expect(parseCidr('1.2.3.4/0junk')).toBeNull()
    expect(parseCidr('1.2.3.4/024')).toBeNull()
    expect(parseCidr('1.2.3.4/24/extra')).toBeNull()
  })
})

describe('validateIpRangeManifestPayload', () => {
  it('accepts a complete publisher payload, including an empty range set', () => {
    expect(validateIpRangeManifestPayload({
      creationTime: 'version-1',
      prefixes: [
        { ipv4Prefix: '192.0.2.0/24' },
        { ipv6Prefix: '2001:db8::/32' },
      ],
    })).toEqual({
      ok: true,
      value: {
        creationTime: 'version-1',
        prefixes: [
          { ipv4Prefix: '192.0.2.0/24' },
          { ipv6Prefix: '2001:db8::/32' },
        ],
      },
    })
    expect(validateIpRangeManifestPayload({ creationTime: 'version-empty', prefixes: [] })).toEqual({
      ok: true,
      value: { creationTime: 'version-empty', prefixes: [] },
    })
  })

  it.each([
    { creationTime: 'version-1', prefixes: [null] },
    { creationTime: 'version-1', prefixes: [{ ipv4Prefix: 123 }] },
    { creationTime: 'version-1', prefixes: [{ ipv4Prefix: '192.0.2.0/0junk' }] },
    { creationTime: 'version-1', prefixes: [{ ipv4Prefix: '2001:db8::/32' }] },
    { creationTime: 'version-1', prefixes: [{ ipv4Prefix: '192.0.2.0/24', ipv6Prefix: '2001:db8::/32' }] },
  ])('rejects an invalid prefix entry without throwing: %j', (payload) => {
    expect(validateIpRangeManifestPayload(payload).ok).toBe(false)
  })

  it('claims no provenance when there were no ranges to compare against', () => {
    // Fails closed on the decision AND on the provenance. A manifest that
    // yields zero usable prefixes never checked this request, so reporting it
    // would assert a comparison that did not happen — the same reason an
    // absent IP yields null below.
    const base = {
      _source: 'https://example.com/bots.json',
      creationTime: 'version-2',
    }
    const payloads = [
      { ...base, prefixes: [] },
      {
        ...base,
        prefixes: [{ ipv4Prefix: '192.0.2.0/0junk' }],
      },
      { ...base, prefixes: [null] },
    ]

    for (const payload of payloads) {
      expect(verifyIpAgainstManifest('192.0.2.1', payload)).toEqual({
        verified: false,
        manifest: null,
      })
    }
  })

  it('claims no provenance when there was no address to check', () => {
    // The distinction the sidecar depends on: `manifest: X` means X compared
    // this address and rejected it; `manifest: null` means nothing compared
    // anything. A source that does not expose a client IP (Vercel request
    // logs) must land in the second case, not the first.
    const payload = {
      _source: 'https://example.com/bots.json',
      creationTime: 'version-2',
      prefixes: [{ ipv4Prefix: '192.0.2.0/24' }],
    }
    for (const ip of [null, undefined, '', 'not-an-ip']) {
      expect(verifyIpAgainstManifest(ip, payload)).toEqual({ verified: false, manifest: null })
    }
    // Same manifest, an address it does not contain: a real rejection, so the
    // provenance is real too.
    expect(verifyIpAgainstManifest('198.51.100.7', payload)).toEqual({
      verified: false,
      manifest: {
        id: `${payload._source}#${payload.creationTime}#sha256:${ipRangeManifestContentHash(payload)}`,
        source: payload._source,
        version: payload.creationTime,
      },
    })
  })

  it('keys stale publisher versions by canonical prefix content', () => {
    const base = {
      _source: 'https://example.com/bots.json',
      creationTime: 'stale-version',
    }
    const first = {
      ...base,
      prefixes: [
        { ipv4Prefix: '192.0.2.99/24' },
        { ipv6Prefix: '2001:DB8::1/32' },
      ],
    }
    const reorderedEquivalent = {
      ...base,
      prefixes: [
        { ipv6Prefix: '2001:0db8:0000:0000:0000:0000:0000:0000/32' },
        { ipv4Prefix: '192.0.2.0/24' },
      ],
    }
    const changed = {
      ...base,
      prefixes: [
        { ipv4Prefix: '198.51.100.0/24' },
        { ipv6Prefix: '2001:db8::/32' },
      ],
    }

    // A parseable address, so a comparison actually runs and the decision
    // carries provenance. Whether it matches is irrelevant here; this test is
    // about manifest IDENTITY across publisher versions.
    const firstManifest = verifyIpAgainstManifest('192.0.2.1', first).manifest
    const equivalentManifest = verifyIpAgainstManifest('192.0.2.1', reorderedEquivalent).manifest
    const changedManifest = verifyIpAgainstManifest('192.0.2.1', changed).manifest

    expect(firstManifest).toMatchObject({ source: base._source, version: base.creationTime })
    expect(firstManifest?.id).toMatch(/#sha256:[0-9a-f]{64}$/)
    expect(equivalentManifest?.id).toBe(firstManifest?.id)
    expect(changedManifest?.id).not.toBe(firstManifest?.id)
  })
})

describe('ipInCidr', () => {
  const cidr24 = parseCidr('66.249.66.0/24')!
  const cidr6 = parseCidr('2001:4860:4801::/48')!

  it('matches IPs inside the IPv4 network', () => {
    expect(ipInCidr('66.249.66.1', cidr24)).toBe(true)
    expect(ipInCidr('66.249.66.255', cidr24)).toBe(true)
    expect(ipInCidr('66.249.66.0', cidr24)).toBe(true)
  })

  it('rejects IPs outside the IPv4 network', () => {
    expect(ipInCidr('66.249.67.1', cidr24)).toBe(false)
    expect(ipInCidr('1.2.3.4', cidr24)).toBe(false)
  })

  it('matches IPs inside the IPv6 network', () => {
    expect(ipInCidr('2001:4860:4801::1', cidr6)).toBe(true)
    expect(ipInCidr('2001:4860:4801:ffff::', cidr6)).toBe(true)
  })

  it('rejects IPs outside the IPv6 network', () => {
    expect(ipInCidr('2001:4860:4802::1', cidr6)).toBe(false)
  })

  it('does not cross-match IPv4 against IPv6 CIDR (or vice versa)', () => {
    expect(ipInCidr('66.249.66.1', cidr6)).toBe(false)
    expect(ipInCidr('2001:4860:4801::1', cidr24)).toBe(false)
  })
})

describe('verifyIpForRule', () => {
  it('verifies a known Googlebot IPv4 inside a published prefix', () => {
    // 192.178.4.0/27 is in the bundled googlebot.json (one of many
    // crawler prefixes). Pick an IP inside that /27 to verify the
    // match path works end-to-end against real publisher data.
    expect(verifyIpForRule('192.178.4.5', 'googlebot')).toBe(true)
  })

  it('verifies a known bingbot IPv4 inside a published prefix', () => {
    // 157.55.39.0/24 is in the bundled bingbot.json.
    expect(verifyIpForRule('157.55.39.10', 'bingbot')).toBe(true)
  })

  it('does not verify a random IP outside all Googlebot prefixes', () => {
    expect(verifyIpForRule('192.0.2.1', 'googlebot')).toBe(false)
    expect(verifyIpForRule('10.0.0.1', 'googlebot')).toBe(false)
  })

  it('verifies ClaudeBot IPv4 against Anthropic\'s official crawler manifest', () => {
    // The /22 remains on Anthropic's official list.
    expect(verifyIpForRule('216.73.216.76', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('216.73.217.125', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('216.73.219.255', 'anthropic-claudebot')).toBe(true)
    // These addresses exist only in the new publisher manifest, not the old
    // bundled ARIN allocation snapshot.
    expect(verifyIpForRule('34.162.230.222', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('40.124.101.49', 'anthropic-claudebot')).toBe(true)
    expect(verifyIpForRule('20.64.57.223', 'anthropic-claudebot')).toBe(true)
  })

  it('does not verify a random IP outside Anthropic prefixes', () => {
    expect(verifyIpForRule('1.2.3.4', 'anthropic-claudebot')).toBe(false)
    // Adjacent /22 outside the official manifest entry.
    expect(verifyIpForRule('216.73.220.1', 'anthropic-claudebot')).toBe(false)
    // The Claude Platform/API egress range is not in the crawler manifest.
    expect(verifyIpForRule('160.79.104.5', 'anthropic-claudebot')).toBe(false)
    expect(verifyIpForRule('160.79.111.254', 'anthropic-claudebot')).toBe(false)
    // The old ARIN-derived bundle also included this IPv6 allocation, but
    // Anthropic's official crawler manifest currently publishes IPv4 only.
    expect(verifyIpForRule('2607:6bc0::1', 'anthropic-claudebot')).toBe(false)
    // A historical AS-based source attributed this Mitel prefix to Anthropic.
    expect(verifyIpForRule('209.249.57.10', 'anthropic-claudebot')).toBe(false)
  })

  it('verifies Claude-User against the shared official Anthropic manifest', () => {
    // The publisher does not split ranges by Claude bot identity, so the same
    // official manifest is keyed to both classifier rules.
    expect(verifyIpForRule('216.73.216.76', 'claude-user')).toBe(true)
    expect(verifyIpForRule('34.162.230.222', 'claude-user')).toBe(true)
    expect(verifyIpForRule('160.79.104.5', 'claude-user')).toBe(false)
    expect(verifyIpForRule('2607:6bc0::1', 'claude-user')).toBe(false)
    // Outside Anthropic's allocation — stays unverified.
    expect(verifyIpForRule('1.2.3.4', 'claude-user')).toBe(false)
  })

  it('returns the exact vendored manifest with verified and rejected decisions', () => {
    expect(verifyIpForRuleDecision('34.162.230.222', 'anthropic-claudebot')).toEqual({
      verified: true,
      manifest: ANTHROPIC_MANIFEST,
    })
    expect(verifyIpForRuleDecision('160.79.104.5', 'anthropic-claudebot')).toEqual({
      verified: false,
      manifest: ANTHROPIC_MANIFEST,
    })
    // No address to check. Previously this returned ANTHROPIC_MANIFEST, making
    // it indistinguishable from the rejection above — a Vercel source, which
    // never carries a client IP, would have recorded every ClaudeBot hit as
    // "Anthropic's manifest checked this and rejected it".
    expect(verifyIpForRuleDecision(null, 'anthropic-claudebot')).toEqual({
      verified: false,
      manifest: null,
    })
    // A rule with no published ranges: also nothing consulted.
    expect(verifyIpForRuleDecision('1.2.3.4', 'meta-externalagent')).toEqual({
      verified: false,
      manifest: null,
    })
  })

  it('verifies Google-Agent against Google\'s user-triggered-agents ranges', () => {
    // user-triggered-agents.json is Google's agentic-fetcher list; the
    // google-agent rule maps to it.
    expect(verifyIpForRule('136.122.0.10', 'google-agent')).toBe(true)    // 136.122.0.0/16
    expect(verifyIpForRule('136.121.16.5', 'google-agent')).toBe(true)    // 136.121.16.0/24
    expect(verifyIpForRule('2001:4860:c::5', 'google-agent')).toBe(true)  // IPv6 2001:4860:c::/124
    // Outside every published prefix — stays unverified.
    expect(verifyIpForRule('1.2.3.4', 'google-agent')).toBe(false)
  })

  it.each([
    ['openai-adsbot', oaiAdsbotRaw],
    ['openai-chatgpt-connector', chatgptConnectorsRaw],
    ['parallel-shapbot', parallelShapbotRaw],
    ['applebot', applebotRaw],
    ['ccbot', ccbotRaw],
    ['duckduckbot', duckduckbotRaw],
    ['duckassistbot', duckassistbotRaw],
    ['mistral-ai-user', mistralAiUserRaw],
    ['mistral-ai-index', mistralAiIndexRaw],
    ['amazonbot', amazonbotRaw],
    ['amzn-searchbot', amznSearchbotRaw],
    ['amzn-user', amznUserRaw],
    ['google-gemini-notebook', googleUserFetchersRaw],
    ['google-cloudvertexbot', googlebotRaw],
  ] as const)('verifies %s against its official vendored manifest', (ruleId, raw) => {
    expect(verifyIpForRule(firstPublishedIp(raw), ruleId)).toBe(true)
  })

  it('returns false for a rule id without published ranges', () => {
    // Meta doesn't publish a public ranges file. The
    // meta-externalagent rule has no entry in RULE_ID_TO_RANGES, so
    // verification always returns false (caller stays
    // claimed_unverified).
    expect(verifyIpForRule('1.2.3.4', 'meta-externalagent')).toBe(false)
  })

  it('returns false for null / empty / malformed IP', () => {
    expect(verifyIpForRule(null, 'googlebot')).toBe(false)
    expect(verifyIpForRule(undefined, 'googlebot')).toBe(false)
    expect(verifyIpForRule('', 'googlebot')).toBe(false)
    expect(verifyIpForRule('not-an-ip', 'googlebot')).toBe(false)
  })

  it('handles IPv6 verification (Googlebot publishes both)', () => {
    // 2001:4860:4801:10::/64 is in the bundled googlebot.json.
    expect(verifyIpForRule('2001:4860:4801:10::1', 'googlebot')).toBe(true)
    // 2001:4860:4801:: (without the :10 in the 4th group) is OUTSIDE
    // every published /64 — the prefixes have specific 4th groups.
    expect(verifyIpForRule('2001:db8::1', 'googlebot')).toBe(false)
  })

  it('also verifies via the existing classifier path (UA + IP both match)', () => {
    // Tests in analysis.test.ts cover the full classifyCrawler path —
    // this duplicates the IP check at the raw layer for confidence.
    expect(verifyIpForRule('192.178.4.5', 'googlebot')).toBe(true)
  })
})

describe('hasVerificationDataFor', () => {
  it('is true for operators with bundled ranges', () => {
    expect(hasVerificationDataFor('googlebot')).toBe(true)
    expect(hasVerificationDataFor('bingbot')).toBe(true)
    expect(hasVerificationDataFor('openai-gptbot')).toBe(true)
    expect(hasVerificationDataFor('openai-chatgpt-user')).toBe(true)
    expect(hasVerificationDataFor('openai-searchbot')).toBe(true)
    expect(hasVerificationDataFor('openai-adsbot')).toBe(true)
    expect(hasVerificationDataFor('perplexity-bot')).toBe(true)
    expect(hasVerificationDataFor('perplexity-user')).toBe(true)
    expect(hasVerificationDataFor('anthropic-claudebot')).toBe(true)
    expect(hasVerificationDataFor('claude-user')).toBe(true)
    expect(hasVerificationDataFor('google-agent')).toBe(true)
    expect(hasVerificationDataFor('google-gemini-notebook')).toBe(true)
    expect(hasVerificationDataFor('google-cloudvertexbot')).toBe(true)
    expect(hasVerificationDataFor('parallel-shapbot')).toBe(true)
    expect(hasVerificationDataFor('applebot')).toBe(true)
    expect(hasVerificationDataFor('ccbot')).toBe(true)
    expect(hasVerificationDataFor('duckduckbot')).toBe(true)
    expect(hasVerificationDataFor('duckassistbot')).toBe(true)
    expect(hasVerificationDataFor('mistral-ai-user')).toBe(true)
    expect(hasVerificationDataFor('mistral-ai-index')).toBe(true)
    expect(hasVerificationDataFor('amazonbot')).toBe(true)
    expect(hasVerificationDataFor('amzn-searchbot')).toBe(true)
    expect(hasVerificationDataFor('amzn-user')).toBe(true)
  })

  it('is false for operators without bundled ranges yet', () => {
    // OpenAI assigns chatgpt-agents.json to Codex cloud service egress, not
    // ChatGPT browser identity, so it must never verify a crawler rule.
    expect(hasVerificationDataFor('openai-chatgpt-agent')).toBe(false)
    expect(hasVerificationDataFor('parallel-shap-user')).toBe(false)
    expect(hasVerificationDataFor('mistral-ai-training')).toBe(false)
    expect(hasVerificationDataFor('mistral-bot')).toBe(false)
    expect(hasVerificationDataFor('deepseek')).toBe(false)
    expect(hasVerificationDataFor('bytespider')).toBe(false)
    expect(hasVerificationDataFor('meta-externalagent')).toBe(false)
    expect(hasVerificationDataFor('you-youbot')).toBe(false)
  })

  it('is false for unknown rule ids', () => {
    expect(hasVerificationDataFor('not-a-real-bot')).toBe(false)
    expect(hasVerificationDataFor('')).toBe(false)
  })
})
