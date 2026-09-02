import { computeShareOfVoice, SHARE_MAX_ROWS } from '../../src/visibility/share.ts'
import type { VisibilityEvidence } from '../../src/runtime/types.ts'

declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

/** One answer. `domains` are the sources the engine attributed to it. */
function answer(
  domains: string[],
  options: { failed?: boolean; brands?: string[] | null } = {},
): VisibilityEvidence {
  return {
    query: 'q',
    provider: 'gemini',
    requestedModel: 'm',
    servedModel: 'm',
    completedAt: '2026-09-01T00:00:00.000Z',
    answerText: options.failed ? null : 'text',
    mentioned: options.failed ? null : false,
    matchedTerms: [],
    cited: options.failed ? null : domains.length > 0,
    citedDomains: domains,
    citedUrls: domains.map((d) => `https://${d}/`),
    matchedCitationDomains: [],
    matchedCitationUrls: [],
    sources: [],
    searchQueries: [],
    // Undefined means this fixture is about citations and says nothing about
    // mentions; null is the record's own "extraction did not run".
    namedBrands: options.failed ? null : options.brands ?? null,
    retrievalStatus: options.failed ? 'error' : 'grounded',
    error: options.failed ? 'boom' : null,
  }
}

Deno.test('share is the fraction of answer appearances, and the parts sum to one', () => {
  const share = computeShareOfVoice([
    answer(['a.com', 'b.com']),
    answer(['a.com', 'c.com']),
    answer(['a.com']),
  ], 'mine.example')
  assert(share, 'expected a share table')

  // 5 appearances: a.com in 3 answers, b.com and c.com in 1 each.
  equal(share.totalAppearances, 5)
  const a = share.entries.find((entry) => entry.domain === 'a.com')!
  equal(a.answers, 3)
  equal(a.share, 3 / 5)
  const sum = share.entries.reduce((total, entry) => total + entry.share, 0)
  assert(Math.abs(sum - 1) < 1e-9, `parts must sum to 1, got ${sum}`)
})

Deno.test('a domain cited many times in one answer still counts once', () => {
  // The evidence already de-duplicates per answer; this pins the contract that
  // ten links from one page never outweigh a domain cited across answers.
  const share = computeShareOfVoice([
    answer(['heavy.com']),
    answer(['spread.com']),
    answer(['spread.com']),
  ], 'mine.example')
  assert(share, 'expected a share table')

  const heavy = share.entries.find((entry) => entry.domain === 'heavy.com')!
  const spread = share.entries.find((entry) => entry.domain === 'spread.com')!
  equal(heavy.answers, 1)
  equal(spread.answers, 2)
  assert(spread.share > heavy.share, 'breadth across answers must beat depth in one')
})

Deno.test('the checked site absorbs its own subdomains', () => {
  const share = computeShareOfVoice([
    answer(['docs.mine.example', 'rival.com']),
    answer(['mine.example']),
  ], 'mine.example')
  assert(share, 'expected a share table')

  const mine = share.entries.find((entry) => entry.isTarget)!
  equal(mine.domain, 'mine.example')
  equal(mine.answers, 2, 'docs.mine.example is the same site')
  assert(!share.entries.some((entry) => entry.domain === 'docs.mine.example'), 'no separate subdomain row')
})

Deno.test('a www.-prefixed target still groups its own citations', () => {
  // The input domain keeps its www. (normalizePublicDomain never strips it),
  // while cited hosts are www.-stripped. The target must still match its own
  // citations rather than appear as a rival stranded at 0%.
  const share = computeShareOfVoice([
    answer(['stripe.com', 'rival.com']),
    answer(['docs.stripe.com']),
  ], 'www.stripe.com')
  assert(share, 'expected a share table')

  const target = share.entries.find((entry) => entry.isTarget)!
  equal(target.answers, 2, 'stripe.com and docs.stripe.com are the checked site')
  assert(target.share > 0, 'the target is not stranded at 0%')
  assert((share.targetShare ?? 0) > 0, 'targetShare reflects the grouped citations')
  assert(
    !share.entries.some((entry) => !entry.isTarget && entry.domain === 'stripe.com'),
    'the target is not listed as its own rival',
  )
})

