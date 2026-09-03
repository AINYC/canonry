import { type CheckRecord, PUBLIC_RATE_LIMITED_ERROR_CODE } from 'npm:@canonry/val-kit@0.1.0/jobs'
import type { CheckResult } from '../../src/runtime/check-result.ts'
import {
  assetUrl,
  canonryDemoClientScript,
  canonryDemoStyles,
  createPublicCheckForm,
  emptyLandingViewModel,
  QUERY_HINT_SUFFIX,
  renderCanonryDemo,
  toCanonryDemoViewModel,
} from '../../src/ui/index.ts'

declare const Deno: {
  test(name: string, fn: () => void | Promise<void>): void
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function readyForm() {
  return createPublicCheckForm({
    publicChecksEnabled: true,
    publicChecksUnavailableMessage: null,
    humanVerificationStatus: 'not-required',
    turnstileSiteKey: null,
  })
}

/** A real completed check mapped through the production view-model path. */
function completedViewModel() {
  const record: CheckRecord<CheckResult> = {
    id: 'check-ui',
    fingerprint: 'fingerprint',
    userQueries: [],
    domain: 'example.com',
    status: 'complete',
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
      visibility: {
        schemaVersion: '1',
        domain: 'example.com',
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:00:30.000Z',
        summary: { successfulChecks: 2, failedChecks: 0, mentionRate: 0.5, citationRate: 0.5 },
        evidence: [
          {
            query: 'best example widgets',
            provider: 'gemini',
            requestedModel: 'gemini-2.5-flash',
            servedModel: 'gemini-2.5-flash',
            completedAt: '2026-09-01T00:00:10.000Z',
            answerText: 'Example sells widgets.',
            mentioned: true,
            matchedTerms: ['Example'],
            cited: false,
            citedDomains: ['other.com'],
            citedUrls: ['https://other.com/a'],
            matchedCitationDomains: [],
            matchedCitationUrls: [],
            sources: [{ url: 'https://other.com/a', title: 'Other' }],
            searchQueries: ['example widgets'],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: 'widget vendors compared',
            provider: 'gemini',
            requestedModel: 'gemini-2.5-flash',
            servedModel: 'gemini-2.5-flash',
            completedAt: '2026-09-01T00:00:20.000Z',
            answerText: 'Several vendors compete.',
            mentioned: false,
            matchedTerms: [],
            cited: true,
            citedDomains: ['example.com'],
            citedUrls: ['https://example.com/widgets'],
            matchedCitationDomains: ['example.com'],
            matchedCitationUrls: ['https://example.com/widgets'],
            sources: [{ url: 'https://example.com/widgets', title: 'Widgets' }],
            searchQueries: ['widget vendors'],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
        ],
      },
      siteHealth: {
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        status: 'complete',
        score: 71,
        pagesDiscovered: 5,
        pagesFetched: 5,
        pagesObserved: 5,
        elapsedMs: 4200,
        terminationReason: null,
        warnings: [],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error: null,
        factors: [{ id: 'answerability', name: 'Answerability', averageScore: 68, count: 5 }],
        pages: [{
          url: 'https://example.com/',
          status: 'success',
          score: 71,
          depth: 0,
          indexability: 'indexable',
          factors: [{
            id: 'answerability',
            name: 'Answerability',
            score: 68,
            applicable: true,
            findings: [],
            recommendations: ['Add a summary'],
          }],
          criticalDefects: [],
          error: null,
        }],
      },
    },
  }
  return toCanonryDemoViewModel(record, { form: readyForm() })
}

type ClientEvent = { key?: string; preventDefault(): void }

class StubClassList {
  #values = new Set<string>()

  constructor(initial: readonly string[] = []) {
    for (const value of initial) this.#values.add(value)
  }

  toggle(value: string, force?: boolean): boolean {
    const next = force ?? !this.#values.has(value)
    if (next) this.#values.add(value)
    else this.#values.delete(value)
    return next
  }

  add(value: string): void {
    this.#values.add(value)
  }

  remove(value: string): void {
    this.#values.delete(value)
  }

  contains(value: string): boolean {
    return this.#values.has(value)
  }
}

class StubElement {
  readonly classList: StubClassList
  readonly dataset: Record<string, string | undefined>
  disabled = false
  hidden = false
  tabIndex = 0
  textContent: string | null = null
  value = ''
  #attributes = new Map<string, string>()
  #listeners = new Map<string, Array<(event: ClientEvent) => void>>()

  constructor(dataset: Record<string, string | undefined> = {}, classNames: readonly string[] = []) {
    this.dataset = dataset
    this.classList = new StubClassList(classNames)
  }

  addEventListener(type: string, listener: (event: ClientEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? []
    listeners.push(listener)
    this.#listeners.set(type, listeners)
  }

  dispatch(type: string, event: ClientEvent = { preventDefault() {} }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null
  }

  focus(): void {}

  querySelector(_selector: string): StubElement | null {
    return null
  }
}

class StubButton extends StubElement {}

function runClientScript(): {
  queryHint: StubElement
  queryInput: StubElement
  citedButton: StubButton
  mentionedPanel: StubElement
  citedPanel: StubElement
  mentionedSummary: StubElement
  citedSummary: StubElement
  submit: StubButton
  busy: StubElement
  form: StubElement
  restore(): void
} {
  const visibilityTab = new StubButton({ reportTab: 'visibility' })
  const siteHealthTab = new StubButton({ reportTab: 'site-health' })
  const visibilityPanel = new StubElement({ reportPanel: 'visibility' })
  const siteHealthPanel = new StubElement({ reportPanel: 'site-health' })
  const mentionedButton = new StubButton({ visibilityMetric: 'mentioned' }, ['is-active'])
  const citedButton = new StubButton({ visibilityMetric: 'cited' })
  const mentionedPanel = new StubElement({ visibilityPanel: 'mentioned' })
  const citedPanel = new StubElement({ visibilityPanel: 'cited' })
  const mentionedSummary = new StubElement({ visibilitySummary: 'mentioned' })
  const citedSummary = new StubElement({ visibilitySummary: 'cited' })
  const submit = new StubButton()
  const busy = new StubElement()
  busy.hidden = true
  const form = new StubElement()
  form.querySelector = (selector: string) =>
    selector === '[data-domain-submit]' ? submit : selector === '[data-form-busy]' ? busy : null
  const selections: Record<string, StubElement[]> = {
    '[data-report-tab]': [visibilityTab, siteHealthTab],
    '[data-report-panel]': [visibilityPanel, siteHealthPanel],
    '[data-visibility-metric]': [mentionedButton, citedButton],
    '[data-visibility-panel]': [mentionedPanel, citedPanel],
    '[data-visibility-summary]': [mentionedSummary, citedSummary],
  }
  const queryHint = new StubElement({ max: '3' })
  const queryInput = new StubElement()
  const documentStub = {
    querySelectorAll(selector: string): StubElement[] {
      return selections[selector] ?? []
    },
    querySelector(selector: string): StubElement | null {
      if (selector === '[data-domain-check-form]') return form
      if (selector === '[data-query-hint]') return queryHint
      return null
    },
    getElementById(id: string): StubElement | null {
      return id === 'queries-input' ? queryInput : null
    },
  }
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const buttonDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
  Object.defineProperty(globalThis, 'HTMLButtonElement', { configurable: true, value: StubButton })
  Function(canonryDemoClientScript)()

  return {
    queryHint,
    queryInput,
    citedButton,
    mentionedPanel,
    citedPanel,
    mentionedSummary,
    citedSummary,
    submit,
    busy,
    form,
    restore(): void {
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
      else delete (globalThis as { document?: unknown }).document
      if (buttonDescriptor) Object.defineProperty(globalThis, 'HTMLButtonElement', buttonDescriptor)
      else delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement
    },
  }
}

Deno.test('the landing page shows an empty state, never fabricated data', () => {
  const html = renderCanonryDemo(emptyLandingViewModel(readyForm()))

  assert(html.includes('Does AI mention your brand?'), 'the landing page must lead with its one job')
  assert(html.includes('is-hero'), 'the landing form is the hero, not a header afterthought')
  // Scaffolding around an absence: no report header, no tabs, no empty panels.
  assert(!html.includes('report-tabs'), 'nothing has been checked, so there are no report tabs')
  assert(!html.includes('No visibility result'), 'an empty panel is not a landing page')
  assert(!html.includes('Domain report'), 'there is no report to head')
  // The page once shipped a four-engine fixture with an invented trend. Only
  // Gemini is ever measured, so naming another engine here is a false claim.
  for (const engine of ['Claude', 'OpenAI', 'Perplexity', 'gpt-', 'sonar']) {
    assert(!html.includes(engine), `landing page must not name ${engine}`)
  }
  assert(!html.includes('%'), 'landing page must not show a rate before anything is measured')
})

Deno.test('a completed check renders only the engines it actually measured', () => {
  const html = renderCanonryDemo(completedViewModel())

  assert(html.includes('Answer-engine snapshot'), 'snapshot heading should render')
  assert(html.includes('Gemini'), 'the measured engine should render')
  for (const engine of ['Claude', 'OpenAI', 'Perplexity']) {
    assert(!html.includes(engine), `unmeasured engine ${engine} must not appear`)
  }
  assert(
    html.includes('Mentioned') && html.includes('Cited'),
    'mention and citation must stay independently visible',
  )
  assert(html.includes('5-page Technical AEO sample'), 'bounded site sample label should render')
})

Deno.test('tabs, no-JS site evidence, and native form busy state remain accessible', () => {
  const html = renderCanonryDemo(completedViewModel())
  const formScript = canonryDemoClientScript.slice(
    canonryDemoClientScript.indexOf('const form = document.querySelector'),
  )

  assert(
    html.includes('aria-selected="false" tabindex="-1" aria-controls="site-health-panel"'),
    'inactive tab must leave the initial tab stop',
  )
  assert(html.includes('<noscript><div class="no-js-site-health">'), 'site health needs a no-JS fallback')
  assert(html.includes('id="site-health-nojs-heading"'), 'fallback must not duplicate active-panel IDs')
  for (const id of [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])) {
    assert(
      html.split(` id="${id}"`).length === 2,
      `id ${id} must appear once; the noscript fallback needs its own prefix`,
    )
  }
  assert(html.includes('data-domain-submit'), 'form submit control needs a client enhancement seam')
  assert(
    html.includes('data-form-busy role="status" aria-live="polite" hidden'),
    'form must expose a polite busy state',
  )
  assert(formScript.includes("form.addEventListener('submit'"), 'busy state should attach to native form submit')
  assert(formScript.includes("form.setAttribute('aria-busy', 'true')"), 'submit should announce busy')
  // The enhancement now takes submission over so the page can show progress
  // instead of blocking on a 45-second navigation. The no-script path is what
  // must survive, and it survives because the form itself still posts.
  assert(html.includes('method="post"'), 'the form must still submit natively without script')
  assert(html.includes('action="/check"'), 'the native action must remain a real endpoint')
  assert(
    formScript.includes('if (!checking) {'),
    'without the waiting view the script must fall back to the native POST',
  )
  assert(
    formScript.includes('window.turnstile.reset()'),
    'a spent single-use token must be replaced when the page survives a failure',
  )
})

Deno.test('the busy enhancement announces submission without cancelling it', () => {
  const harness = runClientScript()
  try {
    let prevented = false
    harness.form.dispatch('submit', {
      preventDefault() {
        prevented = true
      },
    })
    assert(!prevented, 'form submit enhancement must not cancel native navigation')
    assert(harness.form.getAttribute('aria-busy') === 'true', 'form should advertise busy while navigation begins')
    assert(harness.submit.disabled, 'submit button should lock during native navigation')
    assert(
      harness.busy.hidden === false && harness.busy.textContent === 'Starting check…',
      'busy text should become visible',
    )
  } finally {
    harness.restore()
  }
})

Deno.test('the hint states how many questions will be generated', () => {
  const harness = runClientScript()
  // Read through a call so TypeScript does not narrow the field to the first
  // literal it is compared against.
  const hint = () => String(harness.queryHint.textContent)
  const timing = ` ${QUERY_HINT_SUFFIX}`
  try {
    // No JS, or an empty field: the static sentence stands on its own.
    assert(hint() === `Add up to 3. We generate the rest.${timing}`, `hint was ${hint()}`)

    harness.queryInput.value = 'how do I compare answer engines?'
    harness.queryInput.dispatch('input')
    assert(hint() === `Using your 1. We generate the other 2.${timing}`, `hint was ${hint()}`)

    // Blank and too-short lines are not questions and must not be counted.
    harness.queryInput.value = 'first question here\n\n  \nab\nsecond question here'
    harness.queryInput.dispatch('input')
    assert(hint() === `Using your 2. We generate the other 1.${timing}`, `hint was ${hint()}`)

    harness.queryInput.value = 'one question\ntwo question\nthree question\nfour question'
    harness.queryInput.dispatch('input')
    assert(hint() === `Using your 3. We generate none.${timing}`, `hint was ${hint()}`)
  } finally {
    harness.restore()
  }
})

Deno.test('the timing survives the first keystroke', () => {
  // The server writes the timing into the markup and the client rewrites that
  // whole line on every keystroke. With the suffix in only one of the two, it
  // is on the page until the visitor types and then gone, which no assertion
  // about the initial render would catch.
  const rendered = renderCanonryDemo(emptyLandingViewModel(readyForm()))
  assert(rendered.includes(`We generate the rest. ${QUERY_HINT_SUFFIX}`), 'the server markup states the timing')
  assert(
    canonryDemoClientScript.includes(JSON.stringify(QUERY_HINT_SUFFIX)),
    'the client rewrite must carry the same constant, not drop it',
  )
})

Deno.test('the landing explains itself through a tooltip, not a subtitle', () => {
  const html = renderCanonryDemo(emptyLandingViewModel(readyForm()))

  assert(!html.includes('landing-sub'), 'the subtitle is gone')
  // The copy rides the button's accessible name, so a screen reader and a test
  // both reach it without the tooltip being open.
  assert(
    html.includes('aria-label="An answer engine is asked your questions.'),
    "the explainer must be the trigger's accessible name",
  )
  // A real button, so a keyboard reaches it. :focus-within is what opens the
  // note, and that only fires for something focusable.
  assert(html.includes('<button type="button" class="info-tip-trigger"'), 'the trigger must be a button')
  assert(
    canonryDemoStyles.includes('.info-tip:focus-within .info-tip-body'),
    'the note must open on keyboard focus, not hover alone',
  )
  // No JS opens it: the page CSP allows no inline script, and the tooltip must
  // work before or without the enhancement script.
  assert(!canonryDemoClientScript.includes('info-tip'), 'the tooltip must not depend on the client script')
})

Deno.test('the landing says the check includes a technical SEO audit', () => {
  const html = renderCanonryDemo(emptyLandingViewModel(readyForm()))
  assert(html.includes('technical SEO audit on a sample of your pages'), 'the tooltip states the audit')
  // Stated in the open too, since a fact nobody hovers is a fact nobody reads.
  assert(html.includes('5-page technical SEO audit'), 'the footer states the audit plainly')
})

Deno.test('the question field says what to type, and the example is a customer question', () => {
  const html = renderCanonryDemo(emptyLandingViewModel(readyForm()))

  // "Your questions" named the field without saying what belongs in it. The
  // label is the instruction, since this is the empty state and there is
  // nothing else on the page to explain the input.
  assert(
    html.includes('Questions you want to show up for'),
    'the label must say what the questions are for',
  )
  // The old example asked about answer engines, which is the tool, not the
  // visitor's customers. Someone reading it modelled the wrong question.
  assert(!html.includes('compare AI answer engines'), 'the example must not be about this tool')
  assert(html.includes('best CRM for a small agency'), 'the example must read as a customer question')
  assert(html.includes('One question per line'), 'the format instruction stays')
})

Deno.test('the landing states the one engine and points at the open source project', () => {
  const html = renderCanonryDemo(emptyLandingViewModel(readyForm()))
  assert(html.includes('>Gemini only<'), 'a one-engine sample must say so where the check is started')
  assert(
    html.includes('open source Canonry</a>') && html.includes('https://github.com/Canonry/canonry'),
    'the alternative must be reachable, not just named',
  )
})

Deno.test('the landing states each scope fact exactly once', () => {
  // Three stacked lines used to carry five facts, two of them twice: the
  // question count sat in the hint and again in the footer, and the single
  // engine sat in its own sentence and again in the footer. Repetition is what
  // made the block read as a wall rather than a hierarchy.
  // Counted on the VISIBLE block. The tooltip is progressive disclosure and
  // its copy is deliberately written twice, once as the trigger's accessible
  // name and once as the body, which is one statement for two audiences.
  const html = renderCanonryDemo(emptyLandingViewModel(readyForm()))
    .replace(/<span class="info-tip">[\s\S]*?<\/span><\/span>/, '')
  const count = (needle: string) => html.split(needle).length - 1

  assert(!html.includes('info-tip'), 'the tooltip must be stripped before counting')

  assert(count('Gemini') === 1, `the engine is named once, saw ${count('Gemini')}`)
  assert(count('technical SEO audit') === 1, `the audit is named once, saw ${count('technical SEO audit')}`)
  assert(count('Add up to 3') === 1, `the question allowance is stated once, saw ${count('Add up to 3')}`)
  assert(count('45 seconds') === 1, `the timing is stated once, saw ${count('45 seconds')}`)
  // The footer sentence restated the two facts above it and is gone from the
  // landing. It stays on the RESULT page, where no form states the scope.
  assert(!html.includes('A bounded sample'), 'the footer must not repeat the facts row')
})

Deno.test('the result page keeps the scope caveat the landing no longer needs', () => {
  const html = renderCanonryDemo(completedViewModel())
  assert(
    html.includes('A bounded sample: 3 questions to one answer engine, and a 5-page technical SEO audit.'),
    'a report read on its own must still say what it is a sample of',
  )
})

Deno.test('an instruction is never set in the metadata colour', () => {
  // DESIGN.md: --muted is for nonessential metadata, never for instructions.
  // The hint tells the visitor what to type, so it sits one contrast step up
  // from the scope facts below it, which are metadata and are correctly muted.
  assert(
    canonryDemoStyles.includes('.query-field > p { margin: 0; color: var(--secondary); font-size: 13px; }'),
    'the question hint is an instruction and must not be muted',
  )
  assert(
    canonryDemoStyles.includes('.check-facts {') && canonryDemoStyles.includes('color: var(--muted)'),
    'facts stay metadata',
  )
})

/** Every drawn arc, as the numbers the browser will lay the ring out from. */
function shareArcs(html: string): Array<{ className: string; drawn: number; rest: number; offset: number }> {
  return [...html.matchAll(
    /<circle class="share-arc ([^"]+)"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)" stroke-dashoffset="(-?[\d.]+)"/g,
  )].map((match) => ({
    className: match[1]!,
    drawn: Number(match[2]),
    rest: Number(match[3]),
    offset: Number(match[4]),
  }))
}

