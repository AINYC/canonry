import { test, expect, vi } from 'vitest'

import { claudeAdapter } from '../src/adapter.js'

// Claude answers stable-knowledge queries from training data unless steered, and
// Sonnet 5 does so far more readily than Sonnet 4.6. Unsearched answers land in
// the store as zero citations and zero mentions, indistinguishable from a real
// absence, so the retrieval instruction is load-bearing for measurement validity
// rather than cosmetic. See the note on RETRIEVAL_SYSTEM_PROMPT in normalize.ts.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'claude' as const, apiKey: 'k', model: 'claude-sonnet-5', quotaPolicy }
const QUERY = { query: 'commercial roof restoration', canonicalDomains: ['example.com'], competitorDomains: [] }

/** Stub the Messages API and capture the request body the SDK sent. */
function captureRequest(body: Record<string, unknown>): () => Record<string, unknown> {
  let sent: Record<string, unknown> = {}
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    sent = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return () => sent
}

/** A minimal Messages payload whose content blocks are supplied by the caller. */
function message(content: unknown[]): Record<string, unknown> {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

const searchedResponse = [
  {
    type: 'server_tool_use',
    id: 'srvtoolu_1',
    name: 'web_search',
    input: { query: 'commercial roof restoration' },
  },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url: 'https://roofingcontractor.example/guide', title: 'Guide' }],
  },
  {
    type: 'text',
    text: 'Restoration coats an existing roof.',
    citations: [
      {
        type: 'web_search_result_location',
        url: 'https://roofingcontractor.example/guide',
        title: 'Guide',
        cited_text: 'Restoration coats an existing roof',
      },
    ],
  },
]

test('the tracked-query request instructs Claude to search rather than leaving retrieval to its judgement', async () => {
  const sent = captureRequest(message(searchedResponse))
  try {
    await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)

    const system = sent().system
    expect(typeof system).toBe('string')
    expect(system as string).toMatch(/search the web before answering/i)

    // The instruction must steer retrieval only. A system prompt that named a
    // brand, competitor, or ranking would contaminate the mention measurement
    // it exists to protect.
    expect(system as string).not.toMatch(/recommend|best|top|rank|prefer/i)

    // web_search stays offered on `auto`. Forcing it via tool_choice prefills the
    // assistant turn, which suppresses the preamble text parsed as the answer.
    expect(sent().tool_choice).toBeUndefined()
    expect(sent().tools).toMatchObject([{ type: 'web_search_20250305', name: 'web_search' }])
  } finally {
    vi.unstubAllGlobals()
  }
})

test('an answer produced without retrieval is distinguishable from one that searched and cited nothing', async () => {
  // Both shapes yield zero cited domains. searchQueries is what separates them,
  // and is the signal a follow-up should persist on query_snapshots so visibility
  // rates can exclude answers the brand never had a chance to appear in.
  const unsearched = captureRequest(message([{ type: 'text', text: 'Restoration coats an existing roof.' }]))
  try {
    const noRetrieval = await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)
    const normalizedNoRetrieval = claudeAdapter.normalizeResult(noRetrieval)
    expect(normalizedNoRetrieval.searchQueries).toEqual([])
    expect(normalizedNoRetrieval.citedDomains).toEqual([])
    expect(normalizedNoRetrieval.answerText).toContain('Restoration coats')
    expect(unsearched().system).toBeDefined()
  } finally {
    vi.unstubAllGlobals()
  }

  captureRequest(message(searchedResponse))
  try {
    const retrieved = await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)
    const normalizedRetrieved = claudeAdapter.normalizeResult(retrieved)
    expect(normalizedRetrieved.searchQueries).toEqual(['commercial roof restoration'])
    expect(normalizedRetrieved.citedDomains).toEqual(['roofingcontractor.example'])
  } finally {
    vi.unstubAllGlobals()
  }
})
