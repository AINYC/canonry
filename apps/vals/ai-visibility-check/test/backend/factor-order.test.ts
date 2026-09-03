import {
  type CheckRecord,
  checkFingerprint,
  type FactorSample,
  type SiteHealthSample,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.1.0/storage'
import { callMcpTool } from '../../src/mcp/tools.ts'
import { compareFactorRank, orderFactors } from '../../src/site-health/factor-order.ts'
import { toCanonryDemoViewModel } from '../../src/ui/from-check-record.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function same(actual: readonly string[], expected: readonly string[], message = 'order differs'): void {
  if (actual.join(' | ') !== expected.join(' | ')) {
    throw new Error(`${message}:\n  got      ${actual.join(' | ')}\n  expected ${expected.join(' | ')}`)
  }
}

/**
 * The audit rollup as the engine returns it: alphabetical, which is what made
 * the page read as a list of names instead of a ranking. Scores are the ones
 * from the reported check.
 */
const ROLLUP: ReadonlyArray<{ name: string; score: number; count: number }> = [
  { name: 'AI Access Files (llms.txt, sitemap)', score: 100, count: 5 },
  { name: 'AI Crawler Access', score: 100, count: 5 },
  { name: 'Citations & Authority Signals', score: 65, count: 5 },
  { name: 'Content Depth', score: 85, count: 5 },
  { name: 'Content Extractability', score: 60, count: 5 },
  { name: 'Content Freshness', score: 100, count: 5 },
  { name: 'Definition Blocks', score: 28, count: 5 },
  { name: 'E-E-A-T Signals', score: 80, count: 5 },
  { name: 'Entity Consistency', score: 70, count: 5 },
  { name: 'FAQ Content', score: 67, count: 5 },
  { name: 'Named Entities', score: 100, count: 5 },
  { name: 'Schema Completeness', score: 100, count: 5 },
  { name: 'Schema Validity', score: 100, count: 5 },
  { name: 'Snippet Eligibility', score: 100, count: 5 },
]

const RANKED = [
  'AI Access Files (llms.txt, sitemap)',
  'AI Crawler Access',
  'Content Freshness',
  'Named Entities',
  'Schema Completeness',
  'Schema Validity',
  'Snippet Eligibility',
  'Content Depth',
  'E-E-A-T Signals',
  'Entity Consistency',
  'FAQ Content',
  'Citations & Authority Signals',
  'Content Extractability',
  'Definition Blocks',
]

function id(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function siteHealth(
  rollup: ReadonlyArray<{ name: string; score: number; count: number }> = ROLLUP,
): SiteHealthSample {
  const pageFactors: FactorSample[] = rollup.map((factor) => ({
    id: id(factor.name),
    name: factor.name,
    score: factor.score,
    // A rollup count of zero means no sampled page produced the factor. Mark it
    // inapplicable on the page too, so the view model reaches that state the
    // same way a real crawl would.
    applicable: factor.count > 0,
    findings: [],
    recommendations: [],
  }))
  return {
    schemaVersion: '1',
    label: '5-page Technical AEO sample',
    domain: 'example.com',
    rootUrl: 'https://example.com/',
    finalRootUrl: 'https://example.com/',
    status: 'complete',
    score: 82,
    pagesDiscovered: 5,
    pagesFetched: 5,
    pagesObserved: 5,
    elapsedMs: 4_200,
    terminationReason: null,
    warnings: [],
    siteMap: null,
    attemptedHosts: ['example.com'],
    error: null,
    factors: rollup.map((factor) => ({
      id: id(factor.name),
      name: factor.name,
      averageScore: factor.score,
      count: factor.count,
    })),
    pages: [{
      url: 'https://example.com/',
      status: 'success',
      score: 82,
      depth: 0,
      indexability: 'indexable',
      factors: pageFactors,
      criticalDefects: [],
      error: null,
    }],
  }
}

function record(sample: SiteHealthSample = siteHealth()): CheckRecord {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    fingerprint: checkFingerprint('example.com'),
    userQueries: [],
    domain: 'example.com',
    status: 'complete',
    createdAt: '2026-09-01T11:00:00.000Z',
    updatedAt: '2026-09-01T11:00:30.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-01T11:00:30.000Z',
      errors: [],
      visibility: null,
      siteHealth: sample,
    },
  } as CheckRecord
}

