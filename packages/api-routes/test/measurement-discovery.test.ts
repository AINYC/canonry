import { describe, expect, it } from 'vitest'
import { compileMeasurementPlan } from '@ainyc/canonry-contracts'
import {
  classifyMeasurementSitemapUrls,
  type MeasurementDiscoveryInput,
} from '../src/measurement-discovery.js'

const cortlandRules: MeasurementDiscoveryInput['rules'] = {
  primary: { host: 'cortland.com', pathTemplate: '/apartments/{slug}' },
  aliases: [{ host: 'apartments.cortland.com', pathTemplate: '/{slug}' }],
  excludedSlugSuffixes: ['-metro'],
}

function classify(urls: readonly string[], overrides: Partial<MeasurementDiscoveryInput> = {}) {
  return classifyMeasurementSitemapUrls({
    ownedHosts: ['cortland.com'],
    rules: cortlandRules,
    urls,
    maxUrls: 500,
    ...overrides,
  })
}

describe('classifyMeasurementSitemapUrls — Cortland property fixtures', () => {
  it('groups an exact primary slug with its exact-slug apartment-host coverage only', () => {
    const result = classify([
      'https://apartments.cortland.com/cortland-m-line/',
      'https://cortland.com/apartments/cortland-m-line/',
      'https://apartments.cortland.com/cortland-m-line/floorplans/',
      'https://apartments.cortland.com/cortland-park/',
      'https://cortland.com/apartments/cortland-north/',
    ])

    expect(result.candidates).toEqual([
      {
        stableKey: 'target-cortland-m-line',
        slug: 'cortland-m-line',
        label: 'Cortland M Line',
        primaryUrl: 'https://cortland.com/apartments/cortland-m-line',
        aliasCoverageUrls: ['https://apartments.cortland.com/cortland-m-line'],
        status: 'proposed',
        reasonCodes: ['primary-match', 'alias-coverage'],
      },
      {
        stableKey: 'target-cortland-north',
        slug: 'cortland-north',
        label: 'Cortland North',
        primaryUrl: 'https://cortland.com/apartments/cortland-north',
        aliasCoverageUrls: [],
        status: 'proposed',
        reasonCodes: ['primary-match'],
      },
    ])
    expect(result.unmatched).toEqual([
      {
        url: 'https://apartments.cortland.com/cortland-m-line/floorplans',
        canonicalUrl: 'https://apartments.cortland.com/cortland-m-line/floorplans',
        reasonCodes: ['unmatched-path'],
      },
      {
        url: 'https://apartments.cortland.com/cortland-park',
        canonicalUrl: 'https://apartments.cortland.com/cortland-park',
        reasonCodes: ['alias-without-primary'],
      },
    ])
  })

  it('emits contract-valid candidates that compile directly into a Target plan', () => {
    const discovered = classify([
      'https://cortland.com/apartments/cortland-m-line/',
      'https://apartments.cortland.com/cortland-m-line/',
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
      canonicalDomain: 'cortland.com',
      ownedDomains: [],
      trackedQueries: [],
      locations: [],
    })

    expect(compiled.targets.map((target) => target.stableKey)).toEqual(['target-cortland-m-line'])
  })

  it('folds www consistently with Target host normalization', () => {
    const result = classify([
      'https://www.cortland.com/apartments/cortland-m-line/',
      'https://www.apartments.cortland.com/cortland-m-line/',
    ])

    expect(result.candidates).toEqual([
      expect.objectContaining({
        stableKey: 'target-cortland-m-line',
        primaryUrl: 'https://cortland.com/apartments/cortland-m-line',
        aliasCoverageUrls: ['https://apartments.cortland.com/cortland-m-line'],
      }),
    ])
  })

  it('rejects ported sitemap URLs instead of emitting exact matchers that cannot compile', () => {
    const result = classify(['https://cortland.com:8443/apartments/cortland-m-line/'])

    expect(result.candidates).toEqual([])
    expect(result.invalid).toEqual([
      expect.objectContaining({
        url: 'https://cortland.com:8443/apartments/cortland-m-line/',
        canonicalUrl: null,
        reasonCodes: ['invalid-url'],
      }),
    ])
  })

  it.each([
    'cortland%20m-line',
    'cortland-%E2%98%83',
    `cortland-${'x'.repeat(121)}`,
  ])('surfaces an unsupported slug for review instead of emitting an invalid stable key: %s', (slug) => {
    const result = classify([`https://cortland.com/apartments/${slug}/`])

    expect(result.candidates).toEqual([])
    expect(result.unmatched).toEqual([
      expect.objectContaining({ reasonCodes: ['unsupported-slug'] }),
    ])
  })

  it('never creates targets from metro roots, shared pages, unowned lookalikes, or malformed URLs', () => {
    const result = classify([
      'https://cortland.com/apartments/austin-metro/',
      'https://cortland.com/apartments/',
      'https://cortland.com/about/',
      'https://evilcortland.com/apartments/cortland-m-line/',
      'not a url',
    ])

    expect(result.candidates).toEqual([])
    expect(result.shared).toEqual([
      {
        url: 'https://cortland.com/apartments/austin-metro',
        canonicalUrl: 'https://cortland.com/apartments/austin-metro',
        reasonCodes: ['excluded-slug', 'shared-path'],
      },
    ])
    expect(result.unmatched).toEqual([
      {
        url: 'https://cortland.com/about',
        canonicalUrl: 'https://cortland.com/about',
        reasonCodes: ['unmatched-path'],
      },
      {
        url: 'https://cortland.com/apartments',
        canonicalUrl: 'https://cortland.com/apartments',
        reasonCodes: ['unmatched-path'],
      },
    ])
    expect(result.invalid).toEqual([
      {
        url: 'https://evilcortland.com/apartments/cortland-m-line',
        canonicalUrl: 'https://evilcortland.com/apartments/cortland-m-line',
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
        'https://cortland.com/apartments/zeta/?utm_source=sitemap#top',
        'https://cortland.com/apartments/alpha/',
        'https://cortland.com/apartments/zeta',
        'https://cortland.com/apartments/beta/',
      ],
      { maxUrls: 3 },
    )

    expect(result.candidates.map((candidate) => candidate.slug)).toEqual(['alpha', 'beta', 'zeta'])
    expect(result.duplicates).toEqual([
      {
        url: 'https://cortland.com/apartments/zeta/?utm_source=sitemap#top',
        canonicalUrl: 'https://cortland.com/apartments/zeta',
        duplicateOf: 'https://cortland.com/apartments/zeta',
        reasonCodes: ['duplicate-url'],
      },
    ])
    expect(result.truncated).toEqual([])
  })

  it('reports deterministically skipped URLs when a bounded run reaches its cap', () => {
    const result = classify(
      [
        'https://cortland.com/apartments/charlie/',
        'https://cortland.com/apartments/alpha/',
        'https://cortland.com/apartments/bravo/',
      ],
      { maxUrls: 2 },
    )

    expect(result.candidates.map((candidate) => candidate.slug)).toEqual(['alpha', 'bravo'])
    expect(result.truncated).toEqual([
      {
        url: 'https://cortland.com/apartments/charlie',
        canonicalUrl: 'https://cortland.com/apartments/charlie',
        reasonCodes: ['url-cap-reached'],
      },
    ])
  })
})

describe('classifyMeasurementSitemapUrls — scale and canonical order', () => {
  it('turns 213 Cortland roots into 194 targets: 19 metro exclusions and 190 exact aliases', () => {
    const aliasMisses = [
      'cortland-at-colliers-yard',
      'cortland-broad-st',
      'cortland-cassiobury',
      'cortland-reunion-kissimmee',
    ]
    const propertySlugs = [
      ...aliasMisses,
      ...Array.from({ length: 190 }, (_, index) => `community-${String(190 - index).padStart(3, '0')}`),
    ]
    const metroSlugs = Array.from({ length: 19 }, (_, index) => `market-${String(index + 1).padStart(2, '0')}-metro`)
    const urls = [
      ...[...propertySlugs, ...metroSlugs].map((slug) => `https://cortland.com/apartments/${slug}/`),
      ...propertySlugs
        .filter((slug) => !aliasMisses.includes(slug))
        .map((slug) => `https://apartments.cortland.com/${slug}/`),
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
