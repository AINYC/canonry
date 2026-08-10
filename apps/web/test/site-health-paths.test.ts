// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  displayPagePath,
  isSameSiteUrl,
  siteHostFromUrl,
  SITE_HEALTH_HOME_LABEL,
} from '../src/components/project/site-health-paths.js'

const rootHost = 'azcoatingsllc.com'

describe('displayPagePath', () => {
  it('drops the scheme and host of a same-site URL', () => {
    expect(displayPagePath('https://azcoatingsllc.com/about', rootHost)).toBe('/about')
    expect(displayPagePath('http://azcoatingsllc.com/services/epoxy', rootHost)).toBe('/services/epoxy')
  })

  it('treats a www. prefix on either side as the same site', () => {
    expect(displayPagePath('https://www.azcoatingsllc.com/about', rootHost)).toBe('/about')
    expect(displayPagePath('https://azcoatingsllc.com/about', 'www.azcoatingsllc.com')).toBe('/about')
    expect(displayPagePath('https://AZCoatingsLLC.com/about', rootHost)).toBe('/about')
  })

  it('keeps a genuinely cross-host URL in full so an off-site link is never disguised', () => {
    expect(displayPagePath('https://partner.example.com/about', rootHost))
      .toBe('https://partner.example.com/about')
    // A shared suffix is not the same host.
    expect(displayPagePath('https://notazcoatingsllc.com/about', rootHost))
      .toBe('https://notazcoatingsllc.com/about')
  })

  it('names the root page rather than showing a bare slash', () => {
    expect(displayPagePath('https://azcoatingsllc.com/', rootHost)).toBe(SITE_HEALTH_HOME_LABEL)
    expect(displayPagePath('https://azcoatingsllc.com', rootHost)).toBe(SITE_HEALTH_HOME_LABEL)
    expect(SITE_HEALTH_HOME_LABEL).toBe('Home')
  })

  it('preserves query strings, which distinguish real page variants', () => {
    expect(displayPagePath('https://azcoatingsllc.com/search?q=epoxy&page=2', rootHost))
      .toBe('/search?q=epoxy&page=2')
    // A query on the root is not the root page.
    expect(displayPagePath('https://azcoatingsllc.com/?page=2', rootHost)).toBe('/?page=2')
    expect(displayPagePath('https://azcoatingsllc.com/guide#install', rootHost)).toBe('/guide#install')
  })

  it('falls back to the raw string instead of dropping an unusable value', () => {
    expect(displayPagePath('not a url', rootHost)).toBe('not a url')
    expect(displayPagePath('/already-a-path', rootHost)).toBe('/already-a-path')
    expect(displayPagePath('https://azcoatingsllc.com/about', null)).toBe('https://azcoatingsllc.com/about')
    expect(displayPagePath(null, rootHost)).toBe('')
  })
})

describe('siteHostFromUrl and isSameSiteUrl', () => {
  it('reads the hostname of a crawl root and refuses an unparseable one', () => {
    expect(siteHostFromUrl('https://www.azcoatingsllc.com/')).toBe('www.azcoatingsllc.com')
    expect(siteHostFromUrl('nonsense')).toBeNull()
    expect(siteHostFromUrl(null)).toBeNull()
  })

  it('answers same-site only when a root host is actually known', () => {
    expect(isSameSiteUrl('https://azcoatingsllc.com/about', rootHost)).toBe(true)
    expect(isSameSiteUrl('https://other.example/about', rootHost)).toBe(false)
    expect(isSameSiteUrl('https://azcoatingsllc.com/about', null)).toBe(false)
  })
})