Deno.test('factors are ranked best to worst, not listed alphabetically', () => {
  const model = toCanonryDemoViewModel(record())
  assert(model.siteHealth, 'expected a site health section')
  same(model.siteHealth.factors.map((factor) => factor.label), RANKED)
})

Deno.test('equal scores break by name, so the same audit always draws the same list', () => {
  const first = toCanonryDemoViewModel(record()).siteHealth?.factors.map((f) => f.label) ?? []
  // Feed the rollup in reverse: ordering must come from the scores, never from
  // the order the engine happened to emit.
  const reversed = toCanonryDemoViewModel(record(siteHealth([...ROLLUP].reverse()))).siteHealth?.factors
    .map((f) => f.label) ?? []
  same(reversed, first, 'input order must not change the ranking')
  same(first.slice(0, 7), RANKED.slice(0, 7), 'the seven 100s stay alphabetical among themselves')
})

Deno.test('an unmeasured factor sorts last, never as a zero', () => {
  // "Not applicable to the sampled page types" is the absence of a measurement.
  // Ranking it below the worst real score would claim it is worse than the
  // worst thing found, which is a claim the sample cannot support.
  const rollup = [
    { name: 'Definition Blocks', score: 28, count: 5 },
    { name: 'Product Schema', score: 0, count: 0 },
    { name: 'Content Depth', score: 85, count: 5 },
  ]
  const model = toCanonryDemoViewModel(record(siteHealth(rollup)))
  assert(model.siteHealth, 'expected a site health section')
  same(model.siteHealth.factors.map((factor) => factor.label), [
    'Content Depth',
    'Definition Blocks',
    'Product Schema',
  ])
  const last = model.siteHealth.factors[2]
  equal(last?.score, null, 'an unmeasured factor carries no score')
  equal(last?.state, 'not-applicable')
})

Deno.test('the MCP payload is ranked in the same order the page shows', async () => {
  // Two renderings of one audit. If they disagree about which factor is doing
  // best, an agent reading the endpoint and a person reading the page reach
  // different conclusions from the same crawl.
  const stored = record()
  const store = new MemoryCheckStore()
  store.checks.set(stored.id, stored)

  const result = await callMcpTool({ store, now: () => new Date('2026-09-01T12:00:00.000Z') }, 'get_site_health', {
    checkId: stored.id,
  })
  assert(result && !result.isError, 'expected a site health payload')
  const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
    factors: Array<{ name: string }>
  }
  same(payload.factors.map((factor) => factor.name), RANKED)
})

Deno.test('sorting never reorders the stored array in place', () => {
  const stored = siteHealth()
  const before = stored.factors.map((factor) => factor.name)
  orderFactors(stored.factors, (factor) => ({ score: factor.averageScore, label: factor.name }))
  same(stored.factors.map((factor) => factor.name), before, 'the record must be left alone')
})

Deno.test('the comparator treats a non-finite score as unmeasured', () => {
  // A NaN average has reached the rollup before. Sorted as a number it lands
  // wherever the engine's sort happens to leave it; treated as unmeasured it
  // lands at the end, which is the only honest place for it.
  const ranked = orderFactors(
    [
      { label: 'broken', score: Number.NaN },
      { label: 'weak', score: 12 },
    ],
    (item) => item,
  )
  same(ranked.map((item) => item.label), ['weak', 'broken'])
  equal(compareFactorRank({ score: null, label: 'a' }, { score: null, label: 'b' }) < 0, true)
})
