/**
 * Share of voice across the answers, on either of the two signals.
 *
 * `computeShareOfVoice` measures CITATIONS: which domains the engine attributed
 * as sources. `computeMentionShare` measures MENTIONS: which brands the answer
 * prose names. They are independent signals and never share a table, a
 * denominator, or a row set, because a site can be cited without being named
 * and named without being cited.
 *
 * The citation basis needs no help; the notes below are why the mention basis
 * needed a separate extraction step before it could exist at all.
 *
 * This is citation share, not mention share, and the distinction is not
 * cosmetic. Mention share needs to know who the rivals ARE, by name, so their
 * names can be matched in the answer text. A public check has no competitor
 * list, and this Val's own probe contract forbids the shortcut: brand names are
 * exact approved aliases, and a prose alias is never derived from a domain. So
 * inferring "stripe.com appears in the sources, therefore the word Stripe in
 * this answer is a rival mention" is exactly the guess the contract rules out.
 *
 * What IS measured, with no inference: every domain the engine attributed as a
 * source, and how many answers each appeared in. That answers the question the
 * visitor actually has, which is who is winning the answers they are losing.
 *
 * A domain counts once per answer, never once per link. Ten links to one
 * documentation site is one site holding one answer, and counting links would
 * let a single well-linked page outrank a domain cited across every answer.
 */
import { brandKey, hostMatchesDomain } from './brand.js'
import type { VisibilityEvidence } from '../runtime/types.js'

/** Rows past this are folded into a single remainder, so the bar stays readable. */
export const SHARE_MAX_ROWS = 7

export interface ShareEntry {
  domain: string
  /** Answers this domain was cited in. */
  answers: number
  /** Fraction of all domain-answer appearances, 0..1. */
  share: number
  /** The checked domain, including its subdomains. */
  isTarget: boolean
}

/**
 * Everything past the display cap, as one fact rather than a fake row.
 *
 * It used to be an entry in `entries`, which meant the table printed a row
 * reading "12 more sites, 12 of 2 answers": the answers column counted
 * appearances spread across twelve different domains against the number of
 * answers, which is not a ratio of anything.
 */
export interface ShareTail {
  domains: number
  answers: number
  share: number
}

/** Which signal a share table was built from. They are never mixed. */
export type ShareBasis = 'citation' | 'mention'

export interface ShareOfVoice {
  basis: ShareBasis
  /** Successful checks that attributed at least one source. */
  measuredAnswers: number
  /**
   * Successful checks where the engine attributed no source at all. Kept
   * visible: an answer with no sources is not an answer where rivals won.
   */
  unattributedAnswers: number
  /** Denominator of `share`: total domain-answer appearances. */
  totalAppearances: number
  entries: ShareEntry[]
  /** Absent when nothing was folded. */
  tail: ShareTail | null
  /** The checked domain's share. Zero is measured; null means nothing was. */
  targetShare: number | null
}

/**
 * Build the share table. Returns null when no successful check attributed a
 * source, because a chart of nothing is worse than no chart.
 */
export function computeShareOfVoice(
  evidence: readonly VisibilityEvidence[],
  targetDomain: string,
): ShareOfVoice | null {
  // A failed check is unmeasured, not a zero. It cannot count toward a share.
  const successful = evidence.filter((row) => row.cited !== null || row.mentioned !== null)
  if (successful.length === 0) return null

  const answersByDomain = new Map<string, number>()
  let unattributedAnswers = 0

  for (const row of successful) {
    // Group the checked site's subdomains into the site itself: docs.example.com
    // losing to example.com is not a competitive fact.
    const seen = new Set<string>()
    for (const domain of row.citedDomains) {
      const key = hostMatchesDomain(domain, targetDomain) ? targetDomain : domain
      seen.add(key)
    }
    if (seen.size === 0) {
      unattributedAnswers++
      continue
    }
    for (const key of seen) answersByDomain.set(key, (answersByDomain.get(key) ?? 0) + 1)
  }

  return rank(
    answersByDomain,
    successful.length - unattributedAnswers,
    unattributedAnswers,
    targetDomain,
    'citation',
  )
}

/**
 * Turn per-name answer counts into the ranked, capped, target-preserving table
 * both bases render. Shared so the two can never drift apart in ordering, in
 * where the display cut falls, or in how the remainder is reported.
 */
