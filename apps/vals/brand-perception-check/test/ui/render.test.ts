import { type CheckRecord, PUBLIC_RATE_LIMITED_ERROR_CODE } from 'npm:@canonry/val-kit@0.1.0/jobs'
import type { PerceptionEvidence } from 'npm:@canonry/val-kit@0.1.0/perception'
import type { PerceptionCheckResult } from '../../src/runtime/check-result.ts'
import {
  assetUrl,
  brandPerceptionClientScript,
  brandPerceptionStyles,
  createPublicCheckForm,
  emptyLandingViewModel,
  PRODUCT_NAME,
  QUERY_HINT_SUFFIX,
  renderBrandPerception,
  toBrandPerceptionViewModel,
} from '../../src/ui/index.ts'

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

function readyForm() {
  return createPublicCheckForm({
    publicChecksEnabled: true,
    publicChecksUnavailableMessage: null,
    humanVerificationStatus: 'not-required',
    turnstileSiteKey: null,
  })
}

function row(over: Partial<PerceptionEvidence> & Pick<PerceptionEvidence, 'query'>): PerceptionEvidence {
  return {
    provider: 'gemini',
    requestedModel: 'gemini-2.5-flash',
    servedModel: 'gemini-2.5-flash',
    completedAt: '2026-09-01T00:00:10.000Z',
    answerText: 'An answer about the brand.',
    verdict: 'none',
    evidenceSentences: [],
    concerns: [],
    sources: [],
    searchQueries: [],
    retrievalStatus: 'grounded',
    error: null,
    ...over,
  }
}

/** A real completed check mapped through the production view-model path. */
function completedRecord(): CheckRecord<PerceptionCheckResult> {
  return {
    id: 'check-ui',
    fingerprint: 'fingerprint',
    userQueries: [],
    domain: 'example.com',
    status: 'partial',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:30.000Z',
    expiresAt: '2026-09-02T00:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-01T00:00:30.000Z',
      errors: [],
      perception: {
        schemaVersion: '1',
        domain: 'example.com',
        brandNames: ['Example'],
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:00:30.000Z',
        summary: {
          successfulChecks: 2,
          failedChecks: 1,
          verdicts: { recommends: 1, cautions: 0, mixed: 0, none: 1 },
          concerns: [{ phrase: 'Support can be slow', answers: 1 }],
          sourceTypes: {
            measuredAnswers: 1,
            unattributedAnswers: 1,
            totalAppearances: 2,
            entries: [
              { type: 'community', answers: 1, share: 0.5 },
              { type: 'review', answers: 1, share: 0.5 },
            ],
          },
        },
        evidence: [
          row({
            query: 'is Example legit?',
            answerText: 'Example is well regarded. Support can be slow.',
            verdict: 'recommends',
            evidenceSentences: ['Example is well regarded.', 'Reviewers rate it highly.'],
            concerns: ['Support can be slow'],
            sources: [
              { url: 'https://www.reddit.com/r/example', domain: 'reddit.com', title: 'Thread', type: 'community' },
              { url: 'https://www.trustpilot.com/e', domain: 'trustpilot.com', title: 'Reviews', type: 'review' },
            ],
            searchQueries: ['Example reviews'],
          }),
          row({ query: 'Example vs alternatives', verdict: 'none' }),
          row({
            query: 'what are the complaints about Example?',
            answerText: null,
            verdict: null,
            servedModel: null,
            retrievalStatus: 'error',
            error: 'The answer engine did not respond in time.',
          }),
        ],
      },
    },
  }
}

function completedHtml(): string {
  return renderBrandPerception(toBrandPerceptionViewModel(completedRecord(), { form: readyForm() }))
}

// ---------------------------------------------------------------------------
// Naming and attribution
// ---------------------------------------------------------------------------

Deno.test('the product names itself, and never calls itself Canonry', () => {
  const html = completedHtml()
  equal(PRODUCT_NAME, 'Brand Perception Check')
  assert(html.includes('<title>Example | Brand Perception Check</title>'), 'the document title names the product')
  assert(html.includes('>brand perception check</a>'), 'the wordmark names the product')
  // Attribution runs the other way, and deliberately: every surface points back
  // at the open-source project, but the product is never called Canonry.
  assert(html.includes('powered by'), 'the byline attributes Canonry')
  assert(html.includes('>Canonry</span>'), 'the byline names Canonry')
  assert(html.includes('npm i -g @canonry/canonry'), 'the footer carries the install command')
  assert(html.includes('https://github.com/Canonry/canonry'), 'the footer links the repository')
  assert(!/<h1[^>]*>\s*Canonry/.test(html), 'the page must never present itself as Canonry')
})

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