Deno.test('share of voice draws the checked site against the field', () => {
  const html = renderCanonryDemo(completedViewModel())

  assert(html.includes('Who else shows up'), 'the share section should render')
  // The heading is basis-neutral now: a toggle switches the table between
  // brands named in the prose and domains cited as sources, so a heading
  // naming one of them would be wrong half the time.
  assert(!html.includes('Who the answers cite'), 'the heading must not name one basis')
  // Ring geometry rides on SVG attributes, never inline style, because the
  // page CSP blocks the latter.
  assert(html.includes('<svg class="share-donut"'), 'the chart must be SVG')
  assert(!html.match(/share-arc[^>]*style=/), 'arcs must not use inline styles')

  assert(html.includes('class="share-arc is-target"'), 'the checked site is the only coloured arc')
  assert(html.includes('>50%<'), `expected an even split, got: ${html.match(/>\d+%</g)}`)
  assert(html.includes('share-you'), 'the checked row should be marked')
  // Citation share and mention coverage are different claims and must not be
  // conflated in the copy.
  assert(html.includes('Domains cited as sources'), 'the basis must be stated, however tersely')
})

Deno.test('the ring is laid out from the counts, not the rounded percent', () => {
  // The fixture cites other.com in one answer and example.com in the other, so
  // the two arcs must be identical and the second must start at the halfway
  // point. Eight rows each rounded to 5% would leave a ring visibly short of
  // closing, which is why the fractions come from the counts.
  const arcs = shareArcs(renderCanonryDemo(completedViewModel()))
  assert(arcs.length === 2, `expected two arcs, got ${arcs.length}`)
  const [first, second] = arcs as [typeof arcs[number], typeof arcs[number]]
  const circumference = first.drawn + first.rest
  assert(Math.abs(first.drawn - second.drawn) < 0.02, 'an even split must draw even arcs')
  assert(first.offset === 0, 'the first arc starts at the top')
  assert(
    Math.abs(second.offset + circumference / 2) < 0.02,
    `the second arc must start halfway round, got ${second.offset}`,
  )
  // Each arc is shortened by a separator, so the drawn length is under its share.
  assert(first.drawn < circumference / 2, 'arcs are separated, not butted together')
})

