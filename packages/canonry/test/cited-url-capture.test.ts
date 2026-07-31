import { expect, test, vi } from 'vitest'
import { captureCitedUrls, resolveVertexGroundingRedirect } from '../src/cited-url-capture.js'

const vertex = (suffix: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${suffix}`
const source = (uri: string) => ({ uri, title: uri })

test('resolver uses manual redirect and never fetches an arbitrary destination', async () => {
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual')
    expect(String(input)).toBe(vertex('one'))
    return new Response(null, { status: 302, headers: { location: 'https://publisher.example/posts/a#frag' } })
  })

  await expect(resolveVertexGroundingRedirect(vertex('one'), { fetchImpl })).resolves.toBe('https://publisher.example/posts/a')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('resolver only follows bounded exact-host Vertex hops and rejects lookalikes', async () => {
  const fetchImpl = vi.fn(async (input: string | URL) => {
    if (String(input) === vertex('one')) {
      return new Response(null, { status: 302, headers: { location: vertex('two') } })
    }
    return new Response(null, { status: 302, headers: { location: 'https://publisher.example/final' } })
  })
  await expect(resolveVertexGroundingRedirect(vertex('one'), { fetchImpl })).resolves.toBe('https://publisher.example/final')
  expect(fetchImpl).toHaveBeenCalledTimes(2)

  await expect(resolveVertexGroundingRedirect(
    'https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/one',
    { fetchImpl },
  )).resolves.toBeUndefined()
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

test('resolver rejects non-redirect, missing-location, and non-http locations', async () => {
  for (const response of [
    new Response(null, { status: 200 }),
    new Response(null, { status: 302 }),
    new Response(null, { status: 302, headers: { location: 'mailto:ops@example.com' } }),
  ]) {
    const fetchImpl = vi.fn(async () => response)
    await expect(resolveVertexGroundingRedirect(vertex('invalid'), { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  }
})

test('a Vertex lookalike is captured as a direct URL and never fetched', async () => {
  const lookalike = 'https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/direct#fragment'
  const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://should-not-fetch.example/' } }))

  await expect(captureCitedUrls('gemini', [source(lookalike)], { fetchImpl })).resolves.toEqual({
    citedUrls: ['https://vertexaisearch.cloud.google.com.evil.test/grounding-api-redirect/direct'],
    captureStatus: 'complete', sourceCount: 1, resolvedCount: 1, captureVersion: 1,
  })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('capture is bounded, fails open per URL, and reports partial/all-failed outcomes', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl = vi.fn(async (input: string | URL) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight--
    const url = String(input)
    if (url.endsWith('/bad')) throw new Error('network failure')
    return new Response(null, { status: 302, headers: { location: `https://publisher.example/${url.split('/').at(-1)}` } })
  })

  const partial = await captureCitedUrls('gemini', [source(vertex('ok')), source(vertex('bad'))], { fetchImpl })
  expect(partial).toMatchObject({ citedUrls: ['https://publisher.example/ok'], captureStatus: 'partial', sourceCount: 2, resolvedCount: 1, captureVersion: 1 })

  const failed = await captureCitedUrls('gemini', [source(vertex('bad'))], { fetchImpl })
  expect(failed).toMatchObject({ citedUrls: [], captureStatus: 'failed', sourceCount: 1, resolvedCount: 0, captureVersion: 1 })

  await captureCitedUrls('gemini', Array.from({ length: 8 }, (_, i) => source(vertex(String(i)))), { fetchImpl })
  expect(maxInFlight).toBeLessThanOrEqual(5)
})

test('capture reports complete direct and zero cases, preserves counts before dedupe, and fails closed for unsupported providers', async () => {
  await expect(captureCitedUrls('claude', [
    source('https://publisher.example/guides/claude#one'),
    source('https://publisher.example/guides/claude#two'),
  ])).resolves.toEqual({
    citedUrls: ['https://publisher.example/guides/claude'],
    captureStatus: 'complete', sourceCount: 2, resolvedCount: 2, captureVersion: 1,
  })

  await expect(captureCitedUrls('openai', [])).resolves.toEqual({
    citedUrls: [], captureStatus: 'complete', sourceCount: 0, resolvedCount: 0, captureVersion: 1,
  })

  await expect(captureCitedUrls('local', [source('https://publisher.example/a')])).resolves.toEqual({
    citedUrls: null, captureStatus: 'unsupported', sourceCount: 1, resolvedCount: 0, captureVersion: 1,
  })
  await expect(captureCitedUrls('future-adapter', [source('https://publisher.example/a')])).resolves.toMatchObject({ captureStatus: 'unsupported' })
})

test('counts raw grounding sources while completing over capture-eligible candidates', async () => {
  await expect(captureCitedUrls('openai', [
    source('https://chatgpt.com/share/only-provider-self-link'),
  ])).resolves.toEqual({
    citedUrls: [], captureStatus: 'complete', sourceCount: 1, resolvedCount: 0, captureVersion: 1,
  })

  await expect(captureCitedUrls('openai', [])).resolves.toEqual({
    citedUrls: [], captureStatus: 'complete', sourceCount: 0, resolvedCount: 0, captureVersion: 1,
  })
})

test('a timeout fails open without changing the capture result shape', async () => {
  const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  await expect(captureCitedUrls('gemini', [source(vertex('slow'))], { fetchImpl, timeoutMs: 1 })).resolves.toEqual({
    citedUrls: [], captureStatus: 'failed', sourceCount: 1, resolvedCount: 0, captureVersion: 1,
  })
})
