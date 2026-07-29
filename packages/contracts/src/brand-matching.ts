/**
 * EXACT BRAND IDENTITY MATCHING.
 *
 * An approved alias matches as one or more COMPLETE adjacent words, so
 * presentation variants (`Demand IQ`, `Demand-IQ`, `DemandIQ`) all match while
 * spelling guesses never do: `acme` does not match `acmeology`, and `prime`
 * does not match `price`. Similarity is not identity, so nothing here uses
 * edit distance or substrings.
 *
 * A FIXED LOCALE, deliberately. `undefined` resolves to whatever the host is
 * set to, which makes a KPI depend on the machine that computed it: the same
 * answer could segment one way on a laptop and another inside a container.
 * Nothing about this matching repays that risk.
 */
const WORD_SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' })

/** Everything that is not a letter or a digit, i.e. whatever separates words. */
const NON_WORD = /[^\p{L}\p{N}]+/gu
const WORD_RUNS = /[\p{L}\p{N}]+/gu

/** Fold presentation variants without changing spelling. */
function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en')
}

/** The word tokens of an already-normalized string. */
function wordsOfNormalized(normalized: string): string[] {
  const words: string[] = []
  for (const segment of WORD_SEGMENTER.segment(normalized)) {
    if (!segment.isWordLike) continue
    for (const word of segment.segment.match(WORD_RUNS) ?? []) words.push(word)
  }
  return words
}

/**
 * Unicode-aware word tokens for brand identity matching. Compatibility
 * normalization folds presentation variants without changing spelling.
 */
export function brandWords(value: string): string[] {
  return wordsOfNormalized(normalizeForMatch(value))
}

/**
 * Compact key used to compare an approved brand name across punctuation,
 * spacing, and casing variants.
 */
export function brandKeyFromText(value: string): string {
  return brandWords(value).join('')
}

/** Approved aliases compiled once, so one list can be reused across many texts. */
export interface BrandAliasMatcher {
  readonly keys: ReadonlySet<string>
  /** Nothing longer than this can match, so the inner scan stops there. */
  readonly longest: number
}

/**
 * Compile approved aliases into a reusable matcher.
 *
 * Exposed rather than hidden because the shape of the work is one alias list
 * against thousands of texts: a caller classifying a whole property's answers
 * should build this once, not once per answer.
 */
export function compileBrandAliases(aliases: readonly string[]): BrandAliasMatcher {
  const keys = new Set<string>()
  let longest = 0
  for (const alias of aliases) {
    if (!alias) continue
    const key = brandKeyFromText(alias)
    if (!key) continue
    keys.add(key)
    if (key.length > longest) longest = key.length
  }
  return { keys, longest }
}

/**
 * Does any compiled alias appear in the text as complete adjacent words?
 *
 * ONE segmentation for the whole alias set. Asking each alias separately
 * re-segmented the entire text every time, so cost grew with the alias count:
 * measured on a real corpus, the marginal cost of an eighth alias was 604ms
 * against 580ms for a single full segmentation. Since the point of approving
 * aliases is that clients accumulate them, the cost grew exactly where the
 * design says it must not.
 *
 * THE CHEAP REJECT comes first. `wordCharsOnly` is every letter and digit in
 * order with everything else dropped. A match needs adjacent words whose
 * concatenation equals an alias key, and adjacent words are separated in the
 * source by non-word characters only, so a matching alias MUST appear there as
 * a contiguous substring. The converse does not hold (it also "finds" `acme`
 * inside `acmeology`), which is precisely why it only ever rejects. It pays
 * because most answers mention nothing: one regex pass against a full Unicode
 * walk.
 */
export function matcherMatchesText(
  matcher: BrandAliasMatcher,
  text: string | null | undefined,
): boolean {
  if (!text || matcher.keys.size === 0) return false
  const normalized = normalizeForMatch(text)

  const stripped = normalized.replace(NON_WORD, '')
  let possible = false
  for (const key of matcher.keys) {
    if (stripped.includes(key)) {
      possible = true
      break
    }
  }
  if (!possible) return false

  const words = wordsOfNormalized(normalized)
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (matcher.keys.has(candidate)) return true
      if (candidate.length >= matcher.longest) break
    }
  }
  return false
}

/**
 * WHICH aliases matched, from a single pass.
 *
 * Same walk as {@link matcherMatchesText}, collecting instead of returning at
 * the first hit. The caller that needs to report which identity it saw would
 * otherwise ask once per term and pay a full segmentation for each.
 */
export function matchedAliasKeys(
  matcher: BrandAliasMatcher,
  text: string | null | undefined,
): Set<string> {
  const found = new Set<string>()
  if (!text || matcher.keys.size === 0) return found
  const normalized = normalizeForMatch(text)
  const stripped = normalized.replace(NON_WORD, '')
  const reachable = [...matcher.keys].filter(key => stripped.includes(key))
  if (reachable.length === 0) return found

  const words = wordsOfNormalized(normalized)
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (matcher.keys.has(candidate)) found.add(candidate)
      if (candidate.length >= matcher.longest) break
    }
    if (found.size === matcher.keys.size) break
  }
  return found
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
  if (!alias) return false
  return matcherMatchesText(compileBrandAliases([alias]), text)
}

/** Match any operator-approved or domain-derived alias in prose. */
export function textContainsAnyBrandAlias(
  text: string | null | undefined,
  aliases: readonly string[],
): boolean {
  return matcherMatchesText(compileBrandAliases(aliases), text)
}
