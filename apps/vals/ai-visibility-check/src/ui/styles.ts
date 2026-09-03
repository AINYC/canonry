/** Self-contained styles served from `/assets/canonry-ui.css` by the Val host. */
export const canonryDemoStyles = String.raw`
:root {
  color-scheme: dark;
  --bg: #09090b;
  --surface: rgb(24 24 27 / 0.3);
  --surface-soft: rgb(24 24 27 / 0.2);
  --surface-hover: rgb(24 24 27 / 0.4);
  --border: rgb(39 39 42 / 0.6);
  --border-strong: #3f3f46;
  --text: #fafafa;
  --text-strong: #e4e4e7;
  --secondary: #a1a1aa;
  --muted: rgb(139 139 148);
  --faint: rgb(124 124 133);
  --positive: #34d399;
  --caution: #fbbf24;
  --negative: #fb7185;
  --link: #60a5fa;
  --focus: #f4f4f5;
  --sans: "Geist Variable", "Geist", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
html {
  /* Matches apps/web: Geist ships cv11 (alt i/l/I) and ss01/ss03, and without
     them the same typeface still reads as a different one. */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-feature-settings: "cv11", "ss01", "ss03";
}
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.5; }
h1, h2, h3, h4 { letter-spacing: -0.015em; font-feature-settings: "cv11", "ss01", "ss03"; }
h1 { letter-spacing: -0.02em; }
code, kbd, samp, pre { font-feature-settings: "ss02", "cv11"; }
button, input { font: inherit; }
a { color: var(--link); }
a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.canonry-demo { width: min(100%, 1440px); margin: 0 auto; min-height: 100vh; padding: 0 32px 28px; }
.app-header { min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 22px; padding: 14px 0; border-bottom: 1px solid var(--border); }
.app-header.is-bare { border-bottom: 0; }
.brand-lockup { display: flex; align-items: center; gap: 13px; white-space: nowrap; }
.wordmark { color: var(--text); font-size: 18px; font-weight: 700; letter-spacing: -.04em; text-decoration: none; }

.domain-form { display: grid; gap: 8px; align-items: center; }
.domain-form > label { color: var(--secondary); font-size: 13px; white-space: nowrap; }
.domain-form-row { display: flex; min-width: 0; }
.domain-form input { min-width: 0; width: 100%; height: 38px; border: 1px solid var(--border-strong); border-radius: 6px 0 0 6px; background: var(--surface); color: var(--text); font: inherit; padding: 0 11px; }
.domain-form input::placeholder { color: var(--muted); }
.domain-form input:focus-visible { border-color: var(--focus); outline: none; box-shadow: 0 0 0 1px var(--focus); }
.domain-form button { min-height: 38px; border: 1px solid var(--text); border-radius: 0 6px 6px 0; background: var(--text); color: var(--bg); font: inherit; padding: 0 13px; font-weight: 650; cursor: pointer; white-space: nowrap; }
.domain-form button:hover { background: #d4d4d8; border-color: #d4d4d8; }

/* Landing: the form is the page's one job, so it gets room. */
.landing-hero { max-width: 640px; padding: 68px 0 96px; }
.landing-hero h1 { margin: 0 0 30px; font-size: 40px; font-weight: 700; line-height: 1.1; }

/* No JS: hover and :focus-within reveal it, which the page CSP allows and a
   keyboard reaches. The body resets the heading's type, or it inherits 40px
   bold. */
.info-tip { position: relative; display: inline-flex; margin-left: 12px; vertical-align: middle; }
.info-tip-trigger { display: grid; width: 21px; height: 21px; place-items: center; border: 1px solid var(--border-strong); border-radius: 50%; padding: 0; background: transparent; color: var(--muted); cursor: pointer; font-family: var(--mono); font-size: 12px; line-height: 1; }
.info-tip-trigger:hover { border-color: var(--text-strong); color: var(--text-strong); }
.info-tip-body { position: absolute; top: calc(100% + 9px); left: 0; z-index: 5; width: max-content; max-width: 330px; border: 1px solid var(--border-strong); border-radius: 7px; padding: 11px 13px; background: #141417; box-shadow: 0 10px 28px rgb(0 0 0 / .55); color: var(--secondary); font-family: var(--sans); font-size: 13px; font-weight: 400; letter-spacing: normal; line-height: 1.55; opacity: 0; visibility: hidden; transition: opacity .16s cubic-bezier(.22, 1, .36, 1), visibility .16s; }
.info-tip:hover .info-tip-body, .info-tip:focus-within .info-tip-body { opacity: 1; visibility: visible; }
.domain-form.is-hero { max-width: 520px; }
.domain-form.is-hero > label { color: var(--text-strong); font-size: 13px; font-weight: 550; }
.domain-form.is-hero input { height: 46px; font-size: 16px; padding: 0 14px; }
.domain-form.is-hero button { min-height: 46px; padding: 0 18px; }
.form-busy { margin: 2px 0 0; color: var(--secondary); font-size: 13px; line-height: 1.5; }
/* Same treatment as the other failure on this form, so the two cannot look
   like different kinds of thing. The glyph is generated, not markup, because
   the message is set with textContent. */
.form-busy.is-error { display: flex; gap: 7px; align-items: center; color: var(--caution); }
.form-busy.is-error::before { content: "!"; display: grid; flex: none; width: 17px; height: 17px; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-family: var(--mono); font-size: 11px; }
/* Scope facts: metadata, so --muted is right here, and one step down in size
   from the hint above so the two lines read as instruction then footnote. */
.check-facts { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 3px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.check-facts span + span::before { display: inline-block; margin-right: 14px; color: var(--faint); content: "·"; }
.check-facts a { color: var(--secondary); text-underline-offset: 2px; }
.check-facts a:hover { color: var(--text-strong); }

/* Result page: a secondary action, so it must not outweigh the report. */
.domain-form.is-compact { grid-template-columns: auto minmax(230px, 320px); gap: 0 10px; }
.domain-form.is-compact input { height: 34px; }
.domain-form.is-compact button { min-height: 34px; border-color: var(--border-strong); background: transparent; color: var(--text-strong); font-weight: 550; }
.domain-form.is-compact button:hover { border-color: var(--text); background: transparent; color: var(--text); }
.domain-form button:active { transform: translateY(1px); }
.domain-form button:disabled, .domain-form input:disabled { cursor: not-allowed; opacity: .55; }
.domain-form button:disabled:hover { background: var(--text); border-color: var(--text); }
.verification-slot { min-height: 0; }
/* No reserved height: an interaction-only widget is absent on almost every
   load, and holding 65px open for it left a permanent gap under the form. */
.turnstile-wrap { margin-top: 3px; }
/* The flexible widget size fills its container, so the container is what bounds
   it. Unbounded in the result-page header it grew to a third of the width and
   outweighed the report it sits above. */
.turnstile-wrap { max-width: 300px; }
.domain-form.is-hero .turnstile-wrap { max-width: 100%; }
.verification-unavailable { display: flex; gap: 7px; align-items: center; margin: 3px 0 0; color: var(--caution); font-size: 13px; }
.verification-unavailable span { display: grid; width: 17px; height: 17px; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-family: var(--mono); font-size: 11px; }
.report-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 30px 0 24px; border-bottom: 1px solid var(--border); }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; color: var(--text); font-size: clamp(24px, 3vw, 32px); letter-spacing: -.035em; line-height: 1.15; }
h2 { margin: 0; color: var(--text-strong); font-size: 21px; font-weight: 600; letter-spacing: -.025em; }
h3 { color: var(--text-strong); font-size: 15px; font-weight: 600; margin: 0 0 12px; }
.report-domain { margin: 6px 0 0; color: var(--secondary); font-family: var(--mono); font-size: 13px; }
.sample-badge { height: fit-content; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--secondary); font-size: 12px; padding: 4px 9px; white-space: nowrap; }
.notice { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; margin: 18px 0 0; border: 1px solid var(--border); border-radius: 6px; padding: 11px 13px; background: var(--surface); }
.notice-neutral { border-color: var(--border-strong); }
.notice-positive { border-color: color-mix(in oklab, var(--positive) 38%, var(--border)); }
.notice-caution { border-color: color-mix(in oklab, var(--caution) 38%, var(--border)); }
.notice-negative { border-color: color-mix(in oklab, var(--negative) 38%, var(--border)); }
.notice-glyph { display: grid; width: 18px; height: 18px; place-items: center; border: 1px solid currentColor; border-radius: 50%; color: var(--secondary); font-family: var(--mono); font-size: 11px; line-height: 1; }
.notice-caution .notice-glyph { color: var(--caution); }
.notice-negative .notice-glyph { color: var(--negative); }
.notice-title { margin: 0; color: var(--text-strong); font-weight: 600; }
.notice-detail { margin: 1px 0 0; color: var(--secondary); font-size: 13px; }
.notice-link { align-self: center; font-size: 13px; white-space: nowrap; }
.report-tabs { display: flex; gap: 28px; height: 62px; align-items: end; border-bottom: 1px solid var(--border); }
.report-tabs button { position: relative; min-height: 45px; border: 0; padding: 0 0 14px; background: transparent; color: var(--secondary); cursor: pointer; font-size: 15px; font-weight: 550; }
.report-tabs button:hover { color: var(--text); }
.report-tabs button[aria-selected="true"] { color: var(--text); }
.report-tabs button[aria-selected="true"]::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: var(--text); content: ""; }
[data-report-panel] { padding-top: 34px; }
.analysis-section { padding: 0 0 36px; border-bottom: 1px solid var(--border); }
.analysis-section + .analysis-section { padding-top: 32px; }
.section-heading { display: flex; align-items: start; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
.metric-delta.up { color: var(--positive); }
.metric-delta.down { color: var(--negative); }
.metric-toggle.is-active { background: #42424a; color: var(--text); }
.chart-caption { margin: 12px 0 0; color: var(--secondary); font-size: 13px; }
.data-disclosure { margin-top: 14px; color: var(--secondary); }
.data-disclosure > summary, .evidence-detail > summary, .page-detail > summary { width: fit-content; color: var(--link); cursor: pointer; font-size: 13px; }
.data-disclosure > summary:hover, .evidence-detail > summary:hover, .page-detail > summary:hover { color: #dbeafe; }
.table-wrap { overflow-x: auto; max-width: 100%; }
.compact-table, .evidence-table { width: 100%; border-collapse: collapse; min-width: 680px; text-align: left; }
/* A numeric column carries this on its header and on every cell, so the two
   cannot drift apart the way a per-cell text-align did. */
.compact-table .is-numeric, .evidence-table .is-numeric { text-align: right; }
.compact-table { margin-top: 12px; }
th { color: var(--secondary); font-size: 11px; font-weight: 650; letter-spacing: .075em; text-transform: uppercase; }
th, td { border-bottom: 1px solid var(--border); padding: 11px 12px; vertical-align: top; }
tbody th { color: var(--text-strong); font-size: 13px; font-weight: 550; letter-spacing: normal; text-transform: none; }
td { color: var(--secondary); font-size: 13px; }
.section-intro { max-width: 68ch; margin: -10px 0 18px; color: var(--secondary); font-size: 13px; }
.query-text { display: inline-block; max-width: 37ch; }
.signal { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 13px; font-weight: 550; }
.signal-positive { color: var(--positive); }
.signal-neutral { color: var(--secondary); }
.signal-caution { color: var(--caution); }
.signal-unavailable { color: var(--muted); }
.evidence-detail > summary, .page-detail > summary { white-space: nowrap; }
.evidence-content { max-width: 720px; padding: 12px 0 4px; }
.evidence-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 12px; }
code { color: var(--text-strong); font-family: var(--mono); font-size: .92em; }
.detail-label { display: block; margin: 12px 0 4px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
.evidence-answer blockquote { max-width: 72ch; margin: 0; border-left: 2px solid var(--border-strong); padding-left: 11px; color: var(--text-strong); }
.detail-empty { color: var(--muted); font-size: 13px; }
.detail-error { color: var(--negative); }
.source-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.source-title { display: block; overflow: hidden; max-width: 70ch; color: var(--link); text-overflow: ellipsis; white-space: nowrap; }
.source-host { display: block; color: var(--muted); font-family: var(--mono); font-size: 11px; }
.empty-state { display: flex; gap: 12px; align-items: flex-start; border: 1px dashed var(--border-strong); padding: 19px; color: var(--secondary); }
.empty-state p { margin: 0; }
.empty-title { color: var(--text-strong); font-weight: 600; }
.snapshot-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin: 18px 0 0; }
.snapshot-metrics > div { border-top: 1px solid var(--border); padding-top: 11px; }
.snapshot-metrics dt { color: var(--secondary); font-size: 13px; }
.snapshot-metrics dd { margin: 3px 0 0; color: var(--text); font-family: var(--mono); font-size: 25px; font-weight: 650; letter-spacing: -.05em; }
.snapshot-metrics span { color: var(--muted); font-size: 13px; }
.checked-at { margin: 0; color: var(--muted); font-family: var(--mono); font-size: 12px; }
.site-score { display: flex; align-items: baseline; gap: 9px; white-space: nowrap; }
.site-score span { color: var(--secondary); font-size: 13px; }
.site-score strong { color: var(--text); font-family: var(--mono); font-size: 24px; letter-spacing: -.05em; }
.sample-facts { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: -6px 0 24px; color: var(--secondary); font-size: 13px; }
.sample-facts span + span::before { display: inline-block; margin-right: 16px; color: var(--faint); content: "·"; }
.sample-facts strong { color: var(--text-strong); font-family: var(--mono); }
.factor-score { display: flex; align-items: center; gap: 9px; }
.factor-score meter { width: 100%; height: 9px; accent-color: var(--secondary); }
.factor-positive meter { accent-color: var(--positive); }
.factor-caution meter { accent-color: var(--caution); }
.factor-negative meter { accent-color: var(--negative); }
.factor-score strong { min-width: 58px; color: var(--text-strong); font-family: var(--mono); font-size: 13px; text-align: right; white-space: nowrap; }
.factor-state { color: var(--muted); font-size: 13px; text-align: right; }
.worst-pages { margin-top: 34px; }
.url-cell a { display: inline-block; max-width: 48ch; overflow: hidden; color: var(--text-strong); text-overflow: ellipsis; white-space: nowrap; }
.score-cell { color: var(--text-strong); font-family: var(--mono); white-space: nowrap; }
.page-detail > div { max-width: 60ch; padding: 10px 0 2px; }
.page-detail ul { display: grid; gap: 4px; margin: 0; padding-left: 18px; color: var(--secondary); }
.page-indexability { margin: 10px 0 0; color: var(--secondary); }
.sample-scope > p { max-width: 70ch; margin: 9px 0 0; color: var(--secondary); font-size: 13px; }
.sample-scope .sample-provenance { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.no-js-site-health { padding-top: 34px; }
.app-footer { display: flex; justify-content: space-between; gap: 14px; padding: 23px 0 4px; color: var(--muted); font-size: 12px; }
.app-footer a { color: var(--secondary); }
.app-footer > span:first-child { max-width: 62ch; }
.app-footer.is-bare { justify-content: flex-end; }
.footer-links { display: flex; align-items: baseline; gap: 13px; white-space: nowrap; }
.footer-links code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--secondary); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
[hidden] { display: none !important; }
@media (max-width: 860px) {
  .canonry-demo { padding: 0 20px 24px; }
  .app-header { align-items: flex-start; flex-direction: column; padding: 18px 0; }
  .domain-form { width: 100%; max-width: none; }
  .domain-form.is-compact { grid-template-columns: 1fr; }
  .domain-form.is-compact > label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  .landing-hero { padding: 40px 0 64px; }
  .landing-hero h1 { font-size: 30px; }
  /* Anchored right so a 330px note cannot run off a narrow viewport. */
  .info-tip-body { left: auto; right: 0; max-width: min(330px, calc(100vw - 40px)); }
  .report-header { padding: 28px 0 24px; }
  .site-grid { grid-template-columns: 1fr; gap: 28px; }
  /* The ring stops being a companion to the table and becomes a header for it. */
  .share-chart { grid-template-columns: minmax(0, 1fr); gap: 18px; justify-items: center; }
  .share-chart .table-wrap { width: 100%; }
}
@media (max-width: 600px) {
  body { font-size: 14px; }
  .canonry-demo { padding: 0 14px 20px; }
  .report-header, .section-heading { align-items: flex-start; flex-direction: column; }
  .site-score { margin-top: -10px; }
  .snapshot-metrics { grid-template-columns: 1fr; gap: 12px; }
  .factor-row { grid-template-columns: 1fr; gap: 8px; }
  .factor-state { text-align: left; }
  .sample-facts, .check-facts { display: grid; gap: 5px; }
  .sample-facts span + span::before, .check-facts span + span::before { display: none; }
  .notice { grid-template-columns: auto minmax(0, 1fr); }
  .notice-link { grid-column: 2; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}

.map-footnote { margin: 10px 0 0; color: var(--muted); font-size: 12px; }

/* A hairline, not a stripe: it separates two lockups of equal standing rather
   than accenting one of them. */
.lockup-rule { width: 1px; height: 19px; background: var(--border-strong); }
/* The glyph sits against the name it marks, not against the connective, so the
   two read as one lockup. No underline: this is an identity, not a link in
   prose. */
.byline { display: inline-flex; align-items: center; gap: 7px; text-decoration: none; }
/* "from" is the connective, not the name. A step down in size and weight stops
   the attribution reading as one flat four-word phrase. */
.byline-lead { margin-right: 1px; color: var(--muted); font-size: 12px; }
.byline-name { color: var(--secondary); font-size: 14px; font-weight: 550; letter-spacing: -0.01em; }
.byline:hover .byline-name { color: var(--text-strong); }
.byline:hover .canonry-glyph { opacity: 1; }
.canonry-glyph { display: block; opacity: .82; transition: opacity 180ms cubic-bezier(.22, 1, .36, 1); }
.query-field { display: grid; gap: 6px; margin-top: 4px; }
.query-field > label { color: var(--text-strong); font-size: 13px; font-weight: 550; }
.query-field > label span { color: var(--muted); font-weight: 400; }
.query-field textarea { width: 100%; min-height: 74px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; line-height: 1.5; padding: 9px 11px; resize: vertical; }
.query-field textarea::placeholder { color: var(--muted); }
.query-field textarea:focus-visible { border-color: var(--focus); outline: none; box-shadow: 0 0 0 1px var(--focus); }
.query-field > p { margin: 0; color: var(--secondary); font-size: 13px; }

/* Ring and legend swatch read the same ramp, so a colour is written once. */
/* Basis switch: two radios plus a general-sibling selector, so it works on
   first paint and with a keyboard. No script, which the page CSP would block
   inline and which would leave the control dead until a file had loaded. */
.share-switch { display: inline-flex; margin: 0 0 4px; border: 1px solid var(--border-strong); border-radius: 7px; padding: 2px; }
.share-switch label { border-radius: 5px; padding: 5px 13px; color: var(--secondary); cursor: pointer; font-size: 13px; font-weight: 500; }
.share-switch label:hover { color: var(--text-strong); }
/* Offered but empty. Dimmed so the reader can see the basis exists and that
   this check has nothing for it, which a missing control cannot say. */
.share-switch label.is-unmeasured { color: var(--faint); }
.share-pane { display: none; }
#share-basis-mention:checked ~ .share-pane[data-basis="mention"],
#share-basis-citation:checked ~ .share-pane[data-basis="citation"] { display: block; }
#share-basis-mention:checked ~ .share-switch label[data-basis="mention"],
#share-basis-citation:checked ~ .share-switch label[data-basis="citation"] { background: var(--surface-inset, #26262b); color: var(--text); }
.share-basis-input:focus-visible ~ .share-switch label { outline: 2px solid var(--focus); outline-offset: 3px; }
.share-chart { display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 26px; align-items: center; margin-top: 16px; }
.share-donut { display: block; width: 184px; height: 184px; }
.share-arc { fill: none; stroke: var(--share-color, var(--secondary)); stroke-width: 15; }
.share-arc.is-track { stroke: #1c1c20; }
.share-donut-value { fill: var(--text); font-family: var(--mono); font-size: 17px; font-weight: 650; letter-spacing: -.05em; }
.share-donut-label { fill: var(--muted); font-size: 6.4px; }
/* The checked site is the only coloured segment. Rivals are the field, not a
   taxonomy, so hues would imply a meaning that is not there. */
.share-arc.is-target, .share-key.is-target { --share-color: var(--positive); }
.share-arc.is-other, .share-key.is-other { --share-color: #303036; }
.share-arc.rank-0, .share-key.rank-0 { --share-color: #7c7c85; }
.share-arc.rank-1, .share-key.rank-1 { --share-color: #63636c; }
.share-arc.rank-2, .share-key.rank-2 { --share-color: #52525a; }
.share-arc.rank-3, .share-key.rank-3 { --share-color: #45454c; }
.share-arc.rank-4, .share-key.rank-4 { --share-color: #38383e; }
.share-key { display: inline-block; width: 9px; height: 9px; margin-right: 8px; border-radius: 2px; background: var(--share-color, var(--secondary)); vertical-align: baseline; }

.share-table { margin-top: 10px; }
.share-table th[scope="row"] { color: var(--text-strong); font-weight: 500; }
.share-table tr.is-target th[scope="row"] { color: var(--text); font-weight: 600; }
.share-you { margin-left: 8px; border: 1px solid var(--positive); border-radius: 3px; padding: 1px 5px; color: var(--positive); font-size: 11px; letter-spacing: .02em; }
.share-pct { color: var(--text); font-family: var(--mono); font-variant-numeric: tabular-nums; width: 6ch; }
.share-count { color: var(--muted); font-family: var(--mono); font-size: 12px; white-space: nowrap; }
.inbound-cell { color: var(--text-strong); font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cell-unknown { color: var(--faint); font-family: var(--sans); }
.share-footnote { margin: 10px 0 0; color: var(--muted); font-size: 12px; }

.factor-list { margin-top: 10px; border-top: 1px solid var(--border); }
.factor-row { border-bottom: 1px solid var(--border); }
.factor-row > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 46px; padding: 4px 2px; cursor: pointer; list-style: none; }
.factor-row > summary::-webkit-details-marker { display: none; }


.factor-row > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
/* The marker belongs to the name, not to the flex row: on a space-between row
   it would be pushed to the far edge, adrift from the label it discloses. */
.factor-name { display: inline-flex; align-items: center; gap: 9px; flex: 1; min-width: 0; color: var(--text-strong); font-weight: 500; }
.factor-name::before { content: '\25B8'; color: var(--muted); font-size: 10px; line-height: 1; transition: transform 160ms cubic-bezier(.22, 1, .36, 1); }
.factor-row[open] .factor-name::before { transform: rotate(90deg); }
.factor-meta { display: inline-flex; align-items: baseline; gap: 14px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.factor-score { color: var(--text); font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 13px; }
.factor-positive .factor-score { color: var(--positive); }
.factor-caution .factor-score { color: var(--caution); }
.factor-negative .factor-score { color: var(--negative); }
.factor-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px 28px; padding: 2px 2px 18px 22px; }
.factor-body h4 { margin: 0 0 7px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
.factor-body ul, .factor-body ol { margin: 0; padding-left: 18px; color: var(--secondary); font-size: 13px; line-height: 1.55; }
.factor-body li + li { margin-top: 5px; }
.factor-body ul { list-style: disc; }
.factor-body ol { list-style: decimal; }
.factor-body ol::marker, .factor-body li::marker { color: var(--faint); }
.defects { margin-top: 22px; }
.defect-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.defect-list li { border-bottom: 1px solid var(--border); padding: 12px 2px; }
.defect-detail { margin: 0; color: var(--text-strong); font-size: 14px; }
.defect-fix { margin: 5px 0 0; color: var(--secondary); font-size: 13px; }
.defect-fix span { margin-right: 7px; color: var(--text-strong); font-weight: 600; }
.factors-section { margin-top: 24px; }

.checking { max-width: 520px; padding: 4px 0 8px; }
.checking-eyebrow { margin: 0; color: var(--muted); font-size: 13px; }
.checking-domain { margin: 4px 0 0; color: var(--text); font-family: var(--mono); font-size: 22px; letter-spacing: -.02em; }
/* Indeterminate on purpose: the server reports no phase, so a bar that filled
   would be inventing progress. It only says work is happening. */
.checking-bar { position: relative; height: 3px; margin: 20px 0 18px; overflow: hidden; background: var(--surface-hover); border-radius: 999px; }
.checking-bar span { position: absolute; inset: 0; width: 38%; border-radius: 999px; background: var(--positive); animation: checking-sweep 1.5s cubic-bezier(.65, 0, .35, 1) infinite; }
@keyframes checking-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(363%); } }
.checking-tracks { margin: 0; padding: 0; list-style: none; color: var(--secondary); font-size: 14px; }
.checking-tracks li { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.checking-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--positive); animation: checking-pulse 1.6s ease-in-out infinite; }
.checking-tracks li:nth-child(2) .checking-dot { animation-delay: .5s; }
@keyframes checking-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
.checking-queries { margin: 16px 0 0; padding-left: 18px; color: var(--secondary); font-size: 13px; line-height: 1.6; }
.checking-queries li::marker { color: var(--faint); }
.checking-meta { margin: 18px 0 0; color: var(--muted); font-family: var(--mono); font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .checking-bar span { animation: none; width: 100%; opacity: .55; }
  .checking-dot { animation: none; }
}
`
