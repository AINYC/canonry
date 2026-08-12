export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Full Search Console scope. Required for mutations such as sitemap submit. */
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters'
/** Legacy read-only Search Console scope, retained to identify connections that need re-authorization. */
export const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
export const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing'
export const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3'
export const URL_INSPECTION_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
export const GSC_MAX_ROWS_PER_REQUEST = 25000
/**
 * Google's typical search-analytics publishing delay, in days.
 *
 * Use it to PAD the start of a fetch window so a `days`-day request still
 * yields `days` days of published data. Never use it as the window's END:
 * the real delay varies (it is commonly two days and occasionally one), so a
 * fixed ceiling of `today - 3` refuses to ask for days Google has already
 * published and leaves stored data permanently a day behind the Search
 * Console UI. Ask through today instead; the API returns what exists and
 * simply omits the rest.
 */
export const GSC_DATA_LAG_DAYS = 3
export const URL_INSPECTION_DAILY_LIMIT = 2000
export const INDEXING_API_BASE = 'https://indexing.googleapis.com/v3'
export const INDEXING_API_DAILY_LIMIT = 200

// HTTP request timeout (30 s) — prevents the process from hanging indefinitely
// on a slow or unresponsive Google API endpoint.
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000

// Safety limit: max pagination iterations to prevent infinite loops if the API
// returns inconsistent results.
export const GSC_MAX_PAGES = 40
