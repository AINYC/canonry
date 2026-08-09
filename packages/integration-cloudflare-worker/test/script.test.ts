import { AI_ENGINE_DOMAINS } from '@ainyc/canonry-contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BOT_LIST,
  generateWorkerScript,
  generateWranglerToml,
} from '../src/script.js'

const BASE_OPTS = {
  sourceId: 'src_abc123',
  ingestUrl: 'https://canonry.example.com/api/v1/projects/foo/traffic/cloudflare/ingest',
  bearerToken: 'tok_secret_value',
  hmacSecret: 'hmac_secret_value',
  workerVersion: '1.0.0',
  botList: DEFAULT_BOT_LIST,
}

interface GeneratedRequest {
  url: string
  headers: { get(name: string): string | null }
  cf: null
}

function generatedShouldForward(): (request: GeneratedRequest) => boolean {
  const generated = generateWorkerScript(BASE_OPTS)
  const scope: { shouldForward?: (request: GeneratedRequest) => boolean } = {}
  const exposePredicate = new Function(
    'globalThis',
    'addEventListener',
    `${generated}\nglobalThis.shouldForward = shouldForward`,
  )
  exposePredicate(scope, () => undefined)
  return scope.shouldForward!
}

function request(url: string, referer?: string): GeneratedRequest {
  const headers = new Map<string, string>()
  headers.set('user-agent', 'Mozilla/5.0')
  if (referer) headers.set('referer', referer)
  return {
    url,
    headers: { get: name => headers.get(name.toLowerCase()) ?? null },
    cf: null,
  }
}

async function runGeneratedWorker(ingestStatuses: number[]): Promise<{
  ingestCalls: number
  warn: ReturnType<typeof vi.fn>
}> {
  let handler: ((event: {
    request: Request
    respondWith: (response: Promise<Response>) => void
    waitUntil: (task: Promise<unknown>) => void
  }) => void) | undefined
  const waitUntilTasks: Promise<unknown>[] = []
  const warn = vi.fn()
  let ingestCalls = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (typeof input !== 'string') return new Response('origin', { status: 200 })
    ingestCalls += 1
    return new Response('', { status: ingestStatuses.shift() ?? 200 })
  })
  const immediateTimeout = (callback: () => void): number => {
    callback()
    return 0
  }
  const register = (type: string, callback: typeof handler): void => {
    if (type === 'fetch') handler = callback
  }
  const evaluate = new Function('addEventListener', 'fetch', 'crypto', 'console', 'setTimeout', generateWorkerScript(BASE_OPTS))
  evaluate(register, fetchMock, globalThis.crypto, { warn }, immediateTimeout)

  const generatedRequest = new Request('https://example.com/?utm_source=chatgpt', {
    headers: { 'cf-ray': 'evt_retry_test', 'user-agent': 'Mozilla/5.0' },
  })
  Object.defineProperty(generatedRequest, 'cf', { value: null })
  let responsePromise: Promise<Response> | undefined
  handler!({
    request: generatedRequest,
    respondWith: (response) => { responsePromise = response },
    waitUntil: (task) => { waitUntilTasks.push(task) },
  })
  await responsePromise
  await Promise.all(waitUntilTasks)
  return { ingestCalls, warn }
}

