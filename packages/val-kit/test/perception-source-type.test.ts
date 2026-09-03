import { test } from 'vitest'
import { classifySourceType } from '../src/perception/source-type.js'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

test('the brand own site is official, subdomains and www included', () => {
  equal(classifySourceType('example.com', 'example.com'), 'official')
  equal(classifySourceType('www.example.com', 'example.com'), 'official')
  equal(classifySourceType('docs.example.com', 'example.com'), 'official')
  equal(classifySourceType('example.com', 'www.example.com'), 'official', 'the target may still carry www')
  equal(classifySourceType('notexample.com', 'example.com'), 'other', 'a suffix is not a subdomain')
})

test('official wins over every other list, because the company published the page', () => {
  // A brand hosting its own community or newsroom is still the brand speaking.
  equal(classifySourceType('community.example.com', 'example.com'), 'official')
  equal(classifySourceType('news.example.com', 'example.com'), 'official')
})

test('each list types its own hosts, including subdomains', () => {
  equal(classifySourceType('reddit.com', 'example.com'), 'community')
  equal(classifySourceType('www.reddit.com', 'example.com'), 'community')
  equal(classifySourceType('mynewsletter.substack.com', 'example.com'), 'community')
  equal(classifySourceType('trustpilot.com', 'example.com'), 'review')
  equal(classifySourceType('www.g2.com', 'example.com'), 'review')
  equal(classifySourceType('bbc.co.uk', 'example.com'), 'news')
  equal(classifySourceType('www.nytimes.com', 'example.com'), 'news')
})

test('news.ycombinator.com is a forum that happens to be named news', () => {
  // The explicit lists run BEFORE the prefix rules for exactly this case. Order
  // is the whole defence: a listed host must never be re-typed by a heuristic
  // that happens to match its name.
  equal(classifySourceType('news.ycombinator.com', 'example.com'), 'community')
  equal(classifySourceType('news.somepaper.test', 'example.com'), 'news')
})

test('the label prefixes are a deterministic test on two labels, not a scan', () => {
  equal(classifySourceType('forum.acme.test', 'example.com'), 'community')
  equal(classifySourceType('community.acme.test', 'example.com'), 'community')
  equal(classifySourceType('discussions.acme.test', 'example.com'), 'community')
  equal(classifySourceType('forumhouse.test', 'example.com'), 'community', 'the registrable label counts too')
  equal(classifySourceType('acme.test', 'example.com'), 'other')
  equal(
    classifySourceType('cdn.acme.test', 'example.com'),
    'other',
    'a middle label is never inspected, so an unrelated host cannot be typed by accident',
  )
})

test('anything unrecognised is other, and an unattributable source is too', () => {
  // `other` is a real answer: the engine attributed something this instrument
  // does not recognise. Inventing a type from a keyword would not be.
  equal(classifySourceType('some-blog.example.test', 'example.com'), 'other')
  equal(classifySourceType('trustpilot-reviews-scam.test', 'example.com'), 'other', 'never fuzzy')
  equal(classifySourceType(null, 'example.com'), 'other', 'an opaque provider redirect attributes nothing')
  equal(classifySourceType('', 'example.com'), 'other')
  equal(classifySourceType('not a hostname at all', 'example.com'), 'other')
})
