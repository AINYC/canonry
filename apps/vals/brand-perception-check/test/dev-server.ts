/**
 * Local dev server for exercising the Val by hand.
 *
 * It lives under `test/` because `.vtignore` excludes that directory, so this
 * file is never pushed to Val Town.
 *
 * Storage is in-memory rather than Val Town SQLite, which needs val.town
 * credentials to reach. Human verification is bypassed, so `POST /check` works
 * without a Turnstile widget.
 *
 * With no `GEMINI_API_KEY`, a check runs against a stub perception runner so the
 * whole UI and MCP surface is exercisable offline; the answers are obviously
 * fake. Export a real key to run the actual planner, probes, and verdict pass.
 *
 *   deno task dev            # stub, no network
 *   GEMINI_API_KEY=… deno task dev
 */
import { loadValTownConfig } from 'npm:@canonry/val-kit@0.2.0/config'
import { createRequestBoundDispatcher } from 'npm:@canonry/val-kit@0.2.0/jobs'
import {
  createGeminiValPerceptionProbe,
  type PerceptionEvidence,
  type PerceptionProbePort,
  type PerceptionReport,
  summarizePerception,
} from 'npm:@canonry/val-kit@0.2.0/perception'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.2.0/storage'
import { createValTownApp } from '../src/app/app.ts'
import { createPerceptionCheckRunner } from '../src/jobs/perception-check.ts'
import type { PerceptionCheckResult } from '../src/runtime/check-result.ts'
import {
  brandPerceptionClientScript,
  brandPerceptionStyles,
  canonryGlyph,
  canonryMark,
  createPublicCheckForm,
  emptyLandingViewModel,
  renderBrandPerception,
  toBrandPerceptionViewModel,
} from '../src/ui/index.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8788)
const geminiApiKey = Deno.env.get('GEMINI_API_KEY')?.trim() || null
/** A stub returns instantly, which makes the waiting state impossible to see. */
const CHECK_DELAY_MS = Number(Deno.env.get('CHECK_DELAY_MS') ?? 0)
const stall = () => CHECK_DELAY_MS > 0 ? new Promise((r) => setTimeout(r, CHECK_DELAY_MS)) : Promise.resolve()

const config = loadValTownConfig({
  ...Deno.env.toObject(),
  VAL_TOWN_ENV: 'development',
  ALLOW_INSECURE_LOCAL_HUMAN_BYPASS: '1',
})

/**
 * An offline stand-in for the perception instrument.
 *
 * The summary is computed by the REAL `summarizePerception`, so the stub cannot
 * hand the page a headline the rows do not support — which is the one thing a
 * fixture must never be allowed to do here.
 */
function stubPerception(): PerceptionProbePort {
  return {
    async probe({ domain }): Promise<PerceptionReport> {
      await stall()
      const at = new Date().toISOString()
      const brand = domain.replace(/^www\./i, '').split('.')[0] ?? domain
      const row = (over: Partial<PerceptionEvidence> & Pick<PerceptionEvidence, 'query'>): PerceptionEvidence => ({
        provider: 'stub',
        requestedModel: 'stub',
        servedModel: 'stub',
        completedAt: at,
        answerText: 'STUB ANSWER — no provider was called. Set GEMINI_API_KEY for real results.',
        verdict: 'none',
        evidenceSentences: [],
        concerns: [],
        sources: [],
        searchQueries: [brand],
        retrievalStatus: 'grounded',
        error: null,
        ...over,
      })
      const evidence: PerceptionEvidence[] = [
        row({
          query: `STUB: is ${brand} legit?`,
          answerText: `STUB ANSWER. ${brand} is widely used and reviewers rate it well. Support can be slow.`,
          verdict: 'recommends',
          evidenceSentences: [`${brand} is widely used and reviewers rate it well.`],
          concerns: ['Support can be slow'],
          sources: [
            { url: 'https://www.reddit.com/r/stub', domain: 'reddit.com', title: 'Stub thread', type: 'community' },
            { url: 'https://www.trustpilot.com/stub', domain: 'trustpilot.com', title: 'Stub reviews', type: 'review' },
          ],
        }),
        row({
          query: `STUB: what are the complaints about ${brand}?`,
          answerText: `STUB ANSWER. Opinions on ${brand} are split. Support can be slow and pricing is opaque.`,
          verdict: 'mixed',
          evidenceSentences: [`Opinions on ${brand} are split.`],
          concerns: ['Support can be slow', 'pricing is opaque'],
          sources: [{ url: `https://${domain}/`, domain, title: 'Stub official page', type: 'official' }],
        }),
        // A deliberate unmeasured row, so the null-is-not-'none' contract is
        // visible in every hand test.
        row({
          query: `STUB: ${brand} vs alternatives`,
          answerText: null,
          verdict: null,
          searchQueries: [],
          retrievalStatus: 'error',
          error: 'The provider rate-limited this request.',
        }),
      ]
      return {
        schemaVersion: '1',
        domain,
        brandNames: [brand],
        startedAt: at,
        completedAt: at,
        summary: summarizePerception(evidence),
        evidence,
      }
    },
  }
}

const store = new MemoryCheckStore<PerceptionCheckResult>()
await store.initialize()

const runner = createPerceptionCheckRunner({
  store,
  perceptionProbe: geminiApiKey ? createGeminiValPerceptionProbe({ apiKey: geminiApiKey }) : stubPerception(),
  ttlMs: config.checkTtlMs,
})

const form = createPublicCheckForm(config)
const app = createValTownApp({
  store,
  config,
  dispatcher: createRequestBoundDispatcher(runner),
  renderPage: (record) =>
    record
      ? renderBrandPerception(toBrandPerceptionViewModel(record, { form, title: 'Brand Perception Check (dev)' }))
      : renderBrandPerception(emptyLandingViewModel(form)),
  assets: {
    styles: brandPerceptionStyles,
    script: brandPerceptionClientScript,
    mark: canonryMark,
    glyph: canonryGlyph,
  },
})

console.error(`brand perception dev server  http://localhost:${PORT}`)
console.error(`  UI   http://localhost:${PORT}/`)
console.error(`  MCP  http://localhost:${PORT}/mcp`)
console.error(geminiApiKey ? '  runner: REAL (Gemini)' : '  runner: STUB (set GEMINI_API_KEY for real)')

Deno.serve({ port: PORT }, app.fetch)
