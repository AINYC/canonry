import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_LINK_MIN_FETCHED_PAGES,
  TEMPLATE_LINK_RATIO_THRESHOLD,
  classifyTemplateLinks,
  createTemplateLinkPairIndex,
  isTemplateLinkRatio,
  normalizeTemplateAnchorText,
  observeTemplateLinkEdges,
  classifyTemplateLinkEdge,
  isAnchorLinkRelation,
  isPlacementTemplateDetection,
  isTemplateDetectionApplied,
  placementLinkDecision,
  createTemplateLinkDetectionTally,
  observeTemplateLinkDetection,
  templateLinkDetection,
  templateLinkPlacementAvailable,
  templateLinkRatio,
  templateLinkSource,
  templateLinkUbiquityAvailable,
  type SiteCrawlPlacementOccurrencesDto,
  type SiteHealthTemplateDetection,
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

/**
 * Every case in this suite is a crawl with NO placement report: it is the
 * ubiquity fallback under test, which is also exactly what a pre-4.7.0 scan
 * looks like forever, because placement can never be backfilled for one.
 */
function bimodalCrawl(pageCount: number): {
  pagesFetched: number
  placementRulesetVersion: null
  edges: TemplateLinkEdgeInput[]
} {
  const pages = Array.from({ length: pageCount }, (_, index) => `page-${String(index).padStart(2, '0')}`)
  const edges: TemplateLinkEdgeInput[] = []
  for (const source of pages) {
    for (const target of NAV_TARGETS) {
      edges.push({
        edgeKey: `nav:${source}->${target}`,
        sourceNodeKey: source,
        targetNodeKey: target,
        anchors: [target === 'services' ? 'Our services' : target],
        relation: 'anchor'
      })
    }
    for (const target of FOOTER_TARGETS) {
      edges.push({
        edgeKey: `footer:${source}->${target}`,
        sourceNodeKey: source,
        targetNodeKey: target,
        anchors: [target],
        relation: 'anchor'
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
      relation: 'anchor'
    })
  }
  return { pagesFetched: pageCount, placementRulesetVersion: null, edges }
}

function classificationOf(result: ReturnType<typeof classifyTemplateLinks>, edgeKey: string) {
  const found = result.edges.find((edge) => edge.edgeKey === edgeKey)
  if (!found) throw new Error(`missing classification for ${edgeKey}`)
  return found
}

describe('template link detection (ubiquity fallback)', () => {
  it('marks the ubiquitous nav and footer pairs and leaves editorial links alone', () => {
    const crawl = bimodalCrawl(20)
    const result = classifyTemplateLinks(crawl)

    expect(result.detection).toBe('applied')
    const template = result.edges.filter((edge) => edge.isTemplate)
    // 20 pages x (4 nav + 3 footer) links, and nothing else.
    expect(template).toHaveLength(20 * (NAV_TARGETS.length + FOOTER_TARGETS.length))
    expect(template.every((edge) => edge.edgeKey.startsWith('nav:') || edge.edgeKey.startsWith('footer:'))).toBe(true)
    expect(classificationOf(result, 'nav:page-00->services')).toEqual({
      edgeKey: 'nav:page-00->services', isTemplate: true, templateRatio: 1, source: 'ubiquity',
    })
    expect(classificationOf(result, 'body:page-00->guide')).toEqual({
      edgeKey: 'body:page-00->guide', isTemplate: false, templateRatio: 0.05, source: 'ubiquity',
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
        relation: 'anchor'
      }))

    expect(TEMPLATE_LINK_RATIO_THRESHOLD).toBe(0.7)
    const atThreshold = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges: build(14) })
    expect(atThreshold.edges.every((edge) => edge.isTemplate)).toBe(true)
    expect(atThreshold.edges[0]!.templateRatio).toBe(0.7)

    const belowThreshold = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges: build(13) })
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

    expect(result.edges.every((edge) => edge.source === 'unmeasured')).toBe(true)

    expect(templateLinkUbiquityAvailable(0)).toBe(false)
    expect(templateLinkUbiquityAvailable(Number.NaN)).toBe(false)
    expect(templateLinkUbiquityAvailable(TEMPLATE_LINK_MIN_FETCHED_PAGES)).toBe(true)
  })

  it('is deterministic: input order never changes the classification', () => {
    const crawl = bimodalCrawl(20)
    const shuffled = [...crawl.edges].reverse()

    const first = classifyTemplateLinks(crawl)
    const second = classifyTemplateLinks({ ...crawl, edges: shuffled })
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
        edgeKey: edge.edgeKey, isTemplate: edge.isTemplate, templateRatio: edge.templateRatio, source: 'ubiquity',
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
      relation: 'anchor'
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges })
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
        relation: 'anchor'
      })),
      {
        edgeKey: 'mixed',
        sourceNodeKey: 'page-19',
        targetNodeKey: 'about',
        anchors: ['the story behind our shop', 'About'],
        relation: 'anchor'
      },
    ]
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges })
    // 1 of 20 pages says "the story behind our shop", so that is what the row
    // is worth: an editorial link, drawn and counted.
    expect(classificationOf(result, 'mixed')).toEqual({ edgeKey: 'mixed', isTemplate: false, templateRatio: 0.05, source: 'ubiquity' })

    // The nav mesh does not come back with it. Every OTHER page carries only
    // the footer anchor, so those rows stay chrome: a page's link becomes
    // editorial only when that page really does link the target in its own
    // words.
    for (let index = 0; index < 19; index += 1) {
      expect(classificationOf(result, `footer:${index}`)).toEqual({
        edgeKey: `footer:${index}`, isTemplate: true, templateRatio: 1, source: 'ubiquity',
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
      relation: 'anchor'
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges })
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
        relation: 'anchor'
      })),
      // Two pages that ALSO link editorially, each in their own words.
      { edgeKey: 'body:a', sourceNodeKey: 'page-18', targetNodeKey: 'pricing', anchors: ['Pricing', 'what it costs'], relation: 'anchor' },
      { edgeKey: 'body:b', sourceNodeKey: 'page-19', targetNodeKey: 'pricing', anchors: ['Pricing', 'see our plans'], relation: 'anchor' },
    ]
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges })

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
      placementRulesetVersion: null,
      edges: [
        // The crawl saw the link but never resolved the target to a page.
        { edgeKey: 'unresolved', sourceNodeKey: 'page-0', targetNodeKey: null, anchors: ['Home'], relation: 'anchor' },
        // An observation with no anchor at all.
        { edgeKey: 'anchorless', sourceNodeKey: 'page-0', targetNodeKey: 'home', anchors: [], relation: 'anchor' },
      ],
    })
    // Neither is credited to ubiquity. The rule produced no number for them,
    // and claiming it did would falsify the DTO's own invariant that a ratio is
    // present exactly when the source is `ubiquity`.
    for (const edgeKey of ['unresolved', 'anchorless']) {
      expect(classificationOf(result, edgeKey)).toEqual({ edgeKey, isTemplate: false, templateRatio: null, source: 'unmeasured' })
    }
    // Still content links, which is what "not shown to be chrome" has always
    // meant here. There is no third bucket for them to fall into.
    expect(result.edges.every((edge) => edge.isTemplate === false)).toBe(true)
  })

  it('never reports a share above one when a source is outside the fetched count', () => {
    // Redirect nodes link out but are not fetched pages, so the numerator can
    // exceed the denominator. That must read as 100%, not 150%.
    const edges: TemplateLinkEdgeInput[] = Array.from({ length: 30 }, (_, index) => ({
      edgeKey: `nav:${index}`,
      sourceNodeKey: `node-${index}`,
      targetNodeKey: 'home',
      anchors: ['Home'],
      relation: 'anchor'
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges })
    expect(result.edges.every((edge) => edge.templateRatio === 1)).toBe(true)
  })
})

