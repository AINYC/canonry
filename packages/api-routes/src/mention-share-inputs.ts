import {
  brandLabelFromDomain,
  compileQueryClassifier,
  effectiveBrandNames,
  type QueryClass,
} from '@ainyc/canonry-contracts'
import { usableBrandAliases, type MentionShareCompetitor, type MentionShareSnapshot } from '@ainyc/canonry-intelligence'

/**
 * The one place mention-share inputs are assembled.
 *
 * Every surface that reports mention share — the project overview card, the
 * trend buckets, `visibility-stats --share-of-voice`, `visibility-compare`, the
 * client report — has to classify the same queries the same way and match the
 * same competitor aliases the same way, or the same run produces different
 * numbers depending on which screen you read it on. Assembling the inputs in
 * one module is what makes that true rather than aspirational.
 */

export interface MentionShareProject {
  displayName?: string | null
  aliases?: string[] | null
  canonicalDomain?: string | null
  ownedDomains?: string[] | null
}

export interface MentionShareSnapshotRow {
  queryId?: string | null
  queryText?: string | null
  answerMentioned: boolean | null
  answerText: string | null
}

export interface MentionShareInputs {
  snapshots: MentionShareSnapshot[]
  competitors: MentionShareCompetitor[]
  /** False when the project has no usable brand alias, so nothing could be split. */
  classified: boolean
}

/**
 * Competitor aliases for answer-prose matching.
 *
 * A single brand token derived from the registrable domain (`offers.roofle.com`
 * → `roofle`), filtered by the SAME minimum length the metric uses everywhere.
 * A future column of operator-curated aliases layers on here.
 */
export function mentionShareCompetitorsFromDomains(domains: readonly string[]): MentionShareCompetitor[] {
  return domains.map(domain => ({
    domain,
    brandTokens: usableBrandAliases([brandLabelFromDomain(domain)]),
  }))
}

/**
 * Classify a project's tracked queries into branded / non-brand.
 *
 * Returns `null` when the project has no usable brand alias: callers must then
 * report a pooled figure AS pooled rather than passing an unsplit basket off as
 * a non-brand one.
 */
export function projectQueryClassifier(project: MentionShareProject): ((queryText: string | null | undefined) => QueryClass) | null {
  const classifier = compileQueryClassifier(effectiveBrandNames({
    displayName: project.displayName ?? null,
    aliases: project.aliases ?? null,
    canonicalDomain: project.canonicalDomain ?? null,
    ownedDomains: project.ownedDomains ?? null,
  }))
  return classifier ? (queryText) => classifier.classify(queryText) : null
}

/**
 * Build the snapshot + competitor inputs for `buildMentionShare`.
 *
 * `queryTextById` carries the CURRENT text of a tracked query; the snapshot's
 * own denormalized `queryText` is the fallback for rows whose query has since
 * been renamed or deleted. Classification reads whichever is available, so an
 * archived snapshot still lands in the class its text says it belongs to
 * instead of silently defaulting into the competitive figure.
 */
export function buildMentionShareInputs(opts: {
  project: MentionShareProject
  competitorDomains: readonly string[]
  snapshots: readonly MentionShareSnapshotRow[]
  queryTextById?: ReadonlyMap<string, string>
}): MentionShareInputs {
  const classify = projectQueryClassifier(opts.project)
  return {
    classified: classify !== null,
    competitors: mentionShareCompetitorsFromDomains(opts.competitorDomains),
    snapshots: opts.snapshots.map(snap => {
      const queryText = (snap.queryId ? opts.queryTextById?.get(snap.queryId) : undefined) ?? snap.queryText ?? null
      return {
        projectMentioned: snap.answerMentioned === true,
        answerText: snap.answerText,
        queryClass: classify ? classify(queryText) : null,
      }
    }),
  }
}