Deno.test('the hole carries the share, and it is stated exactly once', () => {
  const html = renderCanonryDemo(completedViewModel())
  assert(html.includes('class="share-donut-value"'), 'the hole must hold the share')
  assert(html.includes('your share'), 'the hole must say what the number is')
  // It used to sit in the section header as well. Two copies of one number in
  // one section is the reader wondering which is which.
  assert(!html.includes('share-headline'), 'the header copy of the number is gone')
  assert(html.match(/your share/g)?.length === 1, 'the share is labelled once')
})

Deno.test('a basis with no data is offered and explained, never silently dropped', () => {
  // The section used to render only the bases it had, so a check with no
  // mention data lost the control entirely. A reader cannot tell a missing
  // control from a broken page, and the extraction can fail on a live check
  // too, so this is not only about records written before it shipped.
  const base = completedViewModel()
  const html = renderCanonryDemo({
    ...base,
    visibility: { ...base.visibility!, mentionShare: undefined },
  })

  assert(html.includes('share-basis-mention'), 'the unavailable basis is still offered')
  assert(html.includes('Mentions were not measured on this check.'), 'and it says why it is empty')
  // It must open on the basis that HAS data, or the page loads onto an empty pane.
  assert(
    html.includes('id="share-basis-citation" checked'),
    'the default selection must be a basis with something in it',
  )
  assert(!html.includes('id="share-basis-mention" checked'), 'never open on the empty one')
})

