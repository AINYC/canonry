import { describe, expect, it } from 'vitest'
import { classifyQueryClass, compileQueryClassifier } from '../src/query-class.js'
import { effectiveBrandNames } from '../src/project.js'
import { measurementQueryClassSchema, measurementQueryClassFilterSchema } from '../src/measurement-plan-v2.js'
import { queryClassSchema, queryClassFilterSchema } from '../src/query-class.js'

describe('compileQueryClassifier', () => {
  it('classifies a query that names the brand as branded, and one that does not as non-brand', () => {
    const classifier = compileQueryClassifier(['Tank Air', 'Tankair'])!
    expect(classifier.classify('what is Tank Air known for')).toBe('branded')
    expect(classifier.classify('does Tank Air run small')).toBe('branded')
    expect(classifier.classify('what is the best premium white tank')).toBe('non-brand')
    expect(classifier.classify('what are alternatives to Skims')).toBe('non-brand')
  })

  it('partitions the tankair basket 5 branded / 8 non-brand', () => {
    // The exact 13 tracked queries on project ce80f41f. The 5/8 split is what
    // makes the pooled mention-share figure wrong, so it is pinned here.
    const classifier = compileQueryClassifier(effectiveBrandNames({
      displayName: 'Tank Air',
      aliases: ['Tankair'],
      canonicalDomain: 'tankair.com',
      ownedDomains: ['tankairstudio.com'],
    }))!
    const basket = [
      'Tank Air Studio Tank',
      'are Tank Air tanks see through',
      'are Tank Air tanks worth the money',
      'does Tank Air run small',
      'what is Tank Air known for',
      'what are alternatives to Skims',
      'what are cool independent contemporary womenswear brands',
      'what are the best elevated basics brands',
      'what is a good tank top for a fuller bust',
      'what is a supportive tank top I can wear without a bra',
      'what is the best high-quality women\'s tank top',
      'what is the best premium white tank',
      'what is the best sculpting tank top',
    ]
    const classes = basket.map(q => classifier.classify(q))
    expect(classes.filter(c => c === 'branded')).toHaveLength(5)
    expect(classes.filter(c => c === 'non-brand')).toHaveLength(8)
  })

  it('matches presentation variants but never substrings or spelling guesses', () => {
    const classifier = compileQueryClassifier(['Demand IQ'])!
    expect(classifier.classify('is Demand-IQ worth it')).toBe('branded')
    expect(classifier.classify('is DemandIQ worth it')).toBe('branded')
    expect(classifier.classify('is demand iq worth it')).toBe('branded')
    // "demand" alone is not the brand.
    expect(classifier.classify('how do I forecast solar demand')).toBe('non-brand')
  })

  it('does not match a brand inside a longer word', () => {
    const classifier = compileQueryClassifier(['Acme'])!
    expect(classifier.classify('what is acmeology')).toBe('non-brand')
    expect(classifier.classify('what is acme')).toBe('branded')
  })

  it('returns null when no usable alias exists — unclassifiable is not "non-brand"', () => {
    expect(compileQueryClassifier([])).toBeNull()
    expect(compileQueryClassifier(['', '   '])).toBeNull()
    expect(compileQueryClassifier(['!!!'])).toBeNull()
    expect(classifyQueryClass('anything at all', [])).toBeNull()
  })

  it('treats null / empty query text as non-brand rather than throwing', () => {
    const classifier = compileQueryClassifier(['Acme'])!
    expect(classifier.classify(null)).toBe('non-brand')
    expect(classifier.classify(undefined)).toBe('non-brand')
    expect(classifier.classify('')).toBe('non-brand')
  })

  it('is the same enum advanced measurement publishes, so the two cannot drift apart', () => {
    expect(measurementQueryClassSchema).toBe(queryClassSchema)
    expect(measurementQueryClassFilterSchema).toBe(queryClassFilterSchema)
    expect(queryClassSchema.options).toEqual(['branded', 'non-brand'])
    expect(queryClassFilterSchema.options).toEqual(['all', 'branded', 'non-brand'])
  })
})
