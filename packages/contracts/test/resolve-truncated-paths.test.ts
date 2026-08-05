import { describe, it, expect } from 'vitest'
import { resolveTruncatedPaths } from '../src/url-normalize.js'

/**
 * The shapes here are taken from a production analytics table where one page
 * had its sessions split across four spellings of its own path.
 */
describe('resolveTruncatedPaths', () => {
  const KNOWN = ['/', '/aeo-methodology', '/aeo-agency-new-york-city', '/managed', '/blog', '/blog/ai-visibility-tools-are-lying']

  it('folds every truncated spelling into the one page it can be', () => {
    const folds = resolveTruncatedPaths(['/aeo-met', '/aeo-meth', '/aeo-methodolo'], KNOWN)

    expect(folds.get('/aeo-met')).toBe('/aeo-methodology')
    expect(folds.get('/aeo-meth')).toBe('/aeo-methodology')
    expect(folds.get('/aeo-methodolo')).toBe('/aeo-methodology')
    expect(folds.size).toBe(3)
  })

  it('leaves a real page alone even though it prefixes another', () => {
    // `/blog` prefixes `/blog/ai-visibility-tools-are-lying`, but it exists.
    const folds = resolveTruncatedPaths(['/blog', '/aeo-methodology', '/managed'], KNOWN)
    expect(folds.size).toBe(0)
  })

  it('refuses to fold a section root into one of its children', () => {
    // Same prefix, different depth. Without the depth rule `/blo` would fold
    // into the post rather than the section.
    const folds = resolveTruncatedPaths(['/blo'], ['/blog/only-post'])
    expect(folds.size).toBe(0)
  })

  it('refuses to fold when more than one page matches', () => {
    const folds = resolveTruncatedPaths(['/aeo-'], KNOWN)
    // `/aeo-methodology` and `/aeo-agency-new-york-city` both qualify.
    expect(folds.has('/aeo-')).toBe(false)
  })

  it('folds when a second candidate is ruled out by depth', () => {
    const folds = resolveTruncatedPaths(['/pri'], ['/pricing', '/pricing/enterprise'])
    expect(folds.get('/pri')).toBe('/pricing')
  })

  it('never folds an unattributed sentinel', () => {
    const folds = resolveTruncatedPaths(['(not set)', ''], KNOWN)
    expect(folds.size).toBe(0)
  })

  it('does nothing without a known page list', () => {
    expect(resolveTruncatedPaths(['/aeo-met'], []).size).toBe(0)
  })

  it('does not fold an exact match onto itself', () => {
    const folds = resolveTruncatedPaths(['/managed'], KNOWN)
    expect(folds.has('/managed')).toBe(false)
  })

  it('is case sensitive, since paths are', () => {
    expect(resolveTruncatedPaths(['/AEO-met'], KNOWN).size).toBe(0)
  })

  it('leaves a query-string path alone', () => {
    // `/managed?ref=x` is longer than `/managed`, so nothing can absorb it.
    const folds = resolveTruncatedPaths(['/managed?ref=x'], KNOWN)
    expect(folds.size).toBe(0)
  })

  // The lookup jumps to a sorted run of pages sharing the prefix. These pin the
  // edges of that run, where an off-by-one silently over- or under-matches.

  it('stops at the end of the prefix run', () => {
    // `/pricingz` sorts immediately after `/pricing-plans` but does not share
    // the `/pricing-` prefix, so it must not be considered.
    const folds = resolveTruncatedPaths(['/pricing-'], ['/pricing-plans', '/pricingz'])
    expect(folds.get('/pricing-')).toBe('/pricing-plans')
  })

  it('finds a match that sorts at the very end of the page list', () => {
    const folds = resolveTruncatedPaths(['/zeta-p'], ['/alpha', '/beta', '/zeta-page'])
    expect(folds.get('/zeta-p')).toBe('/zeta-page')
  })

  it('finds a match that sorts at the very start of the page list', () => {
    const folds = resolveTruncatedPaths(['/alpha-p'], ['/alpha-page', '/beta', '/zeta'])
    expect(folds.get('/alpha-p')).toBe('/alpha-page')
  })

  it('stays correct and cheap on a large page list', () => {
    const known = Array.from({ length: 2000 }, (_, i) => `/collections/set-${i}/item-${i}-full`)
    const observed = ['/collections/set-7/item-7-fu', '/collections/set-7/item-7-full', '/nothing-like-this']

    const folds = resolveTruncatedPaths(observed, known)
    expect(folds.get('/collections/set-7/item-7-fu')).toBe('/collections/set-7/item-7-full')
    // A known page keeps its identity, and an unrelated path folds nowhere.
    expect(folds.has('/collections/set-7/item-7-full')).toBe(false)
    expect(folds.has('/nothing-like-this')).toBe(false)
    expect(folds.size).toBe(1)
  })
})
