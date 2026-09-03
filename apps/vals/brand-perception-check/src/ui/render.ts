import { MAX_USER_QUERIES } from 'npm:@canonry/val-kit@0.1.0/jobs'
import { canonryGlyph, canonryMark } from 'npm:@canonry/val-kit@0.1.0/ui'
import { brandPerceptionClientScript, QUERY_HINT_SUFFIX } from './client.ts'
import { brandPerceptionStyles } from './styles.ts'
import type {
  BrandPerceptionViewModel,
  DemoUiStatus,
  PerceptionAnswerViewModel,
  PerceptionSourceViewModel,
  PerceptionViewModel,
  UiNotice,
} from './types.ts'

const DEFAULT_CSS_HREF = '/assets/canonry-ui.css'
const DEFAULT_SCRIPT_SRC = '/assets/canonry-ui.js'
const DEFAULT_MARK_SRC = '/assets/canonry-mark.svg'
const DEFAULT_GLYPH_SRC = '/assets/canonry-glyph.svg'

/** The product's name, written once and used everywhere a name appears. */
export const PRODUCT_NAME = 'Brand Perception Check'

/**
 * Fingerprint an asset's own content into its URL.
 *
 * The document is `no-store` but a stylesheet on a TTL means that after a deploy
 * a returning visitor gets new markup styled by an old stylesheet — new class
 * names unstyled, removed ones still applied. A content hash changes the URL
 * exactly when the bytes change, which is what makes a long cache lifetime safe
 * rather than a liability.
 *
 * FNV-1a rather than SHA-256 because this runs at module load and only has to
 * differ when the content differs; it is a cache key, not a security boundary.
 */
