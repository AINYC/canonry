export interface BingSite {
  Url: string
  /**
   * Whether the site is verified in Bing Webmaster Tools (DNS / HTML file /
   * Meta tag). Field name follows Bing's actual `GetUserSites` JSON payload
   * exactly — historically this was modelled as `Verified` here, but the
   * live API returns `IsVerified` and the `Verified` field was always
   * undefined, which made every doctor "site-access" check fail.
   */
  IsVerified?: boolean
}

export interface BingUrlInfo {
  Url: string
  // Documented UrlInfo fields from Bing's published contract:
  // https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.urlinfo?view=bing-webmaster-dotnet
  // WSDL: https://ssl.bing.com/webmaster/api.svc?singleWsdl
  DocumentSize?: number
  AnchorCount?: number
  DiscoveryDate?: string
  LastCrawledDate?: string
  IsPage?: boolean
  HttpStatus?: number
  TotalChildUrlCount?: number
  // Legacy/undocumented fields observed in older integrations. Keep as fallbacks.
  // Note: `InIndex` was retired from the public UrlInfo contract — Microsoft's
  // current schema (https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.urlinfo)
  // lists only the eight crawl-related properties above.
  HttpCode?: number
  InIndexDate?: string
  CacheDate?: string
}

export interface BingPageStats {
  Date: string
  Impressions: number
  Clicks: number
  Ctr: number
  AveragePosition: number
  Query?: string
  Page?: string
}

export interface BingKeywordStats {
  Query: string
  Impressions: number
  Clicks: number
  Ctr: number
  /** -1 when there are zero clicks (Bing sentinel). */
  AvgClickPosition: number
  AvgImpressionPosition: number
}

export interface BingCrawlStats {
  Date: string
  CrawledPages: number
  InIndex: number
  CrawlErrors: number
  BlockedByRobotsTxt?: number
  HttpErrors?: Record<string, number>
}

export interface BingCrawlIssue {
  Url: string
  HttpCode: number
  Date: string
  IssueType?: string
}

export interface BingSubmitUrlResponse {
  d?: null
}

export interface BingSubmitUrlBatchResponse {
  d?: null
}

/**
 * Bing Webmaster Tools error codes that mean "you are going too fast".
 *
 * Bing does not use HTTP 429 for this. A throttled request comes back as a
 * `400` whose body carries the real condition, e.g.
 * `{"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}` — 5 is a per-host limit
 * (every project on this instance shares it) and 4 is per-API-key.
 */
export const BING_THROTTLE_ERROR_CODES = new Set([4, 5])

export class BingApiError extends Error {
  public status: number
  /** Bing's own `ErrorCode` from the response body, when it sent one. */
  public bingErrorCode: number | null
  /**
   * True when Bing was throttling. Kept as a field rather than re-derived from
   * the message so `isRetryableHttpError` sees the condition structurally and
   * callers do not have to parse prose.
   */
  public isThrottle: boolean

  constructor(message: string, status: number, bingErrorCode: number | null = null) {
    super(message)
    this.name = 'BingApiError'
    this.status = status
    this.bingErrorCode = bingErrorCode
    // 429 is rate limiting by definition; Bing's own codes cover the 400 form.
    this.isThrottle = status === 429 || (bingErrorCode != null && BING_THROTTLE_ERROR_CODES.has(bingErrorCode))
  }
}
