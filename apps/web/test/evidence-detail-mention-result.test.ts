import { expect, test } from 'vitest'

import { resolveMentionResult } from '../src/components/layout/EvidenceDetailModal.js'

test('does not infer an answer mention when mention fields are missing', () => {
  expect(resolveMentionResult({
    answerMentioned: undefined,
    visibilityState: undefined,
  })).toBe('unknown')
})

test('resolves canonical and legacy mention fields without citation input', () => {
  expect(resolveMentionResult({ mentionState: 'mentioned' })).toBe('mentioned')
  expect(resolveMentionResult({ mentionState: 'not-mentioned' })).toBe('not-mentioned')
  expect(resolveMentionResult({ answerMentioned: true })).toBe('mentioned')
  expect(resolveMentionResult({ answerMentioned: false })).toBe('not-mentioned')
  expect(resolveMentionResult({ visibilityState: 'visible' })).toBe('mentioned')
  expect(resolveMentionResult({ visibilityState: 'not-visible' })).toBe('not-mentioned')
  expect(resolveMentionResult({ visibilityState: 'pending' })).toBe('pending')
})
