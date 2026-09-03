/**
 * The shared design system plus the handful of rules this product needs.
 *
 * `canonryDemoStyles` is the kit's, and it is the reason the two Vals look like
 * one company: tokens, type, tables, notices, disclosures, and the tooltip are
 * written once. Everything appended below exists only because this page shows
 * something the other one does not — a verdict row, verbatim quotations, and a
 * concern list — and it is written in the kit's own vocabulary (its tokens, its
 * table classes) so it reads as the same surface rather than a second one.
 *
 * The kit is not edited to hold it. A rule no other Val can use is not a shared
 * value; it is this product's surface, and the seam says that stays here.
 */
import { canonryDemoStyles } from 'npm:@canonry/val-kit@0.2.0/ui'

const PERCEPTION_STYLES = String.raw`
/* One instrument, so no tabs: the report starts straight after the header and
   needs the spacing a tab panel would otherwise have supplied. */
.report-body { padding-top: 34px; }

/* The kit's signal vocabulary has no negative, because the other Val has no
   negative signal. Here an engine cautioning about the brand is exactly that. */
.signal-negative { color: var(--negative); }

/* Unbounded counts, so a flat KPI row and no progress bars: "2 of 3" has no
   target to fill, and a bar would invent one. Four cells across, collapsing
   rather than shrinking, because a two-digit number in a 70px column is not
   more readable for being on one line. */
.verdict-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin: 18px 0 0; }
.verdict-row > div { border-top: 1px solid var(--border); padding-top: 11px; }
.verdict-row dt { color: var(--secondary); font-size: 13px; }
.verdict-row dd { margin: 3px 0 0; color: var(--text); font-family: var(--mono); font-size: 25px; font-weight: 650; letter-spacing: -.05em; }
.verdict-row dd.is-unmeasured { color: var(--muted); font-family: var(--sans); font-size: 15px; font-weight: 500; letter-spacing: normal; }
.verdict-row span { color: var(--muted); font-size: 13px; }
.verdict-row .is-positive dd { color: var(--positive); }
.verdict-row .is-caution dd { color: var(--caution); }
.verdict-row .is-negative dd { color: var(--negative); }

/* The answer's own words, in the table cell. Quoted, because a sentence lifted
   out of an answer is a quotation and must never read as our summary of it. */
.answer-quote { display: inline-block; max-width: 46ch; color: var(--text-strong); }
.answer-note { color: var(--muted); }
.answer-error { color: var(--caution); }

/* Inside the row disclosure: every verified sentence, still quoted. */
.quote-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.quote-list li { max-width: 72ch; border-left: 2px solid var(--border-strong); padding-left: 11px; color: var(--text-strong); }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.chip-list li { border: 1px solid var(--border-strong); border-radius: 999px; padding: 2px 9px; color: var(--secondary); font-size: 12px; }

/* Concerns: a phrase and how many answers wrote it. A list, not a table, since
   there are two facts per row and one of them is prose. */
.concern-list { margin: 10px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.concern-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border); padding: 11px 2px; }
.concern-phrase { color: var(--text-strong); font-size: 14px; }
.concern-count { color: var(--muted); font-family: var(--mono); font-size: 12px; white-space: nowrap; }

.source-count { color: var(--text-strong); font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.source-share { color: var(--text); font-family: var(--mono); font-variant-numeric: tabular-nums; width: 6ch; }
.section-footnote { margin: 10px 0 0; color: var(--muted); font-size: 12px; }

@media (max-width: 860px) {
  .verdict-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .verdict-row { grid-template-columns: 1fr; gap: 12px; }
  .concern-list li { align-items: flex-start; flex-direction: column; gap: 4px; }
}
`

/** Served from `/assets/canonry-ui.css` by the Val host, as one stylesheet. */
export const brandPerceptionStyles = `${canonryDemoStyles}\n${PERCEPTION_STYLES}`
