import { describe, expect, it } from 'vitest'
import {
  brandKeyFromText,
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
