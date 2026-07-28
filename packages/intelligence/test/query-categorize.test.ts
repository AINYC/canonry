import { describe, expect, test } from 'vitest'
import { buildBrandTokens, categorizeQueryByIntent } from '../src/query-categorize.js'

describe('buildBrandTokens', () => {
  test('strips TLD and produces a compact token from the canonical domain', () => {
    expect(buildBrandTokens('demand-iq.com')).toContain('demandiq')
  })

  test('includes brand names as compact tokens when distinct', () => {
    const tokens = buildBrandTokens('foo.com', ['Foo Bar'])
    expect(tokens).toContain('foobar')
  })

  test('drops tokens shorter than 3 characters', () => {
    const tokens = buildBrandTokens('a.com', ['B'])
    expect(tokens).toEqual([])
  })

  test('deduplicates tokens', () => {
    const tokens = buildBrandTokens('foo.com', ['foo'])
    expect(tokens).toEqual(['foo'])
  })

  test('includes multiple brand names (aliases)', () => {
    const tokens = buildBrandTokens('llamaindex.ai', ['LlamaIndex', 'LlamaParse'])
    expect(tokens).toContain('llamaindex')
    expect(tokens).toContain('llamaparse')
  })

  test('handles empty brand names array', () => {
    expect(buildBrandTokens('demand-iq.com', [])).toEqual(['demandiq'])
  })
})

describe('categorizeQueryByIntent', () => {
  const brand = ['demandiq']

  test('matches "demand iq" / "demandiq" / "demand iq login" all as brand', () => {
    expect(categorizeQueryByIntent('demand iq', brand)).toBe('brand')
    expect(categorizeQueryByIntent('demandiq', brand)).toBe('brand')
    expect(categorizeQueryByIntent('demand iq login', brand)).toBe('brand')
    expect(categorizeQueryByIntent('Demand IQ Pricing', brand)).toBe('brand')
  })

  test('matches hyphenated brand variants', () => {
    expect(categorizeQueryByIntent('demand-iq pricing', brand)).toBe('brand')
  })

  test('does not classify non-brand queries as brand', () => {
    expect(categorizeQueryByIntent('roofing estimate calculator', brand)).not.toBe('brand')
    expect(categorizeQueryByIntent('hvac lead generation', brand)).not.toBe('brand')
  })

  test('classifies transactional queries as lead-gen', () => {
    expect(categorizeQueryByIntent('buy hvac estimator', [])).toBe('lead-gen')
    expect(categorizeQueryByIntent('roofing services near me', [])).toBe('lead-gen')
    expect(categorizeQueryByIntent('hvac contractor agency', [])).toBe('lead-gen')
  })

  test('classifies informational queries as industry', () => {
    expect(categorizeQueryByIntent('how does aeo work', [])).toBe('industry')
    expect(categorizeQueryByIntent('what is mrr', [])).toBe('industry')
    expect(categorizeQueryByIntent('best aeo platforms vs', [])).toBe('industry')
  })

  test('falls back to other for unclassifiable queries', () => {
    expect(categorizeQueryByIntent('asdf qwerty', [])).toBe('other')
    expect(categorizeQueryByIntent('demand for hvac', [])).toBe('other')
  })

  test('brand match takes precedence over lead-gen / industry classifiers', () => {
    expect(categorizeQueryByIntent('demand iq buy', brand)).toBe('brand')
    expect(categorizeQueryByIntent('demand iq how to use', brand)).toBe('brand')
  })

  test('empty brand list never produces a brand match', () => {
    expect(categorizeQueryByIntent('demand iq', [])).not.toBe('brand')
  })
})

