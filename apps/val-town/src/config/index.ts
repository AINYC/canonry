import {
  createTurnstileVerifier,
  type HumanVerifier,
  LocalBypassHumanVerifier,
  UnavailableHumanVerifier,
} from '../security/turnstile.ts'

export interface ValTownConfig {
  environment: 'production' | 'development' | 'test'
  checkTtlMs: number
  perClientDailyLimit: number
  globalDailyLimit: number
  quotaSalt: string
  humanVerifier: HumanVerifier
  turnstileSiteKey: string | null
  humanVerificationStatus: 'ready' | 'not-required' | 'unavailable'
  geminiApiKey: string | null
  geminiModel: string | null
  publicChecksEnabled: boolean
  publicChecksUnavailableMessage: string | null
  /** Whether the MCP endpoint may start a check. Reads are always available. */
  mcpStartChecksEnabled: boolean
  /** Daily per-caller allowance for MCP-started checks, in its own quota bucket. */
  mcpPerClientDailyLimit: number
}

function positiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number(input)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function splitCsv(input: string | undefined): string[] {
  return (input ?? '').split(',').map((value) => value.trim()).filter(Boolean)
}

/**
 * Env parsing is intentionally small. A deployed production val refuses every
 * public check if Turnstile isn't configured; local/test can opt into the
 * explicit bypass to keep tests free of secrets.
 */
export function loadValTownConfig(env: Record<string, string | undefined> = Deno.env.toObject()): ValTownConfig {
  // There is no trusted implicit signal that a Val is a development host.
  // Default to production so the local bypass must always be opted into with
  // both an explicit environment and its deliberately unsafe flag.
  const environment = env.VAL_TOWN_ENV === 'development'
    ? 'development'
    : env.VAL_TOWN_ENV === 'test'
    ? 'test'
    : 'production'
  const secret = env.TURNSTILE_SECRET_KEY?.trim()
  const siteKey = env.TURNSTILE_SITE_KEY?.trim()
  const allowedHostnames = splitCsv(env.TURNSTILE_ALLOWED_HOSTNAMES)
  const hasCompleteTurnstileConfig = Boolean(secret && siteKey && allowedHostnames.length > 0)
  const configuredQuotaSalt = env.CANONRY_QUOTA_SALT?.trim() || null

  let humanVerifier: HumanVerifier
  let humanVerificationStatus: ValTownConfig['humanVerificationStatus']
  if (hasCompleteTurnstileConfig && secret) {
    humanVerifier = createTurnstileVerifier({ secret, allowedHostnames })
    humanVerificationStatus = 'ready'
  } else if (environment !== 'production' && env.ALLOW_INSECURE_LOCAL_HUMAN_BYPASS === '1') {
    humanVerifier = new LocalBypassHumanVerifier()
    humanVerificationStatus = 'not-required'
  } else {
    humanVerifier = new UnavailableHumanVerifier()
    humanVerificationStatus = 'unavailable'
  }

  return {
    environment,
    checkTtlMs: positiveInt(env.CANONRY_CHECK_CACHE_TTL_MS, 86_400_000),
    perClientDailyLimit: positiveInt(env.CANONRY_PER_CLIENT_DAILY_LIMIT, 3),
    globalDailyLimit: positiveInt(env.CANONRY_GLOBAL_DAILY_LIMIT, 100),
    // A stable shared salt is required in production. A process-local fallback
    // would make per-IP quotas disappear whenever Val starts another isolate.
    quotaSalt: configuredQuotaSalt || (environment === 'production' ? '' : 'local-development-only'),
    humanVerifier,
    turnstileSiteKey: humanVerificationStatus === 'ready' ? siteKey || null : null,
    humanVerificationStatus,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    geminiModel: env.GEMINI_VISIBILITY_MODEL?.trim() || null,
    publicChecksEnabled: environment !== 'production' || Boolean(configuredQuotaSalt),
    publicChecksUnavailableMessage: environment === 'production' && !configuredQuotaSalt
      ? 'Public checks are temporarily unavailable.'
      : null,
    // An agent cannot solve a Turnstile challenge, so the MCP write path trades
    // human verification for a much tighter per-caller allowance. The global
    // daily cap and the single execution lease are unchanged, so this widens
    // who may spend the budget, never how large the budget is.
    mcpStartChecksEnabled: env.CANONRY_MCP_START_CHECKS !== '0',
    mcpPerClientDailyLimit: positiveInt(env.CANONRY_MCP_PER_CLIENT_DAILY_LIMIT, 2),
  }
}
