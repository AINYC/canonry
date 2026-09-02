/**
 * The public Val Town page consumes this intentionally small, serializable
 * view model. The runtime maps normalized Canonry results into it; this layer
 * never reads secrets, provider payloads, or storage directly.
 */

export type DemoUiStatus =
  | 'demo'
  | 'ready'
  | 'loading'
  | 'partial'
  | 'error'
  | 'rate-limited'
  | 'empty'

export type VisibilityMetric = 'mentioned' | 'cited'
export type EvidenceState = 'success' | 'pending' | 'failed' | 'not-measured'

export interface UiAction {
  label: string
  href?: string
  /** Submit action when the action is represented by the public check form. */
  formAction?: string
}

export interface UiNotice {
  title: string
  detail: string
  tone: 'neutral' | 'positive' | 'caution' | 'negative'
  action?: UiAction
}

export interface ProviderDescriptor {
  id: string
  label: string
  /** Requested model, never inferred from a response. */
  model?: string
  color?: string
}

export interface ShareEntryViewModel {
  domain: string
  answers: number
  /** 0..100, already rounded for display. */
  percent: number
  isTarget: boolean
}

export interface ShareTailViewModel {
  domains: number
  percent: number
}

export interface ShareViewModel {
  /** Which signal built this table. Cited and mentioned never share one. */
  basis: 'citation' | 'mention'
  measuredAnswers: number
  /** Denominator of every share: total domain-answer appearances. */
  totalAppearances: number
  unattributedAnswers: number
  entries: readonly ShareEntryViewModel[]
  /** Everything past the display cap, stated rather than drawn as a fake row. */
  tail: ShareTailViewModel | null
  /** 0..100. Zero is measured; the field is absent when nothing was. */
  targetPercent: number
  targetDomain: string
}

export interface VisibilitySummaryMetric {
  /** 0..100 only when denominator is known. */
  rate: number | null
  numerator: number
  denominator: number
  deltaPoints?: number | null
}

export interface EvidenceSource {
  url: string
  title?: string | null
  /** Whether the source URL belongs to the checked domain. */
  isTargetDomain?: boolean
}

export interface QueryEvidenceViewModel {
  id: string
  query: string
  provider: string
  providerLabel?: string
  requestedModel?: string | null
  servedModel?: string | null
  completedAt?: string | null
  /** A null signal means unavailable, never false. */
  mentioned: boolean | null
  /** A null signal means unavailable, never false. */
  cited: boolean | null
  matchedTerms?: readonly string[]
  answerText?: string | null
  sources?: readonly EvidenceSource[]
  searchQueries?: readonly string[]
  retrievalStatus?: EvidenceState
  error?: string | null
}

export interface VisibilityViewModel {
  /** Demo history is explicitly synthetic. Fresh live work is a snapshot. */
  historyKind: 'snapshot'
  /** Absent when no successful answer attributed a source. */
  /** Cited-basis table. Absent when no successful answer attributed a source. */
  share?: ShareViewModel
  /**
   * Mentioned-basis table. Absent when the brand extraction did not run, which
   * is why it is a separate optional field rather than a variant of `share`:
   * one basis can be measurable while the other is not.
   */
  mentionShare?: ShareViewModel
  checkedAt?: string | null
  requestedAt?: string | null
  providers: readonly ProviderDescriptor[]
  summaries: Record<VisibilityMetric, VisibilitySummaryMetric>
  evidence: readonly QueryEvidenceViewModel[]
  /** Successful checks only are the denominator for the summary rates. */
  completedChecks: number
  requestedChecks: number
  failedChecks?: number
  notice?: UiNotice
}

export type SiteHealthFactorState = 'measured' | 'not-applicable' | 'unavailable'

export interface SiteHealthFactorViewModel {
  id: string
  label: string
  state: SiteHealthFactorState
  score: number | null
  detail: string
  /** What the crawl saw, deduped across sampled pages. */
  findings: readonly string[]
  /** What to do about it, deduped across sampled pages. */
  recommendations: readonly string[]
}

/** Outside the score, so it is never collapsed behind a disclosure. */
export interface SiteHealthDefectViewModel {
  id: string
  severity: string
  detail: string
  recommendation: string
  pages: number
}

export type PageHealthStatus = 'good' | 'needs-attention' | 'unavailable'

export interface SiteHealthPageViewModel {
  url: string
  score: number | null
  status: PageHealthStatus
  findings: readonly string[]
  indexable?: boolean | null
}

export interface SiteHealthFixViewModel {
  id: string
  title: string
  detail: string
  affectedPages?: number | null
}

export interface SiteHealthProvenanceViewModel {
  /** Crawl-result schema retained so the bounded sample remains traceable. */
  schemaVersion?: string | null
  /** Requested and resolved crawl roots distinguish a redirect from a source URL. */
  rootUrl?: string | null
  finalRootUrl?: string | null
  /** Hosts the bounded runner actually attempted, in order. */
  attemptedHosts?: readonly string[]
  /** Optional engine identity when the host makes it available. */
  engineVersion?: string | null
}

/** A laid-out node: graph facts plus the coordinates the renderer resolved. */
export interface SiteMapNodeViewModel {
  key: string
  url: string
  label: string
  depth: number | null
  crawled: boolean
  score: number | null
  indexable: boolean | null
  inboundLinks: number
  outboundLinks: number
}

export interface SiteMapEdgeViewModel {
  from: string
  to: string
  followable: boolean
}

export interface SiteMapViewModel {
  nodes: readonly SiteMapNodeViewModel[]
  edges: readonly SiteMapEdgeViewModel[]
  /** Pre-cap totals, so a displayed sample never reads as the whole site. */
  totalPages: number
  totalEdges: number
  truncated: boolean
}

export interface SiteHealthViewModel {
  /** Must remain an honest bounded-sample label in the public demo. */
  sampleLabel: string
  score: number | null
  /** URLs found by the bounded crawl, not a total site-page count. */
  discoveredPages: number
  attemptedPages: number
  completedPages: number
  failedPages: number
  checkedAt?: string | null
  factors: readonly SiteHealthFactorViewModel[]
  criticalDefects: readonly SiteHealthDefectViewModel[]
  worstPages: readonly SiteHealthPageViewModel[]
  /** Durable reason a bounded crawl ended before completion, never synthesized. */
  terminationReason?: string | null
  provenance?: SiteHealthProvenanceViewModel
  siteMap?: SiteMapViewModel
  notice?: UiNotice
}

export interface CheckFormViewModel {
  action: string
  method?: 'get' | 'post'
  /** Field read by the server-side verifier. Never render a secret in this model. */
  verificationFieldName?: string
  /** A public Cloudflare Turnstile site key. Omit it for local/test bypasses. */
  turnstileSiteKey?: string | null
  /** `audit` is intentionally fixed so the server can reject action mismatches. */
  turnstileAction?: 'audit'
  /** Production without a configured verifier is truthfully disabled. */
  verificationStatus?: 'ready' | 'not-required' | 'unavailable'
  verificationUnavailableMessage?: string
  submitLabel?: string
}

export interface CanonryDemoViewModel {
  status: DemoUiStatus
  title?: string
  displayName: string
  domain: string
  locale?: string
  form?: CheckFormViewModel
  visibility?: VisibilityViewModel
  siteHealth?: SiteHealthViewModel
  notice?: UiNotice
}
