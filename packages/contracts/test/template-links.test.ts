import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_LINK_MIN_FETCHED_PAGES,
  TEMPLATE_LINK_RATIO_THRESHOLD,
  classifyTemplateLinks,
  createTemplateLinkPairIndex,
  isTemplateLinkRatio,
  normalizeTemplateAnchorText,
  observeTemplateLinkEdges,
  templateLinkDetection,
  templateLinkRatio,
  type TemplateLinkEdgeInput,
} from '../src/technical-aeo.js'

/**
 * A crawl shaped like the real measured distribution: a nav block and a footer
 * block that sit on EVERY page, editorial links that sit on one or two, and a
 * near-empty middle. The threshold's job is to land in that empty middle, so
 * the fixture must have one.
 */
const NAV_TARGETS = ['services', 'pricing', 'about', 'contact'] as const
const FOOTER_TARGETS = ['privacy', 'terms', 'careers'] as const

function bimodalCrawl(pageCount: number): { pagesFetched: number; edges: TemplateLinkEdgeInput[] } {
  const pages = Array.from({ length: pageCount }, (_, index) => `page-${String(index).padStart(2, '0')}`)
  const edges: TemplateLinkEdgeInput[] = []
  for (const source of pages) {
    for (const target of NAV_TARGETS) {
      edges.push({
        edgeKey: `nav:${source}->${target}`,
        sourceNodeKey: source,
        targetNodeKey: target,
        anchors: [target === 'services' ? 'Our services' : target],
      })
    }
    for (const target of FOOTER_TARGETS) {
      edges.push({
        edgeKey: `footer:${source}->${target}`,
        sourceNodeKey: source,
        targetNodeKey: target,
        anchors: [target],
      })
    }
  }
  // Editorial links: each body link is written once, by one page.
  for (const [index, source] of pages.entries()) {
    edges.push({
      edgeKey: `body:${source}->guide`,
      sourceNodeKey: source,
      targetNodeKey: `guide-${index}`,
      anchors: [`read the ${index} guide`],
    })
  }
  return { pagesFetched: pageCount, edges }
}

function classificationOf(result: ReturnType<typeof classifyTemplateLinks>, edgeKey: string) {
  const found = result.edges.find((edge) => edge.edgeKey === edgeKey)
  if (!found) throw new Error(`missing classification for ${edgeKey}`)
  return found
}

