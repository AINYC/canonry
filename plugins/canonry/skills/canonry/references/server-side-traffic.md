# Server-side traffic (AI Visibility — Server-Side)

Server-side traffic ingestion captures **what AI engines actually do in
your server logs** — bots crawling pages, AI products sending
click-through arrivals — in addition to the citation data that measures
**what models say** about you. The two surfaces are independent.

## When to use it

Reach for server-side traffic when an analyst or operator asks:

- *"Is GPTBot / ClaudeBot / PerplexityBot actually fetching my pages?"*
- *"Which paths are AI engines paying attention to?"*
- *"Are users clicking through from chatgpt.com / claude.ai / etc.?"*
- *"My citation rate is fine but there's no traffic — why?"*

GA4 referrals (chatgpt.com → your site) catch click-throughs after they
land. Server logs catch the upstream bot activity AND referrals at the
edge — including arrivals GA4 missed because of cookie consent, ad
blockers, or analytics gaps.

## Architecture

Two tables, populated from server-log adapters:

| Table | What's in it |
|---|---|
| `crawler_events_hourly` | One row per `(project, source, hour, bot, verification, path, status)` — bot crawls rolled up by hour |
| `ai_referral_events_hourly` | One row per `(project, source, hour, product, source_domain, evidence_type, landing_path, status)` — click-through arrivals rolled up by hour |
| `raw_event_samples` | Bounded forensic samples (≤100 per sync) for spot-checking |

Each `traffic_sources` row is one server-log integration for a project.
Adapters today:

| Adapter | Source | Best for |
|---|---|---|
| `cloud-run` | GCP Cloud Run request logs via Logging API | Any service running on Cloud Run |
| `wordpress` | The Canonry Traffic Logger WP plugin's REST endpoint | WordPress sites where you control wp-admin |
| `vercel` | Vercel project logs via the Vercel API | Sites deployed on Vercel (Next.js, SvelteKit, etc.) |
| `cloudflare` | A zone Worker selecting edge request events, delivered by direct push | Sites whose public traffic already passes through Cloudflare |

Future adapters slot in by implementing the same contract.

## Connecting a Cloud Run source

```bash
# 1. Create a service account in the Cloud project that hosts the Cloud Run
#    service. Grant it `roles/logging.viewer`. Download the JSON key.

# 2. Connect from cnry CLI:
cnry traffic connect cloud-run <project> \
  --gcp-project <gcp-project-id> \
  --service-account-key <path/to/key.json>

# 3. (Optional) narrow to a specific service or location:
cnry traffic connect cloud-run <project> \
  --gcp-project <id> \
  --service-account-key <path> \
  --service my-service-name \
  --location us-east1
```

Credentials are stored in `~/.canonry/config.yaml` (not the DB). The
canonical key lives only on the host that runs `cnry serve`. The
sync flow does NOT echo the private key back in any response.

## Connecting a WordPress source

The WordPress adapter pulls events from the **Canonry Traffic Logger**
WordPress plugin, which captures every non-admin GET page-load **that
reaches PHP** and exposes a paginated REST endpoint protected by an
Application Password.

> **Cache blind spot.** The plugin is a PHP hook, so it only sees
> requests that execute WordPress. A full-page cache (LiteSpeed, WP
> Rocket, W3 Total Cache, WP Super Cache) or CDN serves cached pages
> before PHP runs, so cache-served page views, including live AI
> user-fetches (Claude-User, ChatGPT-User), are NOT logged. Bot crawls
> of uncached endpoints (sitemap, feeds, assets, cache misses) still
> come through, which can make capture look healthy while real page
> views go uncounted. Exclude AI user-agents from the cache (and any
> CDN), or capture from access/edge logs instead. The
> `traffic.source.cache-blindspot` doctor check warns whenever a
> WordPress source is connected.