Deno.test('the section is absent only when neither basis was measured', () => {
  const base = completedViewModel()
  const html = renderCanonryDemo({
    ...base,
    visibility: { ...base.visibility!, share: undefined, mentionShare: undefined },
  })
  assert(!html.includes('Who else shows up'), 'no chart is better than a chart of nothing')
})

Deno.test('the basis switch is two radios and CSS, never script', () => {
  const html = renderCanonryDemo(completedViewModel())
  if (!html.includes('share-switch')) return // only one basis measurable in this fixture

  // A control that only works once an external file has loaded is broken on
  // first paint, and the page CSP forbids the inline script that would be the
  // usual shortcut. Radios also carry real keyboard semantics for free.
  assert(html.includes('type="radio"'), 'the switch must be real radios')
  assert(
    canonryDemoStyles.includes('#share-basis-mention:checked ~ .share-pane[data-basis="mention"]'),
    'panes must be revealed by the checked radio',
  )
  assert(!canonryDemoClientScript.includes('share-basis'), 'the switch must not depend on the client script')
})

Deno.test('the two bases never share a table, a caption, or a column header', () => {
  const base = completedViewModel()
  const share = base.visibility?.share
  assert(share, 'fixture must have a citation table')
  const html = renderCanonryDemo({
    ...base,
    visibility: {
      ...base.visibility!,
      mentionShare: { ...share, basis: 'mention', targetDomain: 'Example', entries: share.entries },
    },
  })

  // Mentions are names in prose; citations are domains in sources. Rendering
  // either under the other's label is the conflation the vocabulary rules ban.
  assert(html.includes('Brands named in the answer text'), 'the mention pane states its own basis')
  assert(html.includes('Domains cited as sources'), 'the citation pane states its own basis')
  assert(html.includes('>Brand</th>'), 'a table of names is headed Brand')
  assert(html.includes('>Domain</th>'), 'a table of domains is headed Domain')
})

Deno.test('share of voice is absent, not empty, when nothing attributed a source', () => {
  const base = completedViewModel()
  const html = renderCanonryDemo({
    ...base,
    visibility: { ...base.visibility!, share: undefined },
  })
  assert(!html.includes('Who the answers cite'), 'no chart is better than a chart of nothing')
})