export function assetUrl(path: string, content: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${path}?v=${hash.toString(36)}`
}

const MAX_ANSWER_CHARS = 1_400

/** Where "open source Canonry" points. */
const CANONRY_REPO_URL = 'https://github.com/Canonry/canonry'

/**
 * What the check actually does, carried by the heading's tooltip rather than a
 * subtitle. The trigger is a real button, and the copy rides its `aria-label`
 * so nothing is lost for assistive tech or for a test that looks the button up
 * by accessible name.
 */
const LANDING_EXPLAINER =
  'An answer engine is asked questions that name this brand. We record the position each answer takes and quote the ' +
  'sentences it wrote that carry it, along with the concerns it raises and the sources it attributed.'

const VERDICT_TIP =
  'Each answer is read back for the position it takes, and a verdict is kept only when sentences copied word for ' +
  'word out of that answer carry it. "Took no position" means the answer described the brand without recommending ' +
  'or cautioning, which is a finding. Nothing here is a sentiment score.'

const ANSWERS_TIP =
  'Every question here names the brand, so the engine was always going to discuss it. The finding is what it said, ' +
  'not whether it appeared, which makes this a different instrument from an AI visibility rate and never comparable ' +
  'to one. Open a row for the full quotations, the concerns, and the sources behind that answer.'

const CONCERNS_TIP =
  'A concern is a short phrase the answer itself writes as a drawback, verified word for word against the prose. It ' +
  'counts once per answer, however often that answer repeats it, so one verbose answer cannot outrank a concern ' +
  'three separate answers raised.'

const SOURCES_TIP =
  'The sources this answer engine attributed for these answers, grouped by kind. A kind counts once per answer, so ' +
  'eight links to one forum is one answer leaning on community sources. This is not a claim about where opinions ' +
  'about the brand come from on the web — three answers cannot support that.'

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replaceAll('`', '&#96;')
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeHref(value: string): string | null {
  if (value.startsWith('/') && !value.startsWith('//')) return value
  return safeUrl(value)
}

function safeFormAction(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/check'
}

function safeHost(value: string): string {
  const url = safeUrl(value)
  if (!url) return 'Unavailable source'
  return new URL(url).hostname
}

function clip(value: string | null | undefined, limit = MAX_ANSWER_CHARS): string {
  if (!value) return ''
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function formatTime(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function statusCopy(status: DemoUiStatus): UiNotice | null {
  switch (status) {
    case 'loading':
      return {
        tone: 'neutral',
        title: 'Checking this brand',
        detail: 'The report will appear here when the bounded check finishes.',
      }
    case 'partial':
      return {
        tone: 'caution',
        title: 'Partial result',
        detail: 'Only the answers that were measured are counted below. The rest are shown as not measured.',
      }
    case 'error':
      return {
        tone: 'negative',
        title: 'This check could not finish',
        detail: 'Try again later or use a domain that responds publicly.',
      }
    case 'rate-limited':
      return {
        tone: 'caution',
        title: 'Check limit reached',
        detail: 'This public sample has reached its current limit. Try again later.',
      }
    case 'empty':
      return { tone: 'neutral', title: 'No report yet', detail: 'Enter a public domain to create a bounded snapshot.' }
    default:
      return null
  }
}

function renderNotice(notice: UiNotice | undefined): string {
  if (!notice) return ''
  const href = notice.action?.href ? safeHref(notice.action.href) : null
  const action = href && notice.action
    ? `<a class="notice-link" href="${escapeAttr(href)}">${escapeHtml(notice.action.label)}</a>`
    : ''
  return `
    <aside class="notice notice-${escapeAttr(notice.tone)}" role="status">
      <span class="notice-glyph" aria-hidden="true">${notice.tone === 'neutral' ? 'i' : '!'}</span>
      <div>
        <p class="notice-title">${escapeHtml(notice.title)}</p>
        <p class="notice-detail">${escapeHtml(notice.detail)}</p>
      </div>
      ${action}
    </aside>`
}

/** Hover- and focus-revealed note. CSS only, because the page CSP allows no inline script. */
function renderInfoTip(copy: string): string {
  return `<span class="info-tip"><button type="button" class="info-tip-trigger" aria-label="${
    escapeAttr(copy)
  }"><span aria-hidden="true">i</span></button><span class="info-tip-body" aria-hidden="true">${
    escapeHtml(copy)
  }</span></span>`
}

/**
 * One tone vocabulary for the whole page. The badge and the KPI cell read the
 * SAME `verdictTone`, so the colour of "Cautions" cannot be rose in one place
 * and amber in the other — which is what happens when a renderer decides tone
 * a second time.
 */
const VERDICT_TONE_CLASS = {
  positive: 'signal-positive',
  negative: 'signal-negative',
  caution: 'signal-caution',
  neutral: 'signal-neutral',
} as const

const VERDICT_GLYPH = { recommends: '✓', cautions: '!', mixed: '~', none: '−' } as const

/** A verdict badge, never a score. An unmeasured row is dimmed, not toned. */
function verdictBadge(answer: PerceptionAnswerViewModel): string {
  const glyph = answer.verdict === null ? '?' : VERDICT_GLYPH[answer.verdict]
  const className = answer.verdict === null ? 'signal-unavailable' : VERDICT_TONE_CLASS[answer.verdictTone]
  return `<span class="signal ${className}"><span aria-hidden="true">${glyph}</span>${
    escapeHtml(answer.verdictLabel)
  }</span>`
}

/**
 * The headline cell.
 *
 * A measured verdict quotes the answer's own first verified sentence. `none`
 * gets a statement of what happened, and an unmeasured row gets the reason it
 * was not measured — the row already says "Not measured", and the question a
 * reader then asks is "why".
 */
function answerHeadlineCell(answer: PerceptionAnswerViewModel): string {
  if (answer.verdict === null) {
    return `<span class="answer-error">${escapeHtml(answer.error ?? 'This answer was not measured.')}</span>`
  }
  if (answer.headline) {
    return `<q class="answer-quote">${escapeHtml(answer.headline)}</q>`
  }
  return '<span class="answer-note">The answer described the brand without taking a position.</span>'
}

function renderSource(source: PerceptionSourceViewModel): string {
  const url = safeUrl(source.url)
  const title = source.title?.trim() || (url ? safeHost(url) : 'Unavailable source')
  const host = url ? safeHost(url) : source.domain
  const meta = `${escapeHtml(host ?? 'Unattributed host')} · ${escapeHtml(source.typeLabel)}`
  if (!url) {
    return `<li><span class="source-title">${escapeHtml(title)}</span><span class="source-host">${meta}</span></li>`
  }
  return `<li><a href="${escapeAttr(url)}" rel="noreferrer" target="_blank" class="source-title">${
    escapeHtml(title)
  }</a><span class="source-host">${meta}</span></li>`
}

function renderAnswerDetails(answer: PerceptionAnswerViewModel): string {
  const quotes = answer.evidenceSentences.length
    ? `<div><p class="detail-label">What the answer said</p><ul class="quote-list">${
      answer.evidenceSentences.map((sentence) => `<li><q>${escapeHtml(sentence)}</q></li>`).join('')
    }</ul></div>`
    : `<div><p class="detail-label">What the answer said</p><p class="detail-empty">${
      answer.verdict === null
        ? 'This answer was not measured, so nothing was read out of it.'
        : 'No sentence in this answer took a position on the brand.'
    }</p></div>`
  const concerns = answer.concerns.length
    ? `<div><p class="detail-label">Concerns this answer raised</p><ul class="chip-list">${
      answer.concerns.map((concern) => `<li>${escapeHtml(concern)}</li>`).join('')
    }</ul></div>`
    : ''
  const sources = answer.sources.length
    ? `<ul class="source-list">${answer.sources.map(renderSource).join('')}</ul>`
    : `<p class="detail-empty">${
      answer.verdict === null
        ? 'This answer was not measured, so no source was attributed to it.'
        : 'The engine attributed no source to this answer.'
    }</p>`
  const searches = answer.searchQueries.length
    ? `<p><span class="detail-label">Searches the engine ran</span>${
      escapeHtml(answer.searchQueries.join(', '))
    }</p>`
    : ''
  const models = [
    answer.requestedModel ? `<span>Requested: <code>${escapeHtml(answer.requestedModel)}</code></span>` : '',
    answer.servedModel ? `<span>Served: <code>${escapeHtml(answer.servedModel)}</code></span>` : '',
    answer.completedAt && formatTime(answer.completedAt)
      ? `<span>Completed: ${escapeHtml(formatTime(answer.completedAt)!)}</span>`
      : '',
  ].filter(Boolean).join('')
  const answerText = answer.answerText
    ? `<div class="evidence-answer"><p class="detail-label">Full answer</p><blockquote>${
      escapeHtml(clip(answer.answerText))
    }</blockquote></div>`
    : '<p class="detail-empty">Answer text was not retained for this result.</p>'
  const error = answer.error
    ? `<p class="detail-error"><span class="detail-label">Not measured</span>${escapeHtml(answer.error)}</p>`
    : ''
  return `
    <details class="evidence-detail">
      <summary>View evidence<span class="sr-only"> for ${escapeHtml(answer.query)}</span></summary>
      <div class="evidence-content">
        <div class="evidence-meta">${models}</div>
        ${quotes}${concerns}${error}
        <div><p class="detail-label">Sources</p>${sources}</div>
        ${searches}
        ${answerText}
      </div>
    </details>`
}

/**
 * The headline row.
 *
 * Flat KPI cells, never progress bars: "2 of 3 answers" has no target to fill,
 * and a bar would invent one. The denominator is written under every number
 * rather than once at the top, because the number and the bound it rests on
 * have to be read together.
 */
function renderVerdictSnapshot(perception: PerceptionViewModel): string {
  const measured = perception.measuredAnswers
  const checkedAt = formatTime(perception.checkedAt)
  const cells = perception.verdicts.map((verdict) =>
    `<div class="is-${escapeAttr(verdict.tone)}"><dt>${escapeHtml(verdict.label)}</dt>${
      measured === 0
        ? '<dd class="is-unmeasured">Not measured</dd>'
        : `<dd>${verdict.count}</dd>`
    }<span>${
      measured === 0 ? 'No answer was measured' : `of ${measured} ${plural(measured, 'answer', 'answers')}`
    }</span></div>`
  ).join('')
  return `
    <section class="analysis-section" aria-labelledby="verdict-snapshot-heading">
      <div class="section-heading">
        <div><h2 id="verdict-snapshot-heading">Verdict snapshot${renderInfoTip(VERDICT_TIP)}</h2></div>
        ${checkedAt ? `<p class="checked-at">Checked ${escapeHtml(checkedAt)}</p>` : ''}
      </div>
      <div class="sample-facts" role="status"><span><strong>${perception.requestedAnswers}</strong> branded ${
    plural(perception.requestedAnswers, 'question', 'questions')
  }</span><span>Gemini</span><span><strong>${measured}</strong> measured</span></div>
      <dl class="verdict-row" aria-label="Verdict snapshot">${cells}</dl>
    </section>`
}

function renderAnswers(perception: PerceptionViewModel): string {
  const rows = perception.answers.map((answer) => `
    <tr>
      <th scope="row"><span class="query-text">${escapeHtml(answer.query)}</span></th>
      <td>${verdictBadge(answer)}</td>
      <td>${answerHeadlineCell(answer)}</td>
      <td class="source-count is-numeric">${
    // An unmeasured answer has no sources because there is no answer, not
    // because the engine attributed none. A 0 here would be a measured zero.
    answer.verdict === null
      ? '<span class="cell-unknown">not measured</span>'
      : answer.sources.length
  }</td>
      <td>${renderAnswerDetails(answer)}</td>
    </tr>`).join('')
  const empty =
    '<div class="empty-state"><p class="empty-title">No answers were recorded</p><p>Answers appear once the engine replies to a branded question.</p></div>'
  return `
    <section class="analysis-section" aria-labelledby="answers-heading">
      <div class="section-heading"><div><h2 id="answers-heading">Answers${renderInfoTip(ANSWERS_TIP)}</h2></div></div>
      ${perception.notice ? renderNotice(perception.notice) : ''}
      ${
    perception.answers.length
      ? `<div class="table-wrap"><table class="evidence-table"><thead><tr><th scope="col">Branded question</th><th scope="col">Verdict</th><th scope="col">What the answer said</th><th scope="col" class="is-numeric">Sources</th><th scope="col"><span class="sr-only">Evidence</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : empty
  }
    </section>`
}

function renderConcerns(perception: PerceptionViewModel): string {
  const measured = perception.measuredAnswers
  const body = perception.concerns.length
    ? `<ul class="concern-list">${
      perception.concerns.map((concern) =>
        `<li><span class="concern-phrase">${escapeHtml(concern.phrase)}</span><span class="concern-count">in ${concern.answers} of ${measured} ${
          plural(measured, 'answer', 'answers')
        }</span></li>`
      ).join('')
    }</ul>`
    : `<p class="detail-empty">${
      measured === 0
        ? 'No answer was measured, so no concern could be read out of one.'
        : `No concern was raised in the ${measured} ${plural(measured, 'answer', 'answers')} measured.`
    }</p>`
  return `
    <section class="analysis-section" aria-labelledby="concerns-heading">
      <div class="section-heading"><div><h2 id="concerns-heading">Concerns raised${
    renderInfoTip(CONCERNS_TIP)
  }</h2></div></div>
      ${body}
    </section>`
}

function renderSourceTypes(perception: PerceptionViewModel): string {
  const share = perception.sourceTypes
  const body = share
    ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th scope="col">Kind of source</th><th scope="col" class="is-numeric">Answers</th><th scope="col" class="is-numeric">Share</th></tr></thead><tbody>${
      share.entries.map((entry) =>
        `<tr><th scope="row">${escapeHtml(entry.label)}</th><td class="source-count is-numeric">${entry.answers} of ${share.measuredAnswers}</td><td class="source-share is-numeric">${entry.percent}%</td></tr>`
      ).join('')
    }</tbody></table></div>${
      share.unattributedAnswers > 0
        ? `<p class="section-footnote">${share.unattributedAnswers} measured ${
          plural(share.unattributedAnswers, 'answer', 'answers')
        } attributed no source at all, and ${
          plural(share.unattributedAnswers, 'is', 'are')
        } excluded from the share.</p>`
        : ''
    }`
    : `<p class="detail-empty">${
      perception.measuredAnswers === 0
        ? 'No answer was measured, so no source could be attributed.'
        : 'No measured answer attributed a source.'
    }</p>`
  return `
    <section class="analysis-section" aria-labelledby="sources-heading">
      <div class="section-heading"><div><h2 id="sources-heading">Sources the engine attributed${
    renderInfoTip(SOURCES_TIP)
  }</h2></div></div>
      ${body}
    </section>`
}

/**
 * The waiting state, revealed by script when a check is submitted.
 *
 * A check takes about 45 seconds and execution is request-bound, so a native
 * form POST leaves the browser blocked on a navigation for the whole time with
 * nothing on screen but a disabled button. The work still happens inside one
 * request; this just stops that request being the thing the browser is painting.
 *
 * It claims only what is knowable while waiting. The domain and any questions
 * the visitor typed are theirs already, and elapsed time is counted rather than
 * guessed. There is ONE track, not a list of phases: this runner really is
 * sequential — plan, then probe, then read the answers back — but the server
 * reports no phase, so naming three of them would tell the reader which one is
 * running when nothing knows that.
 */
function renderLoadingView(): string {
  return `
    <section class="checking" data-checking hidden aria-live="polite">
      <p class="checking-eyebrow">Checking</p>
      <h2 class="checking-domain" data-checking-domain></h2>
      <div class="checking-bar" aria-hidden="true"><span></span></div>
      <ul class="checking-tracks">
        <li><span class="checking-dot" aria-hidden="true"></span>Asking the answer engine about this brand</li>
      </ul>
      <ol class="checking-queries" data-checking-queries hidden></ol>
      <p class="checking-meta"><span data-checking-elapsed>0s</span> elapsed, usually about 45</p>
    </section>`
}

/**
 * The form does two different jobs, so it gets two treatments.
 *
 * On the landing page it is the ONLY thing to do, so it is the hero: a full
 * headline, a large field, and the scope note underneath. On a result page the
 * reader already has what they came for, so it shrinks into the header as a
 * secondary action and drops the onboarding copy.
 */
function renderCheckForm(model: BrandPerceptionViewModel, variant: 'hero' | 'compact' = 'compact'): string {
  if (!model.form) return ''
  const value = model.status === 'empty' ? '' : model.domain
  const verificationStatus = model.form.verificationStatus ?? (model.form.turnstileSiteKey ? 'ready' : 'not-required')
  const hasTurnstile = Boolean(model.form.turnstileSiteKey && verificationStatus === 'ready')
  const disabled = verificationStatus === 'unavailable'
  // interaction-only: the challenge still runs on load, so a token is ready at
  // submit, but the widget is drawn only if the visitor has to do something.
  const verification = hasTurnstile
    ? `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${
      escapeAttr(model.form.turnstileSiteKey)
    }" data-action="audit" data-theme="dark" data-size="flexible" data-appearance="interaction-only"></div></div>`
    : verificationStatus === 'unavailable'
    ? `<p id="verification-help" class="verification-unavailable" role="status"><span aria-hidden="true">!</span>${
      escapeHtml(
        model.form.verificationUnavailableMessage ?? 'Human verification is unavailable. Public checks are disabled.',
      )
    }</p>`
    : ''
  const verificationSlot = verification
    ? `<div class="verification-slot"${
      model.form.verificationFieldName
        ? ` data-verification-field="${escapeAttr(model.form.verificationFieldName)}"`
        : ''
    } aria-live="polite">${verification}</div>`
    : ''
  const hero = variant === 'hero'
  const submitLabel = model.form.submitLabel ?? 'Check a brand'
  return `
    <form class="domain-form ${hero ? 'is-hero' : 'is-compact'}" data-json-action="/api/checks" method="${
    escapeAttr(model.form.method ?? 'post')
  }" action="${escapeAttr(safeFormAction(model.form.action))}" data-domain-check-form>
      <label for="domain-input"${hero ? '' : ' class="sr-only"'}>${
    hero ? 'Enter a domain' : 'Check another brand'
  }</label>
      <div class="domain-form-row">
        <input id="domain-input" name="domain" type="text" inputmode="url" autocomplete="url" placeholder="example.com" value="${
    escapeAttr(value)
  }" required maxlength="253" aria-describedby="domain-help${disabled ? ' verification-help' : ''}" ${
    disabled ? 'disabled' : ''
  } />
        <button type="submit" data-domain-submit data-label="${escapeAttr(submitLabel)}" ${
    disabled ? 'disabled aria-disabled="true"' : ''
  }>${escapeHtml(submitLabel)}</button>
      </div>
      ${
    hero
      ? `<div class="query-field">
        <label for="queries-input">Questions people ask about this brand <span>optional</span></label>
        <textarea id="queries-input" name="queries" rows="3" maxlength="620" placeholder="Is Acme legit?&#10;One question per line" aria-describedby="queries-help"></textarea>
        <p id="queries-help" data-query-hint data-max="${MAX_USER_QUERIES}">Add up to ${MAX_USER_QUERIES}. We generate the rest. ${QUERY_HINT_SUFFIX}</p>
      </div>`
      : ''
  }
      ${
    hero
      // Scope facts, one line, said once. Metadata, so `--muted` is right, and
      // one step down from the hint above so the two read as instruction then
      // footnote.
      ? `<p id="domain-help" class="check-facts"><span>Gemini only</span><span>3 branded questions</span><span><a href="${CANONRY_REPO_URL}" rel="noreferrer" target="_blank">More engines in open source Canonry</a></span></p>`
      : '<p id="domain-help" class="sr-only">Public pages only. A fresh check puts three branded questions to one answer engine.</p>'
  }
      <p class="form-busy" data-form-busy role="status" aria-live="polite" hidden>Starting check…</p>
      ${verificationSlot}
    </form>`
}

function brandLockup(glyphHref: string): string {
  return `<div class="brand-lockup"><a href="/" class="wordmark" aria-label="${
    escapeAttr(PRODUCT_NAME)
  } home">brand perception check</a><span class="lockup-rule" aria-hidden="true"></span><a class="byline" href="https://canonry.ai" rel="noreferrer" target="_blank"><span class="byline-lead">powered by</span><img class="canonry-glyph" src="${glyphHref}" alt="" width="19" height="21" /><span class="byline-name">Canonry</span></a></div>`
}

const FOOTER_LINKS =
  '<span class="footer-links"><code>npm i -g @canonry/canonry</code><a href="https://github.com/Canonry/canonry" rel="noreferrer" target="_blank">GitHub</a><a href="https://canonry.ai" rel="noreferrer" target="_blank">canonry.ai</a></span>'

function renderMain(model: BrandPerceptionViewModel): string {
  const glyphHref = assetUrl(DEFAULT_GLYPH_SRC, canonryGlyph)
  const globalNotice = (model.status === 'ready' ? model.notice : model.notice ?? statusCopy(model.status)) ?? undefined
  const perception = model.perception
  // Nothing has been checked yet, so a report header over two empty panels is
  // scaffolding around an absence. Lead with the one action instead.
  if (model.status === 'empty') {
    return `
    <main class="canonry-demo" data-ui-status="empty">
      <header class="app-header is-bare">${brandLockup(glyphHref)}</header>
      <section class="landing-hero">
        <div data-hero>
        <h1>What does AI say about your brand?${renderInfoTip(LANDING_EXPLAINER)}</h1>
        ${renderCheckForm(model, 'hero')}
        </div>
        ${renderLoadingView()}
      </section>
      <footer class="app-footer is-bare">${FOOTER_LINKS}</footer>
    </main>`
  }
  return `
    <main class="canonry-demo" data-ui-status="${escapeAttr(model.status)}">
      <header class="app-header">${brandLockup(glyphHref)}${renderCheckForm(model)}</header>
      <section class="report-header" aria-labelledby="report-title">
        <div><h1 id="report-title">${escapeHtml(model.domain)}</h1></div>
      </section>
      ${renderNotice(globalNotice)}
      <div class="report-body">
        ${
    perception
      ? `${renderVerdictSnapshot(perception)}${renderAnswers(perception)}${renderConcerns(perception)}${
        renderSourceTypes(perception)
      }`
      : '<section class="analysis-section"><div class="empty-state"><p class="empty-title">No brand perception result</p><p>Start a check to see what an answer engine says about this brand.</p></div></section>'
  }
      </div>
      <footer class="app-footer"><span>A bounded sample: 3 branded questions to one answer engine, with the sentences behind every verdict.</span>${FOOTER_LINKS}</footer>
    </main>`
}

/** Returns a complete document so the runtime can use it as an HTTP response body. */
export function renderBrandPerception(model: BrandPerceptionViewModel): string {
  const title = `${model.displayName} | ${PRODUCT_NAME}`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" href="${assetUrl(DEFAULT_MARK_SRC, canonryMark)}" type="image/svg+xml" />
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/wght.css" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.3.0/wght.css" />
    <link rel="stylesheet" href="${assetUrl(DEFAULT_CSS_HREF, brandPerceptionStyles)}" />
    <script src="${assetUrl(DEFAULT_SCRIPT_SRC, brandPerceptionClientScript)}" defer></script>
    ${
    model.form?.turnstileSiteKey && (model.form.verificationStatus ?? 'ready') === 'ready'
      ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
      : ''
  }
  </head>
  <body>${renderMain(model)}</body>
</html>`
}

/** Useful for a host that owns the outer document or wants an embedded fragment. */
export function renderBrandPerceptionBody(model: BrandPerceptionViewModel): string {
  return renderMain(model)
}
