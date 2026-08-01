import { describe, expect, it } from 'vitest'
import { compileMeasurementPlan } from '@ainyc/canonry-contracts'
import {
  classifyMeasurementSitemapUrls,
  type MeasurementDiscoveryInput,
} from '../src/measurement-discovery.js'

const exampleLivingRules: MeasurementDiscoveryInput['rules'] = {
  primary: { host: 'example.test', pathTemplate: '/apartments/{slug}' },
  aliases: [{ host: 'homes.example.test', pathTemplate: '/{slug}' }],
  excludedSlugSuffixes: ['-metro'],
}

function classify(urls: readonly string[], overrides: Partial<MeasurementDiscoveryInput> = {}) {
  return classifyMeasurementSitemapUrls({
    ownedHosts: ['example.test'],
    rules: exampleLivingRules,
    urls,
    maxUrls: 500,
    ...overrides,
  })
}

describe('classifyMeasurementSitemapUrls — synthetic property fixtures', () => {
  it('groups an exact primary slug with its exact-slug apartment-host coverage only', () => {
    const result = classify([
      'https://homes.example.test/example-living-harbor/',
      'https://example.test/apartments/example-living-harbor/',
      'https://homes.example.test/example-living-harbor/floorplans/',
      'https://homes.example.test/example-living-park/',
      'https://example.test/apartments/example-living-north/',
    ])

    expect(result.candidates).toEqual([
      {
        stableKey: 'target-example-living-harbor',
        slug: 'example-living-harbor',
        label: 'Example Living Harbor',
        primaryUrl: 'https://example.test/apartments/example-living-harbor',
        aliasCoverageUrls: ['https://homes.example.test/example-living-harbor'],
        status: 'proposed',
        reasonCodes: ['primary-match', 'alias-coverage'],
      },
      {
        stableKey: 'target-example-living-north',
        slug: 'example-living-north',
        label: 'Example Living North',
        primaryUrl: 'https://example.test/apartments/example-living-north',
        aliasCoverageUrls: [],
        status: 'proposed',
        reasonCodes: ['primary-match'],
      },
    ])
    expect(result.unmatched).toEqual([
      {
        url: 'https://homes.example.test/example-living-harbor/floorplans',
        canonicalUrl: 'https://homes.example.test/example-living-harbor/floorplans',
        reasonCodes: ['unmatched-path'],
      },
      {
        url: 'https://homes.example.test/example-living-park',
        canonicalUrl: 'https://homes.example.test/example-living-park',
        reasonCodes: ['alias-without-primary'],
      },
    ])
  })

  it('emits contract-valid candidates that compile directly into a Target plan', () => {
    const discovered = classify([
      'https://example.test/apartments/example-living-harbor/',
      'https://homes.example.test/example-living-harbor/',
    ])
    const compiled = compileMeasurementPlan({
      schemaVersion: 1,
      targets: discovered.candidates.map((candidate) => ({
        stableKey: candidate.stableKey,
        label: candidate.label,
        urls: [candidate.primaryUrl, ...candidate.aliasCoverageUrls].map((url) => ({
          kind: 'exact' as const,
          url,
          pathCase: 'insensitive' as const,
        })),
        aliases: [],
      })),
    }, {
      canonicalDomain: 'example.test',
      ownedDomains: [],
      trackedQueries: [],
      locations: [],
    })

    expect(compiled.targets.map((target) => target.stableKey)).toEqual(['target-example-living-harbor'])
  })

  it('folds www consistently with Target host normalization', () => {
    const result = classify([
      'https://www.example.test/apartments/example-living-harbor/',
      'https://www.homes.example.test/example-living-harbor/',
    ])

    expect(result.candidates).toEqual([
      expect.objectContaining({
        stableKey: 'target-example-living-harbor',
        primaryUrl: 'https://example.test/apartments/example-living-harbor',
        aliasCoverageUrls: ['https://homes.example.test/example-living-harbor'],
      }),
    ])
  })

  it('rejects ported sitemap URLs instead of emitting exact matchers that cannot compile', () => {
    const result = classify(['https://example.test:8443/apartments/example-living-harbor/'])

    expect(result.candidates).toEqual([])
    expect(result.invalid).toEqual([
      expect.objectContaining({
        url: 'https://example.test:8443/apartments/example-living-harbor/',
        canonicalUrl: null,
        reasonCodes: ['invalid-url'],
      }),
    ])
  })

  it.each([
    'example-living%20harbor',
    'example-living-%E2%98%83',
    `example-living-${'x'.repeat(121)}`,
  ])('surfaces an unsupported slug for review instead of emitting an invalid stable key: %s', (slug) => {
    const result = classify([`https://example.test/apartments/${slug}/`])

    expect(result.candidates).toEqual([])
    expect(result.unmatched).toEqual([
      expect.objectContaining({ reasonCodes: ['unsupported-slug'] }),
    ])
  })

  it('never creates targets from metro roots, shared pages, unowned lookalikes, or malformed URLs', () => {
    const result = classify([
      'https://example.test/apartments/sample-city-metro/',
      'https://example.test/apartments/',
      'https://example.test/about/',
      'https://evil-example.test/apartments/example-living-harbor/',
      'not a url',
    ])

    expect(result.candidates).toEqual([])
    expect(result.shared).toEqual([
      {
        url: 'https://example.test/apartments/sample-city-metro',
        canonicalUrl: 'https://example.test/apartments/sample-city-metro',
        reasonCodes: ['excluded-slug', 'shared-path'],
      },
    ])
    expect(result.unmatched).toEqual([
      {
        url: 'https://example.test/about',
        canonicalUrl: 'https://example.test/about',
        reasonCodes: ['unmatched-path'],
      },
      {
        url: 'https://example.test/apartments',
        canonicalUrl: 'https://example.test/apartments',
        reasonCodes: ['unmatched-path'],
      },
    ])
    expect(result.invalid).toEqual([
      {
        url: 'https://evil-example.test/apartments/example-living-harbor',
        canonicalUrl: 'https://evil-example.test/apartments/example-living-harbor',
        reasonCodes: ['unowned-host'],
      },
      { url: 'not a url', canonicalUrl: null, reasonCodes: ['invalid-url'] },
    ])
  })
})
describe('classifyMeasurementSitemapUrls — generic declarative rules', () => {
  it('accepts only a single whole `{slug}` path segment, never caller-provided matcher syntax', () => {
    expect(() =>
      classifyMeasurementSitemapUrls({
        ownedHosts: ['example.com'],
        rules: { primary: { host: 'example.com', pathTemplate: '/customers/{slug}-{region}' } },
        urls: [],
        maxUrls: 1,
      }),
    ).toThrow('exactly one {slug} path segment')
    expect(() =>
      classifyMeasurementSitemapUrls({
        ownedHosts: ['example.com'],
        rules: { primary: { host: 'example.com', pathTemplate: '/customers/{slug}/{slug}' } },
        urls: [],
        maxUrls: 1,
      }),
    ).toThrow('exactly one {slug} path segment')
  })

  it('supports a subdomain primary and an owned SaaS alias without caller-provided regexes', () => {
    const result = classifyMeasurementSitemapUrls({
      ownedHosts: ['example.com'],
      rules: {
        primary: { host: 'app.example.com', pathTemplate: '/customers/{slug}' },
        aliases: [{ host: 'www.example.com', pathTemplate: '/customers/{slug}' }],
        excludedSlugPatterns: [
          { kind: 'suffix', value: '-template' },
          { kind: 'exact', value: 'all-customers' },
        ],
      },
      urls: [
        'https://www.example.com/customers/acme/',
        'https://app.example.com/customers/acme/',
        'https://app.example.com/customers/all-customers/',
        'https://app.example.com/customers/invoice-template/',
        'https://notexample.com/customers/acme/',
      ],
      maxUrls: 50,
    })

    expect(result.candidates).toEqual([
      {
        stableKey: 'target-acme',
        slug: 'acme',
        label: 'Acme',
        primaryUrl: 'https://app.example.com/customers/acme',
        aliasCoverageUrls: ['https://example.com/customers/acme'],
        status: 'proposed',
        reasonCodes: ['primary-match', 'alias-coverage'],
      },
    ])
    expect(result.shared.map((item) => [item.url, item.reasonCodes])).toEqual([
      ['https://app.example.com/customers/all-customers', ['excluded-slug', 'shared-path']],
      ['https://app.example.com/customers/invoice-template', ['excluded-slug', 'shared-path']],
    ])
    expect(result.invalid[0]?.reasonCodes).toEqual(['unowned-host'])
  })

  it('deduplicates canonical URL variants and caps the stable sorted input before classification', () => {
    const result = classify(
      [
        'https://example.test/apartments/zeta/?utm_source=sitemap#top',
        'https://example.test/apartments/alpha/',
        'https://example.test/apartments/zeta',
        'https://example.test/apartments/beta/',
      ],
      { maxUrls: 3 },
    )

    expect(result.candidates.map((candidate) => candidate.slug)).toEqual(['alpha', 'beta', 'zeta'])
    expect(result.duplicates).toEqual([
      {
        url: 'https://example.test/apartments/zeta/?utm_source=sitemap#top',
        canonicalUrl: 'https://example.test/apartments/zeta',
        duplicateOf: 'https://example.test/apartments/zeta',
        reasonCodes: ['duplicate-url'],
      },
    ])
    expect(result.truncated).toEqual([])
  })

  it('reports deterministically skipped URLs when a bounded run reaches its cap', () => {
    const result = classify(
      [
        'https://example.test/apartments/charlie/',
        'https://example.test/apartments/alpha/',
        'https://example.test/apartments/bravo/',
      ],
      { maxUrls: 2 },
    )

    expect(result.candidates.map((candidate) => candidate.slug)).toEqual(['alpha', 'bravo'])
    expect(result.truncated).toEqual([
      {
        url: 'https://example.test/apartments/charlie',
        canonicalUrl: 'https://example.test/apartments/charlie',
        reasonCodes: ['url-cap-reached'],
      },
    ])
  })
})