Deno.test('the link graph is reported as numbers, not drawn as a diagram', () => {
  // A 5-page crawl cannot support a graph. On real data every crawled page came
  // back at depth 0 and every discovered target at depth null, and inbound
  // links took three distinct values across 24 nodes. Two of the diagram's
  // three visual channels therefore carried no variation, so position was
  // effectively alphabetical and the picture read as invented. The facts were
  // real; the drawing could not carry them.
  const nodes = [
    {
      key: 'a',
      url: 'https://example.com/',
      label: '/',
      depth: 0,
      crawled: true,
      score: 90,
      indexable: true,
      inboundLinks: 9,
      outboundLinks: 4,
    },
    {
      key: 'b',
      url: 'https://example.com/other',
      label: '/other',
      depth: 0,
      crawled: false,
      score: null,
      indexable: null,
      inboundLinks: 2,
      outboundLinks: 0,
    },
  ]
  const base = completedViewModel()
  const html = renderCanonryDemo({
    ...base,
    siteHealth: {
      ...base.siteHealth!,
      worstPages: [{ url: 'https://example.com/', score: 90, status: 'good', findings: [] }],
      siteMap: { nodes, edges: [], totalPages: 34, totalEdges: 134, truncated: true },
    },
  })

  assert(!html.includes('<svg class="site-map-svg"'), 'the diagram is gone')
  assert(!html.includes('Internal link map'), 'and so is its heading')
  assert(!canonryDemoStyles.includes('.map-edge'), 'its styles go with it')

  // Every fact it carried survives. Inbound links join the pages table by URL,
  // which is the one number the table did not already have.
  assert(html.includes('>Inbound links</th>'), 'the table gains the column')
  assert(html.includes('class="inbound-cell is-numeric">9<'), 'the count is the crawl figure, joined by URL')
  // And the crawl's breadth, which only the diagram used to state.
  assert(
    html.includes('2 of 34 pages and 0 of 134 internal links were seen by this bounded crawl.'),
    'the bounded-crawl counts must not be lost with the picture',
  )
})

Deno.test('typography matches the Canonry dashboard', () => {
  const html = renderCanonryDemo(completedViewModel())

  // The page previously named Geist without ever loading it, so it rendered in
  // a system font. These are the same package and version apps/web bundles.
  assert(
    html.includes('@fontsource-variable/geist@5.3.0/wght.css'),
    'Geist must actually be loaded, not just named in a font stack',
  )
  assert(html.includes('@fontsource-variable/geist-mono@5.3.0/wght.css'), 'Geist Mono must be loaded')
  assert(canonryDemoStyles.includes('"Geist Variable"'), 'the sans stack must ask for the loaded family')
  assert(canonryDemoStyles.includes('"Geist Mono Variable"'), 'the mono stack must ask for the loaded family')
  // Without the stylistic sets and tracking, the same typeface still reads
  // differently from the dashboard.
  assert(canonryDemoStyles.includes('font-feature-settings: "cv11", "ss01", "ss03"'), 'stylistic sets must match')
  assert(canonryDemoStyles.includes('letter-spacing: -0.02em'), 'h1 tracking must match')
})

Deno.test('colour tokens are the dashboard values, not approximations', () => {
  // Sourced from apps/web/src/styles.css. Drifting these is what made the two
  // surfaces look related but not the same.
  for (
    const [name, value] of [
      ['--bg', '#09090b'],
      ['--surface', 'rgb(24 24 27 / 0.3)'],
      ['--border', 'rgb(39 39 42 / 0.6)'],
      ['--border-strong', '#3f3f46'],
      ['--text', '#fafafa'],
      ['--secondary', '#a1a1aa'],
      ['--positive', '#34d399'],
      ['--caution', '#fbbf24'],
      ['--negative', '#fb7185'],
      ['--link', '#60a5fa'],
    ]
  ) {
    assert(canonryDemoStyles.includes(`${name}: ${value};`), `${name} must be ${value}`)
  }
})

Deno.test('asset URLs carry a content hash so a deploy cannot serve stale CSS', () => {
  const html = renderCanonryDemo(completedViewModel())
  const css = html.match(/href="(\/assets\/canonry-ui\.css\?v=[^"]+)"/)
  const js = html.match(/src="(\/assets\/canonry-ui\.js\?v=[^"]+)"/)
  assert(css, 'the stylesheet must be fingerprinted')
  assert(js, 'the client script must be fingerprinted')

  // The whole point: different bytes must produce a different URL.
  assert(
    assetUrl('/a.css', 'one') !== assetUrl('/a.css', 'two'),
    'changed content must change the URL, or a long cache lifetime is a trap',
  )
  assert(assetUrl('/a.css', 'one') === assetUrl('/a.css', 'one'), 'identical content must be stable')
})

Deno.test('no height is reserved for a widget that is normally not drawn', () => {
  // 65px held open under every form for an interaction-only widget is a gap on
  // almost every load, since the common case is that nothing renders there.
  assert(!canonryDemoStyles.includes('min-height: 65px'), 'the turnstile slot must not reserve height')
})

Deno.test('a failed start is styled as a failure, and a fresh submit clears it', () => {
  // "Starting check…" and a failure shared one 13px grey line, sitting under
  // two more 13px grey lines. Restoring the hero after a failure therefore read
  // as the page bouncing back to the form with nothing said, when the reason
  // was on screen the whole time.
  const harness = runClientScript()
  try {
    // A failure from a previous attempt must not survive the next submit.
    harness.busy.classList.add('is-error')
    harness.form.dispatch('submit')
    assert(!harness.busy.classList.contains('is-error'), 'submitting again clears the previous failure')
    assert(harness.busy.textContent === 'Starting check…', 'and states what is happening now')
  } finally {
    harness.restore()
  }

  // The other half runs only in the enhanced branch, which needs a real
  // FormData, so it is pinned at the source: the two must move together.
  assert(
    /busy\.classList\.add\('is-error'\);\s*\n\s*busy\.textContent = message;/.test(canonryDemoClientScript),
    'the failure path must mark the message as a failure',
  )

  // And the treatment has to differ from the help text beside it, which is the
  // whole reason the bounce looked silent.
  assert(canonryDemoStyles.includes('.form-busy.is-error {'), 'a failure gets its own rule')
  assert(
    canonryDemoStyles.includes('.form-busy { margin: 2px 0 0; color: var(--secondary);'),
    'the neutral line keeps the ordinary colour',
  )
  const errorRule = canonryDemoStyles.slice(canonryDemoStyles.indexOf('.form-busy.is-error {'))
  assert(errorRule.slice(0, 140).includes('var(--caution)'), 'and the failure does not')
})

