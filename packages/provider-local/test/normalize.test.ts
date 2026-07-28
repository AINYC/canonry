import { describe, it, expect } from 'vitest'
import { normalizeResult, extractServedModel } from '../src/normalize.js'
import type { LocalRawResult } from '../src/types.js'

describe('normalizeResult', () => {
  it('does not fabricate citations from domains written in answer prose', () => {
    const raw: LocalRawResult = {
      provider: 'local',
      model: 'llama3',
      rawResponse: {
        choices: [
          {
            message: {
              content: 'The domain is canonry.io'
            }
          }
        ]
      },
      groundingSources: [],
      searchQueries: []
    }
    const normalized = normalizeResult(raw)
    expect(normalized.answerText).toBe('The domain is canonry.io')
    expect(normalized.citedDomains).toEqual([])
    expect(normalized.groundingSources).toEqual([])
  })

  it('derives cited domains only from structured grounding sources', () => {
    const raw: LocalRawResult = {
      provider: 'local',
      model: 'llama3',
      rawResponse: { choices: [{ message: { content: 'See the sources.' } }] },
      groundingSources: [
        { uri: 'https://www.example.com/article', title: 'Example' },
        { uri: 'https://docs.example.com/guide', title: 'Guide' },
      ],
      searchQueries: [],
    }
    const normalized = normalizeResult(raw)
    expect(normalized.citedDomains).toEqual(['example.com', 'docs.example.com'])
    expect(normalized.groundingSources).toEqual(raw.groundingSources)
  })
})

describe('extractServedModel', () => {
  // Local servers speak the OpenAI ChatCompletion shape and routinely echo back a more
  // specific tag than the one requested (e.g. `llama3` -> `llama3:8b-instruct-q4_0`).
  // Constructed, not captured — no local server was called for this change.
  const localResponse: Record<string, unknown> = {
    id: 'chatcmpl-local-1',
    object: 'chat.completion',
    model: 'llama3:8b-instruct-q4_0',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer.' } },
    ],
  }

  it('captures the model the local server reported serving, not the configured alias', () => {
    const configuredModel = 'llama3'
    const servedModel = extractServedModel(localResponse)
    expect(servedModel).toBe('llama3:8b-instruct-q4_0')
    expect(servedModel).not.toBe(configuredModel)
  })

  it('returns undefined when the response carries no model field', () => {
    const { model: _model, ...withoutModel } = localResponse
    const servedModel = extractServedModel(withoutModel)
    expect(servedModel).toBeUndefined()
    expect(servedModel).not.toBe('')
    expect(servedModel).not.toBe('llama3')
  })

  it('returns undefined for a whitespace-only model field', () => {
    expect(extractServedModel({ ...localResponse, model: '  ' })).toBeUndefined()
  })
})