describe('classifyMeasurementSitemapUrls — scale and canonical order', () => {
  it('turns 213 synthetic roots into 194 targets: 19 metro exclusions and 190 exact aliases', () => {
    const aliasMisses = [
      'example-living-sample-one',
      'example-living-sample-two',
      'example-living-sample-three',
      'example-living-sample-four',
    ]
    const propertySlugs = [
      ...aliasMisses,
      ...Array.from({ length: 190 }, (_, index) => `community-${String(190 - index).padStart(3, '0')}`),
    ]
    const metroSlugs = Array.from({ length: 19 }, (_, index) => `market-${String(index + 1).padStart(2, '0')}-metro`)
    const urls = [
      ...[...propertySlugs, ...metroSlugs].map((slug) => `https://example.test/apartments/${slug}/`),
      ...propertySlugs
        .filter((slug) => !aliasMisses.includes(slug))
        .map((slug) => `https://homes.example.test/${slug}/`),
    ]

    const forward = classify(urls)
    const reverse = classify([...urls].reverse())

    expect(forward).toEqual(reverse)
    expect(forward.candidates).toHaveLength(194)
    expect(forward.shared).toHaveLength(19)
    expect(forward.candidates.reduce((total, candidate) => total + candidate.aliasCoverageUrls.length, 0)).toBe(190)
    expect(forward.candidates.map((candidate) => candidate.slug)).toEqual(
      [...forward.candidates.map((candidate) => candidate.slug)].sort(),
    )
    for (const slug of aliasMisses) {
      expect(forward.candidates.find((candidate) => candidate.slug === slug)?.aliasCoverageUrls).toEqual([])
    }
  })
})