Deno.test('the landing page shows an empty state, never fabricated data', () => {
  const html = renderBrandPerception(emptyLandingViewModel(readyForm()))

  assert(html.includes('What does AI say about your brand?'), 'the landing page must lead with its one job')
  assert(html.includes('is-hero'), 'the landing form is the hero, not a header afterthought')
  // Nothing has been checked, so there is nothing to report on.
  assert(!html.includes('Verdict snapshot'), 'nothing has been measured, so there is no snapshot')
  assert(!html.includes('Concerns raised'), 'an empty concern list is not a landing page')
  assert(!html.includes('signal-positive'), 'no verdict may be drawn before a check has run')
  // Only Gemini is ever asked, so naming another engine here is a false claim.
  for (const engine of ['ChatGPT', 'Claude', 'Perplexity']) {
    assert(!html.includes(engine), `the landing must not advertise ${engine}, which this val never asks`)
  }
})

Deno.test('the landing explains itself through a tooltip, not a subtitle', () => {
  const html = renderBrandPerception(emptyLandingViewModel(readyForm()))

  // The copy rides the button's accessible name, so a screen reader and a test
  // both reach it without the tooltip being open.
  assert(
    html.includes('aria-label="An answer engine is asked questions that name this brand.'),
    "the explainer must be the trigger's accessible name",
  )
  // A real button, so a keyboard reaches it. :focus-within is what opens the
  // note, and that only fires for something focusable.
  assert(html.includes('<button type="button" class="info-tip-trigger"'), 'the trigger must be a button')
  assert(
    brandPerceptionStyles.includes('.info-tip:focus-within .info-tip-body'),
    'the note must open on keyboard focus, not hover alone',
  )
  // No JS opens it: the page CSP allows no inline script, and the tooltip must
  // work before or without the enhancement script.
  assert(!brandPerceptionClientScript.includes('info-tip'), 'the tooltip must not depend on the client script')
})

Deno.test('the question field asks for the questions people ask about the brand', () => {
  const html = renderBrandPerception(emptyLandingViewModel(readyForm()))
  assert(
    html.includes('Questions people ask about this brand'),
    'the label must say what belongs in the field',
  )
  assert(html.includes('One question per line'), 'the format instruction stays')
  assert(html.includes('Is Acme legit?'), 'the example reads as a question someone actually types')
})

Deno.test('the timing survives the first keystroke', () => {
  // The server writes the timing into the markup and the client rewrites that
  // whole line on every keystroke. With the suffix in only one of the two, it is
  // on the page until the visitor types and then gone, which no assertion about
  // the initial render would catch.
  const rendered = renderBrandPerception(emptyLandingViewModel(readyForm()))
  assert(rendered.includes(`We generate the rest. ${QUERY_HINT_SUFFIX}`), 'the server markup states the timing')
  assert(
    brandPerceptionClientScript.includes(JSON.stringify(QUERY_HINT_SUFFIX)),
    'the client rewrite must carry the same constant, not drop it',
  )
})

Deno.test('the landing states the one engine and points at the open source project', () => {
  const html = renderBrandPerception(emptyLandingViewModel(readyForm()))
  assert(html.includes('<span>Gemini only</span>'), 'the one engine is stated')
  assert(html.includes('<span>3 branded questions</span>'), 'the sample size is stated')
  assert(html.includes('More engines in open source Canonry'), 'the landing points at the platform')
})

// ---------------------------------------------------------------------------
// Result page: sections, order, and honesty
// ---------------------------------------------------------------------------

Deno.test('the result page renders the four sections in order', () => {
  const html = completedHtml()
  const order = ['Verdict snapshot', 'Answers', 'Concerns raised', 'Sources the engine attributed']
  let cursor = -1
  for (const heading of order) {
    const index = html.indexOf(`>${heading}`)
    assert(index > cursor, `"${heading}" must appear after the section before it`)
    cursor = index
  }
})

