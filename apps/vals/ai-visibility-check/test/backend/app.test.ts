import type { ValTownConfig } from 'npm:@canonry/val-kit@0.1.0/config'
import {
  checkFingerprint,
  createRequestBoundDispatcher,
  type JobDispatcher,
  newCheckRecord,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
  PUBLIC_RATE_LIMITED_ERROR_CODE,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import { LocalBypassHumanVerifier, UnavailableHumanVerifier } from 'npm:@canonry/val-kit@0.1.0/security'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.1.0/storage'
import type { VisibilityProbePort, VisibilityReport } from 'npm:@canonry/val-kit@0.1.0/visibility'
import { createValTownApp } from '../../src/app/app.ts'
import { createPublicCheckRunner } from '../../src/jobs/public-check.ts'
import { CHECK_FINGERPRINT_NAMESPACE, type CheckResult } from '../../src/runtime/check-result.ts'
import type { SiteHealthRunner, SiteHealthSample } from '../../src/site-health/types.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function includes(value: string, expected: string, message = 'expected substring'): void {
  if (!value.includes(expected)) throw new Error(`${message}: ${expected}`)
}

function fakeVisibility(): VisibilityProbePort {
  return {
    probe(): Promise<VisibilityReport> {
      return Promise.resolve({
        schemaVersion: '1',
        domain: 'example.com',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        summary: { successfulChecks: 2, failedChecks: 1, mentionRate: 0.5, citationRate: 0.5 },
        evidence: [
          {
            query: 'example service',
            provider: 'gemini',
            requestedModel: 'model',
            servedModel: 'model',
            completedAt: '2026-01-01T00:00:01.000Z',
            answerText: 'Example is useful.',
            mentioned: true,
            matchedTerms: ['Example'],
            cited: true,
            citedDomains: ['example.com'],
            citedUrls: ['https://example.com/'],
            matchedCitationDomains: ['example.com'],
            matchedCitationUrls: ['https://example.com/'],
            sources: [{ url: 'https://example.com/', title: 'Example' }],
            searchQueries: ['example service'],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: 'unavailable service',
            provider: 'gemini',
            requestedModel: 'model',
            servedModel: null,
            completedAt: '2026-01-01T00:00:01.000Z',
            answerText: null,
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
            error: 'Provider unavailable',
          },
        ],
        // This deliberately extra field ensures the host's selective serializer never stores raw payloads.
        rawProviderResponse: { secret: 'must-not-persist' },
      } as VisibilityReport)
    },
  }
}

function fakeSiteHealth(): SiteHealthRunner {
  return {
    run() {
      return Promise.resolve({
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        status: 'complete',
        score: 80,
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        elapsedMs: 1,
        terminationReason: null,
        warnings: [],
        factors: [],
        pages: [],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error: null,
      })
    },
  }
}

function failedSiteHealth(error: string): SiteHealthRunner {
  return {
    run(): Promise<SiteHealthSample> {
      return Promise.resolve({
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: null,
        status: 'error',
        score: null,
        pagesDiscovered: 0,
        pagesFetched: 0,
        pagesObserved: 0,
        elapsedMs: 1,
        terminationReason: null,
        warnings: [],
        factors: [],
        pages: [],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error,
      })
    },
  }
}

function config(overrides: Partial<ValTownConfig> = {}): ValTownConfig {
  return {
    environment: 'test',
    checkTtlMs: 86_400_000,
    perClientDailyLimit: 3,
    globalDailyLimit: 100,
    quotaSalt: 'test-salt',
    humanVerifier: new LocalBypassHumanVerifier(),
    turnstileSiteKey: null,
    humanVerificationStatus: 'not-required',
    geminiApiKey: null,
    geminiModel: null,
    publicChecksEnabled: true,
    publicChecksUnavailableMessage: null,
    mcpStartChecksEnabled: true,
    mcpPerClientDailyLimit: 2,
    ...overrides,
  }
}

async function createTestApp(
  options: {
    runtimeConfig?: Partial<ValTownConfig>
    visibility?: VisibilityProbePort | null
    siteHealth?: SiteHealthRunner
    dispatcher?: JobDispatcher
    now?: () => Date
  } = {},
) {
  const store = new MemoryCheckStore<CheckResult>()
  await store.initialize()
  const runtimeConfig = config(options.runtimeConfig)
  const runner = createPublicCheckRunner({
    store,
    visibilityProbe: options.visibility === undefined ? fakeVisibility() : options.visibility,
    siteHealthRunner: options.siteHealth ?? fakeSiteHealth(),
    ttlMs: runtimeConfig.checkTtlMs,
    now: options.now,
  })
  return {
    store,
    app: createValTownApp({
      store,
      config: runtimeConfig,
      dispatcher: options.dispatcher ?? createRequestBoundDispatcher(runner),
      renderPage: (record) =>
        `<html><body data-error-code="${record?.errorCode ?? ''}">${
          record?.errorMessage ?? record?.domain ?? 'demo'
        }</body></html>`,
      assets: { styles: 'body{}', script: '', mark: '', glyph: '' },
      now: options.now,
    }),
  }
}

