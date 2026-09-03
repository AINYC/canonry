import { test } from 'vitest'
import { loadValTownConfig } from '../src/config/index.js'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

test('production fails closed when quota salt is absent', () => {
  const config = loadValTownConfig({
    VAL_TOWN_ENV: 'production',
    TURNSTILE_SECRET_KEY: 'secret',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_ALLOWED_HOSTNAMES: 'example.val.run',
  })
  equal(config.publicChecksEnabled, false)
  equal(config.quotaSalt, '')
  equal(config.publicChecksUnavailableMessage, 'Public checks are temporarily unavailable.')
})

test('production requires every Turnstile hostname/site-key/secret component', () => {
  const config = loadValTownConfig({
    VAL_TOWN_ENV: 'production',
    CANONRY_QUOTA_SALT: 'stable-salt',
    TURNSTILE_SECRET_KEY: 'secret',
    TURNSTILE_SITE_KEY: 'site-key',
  })
  equal(config.humanVerificationStatus, 'unavailable')
  equal(config.turnstileSiteKey, null)
})

test('explicit development bypass does not become a production default', () => {
  const config = loadValTownConfig({ VAL_TOWN_ENV: 'development', ALLOW_INSECURE_LOCAL_HUMAN_BYPASS: '1' })
  equal(config.humanVerificationStatus, 'not-required')
  equal(config.publicChecksEnabled, true)
  equal(config.quotaSalt, 'local-development-only')

  const unsetEnvironment = loadValTownConfig({ ALLOW_INSECURE_LOCAL_HUMAN_BYPASS: '1' })
  equal(unsetEnvironment.environment, 'production')
  equal(unsetEnvironment.humanVerificationStatus, 'unavailable')
  equal(unsetEnvironment.publicChecksEnabled, false)
})