function rank(
  answersByKey: Map<string, number>,
  measuredAnswers: number,
  unattributedAnswers: number,
  targetKey: string,
  basis: ShareBasis,
  // Display label per key. Grouping, ordering, the display cut, and the target
  // identity all ride the KEY; only the rendered `domain` uses the label. Absent
  // for citation share, where the key is already the display domain.
  labels?: ReadonlyMap<string, string>,
): ShareOfVoice | null {
  const totalAppearances = [...answersByKey.values()].reduce((sum, count) => sum + count, 0)
  if (totalAppearances === 0) return null

  const ranked = [...answersByKey.entries()]
    .map(([domain, answers]) => ({ domain, answers }))
    // Deterministic: ties break by name, so the same crawl always draws the
    // same bar in the same order.
    .sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain))

  // The checked site always keeps its row. Zero is the case where that row
  // matters most, and the earlier version dropped it precisely then: it only
  // re-inserted a target that ranked BELOW the cut, and a name absent from the
  // ranking has no rank at all.
  const head = ranked.slice(0, SHARE_MAX_ROWS)
  const headKeys = new Set(head.map((entry) => entry.domain))
  if (!headKeys.has(targetKey)) {
    head.push(ranked.find((entry) => entry.domain === targetKey) ?? { domain: targetKey, answers: 0 })
    headKeys.add(targetKey)
  }

  const entries: ShareEntry[] = head.map((entry) => ({
    domain: labels?.get(entry.domain) ?? entry.domain,
    answers: entry.answers,
    share: entry.answers / totalAppearances,
    isTarget: entry.domain === targetKey,
  }))

  const tailEntries = ranked.filter((entry) => !headKeys.has(entry.domain))
  const tailAnswers = tailEntries.reduce((sum, entry) => sum + entry.answers, 0)

  return {
    basis,
    measuredAnswers,
    unattributedAnswers,
    totalAppearances,
    entries,
    tail: tailEntries.length > 0
      ? { domains: tailEntries.length, answers: tailAnswers, share: tailAnswers / totalAppearances }
      : null,
    targetShare: (answersByKey.get(targetKey) ?? 0) / totalAppearances,
  }
}

/**
 * Share of voice measured on MENTIONS: brands named in the answer prose.
 *
 * The rival names come from `mention-extract.ts`, where a model proposes and
 * exact matching disposes, so every name here is written in the answer it is
 * counted against. The target is counted from its OWN verdict (`mentioned`),
 * never from the extraction: its aliases are approved, the extraction's are
 * proposed, and the checked site must not depend on a model naming it
 * correctly.
 *
 * `namedBrands === null` is an answer the extraction never covered. Such an
 * answer is excluded from the denominator entirely rather than counted as
 * naming nobody, which would deflate every share by an outage.
 */
export function computeMentionShare(
  evidence: readonly VisibilityEvidence[],
  targetLabel: string,
): ShareOfVoice | null {
  const measured = evidence.filter((row) => row.mentioned !== null && row.namedBrands !== null)
  if (measured.length === 0) return null

  // Group by the same case-folded brand identity every other brand match uses
  // (`brandKey`), so "GitHub" and "github" are one row, not two. A display label
  // is tracked per key; the target always shows its approved-alias casing.
  const targetKey = brandKey(targetLabel)
  const labels = new Map<string, string>([[targetKey, targetLabel]])
  const answersByBrand = new Map<string, number>()
  let unattributedAnswers = 0

  for (const row of measured) {
    const seen = new Set<string>()
    for (const name of row.namedBrands ?? []) {
      const key = brandKey(name)
      if (!key) continue
      seen.add(key)
      if (!labels.has(key)) labels.set(key, cleanBrand(name))
    }
    // The target's row is its own verdict, never the extraction. Keying by the
    // case-folded identity also collapses the extraction's own differently-cased
    // copy of the target into this single decision, so the target can never
    // appear twice (its row plus a phantom rival) or leak in when not mentioned.
    if (row.mentioned === true) seen.add(targetKey)
    else seen.delete(targetKey)

    if (seen.size === 0) {
      unattributedAnswers++
      continue
    }
    for (const key of seen) answersByBrand.set(key, (answersByBrand.get(key) ?? 0) + 1)
  }

  return rank(answersByBrand, measured.length, unattributedAnswers, targetKey, 'mention', labels)
}

/** Display casing for a proposed rival name: trim and collapse whitespace. */
function cleanBrand(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}