Deno.test('expired public results are no longer readable by their check ID', async () => {
  const { app, store } = await createTestApp({ now: () => new Date('2026-09-02T00:00:00.000Z') })
  const expired = {
    ...newCheckRecord<CheckResult>({
      id: 'f0f0f0f0-0000-4000-8000-000000000099',
      fingerprint: checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, 'expired.example'),
      userQueries: [],
      domain: 'expired.example',
      now: new Date('2026-08-31T00:00:00.000Z'),
    }),
    status: 'complete' as const,
    expiresAt: '2026-09-01T00:00:00.000Z',
  }
  await store.create(expired)

  const apiResponse = await app.fetch(new Request(`https://val.test/api/checks/${expired.id}`))
  equal(apiResponse.status, 404)
  const pageResponse = await app.fetch(new Request(`https://val.test/?check=${expired.id}`))
  equal(await pageResponse.text(), '<html><body data-error-code="">demo</body></html>')
})

Deno.test('failed public results receive a TTL and expire from their public check URL', async () => {
  let clock = new Date('2026-09-01T12:00:00.000Z')
  const { app, store } = await createTestApp({
    now: () => clock,
    runtimeConfig: { checkTtlMs: 1_000 },
    visibility: { probe: () => Promise.reject(new Error('provider unavailable')) },
    siteHealth: { run: () => Promise.reject(new Error('crawler unavailable')) },
  })
  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.31' },
      body: JSON.stringify({ domain: 'failed.example' }),
    }),
  )
  const body = await response.json() as { check: { id: string; status: string; expiresAt: string | null } }
  equal(response.status, 200)
  equal(body.check.status, 'failed')
  equal(body.check.expiresAt, '2026-09-01T12:00:01.000Z')
  equal((await store.get(body.check.id))?.expiresAt, body.check.expiresAt)
  equal(
    await store.findReusable(checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, 'failed.example'), clock.toISOString()),
    null,
  )

  clock = new Date('2026-09-01T12:00:01.001Z')
  const expired = await app.fetch(new Request(`https://val.test/api/checks/${body.check.id}`))
  equal(expired.status, 404)
})

Deno.test('public API stores clipped normalized evidence, never its raw provider payload', async () => {
  const { app, store } = await createTestApp()
  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' },
      body: JSON.stringify({ domain: 'example.com' }),
    }),
  )
  equal(response.status, 200)
  const body = await response.json() as {
    check: {
      id: string
      fingerprint?: string
      leaseOwner?: string
      result: { visibility: { evidence: Array<Record<string, unknown>> } }
    }
  }
  equal(body.check.fingerprint, undefined)
  equal(body.check.leaseOwner, undefined)
  equal(body.check.result.visibility.evidence[0]?.rawProviderResponse, undefined)
  equal(body.check.result.visibility.evidence[1]?.mentioned, null)
  equal(body.check.result.visibility.evidence[1]?.error, 'This answer-engine check was unavailable.')
  const stored = await store.get(body.check.id)
  equal((stored?.result?.visibility as unknown as { rawProviderResponse?: unknown }).rawProviderResponse, undefined)
})

Deno.test('a stale running record is reclaimed and dispatched when the domain is resubmitted', async () => {
  const { app, store } = await createTestApp()
  const stale = {
    ...newCheckRecord<CheckResult>({
      id: 'f0f0f0f0-0000-4000-8000-000000000001',
      fingerprint: checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, 'example.com'),
      userQueries: [],
      domain: 'example.com',
      now: new Date('2026-09-01T11:00:00.000Z'),
    }),
    status: 'running' as const,
    leaseOwner: 'crashed-isolate',
    leaseUntil: '2026-09-01T11:00:01.000Z',
  }
  await store.create(stale)

  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.23' },
      body: JSON.stringify({ domain: 'example.com' }),
    }),
  )
  equal(response.status, 200)
  const body = await response.json() as { check: { id: string; status: string }; reused: boolean }
  equal(body.reused, true)
  equal(body.check.id, stale.id)
  equal(body.check.status, 'complete')
  equal(store.quota.size, 0)
})

Deno.test('client-controlled x-forwarded-for does not create separate quota identities', async () => {
  const { app } = await createTestApp({ runtimeConfig: { perClientDailyLimit: 1 } })
  const request = (domain: string, forwarded: string) =>
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded },
      body: JSON.stringify({ domain }),
    })
  equal((await app.fetch(request('example.com', '198.51.100.1'))).status, 200)
  equal((await app.fetch(request('example.org', '198.51.100.2'))).status, 429)
})

