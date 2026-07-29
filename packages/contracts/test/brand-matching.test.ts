import { describe, expect, it } from 'vitest'
import {
  brandKeyFromText,
  brandWords,
  compileBrandAliases,
  matchedAliasKeys,
  matcherMatchesText,
  textContainsBrandAlias,
  textContainsAnyBrandAlias,
} from '../src/brand-matching.js'

describe('brand identity matching', () => {
  it('folds casing, punctuation, and spacing without changing spelling', () => {
    expect(brandKeyFromText('Demand-IQ')).toBe('demandiq')
    expect(textContainsBrandAlias('Demand IQ pricing', 'DemandIQ')).toBe(true)
    expect(textContainsBrandAlias('Try DemandIQ today', 'Demand IQ')).toBe(true)
  })

  it('matches complete adjacent words, not substrings', () => {
    expect(textContainsBrandAlias('Acme builds this.', 'Acme')).toBe(true)
    expect(textContainsBrandAlias('Acmeology is unrelated.', 'Acme')).toBe(false)
    expect(textContainsBrandAlias('Apply online.', 'Apple')).toBe(false)
    expect(textContainsBrandAlias('Compare price tiers.', 'Prime')).toBe(false)
  })

  it('supports short approved aliases without matching inside words', () => {
    expect(textContainsBrandAlias('LI announced a new product.', 'LI')).toBe(true)
    expect(textContainsBrandAlias('The polished finish lasts.', 'LI')).toBe(false)
  })

  it('normalizes Unicode compatibility and composed forms', () => {
    expect(textContainsBrandAlias('CAFÉ Canon is open.', 'Cafe\u0301 Canon')).toBe(true)
    expect(textContainsAnyBrandAlias('株式会社カノンリーを選ぶ', ['カノンリー'])).toBe(true)
  })

  it('never treats edit-distance neighbors as the same identity', () => {
    expect(textContainsBrandAlias('gelina venice', 'Gjelina')).toBe(false)
    expect(textContainsBrandAlias('selina venice', 'Gjelina')).toBe(false)
  })
})

describe('one segmentation for the whole alias set', () => {
  // The shape that matters: ONE alias list against MANY texts. Asking each
  // alias separately re-walked the entire text every time, so cost grew with
  // the alias count, which is exactly where an approval-driven design adds
  // them. Measured on a real corpus: 4,711ms -> 430ms at eight aliases.
  const aliases = ['Demand IQ', 'DemandIQ Inc', 'Demand Intelligence', 'Acme', 'Gjelina Hotel']

  it('is identical to asking each alias on its own', () => {
    const texts = [
      'We use Demand IQ for solar quotes.',
      'demand-iq is a lead platform.',
      'Nothing relevant here at all.',
      'Acmeology is a different company.', // substring, must NOT match
      'Stayed at the Gjelina Hotel in Venice.',
      'Gjelina is a restaurant on Abbot Kinney.', // the bare name is NOT an alias
    ]
    for (const text of texts) {
      const oneByOne = aliases.some(alias => textContainsBrandAlias(text, alias))
      expect(textContainsAnyBrandAlias(text, aliases)).toBe(oneByOne)
    }
  })

  it('rejects without segmenting when no alias can possibly be present', () => {
    // The cheap reject is sound because adjacent words are separated in the
    // source by non-word characters only, so a match must appear in the
    // letters-and-digits-only view as a contiguous run.
    expect(textContainsAnyBrandAlias('completely unrelated prose', aliases)).toBe(false)
  })

  it('a compiled matcher gives the same answer as the one-shot helper', () => {
    const matcher = compileBrandAliases(aliases)
    for (const text of ['Demand IQ rocks', 'nothing', 'the Gjelina Hotel']) {
      expect(matcherMatchesText(matcher, text)).toBe(textContainsAnyBrandAlias(text, aliases))
    }
  })

  it('reports every alias that matched, not just the first', () => {
    const matcher = compileBrandAliases(['Acme', 'Gjelina Hotel'])
    const hits = matchedAliasKeys(matcher, 'Acme partnered with the Gjelina Hotel.')
    expect([...hits].sort()).toEqual(['acme', 'gjelinahotel'])
  })

  it('pins the segmenter locale so a KPI does not depend on the host', () => {
    // `undefined` resolves to the machine's default locale, which would let the
    // same answer segment one way on a laptop and another in a container.
    expect(brandWords('Gjelina Hotel')).toEqual(['gjelina', 'hotel'])
    expect(brandWords('DEMAND-IQ')).toEqual(['demand', 'iq'])
  })
})
