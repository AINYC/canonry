import { canonryDemoClientScript, QUERY_HINT_SUFFIX } from './client.ts'
import { canonryGlyph, canonryMark } from './mark.ts'
import { canonryDemoStyles } from './styles.ts'
import { MAX_USER_QUERIES } from '../runtime/records.ts'
import type {
  CanonryDemoViewModel,
  DemoUiStatus,
  EvidenceSource,
  QueryEvidenceViewModel,
  ShareEntryViewModel,
  ShareViewModel,
  SiteHealthFactorViewModel,
  SiteHealthPageViewModel,
  SiteMapNodeViewModel,
  SiteMapViewModel,
  UiNotice,
  VisibilityViewModel,
} from './types.ts'

const DEFAULT_CSS_HREF = '/assets/canonry-ui.css'
const DEFAULT_SCRIPT_SRC = '/assets/canonry-ui.js'
const DEFAULT_MARK_SRC = '/assets/canonry-mark.svg'
const DEFAULT_GLYPH_SRC = '/assets/canonry-glyph.svg'

/**
 * Fingerprint an asset's own content into its URL.
 *
 * The document is `no-store` but the stylesheet was `max-age=3600`, so after a
 * deploy a returning visitor got new markup styled by an hour-old stylesheet —
 * new class names unstyled, removed ones still applied. A content hash changes
 * the URL exactly when the bytes change, which is what makes a long cache
 * lifetime safe rather than a liability.
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

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function asPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return 'Not measured'
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function asScore(value: number | null | undefined): string {
  return isFiniteNumber(value) ? `${Math.round(value)} / 100` : 'Not measured'
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
        title: 'Checking this domain',
        detail: 'The report will appear here when the bounded checks finish.',
      }
    case 'partial':
      return {
        tone: 'caution',
        title: 'Partial result',
        detail: 'Only completed checks are included below. Failed checks are shown separately.',
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
      <span class="notice-glyph" aria-hidden="true">${
    notice.tone === 'negative' ? '!' : notice.tone === 'caution' ? '!' : 'i'
  }</span>
      <div>
        <p class="notice-title">${escapeHtml(notice.title)}</p>
        <p class="notice-detail">${escapeHtml(notice.detail)}</p>
      </div>
      ${action}
    </aside>`
}

function round(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}

/**
 * Share of voice as a single 100% bar plus a ranked table.
 *
 * A bar rather than a pie because the question is comparative ("am I ahead of
 * that site?") and angles are read worse than lengths. One bar rather than a
 * bar per domain because the parts are shares of one whole, and the whole is
 * the point.
 *
 * The checked site is the only coloured segment. Rivals sit on a neutral ramp,
 * because giving each a hue would imply category meaning that does not exist:
 * they are the field, not a taxonomy. The ramp is ordered so adjacent segments
 * stay distinguishable.
 */
/**
 * What the check actually does, carried by the heading's tooltip rather than a
 * subtitle. The trigger is a real button, and the copy rides its `aria-label`
 * so nothing is lost for assistive tech or for a test that looks the button up
 * by accessible name.
 */
const LANDING_EXPLAINER =
  'An answer engine is asked your questions. We record whether the answer names your brand and whether it cites your domain, then run a technical SEO audit on a sample of your pages.'

/** Where "open source Canonry" points. */
const CANONRY_REPO_URL = 'https://github.com/Canonry/canonry'

/**
 * Ring geometry. `r` and the stroke width set the hole, and the hole is what
 * the target's own share is written into: a share chart where the reader has to
 * hunt for their own row has buried its own headline.
 */
const DONUT_RADIUS = 38
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS
/** Separator between slices, in path units, shrunk for a slice too thin to keep it. */
const DONUT_GAP = 1.6

/** One arc, positioned by how much of the ring precedes it. */
function donutArc(startFraction: number, fraction: number, className: string, label: string): string {
  const length = fraction * DONUT_CIRCUMFERENCE
  if (length <= 0) return ''
  const drawn = Math.max(length - Math.min(DONUT_GAP, length * 0.3), 0.01)
  return `<circle class="share-arc ${className}" cx="50" cy="50" r="${DONUT_RADIUS}" stroke-dasharray="${
    round2(drawn)
  } ${round2(DONUT_CIRCUMFERENCE - drawn)}" stroke-dashoffset="${
    round2(-startFraction * DONUT_CIRCUMFERENCE)
  }"><title>${label}</title></circle>`
}