Deno.test('the verdict snapshot is a flat KPI row, never a progress bar', () => {
  const html = completedHtml()
  assert(html.includes('class="verdict-row"'), 'the snapshot is a KPI row')
  // Unbounded counts have no target to fill, so a bar or a meter would be
  // inventing one.
  assert(!html.includes('<meter'), 'a count with no ceiling must not be drawn as a meter')
  assert(!html.includes('<progress'), 'a count with no ceiling must not be drawn as a progress bar')
  assert(!brandPerceptionStyles.includes('.verdict-row progress'), 'no bar is styled for this row either')
})

Deno.test('the verdict counts are rendered from the stored summary, not recomputed from the rows', () => {
  // The record's summary says 1 recommends / 1 none over 2 successful checks.
  // Re-deriving from the evidence array here would be a second definition of
  // "successful", and the two drift the first time either changes.
  const record = completedRecord()
  record.result!.perception!.summary.verdicts = { recommends: 2, cautions: 0, mixed: 0, none: 0 }
  record.result!.perception!.summary.successfulChecks = 2
  const html = renderBrandPerception(toBrandPerceptionViewModel(record, { form: readyForm() }))

  const snapshot = html.slice(html.indexOf('class="verdict-row"'), html.indexOf('</dl>'))
  assert(snapshot.includes('<dt>Recommends</dt><dd>2</dd>'), `the summary is what is drawn: ${snapshot}`)
  assert(snapshot.includes('<dt>Took no position</dt><dd>0</dd>'), 'a zero bucket keeps its column')
  assert(snapshot.includes('of 2 answers'), 'the denominator is written under every number')
})

Deno.test('a check that measured nothing says so instead of printing zeroes', () => {
  const record = completedRecord()
  record.result!.perception!.summary.successfulChecks = 0
  record.result!.perception!.summary.failedChecks = 3
  record.result!.perception!.summary.verdicts = { recommends: 0, cautions: 0, mixed: 0, none: 0 }
  const html = renderBrandPerception(toBrandPerceptionViewModel(record, { form: readyForm() }))

  const snapshot = html.slice(html.indexOf('class="verdict-row"'), html.indexOf('</dl>'))
  assert(snapshot.includes('Not measured'), 'a zero denominator is not a measured zero')
  assert(!snapshot.includes('<dd>0</dd>'), 'nothing was measured, so no count may be printed')
})

Deno.test('the bounds are stated on the surface that shows the number', () => {
  const html = completedHtml()
  const snapshot = html.slice(html.indexOf('verdict-snapshot-heading'), html.indexOf('</dl>'))
  assert(snapshot.includes('<strong>3</strong> branded questions'), 'the sample size sits with the counts')
  assert(snapshot.includes('<span>Gemini</span>'), 'the one engine sits with the counts')
  assert(snapshot.includes('<strong>2</strong> measured'), 'the denominator sits with the counts')
})

Deno.test('an unmeasured answer reads as Not measured, with its reason', () => {
  const html = completedHtml()
  assert(html.includes('Not measured'), 'a failed answer is not measured')
  assert(html.includes('The answer engine did not respond in time.'), 'the row carries the reason')
  // A failed answer must never be drawn as a position the answer took.
  const failedRow = html.slice(html.indexOf('what are the complaints about Example?'))
  const rowEnd = failedRow.indexOf('</tr>')
  assert(
    !failedRow.slice(0, rowEnd).includes('Took no position'),
    'an unmeasured answer is never reported as taking no position',
  )
  // Nor as a measured zero. There is no answer, so there is nothing that
  // attributed no source — a "0" in the sources column would be a claim about
  // an answer that does not exist.
  assert(
    failedRow.slice(0, rowEnd).includes('<span class="cell-unknown">not measured</span>'),
    'an unmeasured answer must not print a source count',
  )
  assert(
    html.includes('This answer was not measured, so no source was attributed to it.'),
    'the disclosure says the same thing rather than reporting an empty source list',
  )
})

Deno.test('every verdict is carried by the answer\'s own words, quoted', () => {
  const html = completedHtml()
  assert(html.includes('<q class="answer-quote">Example is well regarded.</q>'), 'the first sentence is quoted inline')
  // The disclosure carries every verified sentence, still quoted.
  assert(html.includes('<li><q>Reviewers rate it highly.</q></li>'), 'the rest are in the row disclosure')
  assert(html.includes('<details class="evidence-detail">'), 'each row discloses its evidence natively')
  assert(html.includes('What the answer said'), 'the disclosure labels the quotations')
  assert(html.includes('Concerns this answer raised'), 'the disclosure carries the concerns')
  assert(html.includes('<p class="detail-label">Sources</p>'), 'the disclosure carries the typed sources')
  assert(html.includes('reddit.com · Community'), 'a source states its host and its kind')
})

