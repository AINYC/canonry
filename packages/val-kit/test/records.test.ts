/**
 * Check-record identity.
 *
 * The fingerprint is the 24h cache key AND the one-active-check index, so it
 * is a stored value: every record already written carries the exact string the
 * code produced at the time. That makes the FORMAT a compatibility contract,
 * not an implementation detail — a reformatting that looks harmless silently
 * orphans every stored record, and the only symptom is a cache that stops
 * hitting and a bill that goes up. The literals below are pinned for that
 * reason, and are the strings the first val's live records were written with.
 */
import { expect, test } from 'vitest'
import { checkFingerprint } from '../src/runtime/records.js'

test('the no-questions key is exactly the namespace, a colon, and the domain', () => {
  expect(checkFingerprint('visibility-v3', 'example.com')).toBe('visibility-v3:example.com')
})

test("the caller's questions join the key after a pipe, in the order asked", () => {
  expect(checkFingerprint('visibility-v3', 'example.com', ['a question'])).toBe(
    'visibility-v3:example.com|a question',
  )
  // U+0001 separates them: it cannot appear in a normalized question, so no
  // question can forge a second one by containing the separator itself.
  expect(checkFingerprint('visibility-v3', 'example.com', ['a question', 'b question'])).toBe(
    'visibility-v3:example.com|a question\u0001b question',
  )
  expect(checkFingerprint('visibility-v3', 'example.com', ['b question', 'a question'])).not.toBe(
    checkFingerprint('visibility-v3', 'example.com', ['a question', 'b question']),
  )
})

test('two products never share a reuse key for the same request', () => {
  // The fingerprint is the one-active-check index. Two products keyed alike
  // would hand a caller the other product's result — a different measurement
  // entirely — and report it as a cache hit.
  const domain = 'example.com'
  const questions = ['a question']
  expect(checkFingerprint('perception-v1', domain)).not.toBe(checkFingerprint('visibility-v3', domain))
  expect(checkFingerprint('perception-v1', domain, questions)).not.toBe(
    checkFingerprint('visibility-v3', domain, questions),
  )
  expect(checkFingerprint('perception-v1', domain)).toBe('perception-v1:example.com')
})

test('an empty namespace is refused rather than collapsed into a shared key', () => {
  // Defaulting would put every product that forgot the argument in one
  // namespace, which is the exact collision the parameter exists to prevent.
  expect(() => checkFingerprint('', 'example.com')).toThrow(/namespace/)
  expect(() => checkFingerprint('   ', 'example.com')).toThrow(/namespace/)
})