/** Copy that must change with the basis, since the two measure different things. */
const SHARE_BASIS = {
  mention: {
    label: 'Mentioned',
    caption: 'Brands named in the answer text. A brand counts once per answer.',
    column: 'Brand',
    tailNoun: 'named in',
    unmeasured: 'Mentions were not measured on this check.',
  },
  citation: {
    label: 'Cited',
    caption: 'Domains cited as sources. A domain counts once per answer.',
    column: 'Domain',
    tailNoun: 'cited in',
    unmeasured: 'Citations were not measured on this check.',
  },
} as const

/**
 * The whole section, with a basis switch when both are measurable.
 *
 * The switch is two radios and CSS, not script: the page CSP allows no inline
 * script, and a control that only works once an external file has loaded is a
 * control that is broken on first paint. Radios also give the group real
 * keyboard semantics for free, which a pair of divs would not.
 */
function renderShareSection(visibility: VisibilityViewModel, idPrefix = 'share'): string {
  // Both bases are always offered. A basis with no data gets a pane that says
  // so, because a control that silently disappears reads as a broken page: the
  // reader cannot tell the difference between "this was not measured" and
  // "this feature is gone". The extraction can fail on a live check too, so
  // this is not only about records written before it existed.
  const panes = [
    { basis: 'mention', share: visibility.mentionShare },
    { basis: 'citation', share: visibility.share },
  ] as const
  if (panes.every((pane) => !pane.share)) return ''

  const headingId = `${idPrefix}-heading`
  const heading = `<div class="section-heading"><div><h2 id="${headingId}">Who else shows up</h2></div></div>`
  // Open on a basis that HAS data, or the page loads onto an empty pane.
  const defaultBasis = panes.find((pane) => pane.share)?.basis ?? 'citation'

  const inputs = panes.map((pane) =>
    `<input type="radio" class="sr-only share-basis-input" name="${idPrefix}-basis" id="${idPrefix}-basis-${pane.basis}"${
      pane.basis === defaultBasis ? ' checked' : ''
    } />`
  ).join('')
  const switcher = `<div class="share-switch" role="group" aria-label="Signal">${
    panes.map((pane) =>
      `<label for="${idPrefix}-basis-${pane.basis}" data-basis="${pane.basis}"${
        pane.share ? '' : ' class="is-unmeasured"'
      }>${SHARE_BASIS[pane.basis].label}</label>`
    ).join('')
  }</div>`

  return `
    <section class="analysis-section" aria-labelledby="${headingId}">
      ${heading}
      ${inputs}
      ${switcher}
      ${
    panes.map((pane) =>
      `<div class="share-pane" data-basis="${pane.basis}">${
        pane.share
          ? renderSharePane(pane.share, pane.basis, `${idPrefix}-${pane.basis}`, headingId)
          : `<p class="chart-caption">${SHARE_BASIS[pane.basis].unmeasured}</p>`
      }</div>`
    ).join('')
  }
    </section>`
}

