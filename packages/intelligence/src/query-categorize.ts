/**
 * Intent classifier for search queries — brand / lead-gen / industry / other.
 *
 * Pure: takes a query string + a precomputed brand-token list. The caller
 * builds the brand tokens once per project (or per render) and passes them
 * in, so the function stays cacheable and reusable across the report
 * builder, CLI text views, dashboards, and Aero's reasoning.
 *
 * Brand matching uses "compact" tokens — strip every non-alphanumeric
 * character on both sides — so "demand iq", "demandiq", "demand-iq",
 * "Demand IQ" all match a brand built from the canonical domain
 * "demand-iq.com".
 */

export type QueryCategory = 'brand' | 'lead-gen' | 'industry' | 'other'

const TRANSACTIONAL_RE = /\b(?:buy|price|pricing|cost|hire|near me|services?|agency|consultant|company)\b/i
const INFORMATIONAL_RE = /\b(?:what|how|why|when|guide|tutorial|vs|versus|alternatives?|examples?|definition)\b/i

const MIN_BRAND_TOKEN_LENGTH = 3

/**
 * Category and legal words that sit on the END of a domain or a display name
 * but are not what anyone types when they mean the brand.
 *
 * WHY THIS LIST EXISTS. Brand matching asks whether the QUERY CONTAINS a token,
 * so a token longer than the query can never match. `gjelinahotel.com` with the
 * display name "Gjelina Hotel" produced exactly one token, `gjelinahotel`, and
 * the brand's actual name is `gjelina`:
 *
 *   "gjelina".includes("gjelinahotel")        -> false
 *   "gjelinavenice".includes("gjelinahotel")  -> false
 *
 * On the pilot property that misfiled 205k impressions of plainly branded
 * search as non-brand, and branded share read 19.7% when it was 49.6%. The
 * branded and non-brand lanes are never pooled downstream, so the error does
 * not average out: it moves demand out of one KPI and into the other.
 *
 * It went unnoticed because it only fires when the display name compacts to the
 * SAME string as the domain stem. `azcoatingsllc.com` with "AZ Coatings"
 * already yields a second, shorter token and was always correct.
 */
const BRAND_SUFFIXES = [
  // Legal entity: what remains is almost always the registered name.
  'llc', 'inc', 'ltd', 'corp', 'company', 'holdings',
  // Category: kept narrow. `bar`, `shop`, `store`, `media` and `labs` were
  // tried and dropped, because their remainders (`wine`, `bike`, `book`,
  // `blue`, `data`) are the market's own vocabulary rather than anyone's name.
  'hotel', 'hotels', 'restaurant', 'clinic', 'realty',
] as const

/**
 * The shortest a suffix-stripped token may be. Four rather than
 * `MIN_BRAND_TOKEN_LENGTH`, because a stem this list can bite into is a token
 * nobody typed and nobody reviewed, so it earns a higher bar than one an
 * operator wrote down deliberately.
 */
const MIN_STRIPPED_TOKEN_LENGTH = 4

/**
 * Words that must never become a brand token on their own.
 *
 * Stripping a category word is only safe when what remains is a NAME. It is not
 * for `winebar.com`, `travelagency.com` or `bookstore.com`, where the remainder
 * is the ordinary English word the whole market searches: branding `wine`,
 * `travel` or `book` would inflate branded share exactly as far as the bug this
 * change fixes deflated it, in the other direction.
 *
 * There is no way to tell "Gjelina Hotel" from "Travel Agency" by shape alone,
 * so the honest guard is a list of remainders that are obviously not names.
 * It is deliberately small and covers the endings above: a stem that survives
 * it and is still generic will over-match, which is why `doctor` should learn to
 * report a project's token set (filed separately).
 */
const GENERIC_STEMS = new Set([
  'wine', 'beer', 'coffee', 'tea', 'juice', 'food', 'book', 'bike', 'auto',
  'travel', 'yoga', 'data', 'blue', 'green', 'sports', 'sport', 'health',
  'home', 'house', 'design', 'digital', 'creative', 'best', 'top', 'first',
  'city', 'local', 'smart', 'prime', 'pure', 'fresh', 'urban', 'modern',
])

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Build the compact brand-token list for a project. The caller passes this
 * into `categorizeQueryByIntent` to drive brand matching.
 *
 * Sources:
 *   1. The canonical domain with its TLD stripped — e.g. `demand-iq.com` → `demandiq`.
 *   2. Each brand name (displayName plus any aliases) — only when its compact
 *      form is at least `MIN_BRAND_TOKEN_LENGTH` and not already covered.
 *
 * Tokens shorter than `MIN_BRAND_TOKEN_LENGTH` are dropped to prevent
 * false-positive matches on common short strings (e.g. brand "x.io" → "x").
 */