Deno.test('an answer that took no position says that, rather than being left blank', () => {
  const html = completedHtml()
  assert(
    html.includes('The answer described the brand without taking a position.'),
    'a measured "none" states what happened',
  )
})

Deno.test('concerns are listed with the answers that raised them', () => {
  const html = completedHtml()
  const section = html.slice(html.indexOf('concerns-heading'), html.indexOf('sources-heading'))
  assert(section.includes('Support can be slow'), 'the phrase is the answer\'s own')
  assert(section.includes('in 1 of 2 answers'), 'the count carries its denominator')
})

Deno.test('no concern raised is stated, not silently omitted', () => {
  const record = completedRecord()
  record.result!.perception!.summary.concerns = []
  const html = renderBrandPerception(toBrandPerceptionViewModel(record, { form: readyForm() }))
  assert(html.includes('Concerns raised'), 'the section stays')
  assert(html.includes('No concern was raised in the 2 answers measured.'), 'an absence is a finding, so state it')
})

Deno.test('the source table counts a kind once per answer and states the unattributed rest', () => {
  const html = completedHtml()
  const section = html.slice(html.indexOf('sources-heading'))
  assert(section.includes('Community'), 'the kinds are named in the reader\'s words')
  assert(section.includes('1 of 1'), 'a kind counts once per answer, against the measured answers')
  assert(section.includes('50%'), 'the share is rounded for display only')
  assert(
    section.includes('1 measured answer attributed no source at all, and is excluded from the share.'),
    'an answer with no source is stated, never folded into the denominator',
  )
  // Never a claim about the web at large. The phrase may appear only inside the
  // tooltip's own denial of it, which is copy worth keeping.
  for (const match of html.matchAll(/where opinions/g)) {
    const before = html.slice(Math.max(0, (match.index ?? 0) - 24), match.index)
    assert(
      before.includes('not a claim about '),
      'the page must never claim to know where opinions about a brand come from',
    )
  }
})

Deno.test('a check where nothing attributed a source says so instead of drawing an empty table', () => {
  const record = completedRecord()
  record.result!.perception!.summary.sourceTypes = null
  const html = renderBrandPerception(toBrandPerceptionViewModel(record, { form: readyForm() }))
  assert(html.includes('No measured answer attributed a source.'), 'an absence is stated')
})

Deno.test('the failure banner leads with the reason only when the failures agree on one', () => {
  const oneReason = completedRecord()
  const banner = (record: CheckRecord<PerceptionCheckResult>) =>
    toBrandPerceptionViewModel(record, { form: readyForm() }).perception?.notice?.detail ?? ''

  assert(
    banner(oneReason).startsWith('The answer engine did not respond in time. '),
    `the single shared reason must lead: ${banner(oneReason)}`,
  )

  // Two different reasons: the banner cannot name one without being wrong about
  // the other, so it defers to the per-row evidence.
  const mixed = completedRecord()
  mixed.result!.perception!.evidence.push(
    row({ query: 'q4', verdict: null, answerText: null, error: 'The answer engine rate-limited this check.' }),
  )
  mixed.result!.perception!.summary.failedChecks = 2
  equal(banner(mixed), 'Every count uses the answers that were measured.')

  // The generic sentence is the ABSENCE of a reason; leading with it would make
  // the banner restate its own title.
  const generic = completedRecord()
  generic.result!.perception!.evidence[2]!.error = 'This answer-engine check was unavailable.'
  equal(banner(generic), 'Every count uses the answers that were measured.')
})

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