function renderSharePane(
  share: ShareViewModel,
  basis: 'mention' | 'citation',
  idPrefix: string,
  headingId: string,
): string {
  const copy = SHARE_BASIS[basis]
  const descId = `${idPrefix}-desc`

  // Fractions come from the counts, never from the rounded display percent:
  // eight rows each rounded to 5% would leave the ring visibly short.
  let cursor = 0
  const arcs = share.entries.map((entry, index) => {
    const fraction = entry.answers / share.totalAppearances
    const arc = donutArc(
      cursor,
      fraction,
      segmentClass(entry, index),
      `${escapeHtml(entry.domain)}: ${entry.percent}%`,
    )
    cursor += fraction
    return arc
  }).join('') + (share.tail
    ? donutArc(cursor, Math.max(1 - cursor, 0), 'is-other', `${share.tail.domains} more: ${share.tail.percent}%`)
    : '')

  const rows = share.entries.map((entry, index) => `
    <tr${entry.isTarget ? ' class="is-target"' : ''}>
      <th scope="row"><span class="share-key ${segmentClass(entry, index)}" aria-hidden="true"></span>${
    escapeHtml(entry.domain)
  }${entry.isTarget ? '<span class="share-you">you</span>' : ''}</th>
      <td class="share-pct is-numeric">${entry.percent}%</td>
      <td class="share-count is-numeric">${entry.answers} of ${share.measuredAnswers}</td>
    </tr>`).join('')

  const summary = share.targetPercent === 0
    ? `${escapeHtml(share.targetDomain)} was not ${copy.tailNoun} any answer`
    : `${escapeHtml(share.targetDomain)} holds ${share.targetPercent}%`

  return `
      <p class="chart-caption" id="${descId}">${copy.caption}</p>
      <div class="share-chart">
        <svg class="share-donut" viewBox="0 0 100 100" role="img" aria-labelledby="${headingId} ${descId}">
          <g transform="rotate(-90 50 50)"><circle class="share-arc is-track" cx="50" cy="50" r="${DONUT_RADIUS}" />${arcs}</g>
          <text class="share-donut-value" x="50" y="51" text-anchor="middle">${share.targetPercent}%</text>
          <text class="share-donut-label" x="50" y="62" text-anchor="middle">your share</text>
        </svg>
        <div class="table-wrap"><table class="compact-table share-table">
          <thead><tr><th scope="col">${copy.column}</th><th scope="col" class="is-numeric">Share</th><th scope="col" class="is-numeric">Answers</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      ${
    share.tail
      ? `<p class="share-footnote">${share.tail.domains} more ${
        share.tail.domains === 1 ? 'holds' : 'hold'
      } the remaining ${share.tail.percent}%.</p>`
      : ''
  }
      ${
    share.unattributedAnswers > 0
      ? `<p class="share-footnote">${share.unattributedAnswers} ${
        share.unattributedAnswers === 1 ? 'answer' : 'answers'
      } ${basis === 'mention' ? 'named no brand' : 'cited no source'} at all, and ${
        share.unattributedAnswers === 1 ? 'is' : 'are'
      } excluded from the share.</p>`
      : ''
  }
      <p class="sr-only">${summary}.</p>`
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/** Target first, remainder last, rivals on a five-step neutral ramp. */
function segmentClass(entry: ShareEntryViewModel, index: number): string {
  if (entry.isTarget) return 'is-target'
  return `rank-${index % 5}`
}

function renderVisibilityChart(visibility: VisibilityViewModel): string {
  const mention = visibility.summaries.mentioned
  const cite = visibility.summaries.cited
  const checkedAt = formatTime(visibility.checkedAt)
  return `
    <section class="analysis-section snapshot-section" aria-labelledby="visibility-snapshot-heading">
      <div class="section-heading">
        <div><h2 id="visibility-snapshot-heading">Answer-engine snapshot</h2></div>
        ${checkedAt ? `<p class="checked-at">Checked ${escapeHtml(checkedAt)}</p>` : ''}
      </div>
      <dl class="snapshot-metrics" aria-label="Answer-engine snapshot summary">
        <div><dt>Mentioned in the answer</dt><dd>${
    asPercent(mention.rate)
  }</dd><span>${mention.numerator} of ${mention.denominator} answers</span></div>
        <div><dt>Cited as a source</dt><dd>${
    asPercent(cite.rate)
  }</dd><span>${cite.numerator} of ${cite.denominator} answers</span></div>
      </dl>
    </section>`
}

function signalLabel(value: boolean | null, positive: string, negative: string): string {
  if (value === true) return positive
  if (value === false) return negative
  return 'Not measured'
}

function signalClass(value: boolean | null): string {
  if (value === true) return 'signal-positive'
  if (value === false) return 'signal-neutral'
  return 'signal-unavailable'
}

function renderSource(source: EvidenceSource): string {
  const url = safeUrl(source.url)
  const title = source.title?.trim() || safeHost(source.url)
  if (!url) {
    return `<li><span class="source-title">${
      escapeHtml(title)
    }</span><span class="source-host">Unavailable URL</span></li>`
  }
  return `<li><a href="${escapeAttr(url)}" rel="noreferrer" target="_blank" class="source-title">${
    escapeHtml(title)
  }</a><span class="source-host">${escapeHtml(safeHost(url))}${
    source.isTargetDomain ? ' · target source' : ''
  }</span></li>`
}

function renderEvidenceDetails(row: QueryEvidenceViewModel): string {
  const answer = row.answerText
    ? `<blockquote>${escapeHtml(clip(row.answerText))}</blockquote>`
    : '<p class="detail-empty">Answer text was not retained for this result.</p>'
  const sources = row.sources?.length
    ? `<ul class="source-list">${row.sources.map(renderSource).join('')}</ul>`
    : '<p class="detail-empty">No source URLs were recorded.</p>'
  const matched = row.matchedTerms?.length
    ? `<p><span class="detail-label">Matched terms</span>${escapeHtml(row.matchedTerms.join(', '))}</p>`
    : ''
  const models = [
    row.requestedModel ? `<span>Requested: <code>${escapeHtml(row.requestedModel)}</code></span>` : '',
    row.servedModel ? `<span>Served: <code>${escapeHtml(row.servedModel)}</code></span>` : '',
  ].filter(Boolean).join('')
  const searches = row.searchQueries?.length
    ? `<p><span class="detail-label">Search queries</span>${escapeHtml(row.searchQueries.join(', '))}</p>`
    : ''
  const error = row.error
    ? `<p class="detail-error"><span class="detail-label">Unavailable</span>${escapeHtml(row.error)}</p>`
    : ''
  return `
    <details class="evidence-detail">
      <summary>View evidence<span class="sr-only"> for ${escapeHtml(row.query)}</span></summary>
      <div class="evidence-content">
        <div class="evidence-meta">${models}${
    row.completedAt && formatTime(row.completedAt)
      ? `<span>Completed: ${escapeHtml(formatTime(row.completedAt)!)}</span>`
      : ''
  }</div>
        <div class="evidence-answer"><p class="detail-label">Answer</p>${answer}</div>
        ${matched}${searches}${error}
        <div><p class="detail-label">Sources</p>${sources}</div>
      </div>
    </details>`
}

function renderEvidence(visibility: VisibilityViewModel): string {
  const rows = visibility.evidence.map((row) => `
    <tr>
      <th scope="row"><span class="query-text">${escapeHtml(row.query)}</span></th>
      <td>${escapeHtml(row.providerLabel ?? row.provider)}</td>
      <td><span class="signal ${signalClass(row.mentioned)}"><span aria-hidden="true">${
    row.mentioned === true ? '✓' : row.mentioned === false ? '−' : '?'
  }</span>${signalLabel(row.mentioned, 'Mentioned', 'Not mentioned')}</span></td>
      <td><span class="signal ${signalClass(row.cited)}"><span aria-hidden="true">${
    row.cited === true ? '✓' : row.cited === false ? '−' : '?'
  }</span>${signalLabel(row.cited, 'Cited', 'Not cited')}</span></td>
      <td>${renderEvidenceDetails(row)}</td>
    </tr>`).join('')
  const empty =
    '<div class="empty-state"><p class="empty-title">No completed query evidence</p><p>Evidence appears after a check returns an answer.</p></div>'
  return `
    <section class="analysis-section evidence-section" aria-labelledby="query-evidence-heading">
      <div class="section-heading"><div><h2 id="query-evidence-heading">Query evidence</h2></div></div>
      ${visibility.notice ? renderNotice(visibility.notice) : ''}
      ${
    visibility.evidence.length
      ? `<div class="table-wrap"><table class="evidence-table"><thead><tr><th scope="col">Query</th><th scope="col">Engine</th><th scope="col">Mentioned</th><th scope="col">Cited</th><th scope="col"><span class="sr-only">Evidence</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : empty
  }
    </section>`
}

function factorTone(factor: SiteHealthFactorViewModel): string {
  if (factor.state !== 'measured' || !isFiniteNumber(factor.score)) return 'factor-unavailable'
  if (factor.score >= 80) return 'factor-positive'
  if (factor.score >= 60) return 'factor-caution'
  return 'factor-negative'
}

/**
 * One row per factor, mirroring the dashboard's page audit: the summary carries
 * everything needed to decide whether to open it, and the evidence and the fix
 * live together inside. Closed by default so the section stays scannable.
 */
function renderFactor(factor: SiteHealthFactorViewModel): string {
  const score = isFiniteNumber(factor.score)
    ? `<span class="factor-score">${asScore(factor.score)}</span>`
    : `<span class="factor-state">${factor.state === 'not-applicable' ? 'Not applicable' : 'Unavailable'}</span>`

  const list = (items: readonly string[], ordered: boolean) =>
    items.length === 0
      ? ''
      : ordered
      ? `<ol>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`
      : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`

  const body = factor.findings.length === 0 && factor.recommendations.length === 0
    ? `<p class="detail-empty">Nothing to report here.</p>`
    : `${factor.findings.length ? `<div><h4>Evidence</h4>${list(factor.findings, false)}</div>` : ''}${
      factor.recommendations.length ? `<div><h4>Recommended fix</h4>${list(factor.recommendations, true)}</div>` : ''
    }`

  return `<details class="factor-row ${factorTone(factor)}">
    <summary><span class="factor-name">${escapeHtml(factor.label)}</span><span class="factor-meta">${
    escapeHtml(factor.detail)
  }${score}</span></summary>
    <div class="factor-body">${body}</div>
  </details>`
}