export function buildBrandTokens(canonicalDomain: string, brandNames: readonly string[] = []): string[] {
  const seen = new Set<string>()
  const stem = canonicalDomain.toLowerCase().replace(/\.[a-z]{2,}$/, '')
  const stemCompact = compact(stem)
  if (stemCompact.length >= MIN_BRAND_TOKEN_LENGTH) seen.add(stemCompact)
  for (const name of brandNames) {
    if (!name) continue
    const nameCompact = compact(name)
    if (nameCompact.length >= MIN_BRAND_TOKEN_LENGTH) seen.add(nameCompact)
  }
  // The brand without its category or legal word. Derived from what is already
  // here rather than asked for, because the operator who would have supplied it
  // as an alias is the same one reading the number it corrupts, and has no
  // reason to suspect a token they never saw.
  for (const token of [...seen]) {
    for (const suffix of BRAND_SUFFIXES) {
      if (!token.endsWith(suffix)) continue
      const stripped = token.slice(0, token.length - suffix.length)
      if (stripped.length >= MIN_STRIPPED_TOKEN_LENGTH && !GENERIC_STEMS.has(stripped)) {
        seen.add(stripped)
      }
      // Only ONE suffix comes off. "hotelgroup" is a plausible ending and
      // stripping both would leave a stub that matches far too much.
      break
    }
  }
  return [...seen]
}

/**
 * Levenshtein distance, bounded by `max` so a long query costs nothing.
 *
 * Iterative and single-row: this runs per query word per token over a whole
 * property's search data, and the allocation of a full matrix showed up.
 */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      if (row[j]! < best) best = row[j]!
    }
    if (best > max) return false // whole row already too far; nothing recovers
    prev = row
  }
  return prev[b.length]! <= max
}

/** A query word is a misspelling of a brand token. */
const MAX_BRAND_EDIT_DISTANCE = 2
/** Below this a token is too short for two edits to mean anything. */
const MIN_FUZZY_TOKEN_LENGTH = 5

/**
 * Does any WORD of the query look like a misspelling of a brand token?
 *
 * People misspell brands constantly, and a brand still building recognition
 * gets a long tail of them: the pilot property had 121 distinct variants worth
 * 29k impressions, every one of them counted as non-brand demand.
 *
 * THREE GUARDS, and each one was put here by a false positive found in real
 * data rather than imagined:
 *
 *  - SAME FIRST LETTER. Without it, distance 2 from "gjelina" matches "selina",
 *    which is a competing hotel chain, plus "delina" and "melina".
 *  - LENGTH WITHIN ONE. Without it, "demand" is two edits from "demandiq", so
 *    "roofing leads on demand" and "on-demand storage solutions denver" both
 *    became branded traffic for a company called Demand IQ.
 *  - DISTANCE 2, NOT 3. Three edits on a seven-letter token is nearly half the
 *    word: it pulled in "hotel giuliana", "galena beach" and "glinka hotels",
 *    which are other businesses entirely.
 *
 * Word-level rather than whole-query, so "gelina venice" is caught by its first
 * word while the second is free to be as unlike the brand as it likes.
 */
function hasBrandMisspelling(query: string, brandTokens: readonly string[]): boolean {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const word of words) {
    for (const token of brandTokens) {
      if (token.length < MIN_FUZZY_TOKEN_LENGTH) continue
      if (word[0] !== token[0]) continue
      if (Math.abs(word.length - token.length) > 1) continue
      if (editDistanceWithin(word, token, MAX_BRAND_EDIT_DISTANCE)) return true
    }
  }
  return false
}

export function categorizeQueryByIntent(query: string, brandTokens: string[]): QueryCategory {
  const compactQuery = compact(query)
  if (brandTokens.length > 0 && brandTokens.some((t) => compactQuery.includes(t))) {
    return 'brand'
  }
  // Checked AFTER the exact test, never instead of it: an exact hit is free and
  // certain, and this only runs on the queries that already failed it.
  if (brandTokens.length > 0 && hasBrandMisspelling(query, brandTokens)) {
    return 'brand'
  }
  if (TRANSACTIONAL_RE.test(query)) return 'lead-gen'
  if (INFORMATIONAL_RE.test(query)) return 'industry'
  return 'other'
}