Deno.test('a numeric column is aligned once, on the column, not per cell', () => {
  // The alignment used to live on the cell classes only, so every header
  // inherited the table's left and sat half a table away from its own numbers.
  // Two places that had to be kept in step by hand, and were not.
  const html = renderCanonryDemo(completedViewModel())

  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    const head = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''
    // Lookahead, because `<th[^>]*>` also matches `<thead>` and shifts every index.
    const headers = head.match(/<th(?=[\s>])[^>]*>/g) ?? []
    const numericColumns = new Set(
      headers.flatMap((cell, index) => cell.includes('is-numeric') ? [index] : []),
    )

    for (const row of table.match(/<tr>(?:(?!<\/tr>)[\s\S])*<\/tr>/g) ?? []) {
      if (row.includes('<th scope="col"')) continue
      const cells = row.match(/<(?:td|th)(?=[\s>])[^>]*>/g) ?? []
      cells.forEach((cell, index) => {
        const cellIsNumeric = cell.includes('is-numeric')
        assert(
          cellIsNumeric === numericColumns.has(index),
          `column ${index}: header and cell disagree about alignment (${cell})`,
        )
      })
    }
  }

  // And the alignment itself is stated once, keyed off that one class.
  assert(
    canonryDemoStyles.includes('.compact-table .is-numeric, .evidence-table .is-numeric { text-align: right; }'),
    'the class must be what aligns the column',
  )
  assert(
    !canonryDemoStyles.includes(
      '.share-count { color: var(--muted); font-family: var(--mono); font-size: 12px; text-align: right;',
    ),
    'no second source of alignment',
  )
})

Deno.test('the renderer emits no inline styles, which the page CSP would block', () => {
  assert(!renderCanonryDemo(completedViewModel()).includes('style='), 'renderer must not emit inline styles')
})

Deno.test('Turnstile uses the fixed audit action only when a site key exists', () => {
  const base = completedViewModel()
  const configured = renderCanonryDemo({
    ...base,
    form: {
      ...base.form!,
      verificationStatus: 'ready',
      turnstileSiteKey: '1x00000000000000000000AA',
      turnstileAction: 'audit',
    },
  })
  assert(
    configured.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'),
    'configured Turnstile should load the canonical script',
  )
  assert(configured.includes('data-action="audit"'), 'Turnstile action must be audit')

  // The widget is drawn only when the visitor must do something. Under the
  // default it was always visible, so the RESULT page showed a green
  // "Success!" panel beside the check-another-domain form: a challenge
  // announcing its own outcome next to a report the visitor had already read.
  assert(
    configured.includes('data-appearance="interaction-only"'),
    'a solved challenge must not draw a success panel over the report',
  )
  // Still present on the result page, which is what makes a second check
  // possible: the token is obtained on load, it is only the widget that hides.
  assert(
    configured.includes('class="cf-turnstile"'),
    'the result-page form still needs a token to submit again',
  )

  // Built through the real config path — checks enabled but Turnstile absent —
  // rather than by hand-setting a status without its matching message.
  const unavailable = renderCanonryDemo({
    ...base,
    form: createPublicCheckForm({
      publicChecksEnabled: true,
      publicChecksUnavailableMessage: null,
      humanVerificationStatus: 'unavailable',
      turnstileSiteKey: null,
    }),
  })
  assert(
    unavailable.includes('Human verification is not configured. Public checks are disabled.'),
    'unavailable verification should explain the disabled state',
  )
  assert(
    unavailable.includes('disabled aria-disabled="true"'),
    'unavailable verification must disable the submit action',
  )
  assert(
    !unavailable.includes('challenges.cloudflare.com'),
    'unconfigured verification must not load the third-party script',
  )
})

Deno.test('full public-check unavailability disables the form even with a ready Turnstile configuration', () => {
  const form = createPublicCheckForm({
    publicChecksEnabled: false,
    publicChecksUnavailableMessage: 'Public checks are temporarily unavailable.',
    humanVerificationStatus: 'ready',
    turnstileSiteKey: '1x00000000000000000000AA',
  })
  const html = renderCanonryDemo({ ...completedViewModel(), form })

  assert(form.verificationStatus === 'unavailable', 'admission unavailability must override CAPTCHA readiness')
  assert(form.turnstileSiteKey === null, 'disabled public checks must not render a CAPTCHA widget')
  assert(
    html.includes('Public checks are temporarily unavailable.'),
    'disabled form should explain full capability unavailability',
  )
  assert(html.includes('disabled aria-disabled="true"'), 'unavailable public checks must disable native submission')
  assert(!html.includes('challenges.cloudflare.com'), 'disabled public checks must not load Turnstile')
})

Deno.test('rate-limited native records retain a rate-limit presentation state', () => {
  const record: CheckRecord<CheckResult> = {
    id: 'check-rate-limited',
    fingerprint: '',
    userQueries: [],
    domain: 'example.com',
    status: 'failed',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    expiresAt: null,
    result: null,
    errorCode: PUBLIC_RATE_LIMITED_ERROR_CODE,
    errorMessage: 'Daily check limit reached.',
    leaseOwner: null,
    leaseUntil: null,
  }
  const model = toCanonryDemoViewModel(record)
  const html = renderCanonryDemo(model)

  assert(model.status === 'rate-limited', 'controlled native quota failure must reach the rate-limited UI state')
  assert(html.includes('data-ui-status="rate-limited"'), 'rate-limited state should be machine-readable in the page')
  assert(html.includes('Check limit reached'), 'rate-limited state should use its own recovery heading')
  assert(html.includes('Daily check limit reached.'), 'rate-limit detail should retain the controlled retry message')
})

Deno.test('record mapping keeps an absent visibility report absent rather than zero', () => {
  const record: CheckRecord<CheckResult> = {
    id: 'check-empty',
    fingerprint: 'fingerprint',
    userQueries: [],
    domain: 'example.com',
    status: 'complete',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-01T00:00:01.000Z',
      visibility: null,
      siteHealth: null,
      errors: [],
    },
  }
  const model = toCanonryDemoViewModel(record)
  const html = renderCanonryDemo(model)

  assert(model.visibility === undefined, 'missing visibility is not a 0% report')
  assert(html.includes('No visibility result'), 'missing visibility should have a truthful empty state')
  assert(!html.includes('0.0%'), 'renderer must not turn null visibility into a numeric score')
})

