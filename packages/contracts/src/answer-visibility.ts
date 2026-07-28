import { brandKeyFromText, textContainsBrandAlias } from './brand-matching.js'
import type { MentionState, VisibilityState } from './run.js'
import {
  brandLabelFromDomain,
  extractDomainsFromText,
  hostMatchesDomain,
  hostOf,
} from './url-normalize.js'

const MIN_DOMAIN_BRAND_KEY_LENGTH = 4

export interface AnswerMentionResult {
  mentioned: boolean
  matchedTerms: string[]
}

export function extractAnswerMentions(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
): AnswerMentionResult {
  if (!answerText) return { mentioned: false, matchedTerms: [] }

  const matchedTerms: string[] = []
  const matchedDomainTerms = new Set<string>()
  const answerDomains = extractDomainsFromText(answerText)

  for (const domain of domains) {
    const normalizedDomain = hostOf(domain)
    if (!normalizedDomain || !normalizedDomain.includes('.')) continue
    if (answerDomains.some(candidate => hostMatchesDomain(candidate, normalizedDomain))) {
      matchedTerms.push(normalizedDomain)
      matchedDomainTerms.add(normalizedDomain)
    }
  }

  // Each configured name is an approved identity. Presentation variants
  // (spacing, punctuation, case) match; spelling guesses do not.
  for (const brandName of brandNames) {
    if (!brandName || !brandName.trim()) continue
    if (textContainsBrandAlias(answerText, brandName)) {
      matchedTerms.push(brandName)
    }
  }

  // A domain is operator-approved project identity too. Its registrable brand
  // label is useful when no display name exists, but only as an exact
  // presentation-normalized match.
  for (const domain of domains) {
    const brand = brandLabelFromDomain(domain)
    if (
      brandKeyFromText(brand).length >= MIN_DOMAIN_BRAND_KEY_LENGTH
      && textContainsBrandAlias(answerText, brand)
    ) {
      matchedTerms.push(brand)
    }
  }

  // Deduplicate and remove tokens already subsumed by a domain match
  // e.g. if 'ainyc.ai' is in matchedTerms, don't also show 'ainyc'
  const unique = [...new Set(matchedTerms)]
  const domainBrandKeys = new Set(
    [...matchedDomainTerms]
      .map(domain => brandKeyFromText(brandLabelFromDomain(domain)))
      .filter(Boolean),
  )
  const dedupedFinal = unique.filter(term => {
    if (matchedDomainTerms.has(term)) return true
    // Drop a matching brand label when the full written domain is already
    // stronger evidence.
    return !domainBrandKeys.has(brandKeyFromText(term))
  })
  return { mentioned: dedupedFinal.length > 0, matchedTerms: dedupedFinal }
}

export function determineAnswerMentioned(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
): boolean {
  return extractAnswerMentions(answerText, brandNames, domains).mentioned
}

export function visibilityStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): VisibilityState {
  return answerMentioned ? 'visible' : 'not-visible'
}

/**
 * Canonical-vocabulary equivalent of `visibilityStateFromAnswerMentioned`.
 * Returns `'mentioned'` / `'not-mentioned'` — the language new APIs, CLI
 * flags, and UI labels must use per the AGENTS.md vocabulary rules.
 */
export function mentionStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): MentionState {
  return answerMentioned ? 'mentioned' : 'not-mentioned'
}