Deno.test('a site that is never cited is a measured zero, not a missing row', () => {
  const share = computeShareOfVoice([answer(['rival.com']), answer(['other.com'])], 'mine.example')
  assert(share, 'expected a share table')
  equal(share.targetShare, 0)
  // The row is the whole point. A site absent from the ranking has no rank, so
  // any re-insertion keyed on rank drops it exactly when it matters most.
  const mine = share.entries.find((entry) => entry.isTarget)
  assert(mine, 'the checked site must have a row even when it was never cited')
  equal(mine.answers, 0)
  equal(mine.share, 0)
})

Deno.test('the tail is a stated fact, never a row with a nonsense ratio', () => {
  const domains = Array.from({ length: SHARE_MAX_ROWS + 5 }, (_, index) => `site${index}.com`)
  const share = computeShareOfVoice(domains.map((domain) => answer([domain])), 'mine.example')
  assert(share, 'expected a share table')

  // "12 more sites, 12 of 2 answers" counted appearances spread across twelve
  // domains against the answer count, which is not a ratio of anything.
  assert(!share.entries.some((entry) => entry.domain.includes('more site')), 'the tail is not an entry')
  assert(share.tail, 'the tail must still be reported')
  equal(share.tail.domains, 5)
  equal(share.tail.answers, 5)

  // Head rows plus the tail still account for the whole bar.
  const drawn = share.entries.reduce((sum, entry) => sum + entry.share, 0) + share.tail.share
  assert(Math.abs(drawn - 1) < 1e-9, `bar must still total 1, got ${drawn}`)
})

Deno.test('a failed answer is unmeasured and cannot dilute the share', () => {
  const withFailure = computeShareOfVoice([
    answer(['a.com']),
    answer([], { failed: true }),
  ], 'mine.example')
  const withoutFailure = computeShareOfVoice([answer(['a.com'])], 'mine.example')
  assert(withFailure && withoutFailure, 'expected both tables')

  equal(withFailure.totalAppearances, withoutFailure.totalAppearances)
  equal(withFailure.entries[0]?.share, 1)
})

Deno.test('a successful answer with no attributable source is counted, not hidden', () => {
  const share = computeShareOfVoice([answer(['a.com']), answer([])], 'mine.example')
  assert(share, 'expected a share table')

  equal(share.unattributedAnswers, 1, 'an answer with no sources is its own fact')
  equal(share.measuredAnswers, 1)
  // It must not become a phantom share: a.com still holds the whole field.
  equal(share.entries[0]?.share, 1)
})

Deno.test('nothing measurable returns null rather than an empty chart', () => {
  equal(computeShareOfVoice([], 'mine.example'), null)
  equal(computeShareOfVoice([answer([], { failed: true })], 'mine.example'), null)
  equal(computeShareOfVoice([answer([])], 'mine.example'), null)
})

Deno.test('the checked site keeps its row even when it ranks below the cut', () => {
  const answers = [
    ...Array.from({ length: SHARE_MAX_ROWS + 3 }, (_, index) => answer([`site${index}.com`, `site${index}b.com`])),
    answer(['mine.example']),
  ]
  const share = computeShareOfVoice(answers, 'mine.example')
  assert(share, 'expected a share table')

  const mine = share.entries.find((entry) => entry.isTarget)
  assert(mine, 'the checked site must never be folded into the remainder')
  equal(mine.answers, 1)
})

Deno.test('ordering is deterministic so the same answers always draw the same bar', () => {
  const build = () => computeShareOfVoice([answer(['b.com', 'a.com']), answer(['a.com', 'b.com'])], 'mine.example')
  equal(JSON.stringify(build()), JSON.stringify(build()))
  // Equal counts break by name, not by insertion order.
  equal(build()?.entries[0]?.domain, 'a.com')
})
