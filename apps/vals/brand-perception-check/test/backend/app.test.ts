import type { ValTownConfig } from 'npm:@canonry/val-kit@0.2.0/config'
import {
  checkFingerprint,
  createRequestBoundDispatcher,
  type JobDispatcher,
  newCheckRecord,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
  PUBLIC_RATE_LIMITED_ERROR_CODE,
} from 'npm:@canonry/val-kit@0.2.0/jobs'
import type { PerceptionProbePort, PerceptionReport } from 'npm:@canonry/val-kit@0.2.0/perception'
import { LocalBypassHumanVerifier, UnavailableHumanVerifier } from 'npm:@canonry/val-kit@0.2.0/security'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.2.0/storage'
import { createValTownApp } from '../../src/app/app.ts'
import { createPerceptionCheckRunner } from '../../src/jobs/perception-check.ts'
import { CHECK_FINGERPRINT_NAMESPACE, type PerceptionCheckResult } from '../../src/runtime/check-result.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function includes(value: string, expected: string, message = 'expected substring'): void {
  if (!value.includes(expected)) throw new Error(`${message}: ${expected}`)
}

function fakePerception(): PerceptionProbePort {
  return {
    probe(): Promise<PerceptionReport> {
      return Promise.resolve({
        schemaVersion: '1',
        domain: 'example.com',
        brandNames: ['Example'],
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        summary: {
          successfulChecks: 1,
          failedChecks: 1,
          verdicts: { recommends: 1, cautions: 0, mixed: 0, none: 0 },
          concerns: [{ phrase: 'Support can be slow', answers: 1 }],
          sourceTypes: {
            measuredAnswers: 1,
            unattributedAnswers: 0,
            totalAppearances: 1,
            entries: [{ type: 'community', answers: 1, share: 1 }],
          },
        },
        evidence: [
          {
            query: 'is Example legit?',
            provider: 'gemini',
            requestedModel: 'model',
            servedModel: 'model',
            completedAt: '2026-01-01T00:00:01.000Z',
            answerText: 'Example is well regarded. Support can be slow.',
            verdict: 'recommends',
            evidenceSentences: ['Example is well regarded.'],
            concerns: ['Support can be slow'],
            sources: [{
              url: 'https://www.reddit.com/r/example',
              domain: 'reddit.com',
              title: 'Thread',
              type: 'community',
            }],
            searchQueries: ['Example reviews'],
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: 'Example complaints',
            provider: 'gemini',
            requestedModel: 'model',
            servedModel: null,
            completedAt: '2026-01-01T00:00:01.000Z',
            answerText: null,
            verdict: null,
            evidenceSentences: [],
            concerns: [],
            sources: [],
            searchQueries: [],
            retrievalStatus: 'error',
            error: 'Provider unavailable',
          },
        ],
        // This deliberately extra field ensures the host's selective serializer
        // never stores raw payloads.
        rawProviderResponse: { secret: 'must-not-persist' },
      } as PerceptionReport)
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
    perception?: PerceptionProbePort | null
    dispatcher?: JobDispatcher
    now?: () => Date
  } = {},
) {
  const store = new MemoryCheckStore<PerceptionCheckResult>()
  await store.initialize()
  const runtimeConfig = config(options.runtimeConfig)
  const runner = createPerceptionCheckRunner({
    store,
    perceptionProbe: options.perception === undefined ? fakePerception() : options.perception,
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
    ...newCheckRecord<PerceptionCheckResult>({
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
    perception: { probe: () => Promise.reject(new Error('provider unavailable')) },
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
      result: { perception: { evidence: Array<Record<string, unknown>> } }
    }
  }
  equal(body.check.fingerprint, undefined)
  equal(body.check.leaseOwner, undefined)
  equal(body.check.result.perception.evidence[0]?.rawProviderResponse, undefined)
  // A failed answer stays unmeasured. It is never coerced into "took no
  // position", which is a finding about the answer rather than about the check.
  equal(body.check.result.perception.evidence[1]?.verdict, null)
  equal(body.check.result.perception.evidence[1]?.error, 'This answer-engine check was unavailable.')
  const stored = await store.get(body.check.id)
  equal((stored?.result?.perception as unknown as { rawProviderResponse?: unknown }).rawProviderResponse, undefined)
})

Deno.test('the branded questions a caller supplies are part of the reuse key', async () => {
  // Two callers asking different things about one brand measure different
  // things, so the second must never be handed the first's answers.
  const { app } = await createTestApp()
  const submit = (queries: string[]) =>
    app.fetch(
      new Request('https://val.test/api/checks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.55' },
        body: JSON.stringify({ domain: 'example.com', queries }),
      }),
    )
  const first = await (await submit(['is Example legit?'])).json() as { check: { id: string } }
  const second = await (await submit(['what are the complaints about Example?'])).json() as {
    check: { id: string }
    reused: boolean
  }
  equal(second.reused, false, 'different questions must not reuse a cached check')
  equal(second.check.id === first.check.id, false)
})

Deno.test('a stale running record is reclaimed and dispatched when the domain is resubmitted', async () => {
  const { app, store } = await createTestApp()
  const stale = {
    ...newCheckRecord<PerceptionCheckResult>({
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
  equal(body.check.status, 'partial', 'one measured answer and one failure is a partial result')
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

Deno.test('raw provider errors are replaced with controlled public messages', async () => {
  const rawProviderError = 'provider credential=should-never-reach-a-browser'
  const { app } = await createTestApp({
    perception: { probe: () => Promise.reject(new Error(rawProviderError)) },
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
  if (body.includes(rawProviderError)) throw new Error('raw execution details reached the public response')
  includes(body, 'The brand perception check could not complete.')
})

Deno.test('a deployment with no answer engine says it is not configured', async () => {
  const { app } = await createTestApp({ perception: null })
  const response = await app.fetch(
    new Request('https://val.test/api/checks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.44' },
      body: JSON.stringify({ domain: 'example.com' }),
    }),
  )
  includes(await response.text(), 'The brand perception check is not configured for this demo.')
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
    ...newCheckRecord<PerceptionCheckResult>({
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
  // No inline script and no inline style, which is why the page's toggles are
  // radios and CSS and the donut-free tables carry their own classes.
  includes(policy, "script-src 'self'", 'the page must never allow inline script')
  // The font is third-party by necessity: Val Town cannot host the woff2.
  includes(policy, "style-src 'self' https://cdn.jsdelivr.net", 'the font stylesheet origin must stay allowed')
  includes(policy, 'font-src https://cdn.jsdelivr.net', 'the font file origin must stay allowed')
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

Deno.test('the health endpoint answers so a deploy can verify itself', async () => {
  const { app } = await createTestApp()
  const response = await app.fetch(new Request('https://val.test/healthz'))
  equal(response.status, 200)
  equal((await response.json() as { ok: boolean }).ok, true)
})
