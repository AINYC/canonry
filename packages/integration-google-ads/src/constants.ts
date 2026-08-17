/**
 * Google Ads versions sunset independently of this package. Keep the version
 * in this one module so an upgrade cannot leave mixed REST paths behind.
 */
export const GOOGLE_ADS_API_VERSION = 'v25'

export const GOOGLE_ADS_API_HOST = 'https://googleads.googleapis.com'
export const GOOGLE_ADS_API_BASE = `${GOOGLE_ADS_API_HOST}/${GOOGLE_ADS_API_VERSION}`
export const GOOGLE_ADS_OAUTH_SCOPE = 'https://www.googleapis.com/auth/adwords'

export const GOOGLE_ADS_REQUEST_TIMEOUT_MS = 30_000
export const GOOGLE_ADS_MAX_RETRIES = 3
export const GOOGLE_ADS_RETRY_BASE_DELAY_MS = 1_000
export const GOOGLE_ADS_RETRY_MAX_DELAY_MS = 30_000

export const GOOGLE_ADS_MAX_RESULT_ROWS = 10_000
export const GOOGLE_ADS_MAX_DAILY_METRICS_DAYS = 90
export const GOOGLE_ADS_MAX_CAMPAIGN_FILTER_IDS = 200

export const GOOGLE_ADS_DEFAULT_ACCESSIBLE_CUSTOMER_DETAILS = 20
export const GOOGLE_ADS_MAX_ACCESSIBLE_CUSTOMER_DETAILS = 100
export const GOOGLE_ADS_CUSTOMER_DETAIL_CONCURRENCY = 5
export const GOOGLE_ADS_DEFAULT_CUSTOMER_CLIENTS = 100
export const GOOGLE_ADS_MAX_CUSTOMER_CLIENTS = 1_000
export const GOOGLE_ADS_DEFAULT_CUSTOMER_CLIENT_DEPTH = 1
export const GOOGLE_ADS_MAX_CUSTOMER_CLIENT_DEPTH = 10