const RULESET = '1.0.0'

function placement(
  navigation: number,
  content: number,
  unknown: number,
): SiteCrawlPlacementOccurrencesDto {
  return { navigation, content, unknown }
}

/**
 * The nav-vs-content split, decided by where a link actually sits in the page.
 *
 * The rule this replaces keys on (target URL, anchor text) and marks a pair
 * chrome once it appears on 70% of pages. It cannot see an editorial link whose
 * anchor text matches the nav's, which is the COMMON case, because good anchor
 * text reuses the destination's name. Measured on canonry.ai: 53 newly added
 * editorial links moved the content-link count by exactly zero.
 */
describe('link placement classification', () => {
  it('policy a: any content occurrence makes the whole link editorial', () => {
    // The exact canonry.ai shape. Every page carries this link in its nav with
    // the anchor "Pricing", so ubiquity scores the row 1.0 and calls it chrome.
    // ONE of those pages also links it from its prose, with the same wording.
    const edges: TemplateLinkEdgeInput[] = Array.from({ length: 20 }, (_, index) => ({
      edgeKey: `link:${index}`,
      sourceNodeKey: `page-${index}`,
      targetNodeKey: 'pricing',
      anchors: ['Pricing'],
      relation: 'anchor',
      placementOccurrences: index === 7 ? placement(1, 1, 0) : placement(1, 0, 0),
    }))
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: RULESET, edges })

    expect(classificationOf(result, 'link:7')).toEqual({
      edgeKey: 'link:7', isTemplate: false, templateRatio: null, source: 'placement',
    })
    // Ubiquity, given the identical links, hides it. That difference is the
    // entire reason placement is now the rule. The scan's ruleset version is
    // the authority on which rule ran, so dropping it is what a pre-4.7.0 crawl
    // of this very site looks like.
    const underUbiquity = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: null, edges })
    expect(classificationOf(underUbiquity, 'link:7')).toMatchObject({ isTemplate: true, source: 'ubiquity' })

    // The other 19 rows stay chrome under both rules: nothing is un-hidden that
    // was not really there.
    expect(result.edges.filter((edge) => edge.isTemplate === false)).toHaveLength(1)
    expect(placementLinkDecision(placement(9, 1, 4))).toBe('content')
  })

  it('policy b: an all-navigation link is a template link', () => {
    const result = classifyTemplateLinks({
      pagesFetched: 20,
      placementRulesetVersion: RULESET,
      edges: [{
        edgeKey: 'nav', sourceNodeKey: 'page-0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor',
        placementOccurrences: placement(3, 0, 0),
      }],
    })
    expect(classificationOf(result, 'nav')).toEqual({
      edgeKey: 'nav', isTemplate: true, templateRatio: null, source: 'placement',
    })
    expect(placementLinkDecision(placement(1, 0, 0))).toBe('navigation')
  })

  it('policy c: an all-unknown link falls back to ubiquity, and says so', () => {
    // A page with no landmarks at all answers nothing about its links. Silence
    // is not evidence either way, so the fallback rule decides, and BOTH the
    // scan state and the per-link source disclose that it did.
    const edges: TemplateLinkEdgeInput[] = [
      ...Array.from({ length: 19 }, (_, index) => ({
        edgeKey: `nav:${index}`,
        sourceNodeKey: `page-${index}`,
        targetNodeKey: 'about',
        anchors: ['About'],
        relation: 'anchor',
        placementOccurrences: placement(1, 0, 0),
      })),
      {
        edgeKey: 'silent', sourceNodeKey: 'page-19', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor',
        placementOccurrences: placement(0, 0, 1),
      },
    ]
    const result = classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: RULESET, edges })

    expect(result.detection).toBe('applied-placement-with-ubiquity')
    expect(classificationOf(result, 'silent')).toEqual({
      edgeKey: 'silent', isTemplate: true, templateRatio: 1, source: 'ubiquity',
    })
    expect(classificationOf(result, 'nav:0')).toMatchObject({ source: 'placement', templateRatio: null })
    expect(placementLinkDecision(placement(0, 0, 9))).toBeNull()
    // A link with no placement observation at all takes the same path.
    expect(placementLinkDecision(null)).toBeNull()
    expect(placementLinkDecision(undefined)).toBeNull()
  })

  it('policy d: navigation plus unknown, with no content, is chrome', () => {
    // Evidence says chrome and the rest is silence, so the evidence stands. It
    // must NOT reach the ubiquity fallback: on this one-page scan the fallback
    // is unavailable, so reaching it would leave the link unclassified.
    const result = classifyTemplateLinks({
      pagesFetched: 3,
      placementRulesetVersion: RULESET,
      edges: [{
        edgeKey: 'mixed', sourceNodeKey: 'page-0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor',
        placementOccurrences: placement(2, 0, 5),
      }],
    })
    expect(classificationOf(result, 'mixed')).toEqual({
      edgeKey: 'mixed', isTemplate: true, templateRatio: null, source: 'placement',
    })
    expect(result.detection).toBe('applied-placement')
    expect(placementLinkDecision(placement(1, 0, 100))).toBe('navigation')
  })

  it('placement has no page floor, because where a link sits is a fact about one page', () => {
    // The floor exists because ubiquity is meaningless on a small site. It has
    // nothing to say about placement, so a four-page scan classifies normally
    // where the older rule reported `unavailable-too-few-pages`.
    const edges: TemplateLinkEdgeInput[] = [
      { edgeKey: 'nav', sourceNodeKey: 'p0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0) },
      { edgeKey: 'body', sourceNodeKey: 'p0', targetNodeKey: 'guide', anchors: ['Guide'], relation: 'anchor', placementOccurrences: placement(0, 1, 0) },
    ]
    const withPlacement = classifyTemplateLinks({ pagesFetched: 4, placementRulesetVersion: RULESET, edges })
    expect(withPlacement.detection).toBe('applied-placement')
    expect(withPlacement.edges.map((edge) => edge.isTemplate)).toEqual([false, true])

    const withoutPlacement = classifyTemplateLinks({ pagesFetched: 4, placementRulesetVersion: null, edges })
    expect(withoutPlacement.detection).toBe('unavailable-too-few-pages')
    expect(withoutPlacement.edges.every((edge) => edge.isTemplate === false)).toBe(true)
  })

  it('grades a link neither rule could measure, and still puts it in one bucket', () => {
    // Small scan, so no ubiquity fallback, and one page declares no landmark.
    // The link is a CONTENT link, because "not shown to be chrome" is what that
    // has always meant here; `unmeasured` is what says no rule proved it. It is
    // deliberately not a third bucket: a third bucket only two of six readers
    // understood is what made the counts disagree in the first place.
    const result = classifyTemplateLinks({
      pagesFetched: 4,
      placementRulesetVersion: RULESET,
      edges: [
        { edgeKey: 'nav', sourceNodeKey: 'p0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0) },
        { edgeKey: 'silent', sourceNodeKey: 'p1', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(0, 0, 2) },
      ],
    })
    expect(result.detection).toBe('applied-placement-partial')
    expect(classificationOf(result, 'silent')).toEqual({
      edgeKey: 'silent', isTemplate: false, templateRatio: null, source: 'unmeasured',
    })
    expect(classificationOf(result, 'nav')).toMatchObject({ isTemplate: true, source: 'placement' })
    // Every link is in exactly one bucket. This is the invariant every reader
    // downstream assumes, and the one the third state broke.
    expect(result.edges.every((edge) => typeof edge.isTemplate === 'boolean')).toBe(true)
  })

  it('a legacy scan keeps its ubiquity answer and never claims placement', () => {
    // A pre-4.7.0 crawl never recorded where a link sat. There is nothing to
    // derive placement from and nothing to backfill, so the honest report is
    // that the weaker rule produced these numbers.
    const legacy = classifyTemplateLinks(bimodalCrawl(20))
    expect(legacy.detection).toBe('applied')
    expect(legacy.edges.every((edge) => edge.source === 'ubiquity')).toBe(true)
    expect(isPlacementTemplateDetection(legacy.detection)).toBe(false)
    expect(isTemplateDetectionApplied(legacy.detection)).toBe(true)

    expect(templateLinkPlacementAvailable(null)).toBe(false)
    expect(templateLinkPlacementAvailable(undefined)).toBe(false)
    expect(templateLinkPlacementAvailable('')).toBe(false)
    expect(templateLinkPlacementAvailable('   ')).toBe(false)
    expect(templateLinkPlacementAvailable(RULESET)).toBe(true)
  })

  it('reports every rule mix as its own state, and mixes nothing silently', () => {
    const tally = (usedUbiquityFallback: boolean, leftUnmeasuredAnchor: boolean) =>
      ({ usedUbiquityFallback, leftUnmeasuredAnchor })
    const cases: Array<[Parameters<typeof templateLinkDetection>[0], SiteHealthTemplateDetection]> = [
      [{ placementAvailable: false, ubiquityAvailable: true, tally: tally(true, false) }, 'applied'],
      [{ placementAvailable: false, ubiquityAvailable: false, tally: tally(false, true) }, 'unavailable-too-few-pages'],
      [{ placementAvailable: true, ubiquityAvailable: true, tally: tally(false, false) }, 'applied-placement'],
      [{ placementAvailable: true, ubiquityAvailable: true, tally: tally(true, false) }, 'applied-placement-with-ubiquity'],
      [{ placementAvailable: true, ubiquityAvailable: false, tally: tally(false, true) }, 'applied-placement-partial'],
      [{ placementAvailable: true, ubiquityAvailable: false, tally: tally(false, false) }, 'applied-placement'],
    ]
    for (const [input, expected] of cases) expect(templateLinkDetection(input)).toBe(expected)

    // Every state the union admits is decided, in both directions, so a new
    // value cannot slip through as neither applied nor unavailable.
    const applied: SiteHealthTemplateDetection[] = [
      'applied', 'applied-placement', 'applied-placement-with-ubiquity', 'applied-placement-partial',
    ]
    for (const detection of applied) expect(isTemplateDetectionApplied(detection)).toBe(true)
    for (const detection of ['unavailable-too-few-pages', 'unavailable-legacy-scan'] as const) {
      expect(isTemplateDetectionApplied(detection)).toBe(false)
    }
    for (const detection of applied.slice(1)) expect(isPlacementTemplateDetection(detection)).toBe(true)
  })

  it('a redirect edge does not count as a mixed classification', () => {
    // Non-anchor edges carry all-zero placement by contract, so they reach the
    // fallback and measure nothing. Counting that as ubiquity evidence would
    // put nearly every scan in the mixed state and make the state worthless.
    const result = classifyTemplateLinks({
      pagesFetched: 20,
      placementRulesetVersion: RULESET,
      edges: [
        { edgeKey: 'nav', sourceNodeKey: 'p0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0) },
        { edgeKey: 'redirect', sourceNodeKey: 'p0', targetNodeKey: null, anchors: [], relation: 'redirect', placementOccurrences: placement(0, 0, 0) },
      ],
    })
    expect(result.detection).toBe('applied-placement')
    expect(classificationOf(result, 'redirect')).toMatchObject({ isTemplate: false, templateRatio: null })
  })

  it('carries the ubiquity ratio only when ubiquity decided the link', () => {
    // The ratio is the fallback rule's own evidence. Printing it beside a
    // placement decision would suggest it had a vote in that decision.
    const result = classifyTemplateLinks({
      pagesFetched: 20,
      placementRulesetVersion: RULESET,
      edges: [
        ...Array.from({ length: 19 }, (_, index) => ({
          edgeKey: `nav:${index}`, sourceNodeKey: `p${index}`, targetNodeKey: 'about', anchors: ['About'], relation: 'anchor',
          placementOccurrences: placement(1, 0, 0),
        })),
        {
          edgeKey: 'silent', sourceNodeKey: 'p19', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor',
          placementOccurrences: placement(0, 0, 1),
        },
      ],
    })
    for (const edge of result.edges) {
      expect(edge.templateRatio != null).toBe(edge.source === 'ubiquity')
    }
  })

  it('streams to the same answer the one-shot classifier gives, with placement', () => {
    const edges: TemplateLinkEdgeInput[] = Array.from({ length: 20 }, (_, index) => ({
      edgeKey: `link:${index}`,
      sourceNodeKey: `page-${index}`,
      targetNodeKey: 'pricing',
      anchors: ['Pricing'],
      relation: 'anchor',
      placementOccurrences: index % 3 === 0 ? placement(1, 1, 0) : index % 3 === 1 ? placement(1, 0, 0) : placement(0, 0, 1),
    }))
    const index = createTemplateLinkPairIndex()
    for (let offset = 0; offset < edges.length; offset += 6) {
      observeTemplateLinkEdges(index, edges.slice(offset, offset + 6))
    }
    const oneShot = new Map(
      classifyTemplateLinks({ pagesFetched: 20, placementRulesetVersion: RULESET, edges })
        .edges.map((edge) => [edge.edgeKey, edge]),
    )
    for (const edge of edges) {
      expect(classifyTemplateLinkEdge(edge, { index, pagesFetched: 20, placementAvailable: true, ubiquityAvailable: true }))
        .toEqual(oneShot.get(edge.edgeKey))
    }
  })

  it('attributes a persisted row to the rule its own scan used, and to none when none measured', () => {
    // Read-time attribution is what lets a consumer compare two scans. It keys
    // off BOTH the scan (which rule could have run) and the stored ratio
    // (whether the fallback actually measured anything).
    const navRow = { isTemplate: true, templateRatio: null, placementOccurrences: placement(1, 0, 0) }
    const silentRow = { isTemplate: true, templateRatio: 1, placementOccurrences: placement(0, 0, 1) }
    const ubiquityRow = { isTemplate: false, templateRatio: 0.1, placementOccurrences: null }

    expect(templateLinkSource('applied-placement', navRow)).toBe('placement')
    expect(templateLinkSource('applied-placement-with-ubiquity', silentRow)).toBe('ubiquity')
    expect(templateLinkSource('applied-placement-partial', navRow)).toBe('placement')
    expect(templateLinkSource('applied', ubiquityRow)).toBe('ubiquity')

    // A scan that recorded no placement can never report `placement`, even if a
    // row somehow carries counts: the scan is the authority on which rule ran.
    expect(templateLinkSource('applied', { ...navRow, templateRatio: 0.9 })).toBe('ubiquity')

    // No ratio means the fallback measured nothing, so it is never credited.
    // This is the class the old attribution lied about: redirects, canonicals,
    // and links whose target was never fetched.
    const unmeasurableRow = { isTemplate: false, templateRatio: null, placementOccurrences: null }
    expect(templateLinkSource('applied', unmeasurableRow)).toBe('unmeasured')
    expect(templateLinkSource('applied-placement', unmeasurableRow)).toBe('unmeasured')
    expect(templateLinkSource('unavailable-too-few-pages', unmeasurableRow)).toBe('unmeasured')
    expect(templateLinkSource('unavailable-legacy-scan', { ...unmeasurableRow, isTemplate: null })).toBe('unmeasured')
  })

  it('holds the ratio invariant over EVERY edge class, unmeasurable ones included', () => {
    // The invariant test used to pass only because its fixture had no
    // unmeasurable edge. This one has all four classes.
    const result = classifyTemplateLinks({
      pagesFetched: 20,
      placementRulesetVersion: RULESET,
      edges: [
        ...Array.from({ length: 18 }, (_, index) => ({
          edgeKey: `nav:${index}`, sourceNodeKey: `p${index}`, targetNodeKey: 'about',
          anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0),
        })),
        // DOM-silent, measurable by the fallback.
        { edgeKey: 'silent', sourceNodeKey: 'p18', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(0, 0, 1) },
        // DOM-silent and unmeasurable: the target was never resolved.
        { edgeKey: 'unresolved', sourceNodeKey: 'p19', targetNodeKey: null, anchors: ['About'], relation: 'anchor', placementOccurrences: placement(0, 0, 1) },
        // Not a page link at all.
        { edgeKey: 'redirect', sourceNodeKey: 'p19', targetNodeKey: null, anchors: [], relation: 'redirect', placementOccurrences: placement(0, 0, 0) },
      ],
    })
    expect(new Set(result.edges.map((edge) => edge.source)))
      .toEqual(new Set(['placement', 'ubiquity', 'unmeasured']))
    for (const edge of result.edges) {
      expect(edge.templateRatio != null).toBe(edge.source === 'ubiquity')
      expect(typeof edge.isTemplate).toBe('boolean')
    }
    expect(classificationOf(result, 'unresolved').source).toBe('unmeasured')
    expect(classificationOf(result, 'redirect').source).toBe('unmeasured')
  })

  it('a redirect never makes a well-marked-up site report missing landmarks', () => {
    // The spurious trigger. A redirect or canonical edge carries no placement
    // BY CONSTRUCTION, so on any sub-floor scan it used to make the whole scan
    // report `applied-placement-partial` and tell the customer "Some pages mark
    // out no menu or main area" about a site whose markup is perfect.
    const result = classifyTemplateLinks({
      pagesFetched: 8,
      placementRulesetVersion: RULESET,
      edges: [
        { edgeKey: 'nav', sourceNodeKey: 'p0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0) },
        { edgeKey: 'body', sourceNodeKey: 'p0', targetNodeKey: 'guide', anchors: ['Guide'], relation: 'anchor', placementOccurrences: placement(0, 1, 0) },
        { edgeKey: 'redirect', sourceNodeKey: 'p0', targetNodeKey: null, anchors: [], relation: 'redirect', placementOccurrences: placement(0, 0, 0) },
        { edgeKey: 'canonical', sourceNodeKey: 'p1', targetNodeKey: null, anchors: [], relation: 'canonical', placementOccurrences: placement(0, 0, 0) },
      ],
    })
    expect(result.detection).toBe('applied-placement')
    expect(isAnchorLinkRelation('anchor')).toBe(true)
    for (const relation of ['redirect', 'canonical', 'link', 'something-new']) {
      expect(isAnchorLinkRelation(relation)).toBe(false)
    }

    // One real anchor link the DOM was silent about IS enough to flip it.
    const withSilentAnchor = classifyTemplateLinks({
      pagesFetched: 8,
      placementRulesetVersion: RULESET,
      edges: [
        { edgeKey: 'nav', sourceNodeKey: 'p0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0) },
        { edgeKey: 'silent', sourceNodeKey: 'p1', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(0, 0, 1) },
      ],
    })
    expect(withSilentAnchor.detection).toBe('applied-placement-partial')
  })

  it('both writers share ONE aggregation, so they cannot reach different states', () => {
    // The streaming publish pass and the one-shot classifier used to count for
    // themselves. They now fold into the same tally, and this asserts the
    // streamed fold reproduces the one-shot answer exactly.
    const edges: TemplateLinkEdgeInput[] = [
      { edgeKey: 'nav', sourceNodeKey: 'p0', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(1, 0, 0) },
      { edgeKey: 'silent', sourceNodeKey: 'p1', targetNodeKey: 'about', anchors: ['About'], relation: 'anchor', placementOccurrences: placement(0, 0, 1) },
      { edgeKey: 'redirect', sourceNodeKey: 'p1', targetNodeKey: null, anchors: [], relation: 'redirect', placementOccurrences: placement(0, 0, 0) },
    ]
    for (const pagesFetched of [4, 20]) {
      const oneShot = classifyTemplateLinks({ pagesFetched, placementRulesetVersion: RULESET, edges })
      const index = createTemplateLinkPairIndex()
      const ubiquityAvailable = templateLinkUbiquityAvailable(pagesFetched)
      if (ubiquityAvailable) observeTemplateLinkEdges(index, edges)
      const tally = createTemplateLinkDetectionTally()
      for (const edge of edges) {
        observeTemplateLinkDetection(
          tally,
          edge,
          classifyTemplateLinkEdge(edge, { index, pagesFetched, placementAvailable: true, ubiquityAvailable }),
        )
      }
      expect(templateLinkDetection({ placementAvailable: true, ubiquityAvailable, tally }))
        .toBe(oneShot.detection)
    }
  })
})
