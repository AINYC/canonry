import { describe, expect, it, vi } from 'vitest'
import {
  ackCloudflareQueueMessages,
  CloudflareQueueApiError,
  pullCloudflareQueueMessages,
} from '../src/index.js'

const client = {
  accountId: 'account-1',
  queueId: 'queue-1',
  apiToken: 'queue-secret-token',
  apiBaseUrl: 'https://queue.example.test/client/v4',
}

function pullResponse(messages: unknown[] = [], backlog = 0): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    result: { message_backlog_count: backlog, messages },
  }), { headers: { 'content-type': 'application/json' } })
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp_ms: 1_700_000_000_000,
    attempts: 2,
    lease_id: 'lease-1',
    metadata: { 'CF-Content-Type': 'json', 'CF-sourceMessageSource': 'worker' },
    body: Buffer.from(JSON.stringify({ hello: 'queue' })).toString('base64'),
    ...overrides,
  }
}

describe('pullCloudflareQueueMessages', () => {
  it('pulls the documented endpoint and preserves queue lease metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([message()], 9))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl }, {
      batchSize: 50,
      visibilityTimeoutMs: 6_000,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://queue.example.test/client/v4/accounts/account-1/queues/queue-1/messages/pull',
    )
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer queue-secret-token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      batch_size: 50,
      visibility_timeout_ms: 6_000,
    })
    expect(result).toEqual({
      messageBacklogCount: 9,
      messages: [{
        id: 'message-1',
        timestampMs: 1_700_000_000_000,
        attempts: 2,
        leaseId: 'lease-1',
        metadata: { 'CF-Content-Type': 'json', 'CF-sourceMessageSource': 'worker' },
        contentType: 'json',
        body: { hello: 'queue' },
      }],
    })
  })

  it('decodes base64 json and bytes, and parses plain text JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([
      message(),
      message({ id: 'bytes', lease_id: 'lease-bytes', metadata: { 'CF-Content-Type': 'bytes' }, body: 'AAEC' }),
      message({ id: 'text', lease_id: 'lease-text', metadata: { 'CF-Content-Type': 'text' }, body: '{"plain":true}' }),
    ]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[1]).toMatchObject({ id: 'bytes', contentType: 'bytes', body: new Uint8Array([0, 1, 2]) })
    expect(result.messages[2]).toMatchObject({ id: 'text', contentType: 'text', body: { plain: true } })
  })

  it('defaults a missing content type to JSON, as Cloudflare documents', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([
      message({ metadata: {} }),
    ]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[0]).toMatchObject({ contentType: 'json', body: { hello: 'queue' } })
  })

  it.each([
    ['v8', message({ metadata: { 'CF-Content-Type': 'v8' } }), 'unsupported-content-type'],
    ['unknown content type', message({ metadata: { 'CF-Content-Type': 'yaml' } }), 'unsupported-content-type'],
    ['bad base64', message({ body: 'not base64!' }), 'malformed-body'],
    ['bad json', message({ body: Buffer.from('{').toString('base64') }), 'malformed-body'],
  ])('returns %s as safe poison while preserving its lease', async (_label, invalid, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([invalid]))

    const result = await pullCloudflareQueueMessages({ ...client, fetchImpl })

    expect(result.messages[0]).toEqual(expect.objectContaining({
      id: 'message-1',
      leaseId: 'lease-1',
      contentType: 'poison',
      reason,
    }))
    expect(result.messages[0]).not.toHaveProperty('body')
  })

  it('rejects a malformed base envelope that cannot be safely acknowledged', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse([{ not: 'a message' }]))

    const error = await pullCloudflareQueueMessages({ ...client, fetchImpl }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(CloudflareQueueApiError)
    expect((error as Error).message).not.toContain('queue-secret-token')
  })

  it('rejects malformed non-success envelopes deterministically', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: false, result: null })))

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl })).rejects.toMatchObject({
      name: 'CloudflareQueueApiError',
      status: 502,
    })
  })

  it('rejects a response above the documented 100-message batch maximum', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => message({
      id: `message-${index}`,
      lease_id: `lease-${index}`,
    }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse(messages, 1))

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl })).rejects.toMatchObject({
      name: 'CloudflareQueueApiError',
      status: 502,
    })
  })

  it('retries 429 using Retry-After without leaking response text', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('token=queue-secret-token', {
        status: 429,
        headers: { 'retry-after': '3' },
      }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(3_000)
  })

  it('caps an excessive Retry-After so bounded retries cannot outlive a source lease', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'retry-after': '3600' },
      }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep })

    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('retries 5xx responses with the bounded exponential delay', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream detail', { status: 503 }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep, retryBaseDelayMs: 7 })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(7)
  })

  it('caps an oversized configured exponential backoff', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, sleep, retryBaseDelayMs: 60_000 })

    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('does not retry permanent 4xx responses and reports no upstream body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('queue-secret-token', { status: 403 }))

    const error = await pullCloudflareQueueMessages({ ...client, fetchImpl }).catch((err: unknown) => err)

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(error).toMatchObject({ status: 403 })
    expect((error as Error).message).not.toContain('queue-secret-token')
  })

  it('passes a timeout signal to injected fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pullResponse())

    await pullCloudflareQueueMessages({ ...client, fetchImpl, timeoutMs: 123 })

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects a visibility timeout beyond Cloudflare\'s documented 12-hour maximum', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl }, {
      visibilityTimeoutMs: 43_200_001,
    })).rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not retry an aborted request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'))

    await expect(pullCloudflareQueueMessages({ ...client, fetchImpl })).rejects.toMatchObject({ status: 408 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('redacts non-abort transport errors before they leave the client', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('Authorization: Bearer queue-secret-token; upstream body'),
    )

    const error = await pullCloudflareQueueMessages({
      ...client,
      fetchImpl,
      maxRetries: 0,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'CloudflareQueueApiError', status: 503 })
    expect((error as Error).message).toBe('Cloudflare Queue request failed')
    expect((error as Error).message).not.toContain('queue-secret-token')
  })
})

describe('ackCloudflareQueueMessages', () => {
  it('groups acknowledgements and retries with delay_seconds', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, result: null })))

    const result = await ackCloudflareQueueMessages({ ...client, fetchImpl }, {
      acks: ['lease-1', 'lease-2'],
      retries: [{ leaseId: 'lease-3', delaySeconds: 600 }],
    })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://queue.example.test/client/v4/accounts/account-1/queues/queue-1/messages/ack',
    )
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      acks: [{ lease_id: 'lease-1' }, { lease_id: 'lease-2' }],
      retries: [{ lease_id: 'lease-3', delay_seconds: 600 }],
    })
    expect(result).toEqual({
      acknowledgedLeaseIds: ['lease-1', 'lease-2'],
      retriedLeaseIds: [{ leaseId: 'lease-3', delaySeconds: 600 }],
    })
  })

  it('requires at least one acknowledgement or retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(ackCloudflareQueueMessages({ ...client, fetchImpl }, {})).rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