Deno.test('raw crawler and provider errors are replaced with controlled public messages', async () => {
  const rawProviderError = 'provider credential=should-never-reach-a-browser'
  const rawCrawlerError = 'crawler internal address=should-never-reach-a-browser'
  const { app } = await createTestApp({
    visibility: { probe: () => Promise.reject(new Error(rawProviderError)) },
    siteHealth: { run: () => Promise.reject(new Error(rawCrawlerError)) },
  })
  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.24' },
      body: JSON.stringify({ domain: 'example.com' }),
    }),
  )
  equal(response.status, 200)
  const body = await response.text()
  if (body.includes(rawProviderError) || body.includes(rawCrawlerError)) {
    throw new Error('raw execution details reached the public response')
  }
  includes(body, 'The AI Visibility sample could not complete.')
  includes(body, 'The Technical AEO sample could not complete.')
})

Deno.test('preserves only allowlisted fulfilled Site Health errors', async () => {
  const timeout = 'The Technical AEO sample timed out.'
  const noPublicPages = 'No public pages could be audited in the Technical AEO sample.'
  const generic = 'The Technical AEO sample could not complete.'
  const rawCrawlerError = 'crawl transport=https://10.0.0.7/ credential=must-not-persist'

  const cases: ReadonlyArray<readonly [input: string, expected: string]> = [
    [timeout, timeout],
    [noPublicPages, noPublicPages],
    [generic, generic],
    [rawCrawlerError, generic],
  ]

  for (const [input, expected] of cases) {
    const { app } = await createTestApp({ siteHealth: failedSiteHealth(input) })
    const response = await app.fetch(
      new Request('https://val.test/api/checks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.43' },
        body: JSON.stringify({ domain: 'example.com' }),
      }),
    )
    equal(response.status, 200)

    const serialized = await response.text()
    if (serialized.includes(rawCrawlerError)) {
      throw new Error('raw fulfilled crawler detail reached the public response')
    }
    const body = JSON.parse(serialized) as {
      check: {
        result: {
          siteHealth: { error: string | null }
          errors: Array<{ area: string; message: string }>
        }
      }
    }
    equal(body.check.result.siteHealth.error, expected)
    equal(body.check.result.errors.find((error) => error.area === 'site-health')?.message, expected)
  }
})

Deno.test('a cached check does not consume another quota slot and is marked reused', async () => {
  const clock = new Date('2026-09-01T12:00:00.000Z')
  const { app, store } = await createTestApp({
    runtimeConfig: { perClientDailyLimit: 1 },
    now: () => clock,
  })
  const request = () =>
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.21' },
      body: JSON.stringify({ domain: 'example.com' }),
    })
  const first = await app.fetch(request())
  const firstBody = await first.json() as { check: { id: string } }
  equal(
    await store.claimGlobalLease(
      PUBLIC_CHECK_EXECUTION_LEASE_NAME,
      'other-isolate',
      clock.toISOString(),
      new Date(clock.getTime() + 60_000).toISOString(),
    ),
    true,
  )
  const second = await app.fetch(request())
  equal(second.status, 200)
  const secondBody = await second.json() as { check: { id: string }; reused: boolean }
  equal(secondBody.reused, true)
  equal(secondBody.check.id, firstBody.check.id)
  equal(store.quota.size, 2)
  await store.releaseGlobalLease(PUBLIC_CHECK_EXECUTION_LEASE_NAME, 'other-isolate')
})

Deno.test('an active same-domain check remains reusable while another domain holds capacity', async () => {
  const clock = new Date('2026-09-01T12:00:00.000Z')
  const { app, store } = await createTestApp({ now: () => clock })
  const active = {
    ...newCheckRecord<CheckResult>({
      id: 'f0f0f0f0-0000-4000-8000-000000000077',
      fingerprint: checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, 'active.example'),
      userQueries: [],
      domain: 'active.example',
      now: clock,
    }),
    status: 'running' as const,
    leaseOwner: 'in-flight-isolate',
    leaseUntil: new Date(clock.getTime() + 60_000).toISOString(),
  }
  await store.create(active)
  equal(
    await store.claimGlobalLease(
      PUBLIC_CHECK_EXECUTION_LEASE_NAME,
      'other-isolate',
      clock.toISOString(),
      new Date(clock.getTime() + 60_000).toISOString(),
    ),
    true,
  )

  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.22' },
      body: JSON.stringify({ domain: 'active.example' }),
    }),
  )
  equal(response.status, 202)
  const body = await response.json() as { check: { id: string; status: string }; reused: boolean }
  equal(body.reused, true)
  equal(body.check.id, active.id)
  equal(body.check.status, 'running')
  equal(store.quota.size, 0)
  await store.releaseGlobalLease(PUBLIC_CHECK_EXECUTION_LEASE_NAME, 'other-isolate')
})