**Which user-agents to exclude from the cache** (one per line in
LiteSpeed's "Do Not Cache User Agents", WP Rocket's
`rocket_cache_reject_ua`, or W3TC / WP Super Cache "Rejected User
Agents"):

```
Claude-User
ClaudeBot
ChatGPT-User
OAI-SearchBot
GPTBot
PerplexityBot
Perplexity-User
```

These are the answer-engine fetchers in both live-user-fetch (`*-User`)
and crawler forms. Do NOT add `Googlebot` or `Bingbot`: caching helps
search crawlers (page speed is a ranking signal, and cached pages let
them crawl more per visit, which matters most on crawl-budget-starved
sites), and their crawl stats are already authoritative in GSC and Bing
Webmaster Tools. Rule of thumb: bypass cache only for agents you cannot
measure elsewhere and that gain nothing from being cached. Answer-engine
fetchers fit both; search crawlers fit neither.

```bash
# 1. Install the plugin. Download the latest release zip from the
#    canonry-traffic-logger plugin's GitHub release (the repo CI workflow
#    publishes a zip on every plugin-file change), then in wp-admin:
#    Plugins → Add New → Upload Plugin → upload + activate.

# 2. In wp-admin, create an Application Password for the operator user:
#    Users → Profile → Application Passwords. Copy the generated password.

# 3. (Optional) Adjust settings at Settings → Canonry Traffic Logger:
#    - Retention window: clamps to 7-365 days, default 90.
#    - "Behind a proxy or CDN": enable this when the site sits behind
#      Cloudflare or another reverse proxy, so the real visitor IP
#      (needed to verify AI-bot hits) is read from forwarded headers
#      rather than the proxy's edge address.
#    The page also shows the current event count and oldest event.

# 4. Connect from cnry CLI:
cnry traffic connect wordpress <project> \
  --url https://example.com \
  --username admin \
  --app-password "xxxx xxxx xxxx xxxx xxxx xxxx"
```

What the events table looks like (mirrors the TS
`WordpressTrafficEventPayload`):

| Column | Meaning |
|---|---|
| `observed_at` | ISO 8601 UTC timestamp with millisecond precision |
| `method`, `host`, `path`, `query_string` | Split `REQUEST_URI` parts |
| `status` | HTTP response status code |
| `user_agent`, `referer` | Headers as captured at request time |
| `remote_ip` | Client IP address (IPv4 or IPv6), or empty when none was captured |

The plugin auto-prunes events older than the retention window (default
90 days) once per day via WP-Cron. Operators who want a different
window change it in `Settings → Canonry Traffic Logger`.

## Connecting a Vercel source

The Vercel adapter pulls per-request logs from the Vercel API for a
specific project + environment. Logs are filtered by canonical domain
before classification so a multi-tenant Vercel project only surfaces
hits for the tracked site.

```bash
# 1. In the Vercel dashboard, create a token with read access to the
#    target team (Settings → Tokens → Create). Note the team ID
#    (Settings → General → Team ID) and the Vercel project ID
#    (Project → Settings → General → Project ID).

# 2. Connect from cnry CLI:
cnry traffic connect vercel <project> \
  --project-id prj_xxxxxxxx \
  --team-id   team_xxxxxxxx \
  --token     <vercel-token>            # or: --token-file <path>

# 3. (Optional) scope to a specific environment (default: production):
cnry traffic connect vercel <project> \
  --project-id prj_xxx --team-id team_xxx --token ... \
  --environment preview
```

Credentials live in `~/.canonry/config.yaml` under `vercelTraffic:`,
mirroring the cloud-run / wordpress blocks. The adapter classifies bot
crawls + AI-referral arrivals into the same `crawler_events_hourly` /
`ai_referral_events_hourly` tables — downstream commands
(`cnry traffic events / sources / status`) are source-agnostic.

### Vercel first-sync window (gotcha)

A new Vercel source captures **only going-forward traffic** by default.
`cnry traffic connect vercel` seeds `lastSyncedAt = NOW` so the first
scheduled sync uses a tight window inside Vercel's ~14-day
`request-logs` retention. Without this, the first sync would fall back
to a 30-day window, exceed retention, and throw — leaving the source
permanently stuck.

Run `cnry traffic backfill <project> --source <id> --days N` (capped at
~14 to stay inside retention) if you need any of the pre-connect
history. It's an explicit operator action; the connect flow never pulls
it implicitly.

## Connecting a Cloudflare source (direct push)

Cloudflare direct push runs a small ES-module Worker on the site's exact
zone route. It applies a broad AI filter and sends selected edge events
to Canonry in `ctx.waitUntil()`. The origin response remains independent
from filtering, scheduling, and delivery errors. The event shape is also
the contract for the later Queue pull transport.

### Current support boundary

Direct push currently supports a local `canonry serve` instance. The CLI
and server must read the same `~/.canonry/config.yaml` credential store.
You can expose that local server through a stable HTTPS tunnel.

The Cloud Run `apps/api` service has no Cloudflare credential store.
Therefore, `apps/api` cannot retain the per-source bearer and HMAC values
that deployment requires.

CAUTION: Use one authoritative server-traffic source for the canonical
site. Overlapping adapters capture the same requests and double-count
project totals. This is a current limitation. Queue support must define
source coverage before it permits a transport change.

### Prerequisites and route preflight

1. Set `publicUrl` in `~/.canonry/config.yaml` to a stable public HTTPS URL.
   If `canonry serve` is local, use a stable HTTPS tunnel URL.
2. Put the ingest host outside the Worker route. For `www.example.com/*`,
   use a different host such as `canonry-ops.example.net`.
3. Install a current Wrangler release and run `wrangler login`.
   If Wrangler lists multiple accounts, pass the exact `--account-id`.
4. Verify that Cloudflare proxies the canonical hostname in DNS.
5. Open **Workers & Pages → existing Worker → Settings → Domains &
   Routes** for the zone. Verify that `<canonical-host>/*` is unclaimed.
6. If another Worker owns that route, stop. Integrate Canonry into that
   Worker instead of attaching a second Worker.
7. Review the account request volume. A route invokes the Worker for every
   matching request. The filter does not reduce Worker invocations.

Workers Free includes 100,000 requests per account each day. The quota
resets at midnight UTC. A fail-closed route returns Cloudflare error 1027
after the account exhausts this quota. A fail-open route bypasses the
Worker and keeps the origin available. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### Generate or deploy

```bash
# Generate secret-free worker.js and wrangler.toml in
# ./canonry-cloudflare-<project-slug>:
canonry traffic connect cloudflare <project> \
  --zone-id <cloudflare-zone-id> \
  --account-id <cloudflare-account-id>

# Deploy only the Worker after the route preflight.
# Both safety acknowledgements are mandatory:
canonry traffic connect cloudflare <project> \
  --zone-id <cloudflare-zone-id> \
  --account-id <cloudflare-account-id> \
  --deploy --confirm-route --confirm-fail-open

# Optional artifact directory / source label:
canonry traffic connect cloudflare <project> \
  --display-name "Cloudflare · production" \
  --output-dir ./infra/canonry-cloudflare
```

`--confirm-route` records that you inspected the exact route.
`--confirm-fail-open` records that you will configure the required route
toggle. Neither flag changes Cloudflare by itself.

With `--deploy`, Canonry reads `wrangler deploy --help` before it connects
the source. Wrangler must support `--secrets-file` and `--strict`. An old
Wrangler stops this step before Canonry changes state.

The generated TOML never declares `[[routes]]`. Thus, Wrangler deploys the
Worker without placing it on production traffic. After deployment, open
Cloudflare Dashboard and attach the exact `<canonical-host>/*` route shown
in the command output. Set **Request limit failure mode** to **Fail open**
as part of this manual activation. Wrangler cannot configure this toggle.

The generated source and TOML contain no credential values. Non-secret
configuration values are Worker vars. The `--account-id` option makes
connect write `account_id` at the top level.

The bearer and HMAC values stay in the local Canonry credential store.
They become `CANONRY_BEARER_TOKEN` and `CANONRY_HMAC_SECRET` Worker
secrets. With `--deploy`, the CLI uses a mode-0600 temporary secrets file.
Then it invokes Wrangler with `--secrets-file ... --strict` and removes
the file.

Rerun the same connect command to update an old generated Worker. Canonry
atomically replaces recognizable Canonry-generated files. It refuses
operator-owned files and symlinks. Therefore, doctor remediation does not
require manual file deletion.

Cloudflare connect is absent from MCP because deployment reads local
secrets. An agent can guide the CLI command. It must not request, print,
or send either secret through chat.

### Direct-push behavior and smoke test

Direct push has bounded retries for network failures and HTTP 408, 425,
429, and 5xx responses (250 ms, then 1 s). Delivery is asynchronous and
never changes the site's response. If Canonry remains unavailable after
the retry budget, the selected event is lost. Direct push has no durable
edge buffer. This limit is the primary reason to add Queue pull next.

Smoke-test all of these before considering the source live:

1. Request a normal page with an ordinary browser UA. Verify that the
   origin status, headers, and body remain unchanged. No Canonry event must land.
2. Request a harmless page with `utm_source=chatgpt` or a known AI crawler
   UA. Verify that one event contains the expected path, status, and UA.
3. Repeat the request without AI evidence. Verify that Canonry receives
   no event.
4. Verify that the site route excludes the Canonry ingest hostname.
   This condition prevents delivery recursion.
5. In the route form, select the exact route and Worker. Set **Request limit
   failure mode** to **Fail open**. Save the route only after both values are correct.
6. Cause a non-production receiver failure in staging. Verify that the
   origin remains healthy and retries stay bounded.
7. Inspect Worker logs. Verify that logs contain no secret values.
8. Run `canonry doctor --project <project>`. Inspect
   `traffic.source.recent-data` and `traffic.source.worker-version`.
9. If the Worker version is stale, rerun the connect command. Then deploy
   with both acknowledgement flags.
10. Rehearse rollback in staging. Detach the route and verify that the
    origin remains healthy without the Worker.

A direct-push source does not use `canonry traffic sync` or a traffic-sync
schedule.

### Rollback and teardown

1. Detach the exact site route from the Worker.
2. Request an ordinary site page. Make sure that the origin status,
   headers, and body remain healthy.
3. Delete the Worker after the origin test succeeds.
4. Run the doctor. Expect source-health warnings until Canonry supports
   Cloudflare disconnect.

The current CLI and API have no Cloudflare disconnect operation. The source
row and local credential store remain after teardown. A follow-up must add
source archival and local credential cleanup.

### Queue pull seam (not shipped yet)

`deliveryMode: direct-push` is explicit in the source config. The reserved
`queue-pull` mode will keep the Worker filter, `CloudflareEdgeEventBatch`,
canonical JSON encoding, normalizer, classifier, and rollups unchanged.
Only delivery changes to a Queue binding, and Canonry gains a polling
adapter. A source must use one mode at a time so the same edge event cannot
arrive through both transports and double-count.

## Syncing data

```bash
# Manual sync — pulls [lastSyncedAt, now]. For a freshly connected
# source the window is short (since connect-time NOW). For a
# regular-cadence schedule the window stays ~30 min wide.
cnry traffic sync <project> --source <id>

# Override the lookback window (minutes) — note: clamped forward to
# lastSyncedAt, so this can only NARROW the window, never widen it
# past data already pulled.
cnry traffic sync <project> --source <id> --since-minutes 4320  # 3 days
```

### Unsticking a stuck source

If a Vercel (or Cloud Run) source has been failing for so long that
`lastSyncedAt` aged past the upstream retention boundary, every sync
will throw a retention error and `lastSyncedAt` will never advance —
the source is permanently stuck. Recovery:

```bash
# Advances lastSyncedAt to NOW, clears the error state. Skipped
# history is unrecoverable from the sync path; run backfill separately
# if any of it needs to be captured.
cnry traffic reset <project> --source <id> --advance-to-now
```

`--advance-to-now` is required — there is no implicit reset.

`reset` accepts any **non-archived** source type. The `lastSyncedAt`
advance is meaningful for time-windowed sources (Vercel, Cloud Run)
where it determines the next sync window. Cursor-based sources
(WordPress) keep their `last_cursor` intact, so the `lastSyncedAt`
advance is informational — the next WordPress drain still resumes
from the cursor. The primary use case is the retention-trap recovery
above; clearing `lastError` for a transient WordPress failure also
works. Archived sources are rejected — re-connect them with
`cnry traffic connect ...` instead.

Cross-sync dedupe via the `last_event_ids` ring buffer means re-running a
sync over an overlapping window cannot double-count rolled-up hourly
hits. Safe to schedule (see "Scheduling" below) or trigger from CI.

## Inspecting source state

```bash
# All sources with last-24h totals + latest sync run (single-call):
cnry traffic status <project> --format json

# Just the source list:
cnry traffic sources <project> --format json

# Windowed events (defaults to last 24h):
cnry traffic events <project> --kind crawler --limit 200 --format json
cnry traffic events <project> --kind ai-referral --since 2026-04-01 --until 2026-04-30
```

The `traffic status` composite returns the same per-source detail
(24h crawler hits, AI-referral arrivals, raw-event-sample count, latest
sync-run summary) whether you reach it via the CLI, the API, or the
MCP `canonry_traffic_status` tool.

**Crawler hits are segmented by path class (#719).** On real sites the raw
`crawlerHits` total is dominated by infrastructure polling — a bot re-fetching
`sitemap_index.xml`, `robots.txt`, and static assets — which overstates how
much of your *content* is being crawled. `traffic status` and `traffic events`
therefore return, alongside the unchanged `crawlerHits` total:

- `crawlerContentHits` — crawls of actual content/document pages (the signal you
  usually want: "are bots reading my pages?").
- `crawlerInfraHits` — sitemap + robots + asset fetches.
- `crawlerSegments` — the full `{ content, sitemap, robots, asset, other }`
  breakdown; the five buckets sum to `crawlerHits`, and
  `content + infra + other == crawlerHits`. `other` captures non-page downloads
  and feeds (PDF, CSV, RSS) plus WordPress polling endpoints that are not page
  reads (`/feed`, `/<path>/feed`, `/wp-json/...`, `xmlrpc.php`, `wp-cron.php`), so
  they stay out of `crawlerContentHits`.

Each crawler row from `traffic events` also carries a `pathClass`
(`content | sitemap | robots | asset | other`). The dashboard leads with the
content figure and shows infrastructure polling as a secondary number. The
classification is read-time only (the pure `classifyTrafficPath` helper) — no
schema change, the stored rollups are untouched.

## Where the data shows up

| Surface | What's rendered |
|---|---|
| Project dashboard `/projects/:name/activity` | Live source table + 24h totals + GA4 referrals (combined view) |
| Top-level `/traffic` route | Cross-project source admin (connect, sync, archive) |
| `cnry report <project>` (HTML + SPA) | "AI Visibility — Server-Side" section, ranked above Indexing Health |
| `cnry doctor --project <name>` | Source health checks, including Cloudflare `traffic.source.worker-version` deployment drift |
| MCP toolkit `traffic` | Read/status tools plus pull-source setup/sync tools. Cloudflare connect is local-CLI-only so Worker secrets cannot enter an MCP transcript. |

## Doctor signals

The doctor checks are adapter-agnostic. When they fail or warn:

| Check | Code | What to do |
|---|---|---|
| `traffic.source.connected` | `traffic.source.none` | No source — `cnry traffic connect cloud-run …` |
| `traffic.source.connected` | `traffic.source.all-errored` | Re-connect the source. The check's `details.lastError` shows the underlying reason. |
| `traffic.source.recent-data` | `traffic.recent-data.stale` | Last sync was >7d ago. Run `cnry traffic sync …` or schedule a recurring sync. |
| `traffic.source.recent-data` | `traffic.recent-data.empty` | Source connected but no data in 30d. Verify config and credentials with `cnry traffic sources <project>`. |
| `traffic.source.credentials` | `traffic.credentials.resolve-failed` | Service-account key in `~/.canonry/config.yaml` is invalid or expired. Re-connect. |
| `traffic.source.cache-blindspot` | `traffic.cache-blindspot.wordpress-plugin` | A WordPress source is connected, so the plugin cannot see cache-served page views. Exclude AI user-agents from the page cache and any CDN, or switch to a log/edge source. Warns only, not a failure. |
| `traffic.source.worker-version` | `traffic.worker-version.waiting-for-first-event` | Send a smoke-test request through the Worker. Then run the doctor again. |
| `traffic.source.worker-version` | `traffic.worker-version.stale` | Redeploy the generated Worker from the credential-owning host. Use `--deploy --confirm-route --confirm-fail-open`. Attach the route manually. |

Cloudflare doctor behavior is capability-driven: only
`deliveryMode=direct-push` (and legacy Cloudflare rows with no mode) skips
pull-watermark lag. The same mode enables `traffic.source.worker-version`.
That check compares `configJson.workerVersion` with `lastWorkerVersion`.
The reserved Queue pull mode uses pull checks and skips the version check.

## Scheduling

`cnry schedule` supports `--kind traffic-sync` for pull sources. Cloudflare
direct push is event-driven and must not receive a traffic-sync schedule. Recurring syncs are
safe because of the `last_event_ids` cross-sync dedupe ring buffer
described above. Recommended cadence:

| Cadence | Use case |
|---|---|
| `0 */6 * * *` (every 6h) | Production agencies tracking active client sites |
| `0 0 * * *` (daily) | Lower-traffic sites or local dev |
| Manual only | First few weeks while validating data |

## Telemetry

Every successful or failed sync emits a `traffic.synced` event to the
canonry telemetry pipeline:

```jsonc
{
  "event": "traffic.synced",
  "errorCode": "PROVIDER_AUTH",       // present only when status='failed'
  "properties": {
    "status": "completed" | "failed",
    "sourceType": "cloud-run",        // adapter type
    "sourceId": "<uuid>",             // opaque
    "pulledEvents": 234,
    "crawlerHits": 200,
    "aiReferralHits": 12,
    "durationMs": 4150
  }
}
```

Counts are aggregate. The sourceId is an opaque UUID. No raw paths,
domains, or PII are surfaced.

## Limits & caveats

- **The WordPress plugin is blind to cache-served traffic.** The
  `wordpress` adapter logs only requests that reach PHP. A full-page
  cache or CDN serves cached pages from the edge, so cache-served page
  views, including live AI user-fetches (Claude-User, ChatGPT-User),
  never reach the plugin and go uncounted, even though bot crawls of
  uncached endpoints (sitemap, assets) still appear. On a cached
  WordPress site, treat the plugin's page-view counts as a floor, not a
  total. Either exclude AI user-agents from the cache + CDN, or capture
  cache-independent via a `cloud-run` / `vercel` / edge-log source. The
  `traffic.source.cache-blindspot` doctor check surfaces this. Adapter
  coverage differs: `vercel` ingests edge request-logs so cache hits are
  captured (it records the `cache` HIT/MISS label), and `cloud-run` logs
  every request that reaches the service, missing only what a CDN placed
  in front of Cloud Run serves from its own edge cache. Only the
  hook-based `wordpress` adapter has the always-present blind spot.
- **Path-level citation cross-reference is not implemented yet.** The
  citation store is domain-grain (`query_snapshots.cited_domains`). A
  future iteration that lands URL-grain citation evidence will extend
  the `topCrawledPaths` entry with a `citationState` flag. Until then,
  treat the report's crawled-paths table as "engine attention" — the
  signal is the bot fetched it, not whether it was cited.
- **Verified vs unverified.** The headline numbers count only
  rDNS-verified hits. Unverified bots claim a known UA but couldn't be
  cross-confirmed via reverse-DNS — they may be the real bot or an
  imitator. Don't promote unverified counts in client-facing copy.
  **Vercel sources are a special case:** the Vercel pull API returns
  no client IP, so every Vercel crawler hit is unverified by
  construction (UA-only). A Vercel source reading 100% unverified is
  expected, not a misconfiguration.
- **Four adapters ship: Cloud Run, WordPress, Vercel, and Cloudflare
  direct push. More adapters are planned.** The doctor checks and report renderer are
  adapter-agnostic — adding a new adapter is just a new entry in
  `traffic_sources.source_type` and a `TrafficSourceValidator`
  registration.
