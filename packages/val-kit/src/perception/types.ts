/**
 * Brand perception: how an answer engine characterises a brand when it is asked
 * about DIRECTLY.
 *
 * This is a different instrument from AI visibility, not a variant of it.
 * Visibility asks NON-BRAND questions and measures whether the brand shows up
 * at all; perception asks BRANDED questions, where showing up is guaranteed and
 * the finding is what the engine then SAYS. The two never share a denominator,
 * a table, or a rate — a branded basket answers a question the non-brand basket
 * cannot, and pooling them lets recall outvote the characterisation.
 *
 * What is reported is the VERDICT the answer literally gives, carried by
 * sentences copied out of it. Never a sentiment score, never an inferred
 * opinion: a number between 0 and 1 would read as a measurement of feeling,
 * and nothing here measures feeling. `'none'` says the answer took no position,
 * which is a finding; `null` says the check did not produce one, which is the
 * absence of a finding and leaves every denominator.
 */

/** What the answer says about the brand, in the answer's own terms. */
export type PerceptionVerdict = 'recommends' | 'cautions' | 'mixed' | 'none'

/**
 * What KIND of place the engine attributed. These are sources the engine cited
 * for this answer — never "where opinions about the brand come from on the web",
 * which is a claim about the internet that three answers cannot support.
 */
export type SourceType = 'official' | 'community' | 'review' | 'news' | 'other'

export interface PerceptionSourceRef {
  url: string
  /** Null when the provider handed back an opaque redirect it could not attribute. */
  domain: string | null
  title: string | null
  type: SourceType
}

/** One branded answer, normalized for display. Never place a raw provider response here. */
export interface PerceptionEvidence {
  /** The branded query asked, verbatim. */
  query: string
  provider: string
  requestedModel: string
  servedModel: string | null
  completedAt: string
  /** Clipped by the runner limits. Null when the check failed. */
  answerText: string | null
  /** Null = the check failed or its verdict was never extracted (unmeasured). `'none'` = measured, took no position. */
  verdict: PerceptionVerdict | null
  /**
   * Sentences copied out of `answerText` that carry the verdict, each verified
   * present in it. Empty when the verdict is `'none'` or `null` — a verdict
   * with nothing written behind it is not a verdict.
   */
  evidenceSentences: string[]
  /** Short phrases the answer raises as concerns, each verified written in the prose. */
  concerns: string[]
  /** Engine-attributed, one entry per URL, typed. */
  sources: PerceptionSourceRef[]
  /** The engine's grounding fan-out, when it disclosed one. */
  searchQueries: string[]
  retrievalStatus: 'grounded' | 'ungrounded' | 'error'
  /** Safe classified message, never a provider body. */
  error: string | null
}

export interface PerceptionVerdictCounts {
  recommends: number
  cautions: number
  mixed: number
  none: number
}

export interface PerceptionConcern {
  /** Display casing is the first-seen prose casing, not a normalized key. */
  phrase: string
  /** Answers that raised it. Counted once per answer, however often it repeats inside one. */
  answers: number
}

export interface PerceptionSourceTypeShare {
  /** Successful checks that attributed at least one source. The denominator. */
  measuredAnswers: number
  /**
   * Successful checks that attributed NO source. Stated rather than folded into
   * the denominator: an answer with no sources is not an answer where some
   * source type won.
   */
  unattributedAnswers: number
  /** Sum over answers of the DISTINCT types that answer attributed. */
  totalAppearances: number
  /** `share` is `answers / totalAppearances`, so the entries sum to 1. */
  entries: Array<{ type: SourceType; answers: number; share: number }>
}

export interface PerceptionSummary {
  /** Checks that produced a verdict. Every rate and every count below rests on this. */
  successfulChecks: number
  /** Checks that produced none — a failed probe or an unextracted verdict. In no denominator. */
  failedChecks: number
  /** Over successful checks only: recommends + cautions + mixed + none === successfulChecks. */
  verdicts: PerceptionVerdictCounts
  /** Counted once per answer, deduped case- and punctuation-insensitively, sorted answers desc then phrase asc. */
  concerns: PerceptionConcern[]
  /** Null when no successful check attributed a source. */
  sourceTypes: PerceptionSourceTypeShare | null
}

export interface PerceptionReport {
  schemaVersion: '1'
  /** As entered by the caller; it may still carry `www.`. */
  domain: string
  /** The aliases the planner approved and the probes asked about. Empty when planning failed. */
  brandNames: string[]
  startedAt: string
  completedAt: string
  summary: PerceptionSummary
  evidence: PerceptionEvidence[]
}

export interface PerceptionProbeInput {
  domain: string
  /**
   * Caller-supplied questions, used verbatim. A visitor's own question need not
   * name the brand — they chose it — while a GENERATED one must. The planner
   * fills only the remainder and is not called at all when the caller supplied
   * the full set.
   */
  userQueries?: readonly string[]
  /** Bounded by the host's own ceiling; a runtime caller can lower it, never raise it. */
  maxProbeCalls: number
  signal: AbortSignal
}

/**
 * Boundary between a val's check orchestration and this instrument. The
 * returned report never includes a raw provider response.
 */
export interface PerceptionProbePort {
  probe(input: PerceptionProbeInput): Promise<PerceptionReport>
}