describe('generateWorkerScript', () => {
  it('produces a non-empty JS string', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/addEventListener\s*\(\s*['"]fetch['"]/)
    expect(script.length).toBeGreaterThan(500)
  })

  it('embeds every required constant', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('src_abc123')
    expect(script).toContain('https://canonry.example.com/api/v1/projects/foo/traffic/cloudflare/ingest')
    expect(script).toContain('tok_secret_value')
    expect(script).toContain('hmac_secret_value')
    expect(script).toContain('1.0.0')
  })

  it('bakes in the bot UA keywords from the supplied bot list', () => {
    const script = generateWorkerScript(BASE_OPTS)
    for (const keyword of DEFAULT_BOT_LIST.uaKeywords) {
      expect(script).toContain(keyword)
    }
  })

  it('bakes in the canonical AI referrer domains from the supplied bot list', () => {
    const script = generateWorkerScript(BASE_OPTS)
    for (const domain of DEFAULT_BOT_LIST.refererDomains) {
      expect(script).toContain(domain)
    }
  })

  it('forwards every canonical AI referrer domain and its subdomains', () => {
    const shouldForward = generatedShouldForward()
    for (const domain of Object.values(AI_ENGINE_DOMAINS)) {
      expect(shouldForward(request('https://example.com/', `https://${domain}/answer`))).toBe(true)
      expect(shouldForward(request('https://example.com/', `https://chat.${domain}/answer`))).toBe(true)
    }
  })

  it('forwards AI utm_source evidence on the request or same-site referrer URL', () => {
    const shouldForward = generatedShouldForward()
    for (const domain of Object.values(AI_ENGINE_DOMAINS)) {
      const token = domain.split('.')[0]!
      expect(shouldForward(request(`https://example.com/?utm_source=${token}`))).toBe(true)
      expect(shouldForward(request(
        'https://example.com/app.js',
        `https://example.com/landing?utm_source=${domain}`,
      ))).toBe(true)
    }
  })

  it('does not treat unrelated host substrings or UTM sources as AI evidence', () => {
    const shouldForward = generatedShouldForward()
    expect(shouldForward(request('https://example.com/', 'https://mail.google.com/'))).toBe(false)
    expect(shouldForward(request('https://example.com/', 'https://snapchat.com/'))).toBe(false)
    expect(shouldForward(request('https://example.com/?utm_source=newsletter'))).toBe(false)
  })

  it('records the bot list version somewhere the operator (or doctor) can read it', () => {
    const script = generateWorkerScript({
      ...BASE_OPTS,
      botList: { ...DEFAULT_BOT_LIST, version: '2099-12-31' },
    })
    expect(script).toContain('2099-12-31')
  })

  it('uses event.waitUntil so the forward fetch never blocks the response', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/event\.waitUntil/)
  })

  it('forwards with the documented headers (Authorization, Timestamp, Signature, Version)', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('Authorization')
    expect(script).toContain('Bearer')
    expect(script).toContain('X-Canonry-Timestamp')
    expect(script).toContain('X-Canonry-Signature')
    expect(script).toContain('X-Canonry-Worker-Version')
  })

  it('signs with HMAC-SHA256 via Web Crypto SubtleCrypto', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('HMAC')
    expect(script).toContain('SHA-256')
    expect(script).toMatch(/crypto\.subtle/)
  })

  it('uses POST as the forward method', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/method\s*:\s*['"]POST['"]/)
  })

  it('retries transient ingest failures without blocking the origin response', async () => {
    const result = await runGeneratedWorker([503, 200])
    expect(result.ingestCalls).toBe(2)
    expect(result.warn).not.toHaveBeenCalled()
  })

  it('does not retry a permanent ingest rejection and logs no secrets', async () => {
    const result = await runGeneratedWorker([401])
    expect(result.ingestCalls).toBe(1)
    expect(result.warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(result.warn.mock.calls)).not.toContain(BASE_OPTS.bearerToken)
    expect(JSON.stringify(result.warn.mock.calls)).not.toContain(BASE_OPTS.hmacSecret)
  })

  it('parses as JavaScript (smoke test)', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(() => new Function(script)).not.toThrow()
  })

  it('treats a custom botScoreMaxForward as the score threshold', () => {
    const script = generateWorkerScript({ ...BASE_OPTS, botScoreMaxForward: 42 })
    expect(script).toContain('42')
  })
})

describe('DEFAULT_BOT_LIST', () => {
  it('includes the canonical AI UA tokens', () => {
    expect(DEFAULT_BOT_LIST.uaKeywords).toEqual(
      expect.arrayContaining(['bot', 'crawler', 'gpt', 'claude', 'perplexity', 'openai', 'anthropic']),
    )
  })

  it('includes the canonical AI referer hosts', () => {
    expect(DEFAULT_BOT_LIST.refererDomains).toEqual(expect.arrayContaining(Object.values(AI_ENGINE_DOMAINS)))
  })

  it('has a non-empty, dated version string so the staleness check can compare', () => {
    expect(DEFAULT_BOT_LIST.version).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('generateWranglerToml', () => {
  it('emits a name and a main field for wrangler deploy', () => {
    const toml = generateWranglerToml({ sourceId: 'src_abc123', hostname: 'example.com' })
    expect(toml).toMatch(/^name\s*=\s*"canonry-traffic-src_abc123"/m)
    expect(toml).toMatch(/^main\s*=/m)
  })

  it('sets compatibility_date to a recent ISO date', () => {
    const toml = generateWranglerToml({ sourceId: 'src_abc123', hostname: 'example.com' })
    expect(toml).toMatch(/compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/)
  })

  it('declares an exact zone route when zoneId is available', () => {
    const toml = generateWranglerToml({
      sourceId: 'src_abc123',
      hostname: 'www.example.com',
      zoneId: 'zone_123',
    })
    expect(toml).toContain('workers_dev = false')
    expect(toml).toContain('[[routes]]')
    expect(toml).toContain('pattern = "www.example.com/*"')
    expect(toml).toContain('zone_id = "zone_123"')
  })

  it('fails closed to dashboard-managed routing when zoneId is omitted', () => {
    const toml = generateWranglerToml({ sourceId: 'src_abc123', hostname: 'example.com' })
    expect(toml).toContain('workers_dev = false')
    expect(toml).not.toContain('[[routes]]')
    expect(toml).toContain('example.com/*')
    expect(toml).not.toContain('wrangler route add')
  })
})
