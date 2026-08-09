import { describe, expect, it } from 'vitest'
import {
  SITE_AUDIT_DEFAULT_EDGE_LIMIT,
  SITE_AUDIT_DEFAULT_PAGE_LIMIT,
  SITE_AUDIT_MAX_EDGE_LIMIT,
  SITE_AUDIT_MAX_PAGE_LIMIT,
  normalizeSiteAuditRunRequest,
  siteAuditRequestIdentity,
  siteAuditRunRequestSchema,
  siteCrawlDeadLinksResponseSchema,
  siteCrawlSummarySchema,
} from '../src/technical-aeo.js'

describe('Technical AEO crawl contracts', () => {
  it('uses conservative unattended budgets while retaining the explicit hard caps', () => {
    expect(SITE_AUDIT_DEFAULT_PAGE_LIMIT).toBe(1_000)
    expect(SITE_AUDIT_DEFAULT_EDGE_LIMIT).toBe(100_000)
    expect(SITE_AUDIT_MAX_PAGE_LIMIT).toBe(50_000)
    expect(SITE_AUDIT_MAX_EDGE_LIMIT).toBe(1_000_000)
    expect(normalizeSiteAuditRunRequest({})).toMatchObject({ maxPages: 1_000, maxEdges: 100_000 })
  })

  it('defaults dead-link checking off while retaining the legacy sitemapUrl and limit aliases', () => {
    expect(siteAuditRunRequestSchema.parse({ sitemapUrl: 'https://example.com/sitemap.xml', limit: 20 })).toMatchObject({
      sitemapUrl: 'https://example.com/sitemap.xml',
      limit: 20,
      checkDeadLinks: false,
    })
    expect(siteAuditRunRequestSchema.safeParse({ maxPages: 50_000, maxEdges: 1_000_000 }).success).toBe(true)
    expect(siteAuditRunRequestSchema.safeParse({ maxPages: 50_001 }).success).toBe(false)
    expect(siteAuditRunRequestSchema.safeParse({ maxEdges: 1_000_001 }).success).toBe(false)
  })

  it('normalizes aliases and includes every production-changing option in request identity', () => {
    const legacy = normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ limit: 20 }))
    const current = normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxPages: 20, checkDeadLinks: false }))
    expect(siteAuditRequestIdentity(legacy)).toBe(siteAuditRequestIdentity(current))

    for (const changed of [
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ sitemapUrl: 'https://example.com/custom.xml' })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxPages: 20 })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxEdges: 20 })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxDepth: 2 })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ checkDeadLinks: true })),
    ]) {
      expect(siteAuditRequestIdentity(changed)).not.toBe(siteAuditRequestIdentity(normalizeSiteAuditRunRequest({})))
    }
  })

  it('makes no crawl data distinct from a zero-count crawl and from disabled dead-link checks', () => {
    expect(siteCrawlSummarySchema.parse({
      project: 'example', hasCrawlData: false, legacyAuditAvailable: true, runId: null, runStatus: null,
      rootUrl: null, complete: false, termination: null, detailsAvailable: false,
      counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
      deadLinks: { state: 'unavailable' },
    }).hasCrawlData).toBe(false)

    expect(siteCrawlDeadLinksResponseSchema.parse({
      project: 'example', runId: 'run-1', state: 'disabled', checkDeadLinks: false,
    }).state).toBe('disabled')
  })
})
