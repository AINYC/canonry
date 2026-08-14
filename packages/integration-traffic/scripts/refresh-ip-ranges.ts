#!/usr/bin/env tsx
/**
 * Refreshes every bundled crawler IP-range JSON from its upstream
 * publisher. Run when an operator updates their list (typically
 * weekly cadence for the big ones — they add ranges as they spin up
 * new datacenter capacity).
 *
 * Usage (from repo root):
 *   pnpm --filter @ainyc/canonry-integration-traffic exec tsx scripts/refresh-ip-ranges.ts
 *
 * Or directly:
 *   tsx packages/integration-traffic/scripts/refresh-ip-ranges.ts
 *
 * Writes pretty-printed JSON so `git diff` shows exactly which
 * prefixes the operator added / removed. A partial failure still updates
 * the lists that succeeded, but exits nonzero so automation cannot silently
 * retain stale data. Prints a per-source summary to stderr.
 *
 * Other operators NOT covered here (no public JSON, no easily-scrape
 * source as of 2026): Meta, ByteDance, Apple, DeepSeek, Mistral,
 * DuckDuckGo, Yandex, Baidu, Amazon. Add them by editing both
 * `SOURCES` here AND `RULE_ID_TO_RANGES` in `src/ip-verify.ts`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateIpRangeManifestPayload } from '../src/ip-range-manifest.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rangesDir = path.resolve(dirname, '..', 'src', 'ip-ranges')

export interface Source {
  /** Filename under `src/ip-ranges/`. Must match the import in `ip-verify.ts`. */
  file: string
  /** Publisher URL — the operator's canonical JSON. */
  url: string
  /** Display label for the per-source progress line. */
  label: string
}

const SOURCES: Source[] = [
  {
    file: 'anthropic.json',
    url: 'https://claude.com/crawling/bots.json',
    label: 'Anthropic Bots',
  },
  {
    file: 'googlebot.json',
    url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
    label: 'Googlebot',
  },
  {
    file: 'bingbot.json',
    url: 'https://www.bing.com/toolbox/bingbot.json',
    label: 'bingbot',
  },
  {
    file: 'gptbot.json',
    url: 'https://openai.com/gptbot.json',
    label: 'OpenAI GPTBot',
  },
  {
    file: 'chatgpt-user.json',
    url: 'https://openai.com/chatgpt-user.json',
    label: 'OpenAI ChatGPT-User',
  },
  {
    file: 'oai-searchbot.json',
    url: 'https://openai.com/searchbot.json',
    label: 'OpenAI OAI-SearchBot',
  },
  {
    file: 'perplexitybot.json',
    url: 'https://www.perplexity.ai/perplexitybot.json',
    label: 'PerplexityBot',
  },
  {
    file: 'perplexity-user.json',
    url: 'https://www.perplexity.ai/perplexity-user.json',
    label: 'Perplexity-User',
  },
  {
    file: 'google-user-triggered-agents.json',
    url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json',
    label: 'Google-Agent (user-triggered)',
  },
]

export interface FetchResult {
  source: Source
  ok: boolean
  prefixCount?: number
  error?: string
}

async function refreshOne(source: Source): Promise<FetchResult> {
  try {
    const res = await fetch(source.url, {
      headers: {
        // Some publishers (Bing) return a 403 to unidentified clients.
        // A vanilla `curl`-style UA gets through reliably.
        'User-Agent': 'canonry-ip-range-refresher/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return { source, ok: false, error: `HTTP ${res.status}` }
    }
    const validation = validateIpRangeManifestPayload(await res.json())
    if (!validation.ok) return { source, ok: false, error: validation.error }
    // Inject `_source` at the top of the file so anyone opening the
    // JSON directly sees where it came from. Re-injected on every
    // refresh because publishers strip unknown fields from their
    // payload — we don't want to lose this trail.
    const annotated = { _source: source.url, ...validation.value }
    const target = path.join(rangesDir, source.file)
    await fs.writeFile(target, JSON.stringify(annotated, null, 2) + '\n', 'utf-8')
    return { source, ok: true, prefixCount: validation.value.prefixes.length }
  } catch (err) {
    return {
      source,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function runRefresh(
  sources: readonly Source[] = SOURCES,
  refresh: (source: Source) => Promise<FetchResult> = refreshOne,
  write: (message: string) => unknown = message => process.stderr.write(message),
): Promise<number> {
  write(`Refreshing ${sources.length} crawler IP-range files in ${rangesDir}\n\n`)
  // Run in parallel — publishers are independent and the script is
  // bounded by request latency, not local CPU.
  const results = await Promise.all(sources.map(refresh))
  let ok = 0
  let failed = 0
  for (const r of results) {
    if (r.ok) {
      ok++
      write(`  ✓ ${r.source.label.padEnd(24)} ${r.source.file}  (${r.prefixCount} prefixes)\n`)
    } else {
      failed++
      write(`  ✗ ${r.source.label.padEnd(24)} ${r.source.file}  ${r.error}\n`)
    }
  }
  write(`\nDone. ${ok} updated, ${failed} failed.\n`)
  if (failed > 0) {
    write(`Failed sources kept their previous JSON — re-run when reachable.\n`)
  }
  return failed > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRefresh()
}
