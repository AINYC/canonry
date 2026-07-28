const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

/**
 * Unicode-aware word tokens for brand identity matching. Compatibility
 * normalization folds presentation variants without changing spelling.
 */
export function brandWords(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const words: string[] = []
  for (const segment of WORD_SEGMENTER.segment(normalized)) {
    if (!segment.isWordLike) continue
    for (const word of segment.segment.match(/[\p{L}\p{N}]+/gu) ?? []) {
      words.push(word)
    }
  }
  return words
}

/**
 * Compact key used to compare an approved brand name across punctuation,
 * spacing, and casing variants.
 */
export function brandKeyFromText(value: string): string {
  return brandWords(value).join('')
}

/**
 * Match an approved brand alias as one or more complete adjacent words.
 *
 * This tolerates presentation-only variants (`Demand IQ`, `Demand-IQ`,
 * `DemandIQ`) but never edit-distance or substring guesses (`prime` does not
 * match `price`, and `acme` does not match `acmeology`).
 */
export function textContainsBrandAlias(
  text: string | null | undefined,
  alias: string | null | undefined,
): boolean {
  if (!text || !alias) return false
  const aliasKey = brandKeyFromText(alias)
  if (!aliasKey) return false

  const words = brandWords(text)
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (candidate === aliasKey) return true
      if (candidate.length >= aliasKey.length) break
    }
  }
  return false
}

/** Match any operator-approved or domain-derived alias in prose. */
export function textContainsAnyBrandAlias(
  text: string | null | undefined,
  aliases: readonly string[],
): boolean {
  return aliases.some(alias => textContainsBrandAlias(text, alias))
}
