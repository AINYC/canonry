import { test, expect, vi } from 'vitest'

import { claudeAdapter } from '../src/adapter.js'
import {
  CLAUDE_RETRIEVAL_CONTRACT,
  executeTrackedQuery,
  normalizeResult,
} from '../src/normalize.js'

// Claude decides for itself whether a query warrants a search, and Sonnet 5
// decides far more conservatively than Sonnet 4.6 did. An answer written without
// retrieval stores as zero cited domains and zero mentions, indistinguishable at
// rest from an answer that searched and did not mention the brand, while sitting
// in the denominator of every visibility rate.
//
// These tests pin the behavioural boundary of the search-required-v1 contract:
// retrieval is guaranteed by tool_choice, and retrieval is recorded separately
// from citation so the two populations never merge.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const CONFIG = { provider: 'claude' as const, apiKey: 'k', model: 'claude-sonnet-5', quotaPolicy }
const QUERY = { query: 'commercial roof restoration', canonicalDomains: ['example.com'], competitorDomains: [] }

// `retrievalStatus` and `retrievalContract` are provider-local for now: the shared
// RawQueryResult/NormalizedQueryResult contracts in contracts/src/run.ts are
// being edited by #879, so threading them through the pipeline (and persisting
// them on query_snapshots) lands on top of that PR rather than conflicting with
// it. Until then the adapter boundary drops them, so retrieval is asserted
// against the provider functions that own it.
const CLAUDE_INPUT = { ...QUERY, config: { apiKey: 'k', model: 'claude-sonnet-5', quotaPolicy } }

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

const searchCall = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'web_search',
  input: { query: 'commercial roof restoration' },
}

const searchResult = {
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: [{ type: 'web_search_result', url: 'https://roofingcontractor.example/guide', title: 'Guide' }],
}

/** Searched, and the answer cites a source. */
const SEARCHED_AND_CITED = [
  searchCall,
  searchResult,
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

/**
 * Searched, but the answer cites nothing. This is the case that must not collapse
 * into the unsearched one: both yield zero cited domains, and only
 * `retrievalStatus` separates them.
 */
const SEARCHED_AND_UNCITED = [
  searchCall,
  searchResult,
  { type: 'text', text: 'Restoration coats an existing roof.' },
]

/** Never searched. Under search-required-v1 this means the contract did not hold. */
const UNSEARCHED = [{ type: 'text', text: 'Restoration coats an existing roof.' }]

test('retrieval is required by tool_choice, not coaxed by a system prompt', async () => {
  const sent = captureRequest(message(SEARCHED_AND_CITED))
  try {
    await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)

    expect(sent().tool_choice).toEqual({ type: 'tool', name: 'web_search' })
    expect(sent().tools).toMatchObject([{ type: 'web_search_20250305', name: 'web_search' }])

    // No system prompt. One would steer persona, tone, and source policy as well
    // as retrieval, contaminating the answer substance being measured.
    expect(sent().system).toBeUndefined()

    // The query reaches Claude verbatim.
    expect(sent().messages).toEqual([{ role: 'user', content: 'commercial roof restoration' }])
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a server_tool_use web_search block records retrieval', async () => {
  captureRequest(message(SEARCHED_AND_CITED))
  try {
    const raw = await executeTrackedQuery(CLAUDE_INPUT)
    expect(raw.retrievalStatus).toBe('used')
    expect(raw.retrievalContract).toBe(CLAUDE_RETRIEVAL_CONTRACT)
    expect(normalizeResult(raw).retrievalStatus).toBe('used')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('searched-but-uncited stays distinct from unsearched though both cite nothing', async () => {
  captureRequest(message(SEARCHED_AND_UNCITED))
  let searchedUncited
  try {
    searchedUncited = normalizeResult(await executeTrackedQuery(CLAUDE_INPUT))
  } finally {
    vi.unstubAllGlobals()
  }

  captureRequest(message(UNSEARCHED))
  let unsearched
  try {
    unsearched = normalizeResult(await executeTrackedQuery(CLAUDE_INPUT))
  } finally {
    vi.unstubAllGlobals()
  }

  // Indistinguishable on every field the store keeps today.
  expect(searchedUncited.citedDomains).toEqual([])
  expect(unsearched.citedDomains).toEqual([])
  expect(searchedUncited.answerText).toEqual(unsearched.answerText)

  // `retrievalStatus` is the only thing that separates them, so it carries the
  // whole distinction between a genuine miss and an answer that never had a chance.
  expect(searchedUncited.retrievalStatus).toBe('used')
  expect(unsearched.retrievalStatus).toBe('not-used')
})

test('an undeterminable response is unknown, never not-used', async () => {
  // A response carrying no content is not evidence that retrieval did not run.
  // Reporting `not-used` here would assert an absence never observed and would
  // let the row be counted as a genuine miss, which is the exact failure the
  // status exists to prevent. `unknown` keeps it out of both populations.
  captureRequest(message([]))
  try {
    const raw = await executeTrackedQuery(CLAUDE_INPUT)
    expect(raw.retrievalStatus).toBe('unknown')
    expect(normalizeResult(raw).retrievalStatus).toBe('unknown')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the adapter boundary reports unknown rather than inventing a status', async () => {
  // The shared RawQueryResult cannot carry retrieval until #879 lands, so a
  // result reconstructed from it has genuinely lost the observation. It must say
  // so rather than default to a value that reads as a real measurement.
  captureRequest(message(SEARCHED_AND_CITED))
  try {
    const viaAdapter = await claudeAdapter.executeTrackedQuery(QUERY, CONFIG)
    // Proves the gap this PR must close before merging: the provider observed a
    // search, and nothing downstream can see that.
    expect('retrievalStatus' in viaAdapter).toBe(false)
    expect(claudeAdapter.normalizeResult(viaAdapter)).not.toHaveProperty('retrievalStatus')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('retrieval is read from the search call, not from recovered query text', async () => {
  // A search whose query string is missing still counts: retrieval answers the
  // denominator question, while searchQueries is only telemetry.
  captureRequest(message([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }, searchResult]))
  try {
    const normalized = normalizeResult(await executeTrackedQuery(CLAUDE_INPUT))
    expect(normalized.searchQueries).toEqual([])
    expect(normalized.retrievalStatus).toBe('used')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('an unsearched response is marked as not retrieved so the contract breach is visible', async () => {
  captureRequest(message(UNSEARCHED))
  try {
    const raw = await executeTrackedQuery(CLAUDE_INPUT)
    // search-required-v1 promises retrieval. When the response carries no search
    // call the promise did not hold, and the row must be identifiable as such
    // rather than pooled with retrieved answers.
    expect(raw.retrievalStatus).toBe('not-used')
    expect(raw.retrievalContract).toBe(CLAUDE_RETRIEVAL_CONTRACT)
  } finally {
    vi.unstubAllGlobals()
  }
})
