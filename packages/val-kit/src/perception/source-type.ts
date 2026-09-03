/**
 * What KIND of place the engine attributed for a branded answer.
 *
 * Explicit host lists, matched exactly or by subdomain. Never fuzzy: a
 * similarity score on a hostname would let `trustpilot-reviews-scam.example`
 * type as a review site and `bbc-news.example` as news, and the reader has no
 * way to see that the label was guessed. The lists are the whole classifier, so
 * extending one is a visible, reviewable edit — which is the point.
 *
 * Anything not on a list is `'other'`. That is a real answer, not a gap: it
 * says the engine attributed something the instrument does not recognise, which
 * is honest, where inventing a type from a keyword would not be.
 */
import { hostMatchesDomain, hostOf } from '../visibility/brand.js'
import type { SourceType } from './types.js'

/**
 * Places where people talk to each other. `news.ycombinator.com` lives here on
 * purpose and is matched before the `news.` prefix rule below — it is a forum
 * that happens to be named news.
 */
const COMMUNITY_HOSTS = [
  'reddit.com',
  'quora.com',
  'stackexchange.com',
  'stackoverflow.com',
  'news.ycombinator.com',
  'discord.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'medium.com',
  'substack.com',
] as const

/** Places whose product IS a rating or a review of a company. */
const REVIEW_HOSTS = [
  'trustpilot.com',
  'g2.com',
  'capterra.com',
  'getapp.com',
  'yelp.com',
  'bbb.org',
  'sitejabber.com',
  'glassdoor.com',
  'producthunt.com',
  'consumeraffairs.com',
  'softwareadvice.com',
  'gartner.com',
  'amazon.com',
] as const

/** A curated newsroom list. Curated because "is this a news site" has no general test. */
const NEWS_HOSTS = [
  'nytimes.com',
  'wsj.com',
  'bloomberg.com',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'theguardian.com',
  'cnbc.com',
  'forbes.com',
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'zdnet.com',
  'cnet.com',
  'businessinsider.com',
  'ft.com',
] as const

/**
 * Label prefixes that name a discussion surface. A deterministic prefix test on
 * two SPECIFIC labels — the leading one (`forum.acme.com`) and the one before
 * the public suffix (`forumhouse.ru`) — not a scan of every label, which would
 * type `acme.com/discuss`-style hosts by accident.
 */
const COMMUNITY_LABEL_PREFIXES = ['forum', 'community', 'discuss'] as const

export function classifySourceType(domain: string | null, targetDomain: string): SourceType {
  const host = hostOf(domain)
  if (!host) return 'other'
  // The brand's own site first: a page the company publishes is official
  // however else its host reads.
  if (hostMatchesDomain(host, targetDomain)) return 'official'
  // Exact lists before the prefix rules, so a listed host is never re-typed by
  // a heuristic that happens to match its name.
  if (matchesAny(host, COMMUNITY_HOSTS)) return 'community'
  if (matchesAny(host, REVIEW_HOSTS)) return 'review'
  if (matchesAny(host, NEWS_HOSTS)) return 'news'
  if (hasCommunityLabel(host)) return 'community'
  if (host.startsWith('news.')) return 'news'
  return 'other'
}

function matchesAny(host: string, hosts: readonly string[]): boolean {
  return hosts.some((candidate) => hostMatchesDomain(host, candidate))
}

function hasCommunityLabel(host: string): boolean {
  const labels = host.split('.')
  const leading = labels.length > 1 ? labels[0] : undefined
  const registrable = labels.length > 1 ? labels[labels.length - 2] : undefined
  return [leading, registrable].some((label) =>
    label !== undefined && COMMUNITY_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
  )
}
