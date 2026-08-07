export const BING_WMT_API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json'

// URL submission limits
export const BING_SUBMIT_URL_BATCH_LIMIT = 500
export const BING_SUBMIT_URL_DAILY_LIMIT = 10000

// HTTP request timeout (30 s) — prevents the process from hanging indefinitely
// on a slow or unresponsive Bing Webmaster Tools endpoint.
export const BING_REQUEST_TIMEOUT_MS = 30_000

// Retry policy for throttled Bing calls.
//
// Bing's host limit is shared by every project on the instance, so a throttle
// is a wait-and-succeed condition rather than a failure. The base delay is
// deliberately well above the 1s default: the observed pattern is a burst
// succeeding and everything behind it throttling within the same second, which
// a sub-second backoff walks straight back into. Four retries at 2s doubling to
// a 30s ceiling covers roughly a minute of throttling per call.
export const BING_MAX_RETRIES = 4
export const BING_RETRY_BASE_DELAY_MS = 2_000
export const BING_RETRY_MAX_DELAY_MS = 30_000

// How long to stop calling an API key that is still throttled after a full
// retry budget.
//
// Retrying is the right answer to a momentary throttle and the wrong answer to
// a sustained one. Measured on 2026-08-06: once the key was throttled, every
// call kept returning `ThrottleUser` for over an hour — including calls for a
// site that had not been touched in six days, with nothing else in flight. The
// limit is on the ACCOUNT, and more requests are what hold it open.
//
// So a call that exhausts its retries and is STILL throttled is treated as
// evidence about the key, not about that URL: further calls fail immediately
// for this window instead of adding load. It is deliberately much shorter than
// the observed penalty — long enough to break the feedback loop, short enough
// that a scheduled refresh an hour later is unaffected.
export const BING_THROTTLE_COOLDOWN_MS = 10 * 60 * 1000
