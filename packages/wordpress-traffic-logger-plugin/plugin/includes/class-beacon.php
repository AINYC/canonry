<?php
/**
 * The beacon lane: how the plugin sees visits a page cache hides.
 *
 * The request hook (Recorder) runs on PHP `shutdown`, so any response served
 * by a page cache — LiteSpeed, WP Rocket, Super Cache, an advanced-cache.php
 * drop-in — never reaches it. On a cached site the PHP lane structurally sees
 * only what falls through to PHP: canonical redirects, 404s, crawlers on
 * uncached URLs. Real human page views vanish. Measured on a live site: zero
 * landed AI referrals ever recorded server-side while GA4 saw sessions.
 *
 * The fix is a second lane whose blind spots are the exact complement of the
 * first. A tiny inline script — cached WITH the page, which is precisely what
 * makes it work — posts one ping per page view to a REST route, and REST
 * routes are not page-cached, so every ping boots PHP and is recorded:
 *
 *                          PHP lane          beacon lane
 *   cached 200 (human)     never boots       script runs
 *   uncached 200 (human)   sees it           script runs   <- dedup below
 *   bot / crawler          sees it           bots run no JS
 *   301 / 404 / 5xx        sees it           no page ran
 *
 * Dedup for the one overlapping cell lives in Recorder::shouldDeferToBeacon:
 * when the beacon is active, the PHP lane skips 200s from browser-looking
 * user agents and lets the beacon own them; bot-looking agents, redirects and
 * errors stay in the PHP lane, which is the only lane that can see them.
 *
 * Everything is first-party and self-contained: the script is inline (no
 * external file, no third-party host), the endpoint is this plugin's own REST
 * namespace, no cookie is set and no identifier is minted. The ping carries
 * only what the access log would have carried: path, query string, referrer.
 *
 * Mode is `auto` by default: enabled exactly when a page cache is detected,
 * because a cache-blind source is silently wrong and silent-wrong defaults
 * are how the blindness went unnoticed. The settings page can force on/off.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class Beacon {
    public const MODE_OPTION = 'canonry_traffic_logger_beacon';
    public const ROUTE_NAMESPACE = 'canonry/v1';
    public const ROUTE = '/pv';

    private const MAX_PATH = 2048;      // matches the `path` column
    private const MAX_QUERY = 4096;     // `query_string` is TEXT; cap abuse anyway
    private const MAX_REFERER = 2048;   // matches the `referer` column

    /**
     * Substrings that mark a user agent as NOT a human browser. Deliberately
     * broad and conservative in the safe direction: a bot we fail to match is
     * merely recorded twice as a candidate referral (its rows carry no AI
     * evidence unless it forged one — and a forger defeats any UA rule), while
     * a HUMAN we wrongly matched here would be double-counted. Emptiness also
     * counts as bot-ish: real browsers always send a UA.
     */
    private const BOT_UA_MARKERS = [
        'bot', 'crawl', 'spider', 'slurp', 'preview', 'fetch', 'scan',
        'curl', 'wget', 'python', 'httpx', 'go-http', 'node', 'java/',
        'headless', 'lighthouse', 'gptbot', 'chatgpt-user', 'oai-searchbot',
        'claude', 'perplexity', 'facebookexternalhit', 'embedly', 'quora',
        'pinterest', 'vkshare', 'whatsapp', 'telegram', 'skypeuripreview',
        'discordbot', 'validator', 'monitor', 'uptime', 'check',
    ];

    public static function register(): void {
        if (!function_exists('register_rest_route')) return;
        // The route is registered even when the beacon is off: cached pages
        // keep carrying the script until the cache is purged, and a missing
        // route would turn every one of those pings into 404 noise. The
        // handler no-ops instead.
        register_rest_route(self::ROUTE_NAMESPACE, self::ROUTE, [
            'methods' => 'POST',
            'callback' => ['\\Canonry\\TrafficLogger\\Beacon', 'handle'],
            // Public by design: the ping comes from anonymous visitors'
            // browsers. Input is validated and length-capped below, and the
            // row it writes is the same shape a direct page hit writes.
            'permission_callback' => '__return_true',
        ]);
    }

    /** auto|on|off, default auto. */
    public static function mode(): string {
        $raw = function_exists('get_option') ? (string) get_option(self::MODE_OPTION, 'auto') : 'auto';
        return in_array($raw, ['auto', 'on', 'off'], true) ? $raw : 'auto';
    }

    public static function isEnabled(): bool {
        $mode = self::mode();
        if ($mode === 'on') return true;
        if ($mode === 'off') return false;
        return self::cacheDetected();
    }

    /**
     * A page cache is in play. WP_CACHE is the load-bearing signal: every
     * advanced-cache.php drop-in (LiteSpeed, WP Rocket, Super Cache, W3TC,
     * Cache Enabler, Breeze) requires it. The plugin constants catch caches
     * momentarily configured without the drop-in.
     */
    public static function cacheDetected(): bool {
        if (defined('WP_CACHE') && WP_CACHE) return true;
        foreach (['LSCWP_V', 'WP_ROCKET_VERSION', 'W3TC', 'WPCACHEHOME', 'CE_VERSION', 'BREEZE_VERSION'] as $const) {
            if (defined($const)) return true;
        }
        return false;
    }

    /** True when this user agent should stay in the PHP lane. */
    public static function looksBot(?string $userAgent): bool {
        if ($userAgent === null || trim($userAgent) === '') return true;
        $ua = strtolower($userAgent);
        foreach (self::BOT_UA_MARKERS as $marker) {
            if (strpos($ua, $marker) !== false) return true;
        }
        return false;
    }

    /** Print the inline ping script. Hooked to wp_footer when enabled. */
    public static function printScript(): void {
        if (!self::isEnabled()) return;
        $url = function_exists('rest_url')
            ? rest_url(self::ROUTE_NAMESPACE . self::ROUTE)
            : home_url('/wp-json/' . self::ROUTE_NAMESPACE . self::ROUTE);
        $url = function_exists('esc_url_raw') ? esc_url_raw($url) : $url;
        // json_encode the URL into the JS so no hand-escaping can break out of
        // the string literal.
        $urlJs = json_encode($url, JSON_UNESCAPED_SLASHES);
        echo "<script>(function(){try{"
            . "var b=JSON.stringify({p:location.pathname,q:location.search.replace(/^\\?/,''),r:document.referrer||''});"
            . "var u={$urlJs};"
            . "if(navigator.sendBeacon){navigator.sendBeacon(u,new Blob([b],{type:'application/json'}))}"
            . "else if(window.fetch){fetch(u,{method:'POST',body:b,keepalive:true,headers:{'Content-Type':'application/json'}})}"
            . "}catch(e){}})();</script>\n";
    }

    /**
     * Record one beacon ping as a normal event row.
     *
     * @param \WP_REST_Request $request
     * @return mixed WP_REST_Response-shaped array in tests.
     */
    public static function handle($request) {
        // Off means drop silently with success: cached pages keep pinging
        // until purged, and erroring would fill browser consoles site-wide.
        if (!self::isEnabled()) return self::noContent();

        $server = $_SERVER;

        // Same-origin gate. sendBeacon/fetch POSTs always carry an Origin in
        // modern browsers; a ping claiming to be for this site from another
        // origin is junk or mischief. When neither Origin nor Referer is
        // present (older browsers), fall through — the payload validation
        // below still bounds what a row can contain.
        $siteHost = self::hostOf(function_exists('home_url') ? home_url('/') : '');
        $originHost = self::hostOf((string) ($server['HTTP_ORIGIN'] ?? ''));
        $refererHost = self::hostOf((string) ($server['HTTP_REFERER'] ?? ''));
        $claimedHost = $originHost !== null ? $originHost : $refererHost;
        if ($siteHost !== null && $claimedHost !== null && $claimedHost !== $siteHost) {
            return self::noContent(); // Silent: never hand a probe an oracle.
        }

        $body = method_exists($request, 'get_body') ? (string) $request->get_body() : '';
        $data = json_decode($body, true);
        if (!is_array($data)) return self::noContent();

        $path = isset($data['p']) && is_string($data['p']) ? $data['p'] : '';
        // A path must be site-absolute and must not smuggle a scheme or our
        // own endpoints back into the log.
        if ($path === '' || $path[0] !== '/' || strpos($path, '://') !== false) return self::noContent();
        if (strpos($path, '/wp-json/canonry/') !== false || strpos($path, '/wp-admin/') !== false) return self::noContent();
        $path = substr($path, 0, self::MAX_PATH);

        $query = isset($data['q']) && is_string($data['q']) && $data['q'] !== ''
            ? substr($data['q'], 0, self::MAX_QUERY) : null;
        $referer = isset($data['r']) && is_string($data['r']) && $data['r'] !== ''
            ? substr($data['r'], 0, self::MAX_REFERER) : null;

        $userAgent = isset($server['HTTP_USER_AGENT']) && is_string($server['HTTP_USER_AGENT']) && $server['HTTP_USER_AGENT'] !== ''
            ? substr($server['HTTP_USER_AGENT'], 0, 1024) : null;
        $remoteIp = ClientIp::resolve($server, Plugin::trustProxy());

        global $wpdb;
        $table = $wpdb->prefix . Recorder::TABLE;
        $wpdb->insert(
            $table,
            [
                'observed_at'  => self::nowIsoUtc(),
                'method'       => 'GET',   // The page view the ping stands for, not the ping itself.
                'host'         => $siteHost,
                'path'         => $path,
                'query_string' => $query,
                // The view rendered in a browser; the served page is a 200
                // regardless of which cache layer produced the bytes.
                'status'       => 200,
                'user_agent'   => $userAgent,
                'remote_ip'    => $remoteIp,
                'referer'      => $referer,
            ],
            ['%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s', '%s']
        );

        return self::noContent();
    }

    private static function hostOf(string $url): ?string {
        if ($url === '') return null;
        $host = parse_url($url, PHP_URL_HOST);
        return is_string($host) && $host !== '' ? strtolower($host) : null;
    }

    private static function nowIsoUtc(): string {
        try {
            return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\\TH:i:s.v\\Z');
        } catch (\Throwable $e) {
            return gmdate('Y-m-d\\TH:i:s\\Z');
        }
    }

    /** @return mixed */
    private static function noContent() {
        if (class_exists('\\WP_REST_Response')) {
            return new \WP_REST_Response(null, 204);
        }
        return ['status' => 204];
    }
}