describe('template link detection', () => {
  it('marks the ubiquitous nav and footer pairs and leaves editorial links alone', () => {
    const crawl = bimodalCrawl(20)
    const result = classifyTemplateLinks(crawl)

    expect(result.detection).toBe('applied')
    const template = result.edges.filter((edge) => edge.isTemplate)
    // 20 pages x (4 nav + 3 footer) links, and nothing else.
    expect(template).toHaveLength(20 * (NAV_TARGETS.length + FOOTER_TARGETS.length))
    expect(template.every((edge) => edge.edgeKey.startsWith('nav:') || edge.edgeKey.startsWith('footer:'))).toBe(true)
    expect(classificationOf(result, 'nav:page-00->services')).toEqual({
      edgeKey: 'nav:page-00->services', isTemplate: true, templateRatio: 1,
    })
    expect(classificationOf(result, 'body:page-00->guide')).toEqual({
      edgeKey: 'body:page-00->guide', isTemplate: false, templateRatio: 0.05,
    })
  })

  it('cuts exactly at the threshold, which the measured distribution leaves empty', () => {
    // 14 of 20 pages is exactly 0.7; 13 of 20 is 0.65.
    const build = (sourceCount: number): TemplateLinkEdgeInput[] =>
      Array.from({ length: sourceCount }, (_, index) => ({
        edgeKey: `partial:${index}`,
        sourceNodeKey: `page-${index}`,
        targetNodeKey: 'services',
        anchors: ['services'],
      }))

    expect(TEMPLATE_LINK_RATIO_THRESHOLD).toBe(0.7)
    const atThreshold = classifyTemplateLinks({ pagesFetched: 20, edges: build(14) })
    expect(atThreshold.edges.every((edge) => edge.isTemplate)).toBe(true)
    expect(atThreshold.edges[0]!.templateRatio).toBe(0.7)

    const belowThreshold = classifyTemplateLinks({ pagesFetched: 20, edges: build(13) })
    expect(belowThreshold.edges.every((edge) => edge.isTemplate)).toBe(false)
    expect(belowThreshold.edges[0]!.templateRatio).toBe(0.65)

    expect(isTemplateLinkRatio(TEMPLATE_LINK_RATIO_THRESHOLD)).toBe(true)
    expect(isTemplateLinkRatio(TEMPLATE_LINK_RATIO_THRESHOLD - 0.000001)).toBe(false)
    // An unmeasurable link is never a template link.
    expect(isTemplateLinkRatio(null)).toBe(false)
  })

  it('marks nothing below the small-site floor and says why', () => {
    const tooSmall = bimodalCrawl(TEMPLATE_LINK_MIN_FETCHED_PAGES - 1)
    const result = classifyTemplateLinks(tooSmall)

    expect(result.detection).toBe('unavailable-too-few-pages')
    // Not one link is marked, and no ratio is invented for any of them.
    expect(result.edges.every((edge) => edge.isTemplate === false)).toBe(true)
    expect(result.edges.every((edge) => edge.templateRatio === null)).toBe(true)
    // The same crawl one page larger IS classifiable, so the floor is the only
    // thing that changed the answer.
    expect(classifyTemplateLinks(bimodalCrawl(TEMPLATE_LINK_MIN_FETCHED_PAGES)).detection).toBe('applied')

    expect(templateLinkDetection(0)).toBe('unavailable-too-few-pages')
    expect(templateLinkDetection(Number.NaN)).toBe('unavailable-too-few-pages')
    expect(templateLinkDetection(TEMPLATE_LINK_MIN_FETCHED_PAGES)).toBe('applied')
  })

  it('is deterministic: input order never changes the classification', () => {
    const crawl = bimodalCrawl(20)
    const shuffled = [...crawl.edges].reverse()

    const first = classifyTemplateLinks(crawl)
    const second = classifyTemplateLinks({ pagesFetched: crawl.pagesFetched, edges: shuffled })
    expect(second).toEqual(first)
    // Ordered by edge key, so a persisted write order is stable too.
    expect(first.edges.map((edge) => edge.edgeKey))
      .toEqual([...first.edges.map((edge) => edge.edgeKey)].sort((a, b) => a.localeCompare(b)))
  })

  it('streams to the same answer the one-shot classifier gives', () => {
    // Both writers stream a crawl in batches rather than holding a million
    // links in memory. That path must not be able to drift from this one.
    const crawl = bimodalCrawl(20)
    const index = createTemplateLinkPairIndex()
    for (let offset = 0; offset < crawl.edges.length; offset += 7) {
      observeTemplateLinkEdges(index, crawl.edges.slice(offset, offset + 7))
    }
    const streamed = crawl.edges.map((edge) => ({
      edgeKey: edge.edgeKey,
      templateRatio: templateLinkRatio(index, crawl.pagesFetched, edge),
    })).map((edge) => ({ ...edge, isTemplate: isTemplateLinkRatio(edge.templateRatio) }))

    const oneShot = new Map(classifyTemplateLinks(crawl).edges.map((edge) => [edge.edgeKey, edge]))
    for (const edge of streamed) {
      expect(oneShot.get(edge.edgeKey)).toEqual({
        edgeKey: edge.edgeKey, isTemplate: edge.isTemplate, templateRatio: edge.templateRatio,
      })
    }
  })

  it('treats one anchor written differently across pages as one anchor', () => {
    expect(normalizeTemplateAnchorText('  Our   Services\n')).toBe('our services')
    expect(normalizeTemplateAnchorText('OUR SERVICES')).toBe(normalizeTemplateAnchorText('our services'))
    // An empty anchor is real: a logo or icon link has no text, and dropping
    // it would leave the most ubiquitous link on the site unclassified.
    expect(normalizeTemplateAnchorText('   ')).toBe('')

    const edges: TemplateLinkEdgeInput[] = Array.from({ length: 20 }, (_, index) => ({
      edgeKey: `nav:${index}`,
      sourceNodeKey: `page-${index}`,
      targetNodeKey: 'home',
      // The same nav item, formatted differently by the template engine.
      anchors: [index % 2 === 0 ? 'Our   Services' : ' our services '],
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, edges })
    expect(result.edges.every((edge) => edge.isTemplate)).toBe(true)
    expect(result.edges.every((edge) => edge.templateRatio === 1)).toBe(true)
  })

  it('keeps an editorial link that shares a row with a footer link', () => {
    // One page links to /about twice: once from the footer, once from its
    // body. The crawl stores that as ONE row carrying both anchors.
    //
    // This is the regression. Reading the row's MOST ubiquitous anchor handed
    // it the footer's ratio, so the in-prose link was marked chrome, hidden
    // from the map, and dropped from every content count. On a site whose
    // footer links to nearly every page, that is nearly every editorial link
    // on the site.
    const edges: TemplateLinkEdgeInput[] = [
      ...Array.from({ length: 19 }, (_, index) => ({
        edgeKey: `footer:${index}`,
        sourceNodeKey: `page-${index}`,
        targetNodeKey: 'about',
        anchors: ['About'],
      })),
      {
        edgeKey: 'mixed',
        sourceNodeKey: 'page-19',
        targetNodeKey: 'about',
        anchors: ['the story behind our shop', 'About'],
      },
    ]
    const result = classifyTemplateLinks({ pagesFetched: 20, edges })
    // 1 of 20 pages says "the story behind our shop", so that is what the row
    // is worth: an editorial link, drawn and counted.
    expect(classificationOf(result, 'mixed')).toEqual({ edgeKey: 'mixed', isTemplate: false, templateRatio: 0.05 })

    // The nav mesh does not come back with it. Every OTHER page carries only
    // the footer anchor, so those rows stay chrome: a page's link becomes
    // editorial only when that page really does link the target in its own
    // words.
    for (let index = 0; index < 19; index += 1) {
      expect(classificationOf(result, `footer:${index}`)).toEqual({
        edgeKey: `footer:${index}`, isTemplate: true, templateRatio: 1,
      })
    }
    expect(result.edges.filter((edge) => !edge.isTemplate)).toHaveLength(1)
  })

  it('stays chrome when every anchor on the row is ubiquitous', () => {
    // A logo link and a nav item to the same target from every page. Two
    // anchors, both site-wide: nothing here is editorial, and reading the
    // least ubiquitous anchor must not turn the header into content.
    const edges: TemplateLinkEdgeInput[] = Array.from({ length: 20 }, (_, index) => ({
      edgeKey: `chrome:${index}`,
      sourceNodeKey: `page-${index}`,
      targetNodeKey: 'home',
      anchors: ['', 'Home'],
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, edges })
    expect(result.edges.every((edge) => edge.isTemplate)).toBe(true)
    expect(result.edges.every((edge) => edge.templateRatio === 1)).toBe(true)
  })

  it('classifies chrome as a subset of what the old rule classified', () => {
    // The rule changed from "any anchor is ubiquitous" to "every anchor is",
    // so the chrome set can only shrink and the content set can only grow.
    // That is why no count on this surface can go DOWN after the fix, and it
    // is the property the whole change rests on.
    const edges: TemplateLinkEdgeInput[] = [
      ...Array.from({ length: 18 }, (_, index) => ({
        edgeKey: `footer:${index}`,
        sourceNodeKey: `page-${index}`,
        targetNodeKey: 'pricing',
        anchors: ['Pricing'],
      })),
      // Two pages that ALSO link editorially, each in their own words.
      { edgeKey: 'body:a', sourceNodeKey: 'page-18', targetNodeKey: 'pricing', anchors: ['Pricing', 'what it costs'] },
      { edgeKey: 'body:b', sourceNodeKey: 'page-19', targetNodeKey: 'pricing', anchors: ['Pricing', 'see our plans'] },
    ]
    const result = classifyTemplateLinks({ pagesFetched: 20, edges })

    const contentKeys = result.edges.filter((edge) => !edge.isTemplate).map((edge) => edge.edgeKey)
    expect(contentKeys).toEqual(['body:a', 'body:b'])
    // Under the old maximum rule every one of these rows scored 0.9 and the
    // content count was zero. The content links were always there.
    expect(contentKeys).toHaveLength(2)
    expect(result.edges.filter((edge) => edge.isTemplate)).toHaveLength(18)
  })

  it('never claims a link it cannot measure', () => {
    const result = classifyTemplateLinks({
      pagesFetched: 20,
      edges: [
        // The crawl saw the link but never resolved the target to a page.
        { edgeKey: 'unresolved', sourceNodeKey: 'page-0', targetNodeKey: null, anchors: ['Home'] },
        // An observation with no anchor at all.
        { edgeKey: 'anchorless', sourceNodeKey: 'page-0', targetNodeKey: 'home', anchors: [] },
      ],
    })
    for (const edgeKey of ['unresolved', 'anchorless']) {
      expect(classificationOf(result, edgeKey)).toEqual({ edgeKey, isTemplate: false, templateRatio: null })
    }
  })

  it('never reports a share above one when a source is outside the fetched count', () => {
    // Redirect nodes link out but are not fetched pages, so the numerator can
    // exceed the denominator. That must read as 100%, not 150%.
    const edges: TemplateLinkEdgeInput[] = Array.from({ length: 30 }, (_, index) => ({
      edgeKey: `nav:${index}`,
      sourceNodeKey: `node-${index}`,
      targetNodeKey: 'home',
      anchors: ['Home'],
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, edges })
    expect(result.edges.every((edge) => edge.templateRatio === 1)).toBe(true)
  })
})