Deno.test('a numeric column is aligned once, on the column, not per cell', () => {
  // The alignment used to live on cell classes only in the sibling val, so every
  // header inherited the table's left and sat half a table away from its numbers.
  const html = completedHtml()

  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    const head = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''
    // Lookahead, because `<th[^>]*>` also matches `<thead>` and shifts every index.
    const headers = head.match(/<th(?=[\s>])[^>]*>/g) ?? []
    const numericColumns = new Set(headers.flatMap((cell, index) => cell.includes('is-numeric') ? [index] : []))

    for (const tableRow of table.match(/<tr>(?:(?!<\/tr>)[\s\S])*<\/tr>/g) ?? []) {
      if (tableRow.includes('<th scope="col"')) continue
      const cells = tableRow.match(/<(?:td|th)(?=[\s>])[^>]*>/g) ?? []
      cells.forEach((cell, index) => {
        equal(
          cell.includes('is-numeric'),
          numericColumns.has(index),
          `column ${index}: header and cell disagree about alignment (${cell})`,
        )
      })
    }
  }

  // And the alignment itself is stated once, keyed off that one class.
  assert(
    brandPerceptionStyles.includes('.compact-table .is-numeric, .evidence-table .is-numeric { text-align: right; }'),
    'the class must be what aligns the column',
  )
})

Deno.test('the renderer emits no inline styles and no inline script, which the page CSP would block', () => {
  const html = completedHtml()
  assert(!html.includes('style='), 'renderer must not emit inline styles')
  assert(!/<script(?![^>]*\ssrc=)/.test(html), 'every script must be an external file')
  assert(!html.includes('onclick='), 'no inline event handlers')
})

Deno.test('the shared design system is the kit\'s, extended rather than forked', () => {
  // The two Vals must look like one product, and the tokens are how. A literal
  // hex here instead of a token is the first step to two design systems.
  assert(brandPerceptionStyles.includes('--positive: #34d399;'), 'the tone tokens are the dashboard values')
  assert(brandPerceptionStyles.includes('--negative: #fb7185;'), 'the tone tokens are the dashboard values')
  assert(brandPerceptionStyles.includes('.signal-negative { color: var(--negative); }'), 'additions use the tokens')
  assert(
    brandPerceptionStyles.includes('"Geist Variable"'),
    'the typeface is the one the dashboard bundles, not a system fallback',
  )
})

Deno.test('asset URLs carry a content hash so a deploy cannot serve stale CSS', () => {
  const first = assetUrl('/assets/canonry-ui.css', 'a{}')
  const second = assetUrl('/assets/canonry-ui.css', 'a{color:red}')
  assert(first !== second, 'a changed stylesheet must arrive under a new URL')
  assert(completedHtml().includes(assetUrl('/assets/canonry-ui.css', brandPerceptionStyles)), 'the page uses the hash')
})

Deno.test('a rate-limited record keeps its rate-limit presentation state', () => {
  const record = completedRecord()
  record.status = 'failed'
  record.errorCode = PUBLIC_RATE_LIMITED_ERROR_CODE
  record.errorMessage = 'Daily check limit reached.'
  const model = toBrandPerceptionViewModel(record, { form: readyForm() })
  equal(model.status, 'rate-limited')
  assert(renderBrandPerception(model).includes('Daily check limit reached.'), 'the reason reaches the page')
})

Deno.test('a stored partial with nothing failed does not warn the reader', () => {
  // `record.status` is frozen at check time, so reading it would keep warning a
  // reader off a result in which nothing actually failed. `hasFailedWork` reads
  // the evidence instead.
  const record = completedRecord()
  record.result!.perception!.evidence = [
    row({ query: 'q1', verdict: 'recommends', evidenceSentences: ['Example is well regarded.'] }),
  ]
  record.result!.perception!.summary.failedChecks = 0
  record.result!.perception!.summary.successfulChecks = 1
  record.result!.perception!.summary.verdicts = { recommends: 1, cautions: 0, mixed: 0, none: 0 }

  const model = toBrandPerceptionViewModel(record, { form: readyForm() })
  equal(model.status, 'ready', 'a stored partial with no failure reads as ready')
  assert(!renderBrandPerception(model).includes('Partial result'), 'no caution when nothing failed')
})

Deno.test('an absent perception report stays absent rather than becoming zeroes', () => {
  const record = completedRecord()
  record.status = 'failed'
  record.result!.perception = null
  record.result!.errors = [{ area: 'perception', message: 'The brand perception check timed out.' }]
  const model = toBrandPerceptionViewModel(record, { form: readyForm() })

  equal(model.perception, undefined, 'no report means no view model, never an empty one')
  const html = renderBrandPerception(model)
  assert(html.includes('No brand perception result'), 'the page says there is nothing to show')
  assert(html.includes('The brand perception check timed out.'), 'and says why')
  assert(!html.includes('class="verdict-row"'), 'no snapshot may be drawn over an absent report')
})