Deno.test('a quota rejection releases its pre-admission execution reservation', async () => {
  const clock = new Date('2026-09-01T12:00:00.000Z')
  const { app, store } = await createTestApp({
    runtimeConfig: { perClientDailyLimit: 0 },
    now: () => clock,
  })
  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.26' },
      body: JSON.stringify({ domain: 'quota.example' }),
    }),
  )
  equal(response.status, 429)
  equal(store.checks.size, 0)
  equal(store.quota.size, 0)
  equal(
    await store.claimGlobalLease(
      PUBLIC_CHECK_EXECUTION_LEASE_NAME,
      'next-isolate',
      clock.toISOString(),
      new Date(clock.getTime() + 60_000).toISOString(),
    ),
    true,
  )
})

Deno.test('API rejects oversized bodies and production verification fails closed', async () => {
  const first = await createTestApp()
  const tooLarge = await first.app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'a'.repeat(5_000) }),
    }),
  )
  equal(tooLarge.status, 413)

  const second = await createTestApp({
    runtimeConfig: {
      environment: 'production',
      humanVerifier: new UnavailableHumanVerifier(),
      humanVerificationStatus: 'unavailable',
    },
  })
  const unavailable = await second.app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    }),
  )
  equal(unavailable.status, 503)
})

Deno.test('native form failures return a readable HTML state instead of API JSON', async () => {
  const { app } = await createTestApp()
  const response = await app.fetch(
    new Request('https://val.test/check', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'domain=localhost',
    }),
  )
  equal(response.status, 400)
  const body = await response.text()
  includes(body, 'Private and local hosts cannot be checked.')
  if (body.includes('"error"')) throw new Error('form error leaked an API JSON response')
})

Deno.test('native quota failures carry the controlled rate-limit presentation code', async () => {
  const { app } = await createTestApp({ runtimeConfig: { perClientDailyLimit: 1 } })
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.20' }
  await app.fetch(new Request('https://val.test/check', { method: 'POST', headers, body: 'domain=first.example' }))
  const response = await app.fetch(
    new Request('https://val.test/check', { method: 'POST', headers, body: 'domain=second.example' }),
  )

  equal(response.status, 429)
  includes(await response.text(), `data-error-code="${PUBLIC_RATE_LIMITED_ERROR_CODE}"`)
})

Deno.test('a disabled public-check capability also removes unused Turnstile CSP permissions', async () => {
  const { app } = await createTestApp({
    runtimeConfig: {
      publicChecksEnabled: false,
      humanVerificationStatus: 'ready',
      turnstileSiteKey: 'test-site-key',
    },
  })

  const response = await app.fetch(new Request('https://val.test/'))
  const policy = response.headers.get('content-security-policy') ?? ''
  if (policy.includes('challenges.cloudflare.com')) {
    throw new Error('disabled public checks must not retain Turnstile CSP permissions')
  }
  // The font is third-party by necessity: Val Town cannot host the woff2.
  if (!policy.includes("style-src 'self' https://cdn.jsdelivr.net")) {
    throw new Error('the font stylesheet origin must stay allowed')
  }
  if (!policy.includes('font-src https://cdn.jsdelivr.net')) {
    throw new Error('the font file origin must stay allowed')
  }
})

Deno.test('a held execution lease rejects a new check before quota or row admission, then releases cleanly', async () => {
  const clock = new Date('2026-09-01T12:00:00.000Z')
  const { app, store } = await createTestApp({ now: () => clock })
  const holder = 'other-isolate'
  equal(
    await store.claimGlobalLease(
      PUBLIC_CHECK_EXECUTION_LEASE_NAME,
      holder,
      clock.toISOString(),
      new Date(clock.getTime() + 60_000).toISOString(),
    ),
    true,
  )

  const response = await app.fetch(
    new Request('https://val.test/check', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.25' },
      body: 'domain=capacity.example',
    }),
  )
  equal(response.status, 503)
  const body = await response.text()
  includes(body, 'The public check is at capacity. Try again shortly.')
  if (body.includes('"error"')) throw new Error('form capacity error leaked an API JSON response')
  equal(store.checks.size, 0)
  equal(store.quota.size, 0)

  await store.releaseGlobalLease(PUBLIC_CHECK_EXECUTION_LEASE_NAME, holder)
  const recovered = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.25' },
      body: JSON.stringify({ domain: 'capacity.example' }),
    }),
  )
  equal(recovered.status, 200)
  equal(store.checks.size, 1)
  equal(store.quota.size, 2)
})