function pageStatusLabel(status: SiteHealthPageViewModel['status']): string {
  if (status === 'good') return 'Good'
  if (status === 'needs-attention') return 'Needs attention'
  return 'Unavailable'
}

function renderPageDetails(page: SiteHealthPageViewModel): string {
  const facts = page.findings.length
    ? `<ul>${page.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join('')}</ul>`
    : '<p class="detail-empty">No page-level findings were retained.</p>'
  return `<details class="page-detail"><summary>View findings<span class="sr-only"> for ${
    escapeHtml(page.url)
  }</span></summary><div>${facts}${
    page.indexable != null
      ? `<p class="page-indexability">${
        page.indexable ? 'Indexable in this sample.' : 'Not indexable in this sample.'
      }</p>`
      : ''
  }</div></details>`
}

function readableValue(value: string): string {
  return value.replaceAll(/[-_]+/g, ' ').replaceAll(/\s+/g, ' ').trim()
}

function renderSiteHealth(siteHealth: CanonryDemoViewModel['siteHealth'], idPrefix = 'site-health'): string {
  const headingId = `${idPrefix}-heading`
  const factorHeadingId = `${idPrefix}-factors`
  const fixHeadingId = `${idPrefix}-fixes`
  const worstPagesHeadingId = `${idPrefix}-worst-pages`
  if (!siteHealth) {
    return `
    <section class="analysis-section empty-section" aria-labelledby="${headingId}">
      <div class="section-heading"><div><h2 id="${headingId}">Technical AEO sample</h2></div></div>
      <div class="empty-state"><p class="empty-title">No site-health sample</p><p>A bounded crawl can appear with a domain check.</p></div>
    </section>`
  }
  const checkedAt = formatTime(siteHealth.checkedAt)
  // Inbound links come from the same crawl's link graph, joined by URL.
  const inboundByUrl = new Map((siteHealth.siteMap?.nodes ?? []).map((node) => [node.url, node.inboundLinks]))
  const pages = siteHealth.worstPages.map((page) => {
    const inbound = inboundByUrl.get(page.url)
    const url = safeUrl(page.url)
    const label = escapeHtml(page.url.replace(/^https?:\/\//, ''))
    const pageLink = url
      ? `<a href="${escapeAttr(url)}" rel="noreferrer" target="_blank">${label}</a>`
      : `<span>${label}</span>`
    return `<tr><th scope="row" class="url-cell">${pageLink}</th><td><span class="signal ${
      page.status === 'good'
        ? 'signal-positive'
        : page.status === 'needs-attention'
        ? 'signal-caution'
        : 'signal-unavailable'
    }">${escapeHtml(pageStatusLabel(page.status))}</span></td><td class="score-cell">${
      asScore(page.score)
    }</td><td class="inbound-cell is-numeric">${
      inbound === undefined ? '<span class="cell-unknown">not measured</span>' : inbound
    }</td><td>${renderPageDetails(page)}</td></tr>`
  }).join('')
  const defects = siteHealth.criticalDefects.map((defect) =>
    `<li><p class="defect-detail">${escapeHtml(defect.detail)}</p><p class="defect-fix"><span>Fix</span>${
      escapeHtml(defect.recommendation)
    }</p></li>`
  ).join('')
  const termination = siteHealth.terminationReason
    ? `<p>Partial termination: ${escapeHtml(readableValue(siteHealth.terminationReason))}.</p>`
    : ''
  const provenance = [
    siteHealth.provenance?.schemaVersion ? `Crawl schema ${siteHealth.provenance.schemaVersion}` : '',
    siteHealth.provenance?.engineVersion ? `Engine ${siteHealth.provenance.engineVersion}` : '',
  ].filter(Boolean).join(' · ')
  return `
    <section class="analysis-section site-health-section" aria-labelledby="${headingId}">
      <div class="section-heading site-health-heading">
        <div><h2 id="${headingId}">${escapeHtml(siteHealth.sampleLabel)}</h2></div>
        <div class="site-score"><span>Sample score</span><strong>${asScore(siteHealth.score)}</strong></div>
      </div>
      <div class="sample-facts" role="status"><span><strong>${siteHealth.completedPages}</strong> of <strong>${siteHealth.attemptedPages}</strong> pages completed</span><span><strong>${siteHealth.discoveredPages}</strong> pages discovered</span><span>${
    siteHealth.failedPages === 0
      ? 'No failed pages'
      : `${siteHealth.failedPages} failed ${siteHealth.failedPages === 1 ? 'page' : 'pages'}`
  }</span>${checkedAt ? `<span>Checked ${escapeHtml(checkedAt)}</span>` : ''}</div>
      ${siteHealth.notice ? renderNotice(siteHealth.notice) : ''}
      ${
    siteHealth.criticalDefects.length
      ? `<section class="defects" aria-labelledby="${fixHeadingId}"><h3 id="${fixHeadingId}">Problems outside the score</h3><ul class="defect-list">${defects}</ul></section>`
      : ''
  }
      <section class="factors-section" aria-labelledby="${factorHeadingId}"><h3 id="${factorHeadingId}">Factors</h3><div class="factor-list">${
    siteHealth.factors.map(renderFactor).join('')
  }</div></section>
      <section class="worst-pages" aria-labelledby="${worstPagesHeadingId}"><h3 id="${worstPagesHeadingId}">Worst sampled pages</h3>${
    pages
      ? `<div class="table-wrap"><table class="evidence-table"><thead><tr><th scope="col">Page</th><th scope="col">Status</th><th scope="col">Score</th><th scope="col" class="is-numeric">Inbound links</th><th scope="col"><span class="sr-only">Findings</span></th></tr></thead><tbody>${pages}</tbody></table></div>`
      : '<p class="detail-empty">No page audit evidence is available.</p>'
  }${
    siteHealth.siteMap
      ? `<p class="map-footnote">${siteHealth.siteMap.nodes.length} of ${siteHealth.siteMap.totalPages} pages and ${siteHealth.siteMap.edges.length} of ${siteHealth.siteMap.totalEdges} internal links were seen by this bounded crawl.</p>`
      : ''
  }</section>
      <details class="data-disclosure sample-scope"><summary>Sample scope</summary><p>This is a bounded page sample, not a complete technical audit. A score applies only to the pages and factors checked here.</p>${termination}${
    provenance ? `<p class="sample-provenance">${escapeHtml(provenance)}</p>` : ''
  }</details>
    </section>`
}

/**
 * The form does two different jobs, so it gets two treatments.
 *
 * On the landing page it is the ONLY thing to do, so it is the hero: a full
 * headline, a large field, and the scope note underneath. On a result page the
 * reader already has what they came for, so it shrinks into the header as a
 * secondary action and drops the onboarding copy — that copy wrapped to two
 * lines under a field jammed against the top edge, which is what made the
 * header look broken.
 */
/**
 * The waiting state, revealed by script when a check is submitted.
 *
 * A check takes about 45 seconds and execution is request-bound, so the native
 * form POST leaves the browser blocked on a navigation for the whole time with
 * nothing on screen but a disabled button. The work still happens inside one
 * request; this just stops that request being the thing the browser is
 * painting.
 *
 * It claims only what is knowable while waiting. The domain and any questions
 * the visitor typed are theirs already; elapsed time is counted, not guessed;
 * and the two tracks are shown running TOGETHER because they genuinely do
 * (`Promise.allSettled` over the probe and the crawl). No invented sequence of
 * phases, because the server reports none and a progress bar that moves on a
 * timer is a lie with a nice curve.
 *
 * Rendered server-side and hidden, rather than built in script, so the markup
 * stays in one place and there is nothing to keep in sync.
 */
function renderLoadingView(): string {
  return `
    <section class="checking" data-checking hidden aria-live="polite">
      <p class="checking-eyebrow">Checking</p>
      <h2 class="checking-domain" data-checking-domain></h2>
      <div class="checking-bar" aria-hidden="true"><span></span></div>
      <ul class="checking-tracks">
        <li><span class="checking-dot" aria-hidden="true"></span>Putting questions to the answer engine</li>
        <li><span class="checking-dot" aria-hidden="true"></span>Crawling and auditing pages</li>
      </ul>
      <ol class="checking-queries" data-checking-queries hidden></ol>
      <p class="checking-meta"><span data-checking-elapsed>0s</span> elapsed, usually about 45</p>
    </section>`
}

/** Hover- and focus-revealed note. CSS only, because the page CSP allows no inline script. */
function renderInfoTip(copy: string): string {
  return `<span class="info-tip"><button type="button" class="info-tip-trigger" aria-label="${
    escapeAttr(copy)
  }"><span aria-hidden="true">i</span></button><span class="info-tip-body" aria-hidden="true">${
    escapeHtml(copy)
  }</span></span>`
}

function renderCheckForm(model: CanonryDemoViewModel, variant: 'hero' | 'compact' = 'compact'): string {
  if (!model.form) return ''
  const value = model.status === 'demo' || model.status === 'empty' ? '' : model.domain
  const verificationStatus = model.form.verificationStatus ?? (model.form.turnstileSiteKey ? 'ready' : 'not-required')
  const hasTurnstile = Boolean(model.form.turnstileSiteKey && verificationStatus === 'ready')
  const disabled = verificationStatus === 'unavailable'
  // interaction-only: the challenge still runs on load, so a token is ready at
  // submit, but the widget is drawn only if the visitor has to do something.
  // The default (`always`) meant the result page carried a green "Success!"
  // panel next to the check-another-domain form, announcing the outcome of a
  // challenge for a submission that had not happened, beside a report that had.
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
  return `
    <form class="domain-form ${hero ? 'is-hero' : 'is-compact'}" data-json-action="/api/checks" method="${
    escapeAttr(model.form.method ?? 'post')
  }" action="${escapeAttr(safeFormAction(model.form.action))}" data-domain-check-form>
      <label for="domain-input"${hero ? '' : ' class="sr-only"'}>${
    hero ? 'Enter a domain' : 'Check another domain'
  }</label>
      <div class="domain-form-row">
        <input id="domain-input" name="domain" type="text" inputmode="url" autocomplete="url" placeholder="example.com" value="${
    escapeAttr(value)
  }" required maxlength="253" aria-describedby="domain-help${disabled ? ' verification-help' : ''}" ${
    disabled ? 'disabled' : ''
  } />
        <button type="submit" data-domain-submit data-label="${
    escapeAttr(model.form.submitLabel ?? 'Check a domain')
  }" ${disabled ? 'disabled aria-disabled="true"' : ''}>${
    escapeHtml(model.form.submitLabel ?? 'Check a domain')
  }</button>
      </div>
      ${
    hero
      ? `<div class="query-field">
        <label for="queries-input">Questions you want to show up for <span>optional</span></label>
        <textarea id="queries-input" name="queries" rows="3" maxlength="620" placeholder="What is the best CRM for a small agency?&#10;One question per line" aria-describedby="queries-help"></textarea>
        <p id="queries-help" data-query-hint data-max="${MAX_USER_QUERIES}">Add up to ${MAX_USER_QUERIES}. We generate the rest. ${QUERY_HINT_SUFFIX}</p>
      </div>`
      : ''
  }
      ${
    hero
      // Scope facts, one line, said once. They used to be a sentence here and
      // a second sentence in the footer, which repeated the engine and the
      // question count the hint above already states.
      ? `<p id="domain-help" class="check-facts"><span>Gemini only</span><span>5-page technical SEO audit</span><span><a href="${CANONRY_REPO_URL}" rel="noreferrer" target="_blank">More engines in open source Canonry</a></span></p>`
      : '<p id="domain-help" class="sr-only">Public pages only. A fresh check returns one visibility snapshot and a five-page site sample.</p>'
  }
      <p class="form-busy" data-form-busy role="status" aria-live="polite" hidden>Starting check…</p>
      ${verificationSlot}
    </form>`
}

function renderMain(model: CanonryDemoViewModel): string {
  const glyphHref = assetUrl(DEFAULT_GLYPH_SRC, canonryGlyph)
  const globalNotice =
    (model.status === 'demo' || model.status === 'ready' ? model.notice : model.notice ?? statusCopy(model.status)) ??
      undefined
  const loading = model.status === 'loading'
  const visibility = model.visibility
  // Nothing has been checked yet, so a report header, tabs, and two empty
  // panels are scaffolding around an absence. Lead with the one action instead.
  if (model.status === 'empty') {
    return `
    <main class="canonry-demo" data-ui-status="empty">
      <header class="app-header is-bare">
        <div class="brand-lockup"><a href="/" class="wordmark" aria-label="AI Visibility Check home">ai visibility check</a><span class="lockup-rule" aria-hidden="true"></span><a class="byline" href="https://canonry.ai" rel="noreferrer" target="_blank"><span class="byline-lead">from</span><img class="canonry-glyph" src="${glyphHref}" alt="" width="19" height="21" /><span class="byline-name">Canonry</span></a></div>
      </header>
      <section class="landing-hero">
        <div data-hero>
        <h1>Does AI mention your brand?${renderInfoTip(LANDING_EXPLAINER)}</h1>
        ${renderCheckForm(model, 'hero')}
        </div>
        ${renderLoadingView()}
      </section>
      <footer class="app-footer is-bare"><span class="footer-links"><code>npm i -g @canonry/canonry</code><a href="https://github.com/Canonry/canonry" rel="noreferrer" target="_blank">GitHub</a><a href="https://canonry.ai" rel="noreferrer" target="_blank">canonry.ai</a></span></footer>
    </main>`
  }
  return `
    <main class="canonry-demo" data-ui-status="${escapeAttr(model.status)}">
      <header class="app-header">
        <div class="brand-lockup"><a href="/" class="wordmark" aria-label="AI Visibility Check home">ai visibility check</a><span class="lockup-rule" aria-hidden="true"></span><a class="byline" href="https://canonry.ai" rel="noreferrer" target="_blank"><span class="byline-lead">from</span><img class="canonry-glyph" src="${glyphHref}" alt="" width="19" height="21" /><span class="byline-name">Canonry</span></a></div>
        ${renderCheckForm(model)}
      </header>
      <section class="report-header" aria-labelledby="report-title">
        <div>
          <h1 id="report-title">${escapeHtml(model.domain)}</h1>
          ${model.locale ? `<p class="report-domain">${escapeHtml(model.locale)}</p>` : ''}
        </div>
        ${model.status === 'demo' ? '<span class="sample-badge">Sample data</span>' : ''}
      </section>
      ${renderNotice(globalNotice)}
      <div class="report-tabs" role="tablist" aria-label="Report sections">
        <button id="visibility-tab" type="button" role="tab" aria-selected="true" aria-controls="visibility-panel" data-report-tab="visibility">AI Visibility</button>
        <button id="site-health-tab" type="button" role="tab" aria-selected="false" tabindex="-1" aria-controls="site-health-panel" data-report-tab="site-health">Site Health</button>
      </div>
      <div id="visibility-panel" role="tabpanel" aria-labelledby="visibility-tab" data-report-panel="visibility" ${
    loading ? 'aria-busy="true"' : ''
  }>
        ${
    visibility
      ? `${renderVisibilityChart(visibility)}${renderShareSection(visibility)}${renderEvidence(visibility)}`
      : '<section class="analysis-section"><div class="empty-state"><p class="empty-title">No visibility result</p><p>Start a check to inspect answer-engine evidence.</p></div></section>'
  }
      </div>
      <div id="site-health-panel" role="tabpanel" aria-labelledby="site-health-tab" data-report-panel="site-health" hidden>${
    renderSiteHealth(model.siteHealth)
  }</div>
      <noscript><div class="no-js-site-health">${
    renderSiteHealth(model.siteHealth, 'site-health-nojs')
  }</div></noscript>
      <footer class="app-footer"><span>A bounded sample: 3 questions to one answer engine, and a 5-page technical SEO audit.</span><span class="footer-links"><code>npm i -g @canonry/canonry</code><a href="https://github.com/Canonry/canonry" rel="noreferrer" target="_blank">GitHub</a><a href="https://canonry.ai" rel="noreferrer" target="_blank">canonry.ai</a></span></footer>
    </main>`
}

/** Returns a complete document so the runtime can use it as an HTTP response body. */
export function renderCanonryDemo(model: CanonryDemoViewModel): string {
  const title = `${model.displayName} | AI Visibility Check`
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
    <link rel="stylesheet" href="${assetUrl(DEFAULT_CSS_HREF, canonryDemoStyles)}" />
    <script src="${assetUrl(DEFAULT_SCRIPT_SRC, canonryDemoClientScript)}" defer></script>
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
export function renderCanonryDemoBody(model: CanonryDemoViewModel): string {
  return renderMain(model)
}
