/**
 * The public Val Town page consumes this intentionally small, serializable view
 * model. The runtime maps normalized check records into it; this layer never
 * reads secrets, provider payloads, or storage directly.
 */
import type { PerceptionVerdict, SourceType } from 'npm:@canonry/val-kit@0.1.0/perception'

export type DemoUiStatus =
  | 'ready'
  | 'loading'
  | 'partial'
  | 'error'
  | 'rate-limited'
  | 'empty'

export type UiTone = 'neutral' | 'positive' | 'caution' | 'negative'

export interface UiAction {
  label: string
  href?: string
}

export interface UiNotice {
  title: string
  detail: string
  tone: UiTone
  action?: UiAction
}

export interface PerceptionSourceViewModel {
  url: string
  title: string | null
  /** Null when the engine handed back an opaque redirect it could not attribute. */
  domain: string | null
  typeLabel: string
}

export interface PerceptionAnswerViewModel {
  id: string
  query: string
  /** Null is unmeasured, never 'none'. 'none' is a position the answer took. */
  verdict: PerceptionVerdict | null
  verdictLabel: string
  verdictTone: UiTone
  /** The first verified sentence, or null when there is none to quote. */
  headline: string | null
  evidenceSentences: readonly string[]
  concerns: readonly string[]
  sources: readonly PerceptionSourceViewModel[]
  searchQueries: readonly string[]
  answerText: string | null
  requestedModel?: string | null
  servedModel?: string | null
  completedAt?: string | null
  /** Why this answer was not measured. Null when it was. */
  error: string | null
}

export interface VerdictCountViewModel {
  key: PerceptionVerdict
  label: string
  count: number
  tone: UiTone
}

export interface ConcernViewModel {
  phrase: string
  answers: number
}

export interface SourceTypeEntryViewModel {
  type: SourceType
  label: string
  answers: number
  /** 0..100, already rounded for display. */
  percent: number
}

export interface SourceTypeViewModel {
  measuredAnswers: number
  unattributedAnswers: number
  totalAppearances: number
  entries: readonly SourceTypeEntryViewModel[]
}

export interface PerceptionViewModel {
  checkedAt?: string | null
  requestedAt?: string | null
  /** Checks that produced a verdict. The denominator of every count below. */
  measuredAnswers: number
  /** Every branded question asked, measured or not. */
  requestedAnswers: number
  failedAnswers: number
  verdicts: readonly VerdictCountViewModel[]
  concerns: readonly ConcernViewModel[]
  /** Absent when no measured answer attributed a source. */
  sourceTypes?: SourceTypeViewModel
  answers: readonly PerceptionAnswerViewModel[]
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

export interface BrandPerceptionViewModel {
  status: DemoUiStatus
  title?: string
  displayName: string
  domain: string
  form?: CheckFormViewModel
  perception?: PerceptionViewModel
  notice?: UiNotice
}