Deno.test('record mapping converts fractional probe rates into display percentages', () => {
  const evidence = [0, 1, 2].map((index) => ({
    query: `query ${index + 1}`,
    provider: 'gemini',
    requestedModel: 'gemini-2.5-flash',
    servedModel: 'gemini-2.5-flash',
    completedAt: '2026-09-01T00:00:01.000Z',
    answerText: 'A short answer.',
    mentioned: index < 2,
    matchedTerms: index < 2 ? ['Example'] : [],
    cited: index < 2,
    citedDomains: [],
    citedUrls: ['https://directory.example/listing', 'https://example.com/services'],
    matchedCitationUrls: ['https://example.com/services'],
    sources: [
      { url: 'https://directory.example/listing', title: 'Directory' },
      { url: 'https://example.com/services', title: 'Services' },
    ],
    searchQueries: [],
    namedBrands: null,
    retrievalStatus: 'grounded' as const,
    error: null,
  }))
  const record = {
    id: 'check-rates',
    fingerprint: 'fingerprint',
    userQueries: [],
    domain: 'example.com',
    status: 'complete',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-01T00:00:01.000Z',
      visibility: {
        schemaVersion: '1.0',
        domain: 'example.com',
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:00:01.000Z',
        summary: { successfulChecks: 3, failedChecks: 0, mentionRate: 2 / 3, citationRate: 2 / 3 },
        evidence,
      },
      siteHealth: null,
      errors: [],
    },
  } as unknown as CheckRecord<CheckResult>
  const model = toCanonryDemoViewModel(record)
  const html = renderCanonryDemo(model)

  assert(
    model.visibility?.summaries.mentioned.rate === 66.66666666666666,
    'fractional rate should convert to a 0..100 UI value',
  )
  assert(html.includes('66.7%'), 'display should round a two-of-three rate to 66.7%')
  assert(
    !html.includes('Directory</a><span class="source-host">directory.example · target source'),
    'unmatched provider sources must not be called target citations',
  )
  assert(
    html.includes('Services</a><span class="source-host">example.com · target source'),
    'matched citation URLs should be called target citations',
  )
})

Deno.test('failed provider observations stay not measured rather than false', () => {
  const record = {
    id: 'check-failed-observation',
    fingerprint: 'fingerprint',
    userQueries: [],
    domain: 'example.com',
    status: 'partial',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-01T00:00:01.000Z',
      visibility: {
        schemaVersion: '1.0',
        domain: 'example.com',
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: '2026-09-01T00:00:01.000Z',
        summary: { successfulChecks: 0, failedChecks: 1, mentionRate: null, citationRate: null },
        evidence: [{
          query: 'example query',
          provider: 'gemini',
          requestedModel: 'gemini-2.5-flash',
          servedModel: null,
          completedAt: '2026-09-01T00:00:01.000Z',
          answerText: null,
          mentioned: null,
          cited: null,
          matchedTerms: [],
          citedDomains: [],
          citedUrls: [],
          matchedCitationUrls: [],
          sources: [],
          searchQueries: [],
          namedBrands: null,
          retrievalStatus: 'error',
          error: 'Timed out.',
        }],
      },
      siteHealth: null,
      errors: [],
    },
  } as unknown as CheckRecord<CheckResult>
  const html = renderCanonryDemo(toCanonryDemoViewModel(record))

  assert(html.includes('Not measured'), 'null visibility signals should never be rendered as false')
  assert(!html.includes('Not cited'), 'failed observations must not become Not cited')
})

Deno.test('site-health mapping preserves not-applicable factors and partial provenance', () => {
  const record = {
    id: 'check-partial-site-health',
    fingerprint: 'fingerprint',
    userQueries: [],
    domain: 'example.com',
    status: 'partial',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-01T00:00:01.000Z',
      visibility: null,
      siteHealth: {
        schemaVersion: '1.2',
        engineVersion: 'audit-1.2.0',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        status: 'partial',
        score: 80,
        pagesDiscovered: 3,
        pagesFetched: 1,
        pagesObserved: 2,
        elapsedMs: 120_000,
        terminationReason: 'max-duration',
        warnings: [],
        factors: [
          { id: 'faq', name: 'FAQ content', averageScore: 0, count: 0 },
          { id: 'metadata', name: 'Metadata', averageScore: 70, count: 2 },
        ],
        pages: [{
          url: 'https://example.com/',
          status: 'success',
          score: 80,
          depth: 0,
          indexability: 'indexable',
          factors: [
            { id: 'faq', name: 'FAQ content', score: 0, applicable: false, findings: [], recommendations: [] },
            {
              id: 'metadata',
              name: 'Metadata',
              score: 70,
              applicable: true,
              findings: [],
              recommendations: ['Add a precise page title.'],
            },
          ],
          criticalDefects: [],
          error: null,
        }, {
          url: 'https://example.com/services',
          status: 'success',
          score: 70,
          depth: 1,
          indexability: 'indexable',
          factors: [
            { id: 'faq', name: 'FAQ content', score: 0, applicable: false, findings: [], recommendations: [] },
            {
              id: 'metadata',
              name: 'Metadata',
              score: 70,
              applicable: true,
              findings: [],
              recommendations: ['Add a precise page title.'],
            },
          ],
          criticalDefects: [],
          error: null,
        }],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error: null,
      },
      errors: [],
    },
  } as unknown as CheckRecord<CheckResult>
  const model = toCanonryDemoViewModel(record)
  const html = renderCanonryDemo(model)

  // Found by id, not by position: factors are ranked by score, and an
  // unmeasured one has no score to rank on, so it sits at the end.
  const inapplicable = model.siteHealth?.factors.find((factor) => factor.id === 'faq')
  assert(
    inapplicable?.state === 'not-applicable',
    'all inapplicable page factors should remain not applicable',
  )
  assert(inapplicable?.score === null, 'not-applicable factors should not expose a made-up score')
  assert(model.siteHealth?.discoveredPages === 3, 'bounded crawl discoveries must remain available')
  // A recommendation repeated across sampled pages is one fix, not several:
  // five pages of one template must not read as five problems.
  const withFix = model.siteHealth?.factors.find((factor) => factor.recommendations.length > 0)
  assert(withFix, 'a factor carrying a recommendation should exist')
  assert(
    withFix.recommendations.filter((text) => text === 'Add a precise page title.').length === 1,
    `a fix seen on two pages must appear once, got ${JSON.stringify(withFix.recommendations)}`,
  )
  assert(model.siteHealth?.terminationReason === 'max-duration', 'partial termination reason must remain in the model')
  assert(model.siteHealth?.provenance?.schemaVersion === '1.2', 'crawl schema must remain available')
  assert(model.siteHealth?.provenance?.rootUrl === 'https://example.com/', 'requested crawl root must remain available')
  assert(
    model.siteHealth?.provenance?.finalRootUrl === 'https://example.com/',
    'resolved crawl root must remain available',
  )
  assert(
    model.siteHealth?.provenance?.attemptedHosts?.join(',') === 'example.com',
    'attempted hosts must remain available',
  )
  assert(
    model.siteHealth?.provenance?.engineVersion === 'audit-1.2.0',
    'optional engine provenance must remain available',
  )
  assert(html.includes('Not applicable'), 'renderer should distinguish non-applicability from unavailable')
  assert(html.includes('<strong>3</strong> pages discovered'), 'renderer should disclose bounded crawl discovery count')
  assert(html.includes('2 sampled pages.'), 'renderer should show the affected sampled-page count for a live fix')
  // The reason stays visible as evidence; only the framing changed. Reaching a
  // limit this app configured is the sample working, not a partial failure.
  assert(
    html.includes('Stopped at a configured limit: max duration.'),
    'the termination reason must remain visible as evidence',
  )
  assert(!html.includes('Partial termination'), 'and must not be framed as a failure')
  assert(html.includes('Crawl schema 1.2 · Engine audit-1.2.0'), 'crawl provenance must remain visible as evidence')
})

