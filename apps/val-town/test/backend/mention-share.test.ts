import { buildMentionExtractPrompt, parseMentionExtractResponse } from '../../src/visibility/mention-extract.ts'
import { namesWrittenIn } from '../../src/visibility/brand.ts'
import { computeMentionShare, computeShareOfVoice, SHARE_MAX_ROWS } from '../../src/visibility/share.ts'
import { checkFingerprint } from '../../src/runtime/records.ts'
import type { VisibilityEvidence } from '../../src/runtime/types.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function answer(options: {
  text?: string
  mentioned?: boolean | null
  brands?: string[] | null
  domains?: string[]
}): VisibilityEvidence {
  const failed = options.mentioned === null
  return {
    query: 'q',
    provider: 'gemini',
    requestedModel: 'm',
    servedModel: failed ? null : 'm',
    completedAt: '2026-09-01T00:00:00.000Z',
    answerText: options.text ?? 'text',
    mentioned: options.mentioned ?? false,
    matchedTerms: [],
    cited: failed ? null : (options.domains ?? []).length > 0,
    citedDomains: options.domains ?? [],
    citedUrls: [],
    matchedCitationDomains: [],
    matchedCitationUrls: [],
    sources: [],
    searchQueries: [],
    namedBrands: options.brands === undefined ? [] : options.brands,
    retrievalStatus: failed ? 'error' : 'grounded',
    error: failed ? 'boom' : null,
  }
}

Deno.test('a brand the answer does not write is dropped, whatever the model returned', () => {
  // The whole basis of the mention metric. The extraction only PROPOSES names;
  // exact matching decides. A model that expands an abbreviation, translates a
  // name, or invents one produces a string the prose does not contain.
  const text = 'HubSpot and Coveo both sell this. Salesforce was not discussed.'
  const proposed = ['HubSpot', 'Coveo', 'Salesforce', 'Hub Spot Inc', 'Zoho']
  const verified = namesWrittenIn(text, proposed)

  assert(verified.includes('HubSpot'), 'a written name survives')
  assert(verified.includes('Salesforce'), 'written counts even in a negative sentence, which is a known limit')
  assert(!verified.includes('Zoho'), 'an invented name is dropped')
  assert(!verified.includes('Hub Spot Inc'), 'an expanded name is not the written name')
})

Deno.test('matching is by whole words, never by substring', () => {
  // "Contently" contains "content"; a substring matcher would report the brand
  // every time an answer used the ordinary word.
  equal(namesWrittenIn('We publish content weekly.', ['Contently']).length, 0)
  equal(namesWrittenIn('Contently publishes weekly.', ['Contently']).length, 1)
})

Deno.test('the target is counted from its own verdict, not from the extraction', () => {
  // The target's aliases are approved by the planner; the extraction's are
  // proposals. The checked site must not depend on a model naming it right.
  const share = computeMentionShare([
    answer({ mentioned: true, brands: ['Rival'] }),
    answer({ mentioned: false, brands: ['Rival', 'Acme'] }),
  ], 'Acme')
  assert(share, 'expected a table')

  const target = share.entries.find((entry) => entry.isTarget)
  assert(target, 'the checked brand keeps its row')
  // Answer 1: mentioned true, so Acme counts even though the extraction did not
  // list it. Answer 2: mentioned false, so the extraction listing Acme does NOT
  // add a count.
  equal(target.answers, 1, 'the verdict wins in both directions')
})

Deno.test('an answer the extraction never covered is excluded, not counted as naming nobody', () => {
  // Counting an unmeasured answer in the denominator would deflate every share
  // by an outage rather than reporting the outage.
  const withGap = computeMentionShare([
    answer({ mentioned: false, brands: ['Rival'] }),
    answer({ mentioned: false, brands: null }),
  ], 'Acme')
  const withoutGap = computeMentionShare([answer({ mentioned: false, brands: ['Rival'] })], 'Acme')
  assert(withGap && withoutGap, 'expected both tables')

  equal(withGap.measuredAnswers, 1, 'the uncovered answer is not measured')
  equal(withGap.entries.find((entry) => entry.domain === 'Rival')?.share, 1)
  equal(withGap.totalAppearances, withoutGap.totalAppearances)
})

Deno.test('nothing measurable returns null rather than an empty table', () => {
  equal(computeMentionShare([], 'Acme'), null)
  equal(computeMentionShare([answer({ mentioned: null, brands: null })], 'Acme'), null)
  // Every answer covered, none naming anyone: measurable, but no appearances.
  equal(computeMentionShare([answer({ mentioned: false, brands: [] })], 'Acme'), null)
})

