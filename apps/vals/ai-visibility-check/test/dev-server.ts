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
 * With no `GEMINI_API_KEY`, `start_check` runs against stub runners so the
 * whole MCP surface is exercisable offline; the answers are obviously fake.
 * Export a real key to run the actual Gemini planner, probes, and crawl.
 *
 *   deno task dev            # stubs, no network
 *   GEMINI_API_KEY=… deno task dev
 */
import { loadValTownConfig } from 'npm:@canonry/val-kit@0.1.0/config'
import { createRequestBoundDispatcher } from 'npm:@canonry/val-kit@0.1.0/jobs'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.1.0/storage'
import {
  createGeminiValVisibilityProbe,
  type VisibilityProbePort,
  type VisibilityReport,
} from 'npm:@canonry/val-kit@0.1.0/visibility'
import { createValTownApp } from '../src/app/app.ts'
import { createPublicCheckRunner } from '../src/jobs/public-check.ts'
import type { CheckResult } from '../src/runtime/check-result.ts'
import { createSiteHealthRunner } from '../src/site-health/runner.ts'
import type { SiteHealthRunner, SiteHealthSample } from '../src/site-health/types.ts'
import {
  canonryDemoClientScript,
  canonryDemoStyles,
  canonryGlyph,
  canonryMark,
  createPublicCheckForm,
  emptyLandingViewModel,
  renderCanonryDemo,
  toCanonryDemoViewModel,
} from '../src/ui/index.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8787)
const geminiApiKey = Deno.env.get('GEMINI_API_KEY')?.trim() || null
/** Stubs return instantly, which makes the waiting state impossible to see. */
const CHECK_DELAY_MS = Number(Deno.env.get('CHECK_DELAY_MS') ?? 0)
const stall = () => CHECK_DELAY_MS > 0 ? new Promise((r) => setTimeout(r, CHECK_DELAY_MS)) : Promise.resolve()

const config = loadValTownConfig({
  ...Deno.env.toObject(),
  VAL_TOWN_ENV: 'development',
  ALLOW_INSECURE_LOCAL_HUMAN_BYPASS: '1',
})

function stubVisibility(): VisibilityProbePort {
  return {
    async probe({ domain }): Promise<VisibilityReport> {
      await stall()
      const at = new Date().toISOString()
      return ({
        schemaVersion: '1',
        domain,
        startedAt: at,
        completedAt: at,
        summary: { successfulChecks: 2, failedChecks: 1, mentionRate: 0.5, citationRate: 0.5 },
        evidence: [
          {
            query: `STUB: what is ${domain}`,
            provider: 'stub',
            requestedModel: 'stub',
            servedModel: 'stub',
            completedAt: at,
            answerText: `STUB ANSWER — no provider was called. Set GEMINI_API_KEY for real results.`,
            mentioned: true,
            matchedTerms: [domain],
            cited: false,
            citedDomains: ['wikipedia.org', 'reddit.com', 'g2.com'],
            citedUrls: ['https://wikipedia.org/', 'https://reddit.com/', 'https://g2.com/'],
            matchedCitationDomains: [],
            matchedCitationUrls: [],
            sources: [{ url: 'https://example.org/', title: 'Stub source' }],
            searchQueries: [domain],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: `STUB: ${domain} alternatives`,
            provider: 'stub',
            requestedModel: 'stub',
            servedModel: 'stub',
            completedAt: at,
            answerText: 'STUB ANSWER.',
            mentioned: false,
            matchedTerms: [],
            cited: true,
            citedDomains: [domain, 'wikipedia.org', 'competitor.example'],
            citedUrls: [`https://${domain}/`, 'https://wikipedia.org/', 'https://competitor.example/'],
            matchedCitationDomains: [domain],
            matchedCitationUrls: [`https://${domain}/`],
            sources: [{ url: `https://${domain}/`, title: 'Stub' }],
            searchQueries: [domain],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: `STUB: is ${domain} any good`,
            provider: 'stub',
            requestedModel: 'stub',
            servedModel: null,
            completedAt: at,
            answerText: null,
            // A deliberate failed row, so the null-not-false contract is
            // visible in every hand test.
            mentioned: null,
            matchedTerms: [],
            cited: null,
            citedDomains: [],
            citedUrls: [],
            matchedCitationDomains: [],
            matchedCitationUrls: [],
            sources: [],
            searchQueries: [],
            namedBrands: null,
            retrievalStatus: 'error',
            error: 'stub failure',
          },
        ],
      })
    },
  }
}

