import { normalizePublicDomain, PublicUrlError, wwwAlternate } from '../../src/security/url.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function throws(action: () => unknown, message = 'expected throw'): void {
  try {
    action()
  } catch (error) {
    if (error instanceof PublicUrlError) return
    throw error
  }
  throw new Error(message)
}

function errorMessage(action: () => unknown, message = 'expected throw'): string {
  try {
    action()
  } catch (error) {
    if (error instanceof PublicUrlError) return error.message
    throw error
  }
  throw new Error(message)
}

Deno.test('normalizes a public bare domain to an HTTPS root', () => {
  equal(normalizePublicDomain('Example.COM.').domain, 'example.com')
  equal(normalizePublicDomain('example.com').rootUrl, 'https://example.com/')
})

Deno.test('rejects paths, credentials, private ranges, and local hosts', () => {
  for (
    const input of [
      'https://example.com/services',
      'https://user:pass@example.com',
      'localhost',
      '127.0.0.1',
      '10.0.0.7',
      '169.254.169.254',
      'http://[::1]',
    ]
  ) throws(() => normalizePublicDomain(input), input)
})

Deno.test('rejects special-use internal name suffixes, including cloud metadata', () => {
  for (
    const host of [
      'metadata.google.internal',
      'foo.internal',
      'server.corp',
      'nas.home',
      'printer.lan',
    ]
  ) {
    equal(
      errorMessage(() => normalizePublicDomain(host), host),
      'Private and local hosts cannot be checked.',
      host,
    )
  }
})

Deno.test('only applies IPv6 private prefixes to IPv6 literals and rejects public literals deliberately', () => {
  for (const domain of ['fda.gov', 'fdic.gov', 'fc2.com']) {
    equal(normalizePublicDomain(domain).domain, domain)
  }

  for (const literal of ['[::1]', '[::]', '[fc00::1]', '[fd00::1]', '[fe80::1]']) {
    equal(errorMessage(() => normalizePublicDomain(`https://${literal}`)), 'Private and local hosts cannot be checked.')
  }
  equal(
    errorMessage(() => normalizePublicDomain('https://[2001:4860:4860::8888]')),
    'IPv6 literal domains are not supported.',
  )
})

Deno.test('blocks only the 192.0.0.0 IPv4 /24 special range', () => {
  equal(errorMessage(() => normalizePublicDomain('192.0.0.8')), 'Private and local hosts cannot be checked.')
  equal(normalizePublicDomain('192.0.78.0').domain, '192.0.78.0')
})

Deno.test('only derives a domain-www alternate for DNS names', () => {
  equal(wwwAlternate('example.com'), 'www.example.com')
  equal(wwwAlternate('www.example.com'), 'example.com')
  equal(wwwAlternate('203.0.113.10'), null)
})