Deno.test('a stored partial with nothing failed does not warn the reader', () => {
  // `record.status` is decided once and stored. When the rule behind it was
  // corrected, every check already written kept the old verdict for its whole
  // 24h life — so a reader opening a shared link still saw "Partial result /
  // Failed checks are shown separately" over a run where nothing failed.
  // The evidence is in the result, so the caution reads that instead.
  const record = {
    id: '11111111-2222-4333-8444-555555555555',
    fingerprint: 'f',
    userQueries: [],
    domain: 'example.com',
    status: 'partial',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:20.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-02T00:00:20.000Z',
      errors: [],
      visibility: {
        schemaVersion: '1',
        domain: 'example.com',
        startedAt: '2026-09-02T00:00:00.000Z',
        completedAt: '2026-09-02T00:00:20.000Z',
        summary: { successfulChecks: 3, failedChecks: 0, mentionRate: 0, citationRate: 0 },
        evidence: [{
          query: 'q',
          provider: 'gemini',
          requestedModel: 'm',
          servedModel: 'm',
          completedAt: '2026-09-02T00:00:10.000Z',
          answerText: 'text',
          mentioned: false,
          matchedTerms: [],
          cited: false,
          citedDomains: [],
          citedUrls: [],
          matchedCitationDomains: [],
          matchedCitationUrls: [],
          sources: [],
          searchQueries: [],
          namedBrands: [],
          retrievalStatus: 'grounded',
          error: null,
        }],
      },
      // A crawl that stopped at its own page cap, which is the sample working.
      siteHealth: {
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        status: 'partial',
        score: 80,
        pagesDiscovered: 5,
        pagesFetched: 5,
        pagesObserved: 5,
        elapsedMs: 900,
        terminationReason: 'max-pages',
        warnings: [],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error: null,
        factors: [],
        pages: [],
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any

  const clean = toCanonryDemoViewModel(record)
  assert(clean.status === 'ready', `a stored partial with no failure reads as ready, got ${clean.status}`)
  assert(!renderCanonryDemo(clean).includes('Partial result'), 'and paints no caution banner')

  // But a real failure still warns: one unmeasured probe is a failed check.
  const withFailure = structuredClone(record)
  withFailure.result.visibility.evidence[0].mentioned = null
  withFailure.result.visibility.evidence[0].cited = null
  assert(
    toCanonryDemoViewModel(withFailure).status === 'partial',
    'a probe that never completed must still raise the caution',
  )

  // And so does a recorded phase error, even with every probe fine.
  const withPhaseError = structuredClone(record)
  withPhaseError.result.errors = [{ area: 'visibility', code: 'unavailable', message: 'boom' }]
  assert(toCanonryDemoViewModel(withPhaseError).status === 'partial', 'a phase error must still raise the caution')
})

Deno.test('no caution anywhere unless a page actually failed', () => {
  // There were TWO of these, keyed off the same frozen status: the top-level
  // "Partial result" and a "Partial site sample" inside Site Health. Fixing one
  // and grepping for its exact title missed the other, so the banner appeared
  // to be gone and was not.
  const base = completedViewModel()
  const health = base.siteHealth!

  const clean = renderCanonryDemo({
    ...base,
    siteHealth: { ...health, failedPages: 0, completedPages: 5, attemptedPages: 5, notice: undefined },
  })
  for (const caution of ['Partial result', 'Partial site sample']) {
    assert(!clean.includes(caution), `"${caution}" must not appear when nothing failed`)
  }

  // A page that genuinely could not be audited still warns, and says how many.
  const withFailure = toCanonryDemoViewModel(recordWithFailedPage())
  const html = renderCanonryDemo(withFailure)
  assert(html.includes('Partial site sample'), 'a failed page must still raise the caution')
  assert(
    html.includes('1 of 5 sampled pages could not be audited'),
    'the caution pluralizes on the sample size, not the single-failure count',
  )
})

/** One completed check whose crawl audited four pages and failed one. */
function recordWithFailedPage() {
  const page = (url: string, ok: boolean) => ({
    url,
    status: ok ? 'success' : 'error',
    score: ok ? 80 : null,
    depth: 0,
    indexability: 'indexable',
    factors: [],
    criticalDefects: [],
    error: ok ? null : 'This page could not be audited.',
  })
  return {
    id: '11111111-2222-4333-8444-555555555555',
    fingerprint: 'f',
    userQueries: [],
    domain: 'example.com',
    status: 'complete',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:20.000Z',
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-09-02T00:00:20.000Z',
      errors: [],
      visibility: null,
      siteHealth: {
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        status: 'complete',
        score: 80,
        pagesDiscovered: 5,
        pagesFetched: 5,
        pagesObserved: 5,
        elapsedMs: 900,
        terminationReason: 'max-pages',
        warnings: [],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error: null,
        factors: [],
        pages: [page('https://example.com/a', true), page('https://example.com/b', false)],
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any
}