describe('the brand name without its category word', () => {
  // The bug: brand matching asks whether the QUERY CONTAINS a token, so a token
  // longer than the query can never match. On the pilot property this filed
  // 205k impressions of plainly branded search as non-brand and reported
  // branded share at 19.7% instead of 49.6%.
  const gjelina = buildBrandTokens('gjelinahotel.com', ['Gjelina Hotel'])

  test('derives the shorter token the display name and the domain both hide', () => {
    // Both inputs compact to the same string, which is why this had ONE token.
    expect(gjelina).toContain('gjelinahotel')
    expect(gjelina).toContain('gjelina')
  })

  test('classifies the brand name itself as brand', () => {
    // 111,808 impressions on this exact query, previously counted as growth.
    expect(categorizeQueryByIntent('gjelina', gjelina)).toBe('brand')
  })

  test('classifies branded queries with a modifier as brand', () => {
    expect(categorizeQueryByIntent('gjelina venice', gjelina)).toBe('brand')
    expect(categorizeQueryByIntent('gjelina los angeles', gjelina)).toBe('brand')
  })

  test('does NOT make the category word itself branded', () => {
    // The whole risk of stripping: `gjelinahotel` contains `hotel`, so a rule
    // built on containment rather than a suffix would brand every hotel query
    // on a hotel's own property.
    expect(categorizeQueryByIntent('hotel', gjelina)).not.toBe('brand')
    expect(categorizeQueryByIntent('venice beach hotels', gjelina)).not.toBe('brand')
  })

  test('takes only ONE suffix off', () => {
    // Stacked endings are real ("Acme Corp LLC"). Stripping every one of them
    // walks the token down to a stub that matches far too much, so the loop
    // stops after the first and never re-examines what it produced.
    const tokens = buildBrandTokens('acmecorpllc.com')
    expect(tokens).toContain('acmecorp')
    expect(tokens).not.toContain('acme')
  })

  test('refuses to strip down to a stub', () => {
    // `azco.com` -> stripping `co` leaves `az`, which would brand half the web.
    expect(buildBrandTokens('azco.com')).not.toContain('az')
  })

  test.each([
    ['winebar.com', 'wine'],
    ['travelagency.com', 'travel'],
    ['bookstore.com', 'book'],
    ['bikeshop.com', 'bike'],
    ['yogastudio.com', 'yoga'],
    ['datalabs.com', 'data'],
    ['sportsbar.com', 'sports'],
  ])('never turns %s into the generic token %s', (domain, generic) => {
    // Stripping is only safe when what remains is a NAME. Branding the market's
    // own vocabulary would inflate branded share exactly as far as the bug this
    // fixes deflated it, just in the other direction.
    expect(buildBrandTokens(domain)).not.toContain(generic)
  })

  test('leaves a correctly-configured project alone', () => {
    // AZ Coatings already had a second token because its display name drops the
    // `llc`. This must not shift its numbers by a single impression.
    const az = buildBrandTokens('azcoatingsllc.com', ['AZ Coatings'])
    expect(az).toEqual(expect.arrayContaining(['azcoatingsllc', 'azcoatings']))
    expect(categorizeQueryByIntent('polyurea roofing', az)).not.toBe('brand')
    expect(categorizeQueryByIntent('polyurethane roof coatings in michigan', az)).not.toBe('brand')
  })
})

describe('brand misspellings', () => {
  const gjelina = buildBrandTokens('gjelinahotel.com', ['Gjelina Hotel'])
  const demandiq = buildBrandTokens('demand-iq.com', ['Demand IQ'])

  test.each(['gelina', 'gjelena', 'ggelina', 'ghelina', 'gjlina', 'gjlena', 'gjelins', 'gjelna'])(
    'counts %s as branded',
    (typo) => {
      expect(categorizeQueryByIntent(typo, gjelina)).toBe('brand')
    },
  )

  test('catches a misspelling that carries a modifier', () => {
    expect(categorizeQueryByIntent('gelina hotel', gjelina)).toBe('brand')
    expect(categorizeQueryByIntent('gelina venice', gjelina)).toBe('brand')
  })

  // Each of the three below is a REAL false positive found in live data, and is
  // the reason its guard exists. They are the point of this describe block.
  test('does not brand a COMPETITOR two edits away (same-first-letter guard)', () => {
    // Selina is a hotel chain. Two edits from "gjelina".
    expect(categorizeQueryByIntent('selina', gjelina)).not.toBe('brand')
    expect(categorizeQueryByIntent('delina', gjelina)).not.toBe('brand')
    expect(categorizeQueryByIntent('melina', gjelina)).not.toBe('brand')
  })

  test('does not brand a common word inside the brand (length guard)', () => {
    // "demand" is two edits from "demandiq". Without the length guard these
    // became branded traffic for a company called Demand IQ.
    expect(categorizeQueryByIntent('roofing leads on demand', demandiq)).not.toBe('brand')
    expect(categorizeQueryByIntent('on-demand storage solutions denver', demandiq)).not.toBe('brand')
    expect(categorizeQueryByIntent('demand intelligence', demandiq)).not.toBe('brand')
  })

  test('does not brand other businesses three edits away (distance guard)', () => {
    expect(categorizeQueryByIntent('hotel giuliana', gjelina)).not.toBe('brand')
    expect(categorizeQueryByIntent('galena beach', gjelina)).not.toBe('brand')
    expect(categorizeQueryByIntent('glinka hotels', gjelina)).not.toBe('brand')
  })

  test('never fuzzy-matches a short token', () => {
    // Two edits on a four-letter token is half the word.
    expect(categorizeQueryByIntent('acne', ['acme'])).not.toBe('brand')
  })

  test('an empty token list still classifies nothing as brand', () => {
    expect(categorizeQueryByIntent('gjelina', [])).not.toBe('brand')
  })
})
