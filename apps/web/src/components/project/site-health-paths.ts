/**
 * How Site Health writes a crawled page in a list cell.
 *
 * Every URL in one scan usually shares the crawl root's host, so repeating
 * `https://example.com/` in front of each row costs a column of width and
 * tells the reader nothing. Stripping it is a DISPLAY change only: call sites
 * keep the full URL in `title` and in whatever they link or copy, and a
 * genuinely cross-host URL keeps its full form so an off-site link is never
 * disguised as an internal path.
 */

/** The crawl root reads as a name, not a bare slash, everywhere it appears. */
export const SITE_HEALTH_HOME_LABEL = 'Home'

const WWW_PREFIX = /^www\./i

/** Hostname of a crawl root URL, or null when it cannot be parsed. */
export function siteHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * `www.` is a presentation prefix, not a different site, so it never decides
 * whether a URL counts as same-host.
 */
function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(WWW_PREFIX, '')
}

export function isSameSiteUrl(url: string, rootHost: string | null | undefined): boolean {
  if (!rootHost) return false
  try {
    return bareHost(new URL(url).hostname) === bareHost(rootHost)
  } catch {
    return false
  }
}

/**
 * Display text for one crawled page URL.
 *
 * Same-host URLs render as their path (query strings kept, because
 * `/search?q=roof` and `/search` are different pages), the root renders as
 * "Home", and anything else, including an unparseable value, is returned
 * unchanged rather than silently dropped.
 */
export function displayPagePath(
  url: string | null | undefined,
  rootHost: string | null | undefined,
): string {
  if (!url) return ''
  if (!isSameSiteUrl(url, rootHost)) return url

  const parsed = new URL(url)
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return path === '' || path === '/' ? SITE_HEALTH_HOME_LABEL : path
}