Deno.test('the two bases are independent tables and never blend', () => {
  // A site cited but never named, and a brand named but never cited: the two
  // tables must disagree, which is the entire reason both exist.
  const evidence = [
    answer({ mentioned: false, brands: ['Coveo'], domains: ['hubspot.com'] }),
    answer({ mentioned: false, brands: ['Coveo'], domains: ['hubspot.com'] }),
  ]
  const cited = computeShareOfVoice(evidence, 'acme.example')
  const named = computeMentionShare(evidence, 'Acme')
  assert(cited && named, 'expected both tables')

  equal(cited.basis, 'citation')
  equal(named.basis, 'mention')
  assert(cited.entries.some((entry) => entry.domain === 'hubspot.com'), 'cited table holds the domain')
  assert(!cited.entries.some((entry) => entry.domain === 'Coveo'), 'a prose name is not a citation')
  assert(named.entries.some((entry) => entry.domain === 'Coveo'), 'mention table holds the name')
  assert(!named.entries.some((entry) => entry.domain === 'hubspot.com'), 'a cited domain is not a mention')
})

Deno.test('both bases share one ranker, so ordering and the cut cannot drift', () => {
  const many = Array.from({ length: SHARE_MAX_ROWS + 4 }, (_, index) => answer({ brands: [`Brand${index}`] }))
  const share = computeMentionShare(many, 'Acme')
  assert(share, 'expected a table')

  // Same contract the citation table is held to: capped head, target always
  // present, remainder stated as a tail rather than a row.
  equal(share.entries.length, SHARE_MAX_ROWS + 1, 'head plus the target row')
  assert(share.entries.some((entry) => entry.isTarget), 'the target keeps its row at zero')
  assert(share.tail, 'the remainder is reported')
  const drawn = share.entries.reduce((sum, entry) => sum + entry.share, 0) + share.tail.share
  assert(Math.abs(drawn - 1) < 1e-9, `parts must total 1, got ${drawn}`)
})

Deno.test('a malformed extraction response is unmeasured, never an empty finding', () => {
  // "The model returned garbage" and "the answers named nobody" are different
  // claims, and only one of them is a finding.
  for (const bad of ['', 'not json', '{"answers":"nope"}', '{}']) {
    const parsed = parseMentionExtractResponse(bad, 2)
    equal(parsed.length, 2)
    equal(parsed[0], null, `"${bad}" must not read as an empty list`)
  }
})

Deno.test('the extraction parser holds each answer to its own index', () => {
  const parsed = parseMentionExtractResponse(
    '```json\n{"answers":[{"index":2,"brands":["B"]},{"index":1,"brands":["A"," A ","x".repeat(0)]}]}\n```'
      .replace('"x".repeat(0)', '""'),
    2,
  )
  equal(parsed[0]?.join(','), 'A', 'index 1 maps to the first answer, blanks dropped, duplicates collapsed')
  equal(parsed[1]?.join(','), 'B', 'out-of-order rows still land on their own answer')

  // An index outside the batch is discarded rather than shifting a row onto
  // the wrong answer.
  equal(parseMentionExtractResponse('{"answers":[{"index":9,"brands":["Z"]}]}', 2)[0], null)
})

Deno.test('the prompt forbids the inference the metric is built to avoid', () => {
  const prompt = buildMentionExtractPrompt(['One answer.'])
  assert(prompt.includes('Copy each name exactly as the text writes it'), 'names must be copied, not produced')
  assert(
    prompt.includes('add a name the text does not write'),
    'the prompt must forbid producing a name, which is the inference the metric rules out',
  )
  assert(prompt.includes('Text 1:'), 'answers are numbered so replies map back by index')
})

Deno.test('adding a measured signal retires the records that lack it', () => {
  // The reuse key must change when what a check PRODUCES changes. Mention share
  // was added to every new check, but a cached pre-extraction record still
  // satisfied a request for the same domain, so a visitor got a result silently
  // missing half the report until the old row hit its own 24h TTL.
  const key = checkFingerprint('example.com')
  assert(key.startsWith('visibility-v3:'), `the version must move with the signal set, got ${key}`)
  assert(!key.includes('visibility-v2'), 'a v2 record must not satisfy a v3 request')

  // The caller's own questions still join the identity, unchanged.
  assert(
    checkFingerprint('example.com', ['a question']) !== key,
    'different questions are still different checks',
  )
})