function stubSiteHealth(): SiteHealthRunner {
  return {
    run(domain): Promise<SiteHealthSample> {
      return Promise.resolve({
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain,
        rootUrl: `https://${domain}/`,
        finalRootUrl: `https://${domain}/`,
        status: 'complete',
        score: 64,
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        elapsedMs: 1,
        terminationReason: null,
        warnings: ['STUB — no crawl was performed.'],
        siteMap: {
          totalPages: 14,
          totalEdges: 31,
          truncated: true,
          nodes: [
            {
              key: `https://${domain}/`,
              url: `https://${domain}/`,
              label: domain,
              depth: 0,
              crawled: true,
              score: 82,
              indexable: true,
              inboundLinks: 6,
              outboundLinks: 5,
            },
            {
              key: `https://${domain}/pricing`,
              url: `https://${domain}/pricing`,
              label: '/pricing',
              depth: 1,
              crawled: true,
              score: 64,
              indexable: true,
              inboundLinks: 4,
              outboundLinks: 2,
            },
            {
              key: `https://${domain}/blog`,
              url: `https://${domain}/blog`,
              label: '/blog',
              depth: 1,
              crawled: true,
              score: 41,
              indexable: true,
              inboundLinks: 3,
              outboundLinks: 3,
            },
            {
              key: `https://${domain}/about`,
              url: `https://${domain}/about`,
              label: '/about',
              depth: 1,
              crawled: true,
              score: 71,
              indexable: true,
              inboundLinks: 2,
              outboundLinks: 1,
            },
            {
              key: `https://${domain}/legacy`,
              url: `https://${domain}/legacy`,
              label: '/legacy',
              depth: 2,
              crawled: true,
              score: 33,
              indexable: false,
              inboundLinks: 1,
              outboundLinks: 0,
            },
            ...['/docs', '/careers', '/contact', '/blog/one', '/blog/two', '/changelog'].map((path, index) => ({
              key: `https://${domain}${path}`,
              url: `https://${domain}${path}`,
              label: path,
              depth: 2,
              crawled: false,
              score: null,
              indexable: null,
              inboundLinks: 3 - (index % 3),
              outboundLinks: 0,
            })),
          ],
          edges: [
            { from: `https://${domain}/`, to: `https://${domain}/pricing`, followable: true },
            { from: `https://${domain}/`, to: `https://${domain}/blog`, followable: true },
            { from: `https://${domain}/`, to: `https://${domain}/about`, followable: true },
            { from: `https://${domain}/`, to: `https://${domain}/docs`, followable: true },
            { from: `https://${domain}/`, to: `https://${domain}/contact`, followable: false },
            { from: `https://${domain}/pricing`, to: `https://${domain}/contact`, followable: true },
            { from: `https://${domain}/blog`, to: `https://${domain}/blog/one`, followable: true },
            { from: `https://${domain}/blog`, to: `https://${domain}/blog/two`, followable: true },
            { from: `https://${domain}/blog`, to: `https://${domain}/changelog`, followable: true },
            { from: `https://${domain}/about`, to: `https://${domain}/careers`, followable: true },
            { from: `https://${domain}/pricing`, to: `https://${domain}/legacy`, followable: false },
          ],
        },
        attemptedHosts: [domain],
        error: null,
        factors: [{ id: 'answerability', name: 'Answerability', averageScore: 64, count: 1 }],
        pages: [{
          url: `https://${domain}/`,
          status: 'success',
          score: 64,
          depth: 0,
          indexability: 'indexable',
          factors: [{
            id: 'answerability',
            name: 'Answerability',
            score: 64,
            applicable: true,
            findings: [{ code: 'stub', message: 'Stub finding.' }],
            recommendations: ['Set GEMINI_API_KEY and use the real runners.'],
          }],
          criticalDefects: [],
          error: null,
        }],
      })
    },
  }
}

const store = new MemoryCheckStore<CheckResult>()
await store.initialize()

const runner = createPublicCheckRunner({
  store,
  visibilityProbe: geminiApiKey ? createGeminiValVisibilityProbe({ apiKey: geminiApiKey }) : stubVisibility(),
  siteHealthRunner: geminiApiKey ? createSiteHealthRunner() : stubSiteHealth(),
  ttlMs: config.checkTtlMs,
})

const form = createPublicCheckForm(config)
const app = createValTownApp({
  store,
  config,
  dispatcher: createRequestBoundDispatcher(runner),
  renderPage: (record) =>
    record
      ? renderCanonryDemo(toCanonryDemoViewModel(record, { form, title: 'AI Visibility Check (dev)' }))
      : renderCanonryDemo(emptyLandingViewModel(form)),
  assets: { styles: canonryDemoStyles, script: canonryDemoClientScript, mark: canonryMark, glyph: canonryGlyph },
})

console.error(`canonry dev server  http://localhost:${PORT}`)
console.error(`  UI   http://localhost:${PORT}/`)
console.error(`  MCP  http://localhost:${PORT}/mcp`)
console.error(geminiApiKey ? '  runners: REAL (Gemini + crawl)' : '  runners: STUB (set GEMINI_API_KEY for real)')

Deno.serve({ port: PORT }, app.fetch)
