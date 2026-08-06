# integration-bing

## Purpose

Bing Webmaster Tools integration — API client for fetching URL inspection data, keyword stats, and site-level metrics from Bing's Webmaster API.

## Key Files

| File | Role |
|------|------|
| `src/bing-client.ts` | Bing Webmaster API client — URL inspections, keyword stats, crawl stats, and site information. |
| `src/types.ts` | Type definitions and `BingApiError` custom error class |
| `src/constants.ts` | API URLs, timeouts |
| `src/index.ts` | Re-exports public API |

## Patterns

- **API key auth**: Uses a Bing Webmaster API key stored in `~/.canonry/config.yaml`.
- **Error handling**: Uses `BingApiError` for API-specific errors.
- **Retry lives here, and only here.** `bingFetch` wraps `bingFetchOnce` in `withRetry` (`BING_MAX_RETRIES`, `Retry-After` aware, throttle-aware via `BingApiError.isThrottle`). Callers must NOT add a second retry layer — layers multiply: a driver retrying 4 times around this client's 5 attempts issued 20 HTTP requests for one throttled URL.
- **Throttle cooldown.** A call that exhausts its retry budget and is STILL throttled opens a `BING_THROTTLE_COOLDOWN_MS` window for that API key, during which `bingFetch` fails fast without touching the network. Bing's throttle is on the **account** (`ErrorCode 4 ThrottleUser`) as well as the host (`ErrorCode 5 ThrottleHost`), and measurement showed it outlasting the run by over an hour — a site untouched for six days was still refused with nothing in flight. Continued requests are what hold it open, so backing off entirely is the only thing that helps. Keyed by a digest, never the raw key. `__resetBingThrottleCooldownForTest(now?)` clears it and pins the clock; because the state is module-level (deliberately — the limit is per account, not per call site), any suite touching this client should reset it in `beforeEach`.

## Common Mistakes

- **Storing API keys in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Adding retry at the call site** — it is already here, and stacking multiplies load against an API that is refusing you.
- **Treating a throttle as per-site** — one key serves every project on the instance, so one project's burst throttles all of them.

## See Also

- `docs/bing-webmaster-setup.md` — user-facing setup guide
- `packages/api-routes/src/bing.ts` — API routes that use this client
