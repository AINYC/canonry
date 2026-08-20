<?php
/**
 * The beacon lane: cached page views reach the log through a REST ping, and
 * the PHP lane defers browser-looking 200s to it so an uncached human view is
 * never counted twice. See class-beacon.php for the two-lane table.
 */

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\Beacon;
use Canonry\TrafficLogger\Recorder;
use Canonry\TrafficLogger\Test\TestCase;

final class BeaconTest extends TestCase {
    /** @var array<string, mixed> */
    private array $savedServer = [];

    public function setUp(): void {
        wpshim_reset();
        Beacon::resetPrintedFlagForTests();
        \Canonry\TrafficLogger\Plugin::activate();
        $this->savedServer = $_SERVER;
        // A same-origin browser ping, as sendBeacon would send it.
        $_SERVER['HTTP_ORIGIN'] = 'https://example.com';
        $_SERVER['HTTP_USER_AGENT'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/605.1.15';
        $_SERVER['REMOTE_ADDR'] = '203.0.113.9';
        update_option(Beacon::MODE_OPTION, 'on');
    }

    public function tearDown(): void {
        $_SERVER = $this->savedServer;
    }

    /** @return array<int, array<string, mixed>> */
    private function rows(): array {
        global $wpdb;
        return $wpdb->rows[$wpdb->prefix . Recorder::TABLE] ?? [];
    }

    private function ping(array $payload): void {
        $request = new \WP_REST_Request('POST', [], [], json_encode($payload));
        Beacon::handle($request);
    }

    // ── mode resolution ────────────────────────────────────────────────

    public function test_mode_defaults_to_auto_and_rejects_junk(): void {
        update_option(Beacon::MODE_OPTION, 'auto');
        $this->assertSame('auto', Beacon::mode());
        update_option(Beacon::MODE_OPTION, 'banana');
        $this->assertSame('auto', Beacon::mode());
    }

    public function test_auto_without_a_detected_cache_is_disabled(): void {
        // The test process defines none of the cache constants, so auto = off.
        update_option(Beacon::MODE_OPTION, 'auto');
        $this->assertFalse(Beacon::isEnabled());
    }

    public function test_explicit_on_and_off_override_detection(): void {
        update_option(Beacon::MODE_OPTION, 'on');
        $this->assertTrue(Beacon::isEnabled());
        update_option(Beacon::MODE_OPTION, 'off');
        $this->assertFalse(Beacon::isEnabled());
    }

    // ── the ping handler ───────────────────────────────────────────────

    public function test_records_a_page_view_with_the_payload_referrer(): void {
        $this->ping(['p' => '/roof-coatings', 'q' => 'utm_source=chatgpt.com', 'r' => 'https://chatgpt.com/']);

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $row = $rows[0];
        // The row is the PAGE VIEW the ping stands for, not the ping request:
        // method GET, status 200, and the referrer the BROWSER saw — the REST
        // request's own Referer header would be the page URL, which is useless
        // as evidence.
        $this->assertSame('GET', $row['method']);
        $this->assertSame(200, $row['status']);
        $this->assertSame('example.com', $row['host']);
        $this->assertSame('/roof-coatings', $row['path']);
        $this->assertSame('utm_source=chatgpt.com', $row['query_string']);
        $this->assertSame('https://chatgpt.com/', $row['referer']);
        $this->assertSame('203.0.113.9', $row['remote_ip']);
        $this->assertMatchesRegex('/Safari/', (string) $row['user_agent']);
    }

    /**
     * The reproduced forgery: a raw POST with neither Origin nor Referer,
     * carrying attacker-chosen referrer and UTMs. Browsers modern enough to
     * run the script always send Origin on POST, so headerless is not a
     * browser — it is curl.
     */
    public function test_drops_headerless_pings_as_forgeries(): void {
        unset($_SERVER['HTTP_ORIGIN'], $_SERVER['HTTP_REFERER']);
        $this->ping(['p' => '/', 'q' => 'utm_source=chatgpt.com', 'r' => 'https://chatgpt.com/']);
        $this->assertCount(0, $this->rows());
    }

    /**
     * Googlebot renders JavaScript, so it fires the beacon like a browser.
     * The PHP lane owns bots; recording the ping too would double-count every
     * JS-capable crawler.
     */
    public function test_drops_bot_pings_because_the_php_lane_owns_bots(): void {
        $_SERVER['HTTP_USER_AGENT'] = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
        $this->ping(['p' => '/', 'q' => '', 'r' => '']);
        $this->assertCount(0, $this->rows());
    }

    public function test_drops_cross_origin_pings_silently(): void {
        $_SERVER['HTTP_ORIGIN'] = 'https://evil.example.net';
        $this->ping(['p' => '/', 'q' => '', 'r' => '']);
        $this->assertCount(0, $this->rows());
    }

    public function test_drops_when_disabled_but_still_succeeds(): void {
        // Cached pages keep pinging until the cache is purged; a disabled
        // beacon must swallow them without error noise.
        update_option(Beacon::MODE_OPTION, 'off');
        $response = null;
        $request = new \WP_REST_Request('POST', [], [], json_encode(['p' => '/', 'q' => '', 'r' => '']));
        $response = Beacon::handle($request);
        $this->assertCount(0, $this->rows());
        $this->assertSame(204, is_object($response) ? $response->status : $response['status']);
    }

    public function test_rejects_paths_that_are_not_site_absolute(): void {
        foreach (['relative', 'https://elsewhere.example/x', '//protocol-relative', ''] as $bad) {
            $this->ping(['p' => $bad, 'q' => '', 'r' => '']);
        }
        // '//x' parses as path starting '/', keep it: only the first three are
        // rejected outright ('' and non-/ and scheme). Protocol-relative
        // starts with '/' and carries no '://', so it records as a path.
        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('//protocol-relative', $rows[0]['path']);
    }

    public function test_never_logs_its_own_or_admin_endpoints(): void {
        $this->ping(['p' => '/wp-json/canonry/v1/pv', 'q' => '', 'r' => '']);
        $this->ping(['p' => '/wp-admin/options.php', 'q' => '', 'r' => '']);
        $this->assertCount(0, $this->rows());
    }

    public function test_caps_field_lengths(): void {
        $this->ping(['p' => '/' . str_repeat('a', 5000), 'q' => str_repeat('b', 9000), 'r' => 'https://chatgpt.com/' . str_repeat('c', 5000)]);
        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertTrue(strlen($rows[0]['path']) <= 2048);
        $this->assertTrue(strlen($rows[0]['query_string']) <= 4096);
        $this->assertTrue(strlen($rows[0]['referer']) <= 2048);
    }

    public function test_ignores_garbage_bodies(): void {
        foreach (['', 'not json', '[]', '"str"', json_encode(['p' => 42])] as $body) {
            Beacon::handle(new \WP_REST_Request('POST', [], [], $body));
        }
        $this->assertCount(0, $this->rows());
    }

    // ── the script tag ─────────────────────────────────────────────────

    public function test_prints_the_ping_script_only_when_enabled(): void {
        ob_start();
        Beacon::printScript();
        $on = (string) ob_get_clean();
        $this->assertMatchesRegex('/sendBeacon/', $on);
        $this->assertMatchesRegex('~/wp-json/canonry/v1/pv~', $on);

        update_option(Beacon::MODE_OPTION, 'off');
        ob_start();
        Beacon::printScript();
        $this->assertSame('', (string) ob_get_clean());
    }

    // ── the dedup: who owns which cell of the lane table ───────────────

    private function armBeaconScript(): void {
        ob_start();
        Beacon::printScript();
        ob_end_clean();
    }

    public function test_php_lane_defers_browser_200s_once_the_script_was_printed(): void {
        $this->armBeaconScript();
        Recorder::record($this->browserRequest(), 200);
        $this->assertCount(0, $this->rows());
    }

    /**
     * A response that never carried the script can never ping: footer-less
     * themes, feeds, embeds, API responses. Deferring those would not hand the
     * visit to the other lane — it would drop it. The PHP lane keeps them.
     */
    public function test_php_lane_keeps_browser_200s_when_no_script_was_printed(): void {
        Recorder::record($this->browserRequest(), 200);
        $this->assertCount(1, $this->rows());
    }

    public function test_php_lane_keeps_bot_200s(): void {
        $this->armBeaconScript();
        $request = $this->browserRequest();
        $request['HTTP_USER_AGENT'] = 'Mozilla/5.0 AppleWebKit/537.36; compatible; GPTBot/1.2';
        Recorder::record($request, 200);
        $this->assertCount(1, $this->rows());
    }

    public function test_php_lane_keeps_redirects_and_errors_from_browsers(): void {
        $this->armBeaconScript();
        Recorder::record($this->browserRequest(), 301);
        Recorder::record($this->browserRequest(), 404);
        $this->assertCount(2, $this->rows());
    }

    public function test_php_lane_keeps_unknown_status_rows(): void {
        $this->armBeaconScript();
        // Never guess a row away: a status the shutdown hook could not read
        // is not proof the beacon will see the view.
        Recorder::record($this->browserRequest(), null);
        $this->assertCount(1, $this->rows());
    }

    public function test_php_lane_records_browser_200s_when_beacon_is_off(): void {
        $this->armBeaconScript();
        update_option(Beacon::MODE_OPTION, 'off');
        Recorder::record($this->browserRequest(), 200);
        $this->assertCount(1, $this->rows());
    }

    public function test_empty_user_agent_counts_as_bot_and_stays_in_php_lane(): void {
        $this->armBeaconScript();
        $request = $this->browserRequest();
        unset($request['HTTP_USER_AGENT']);
        Recorder::record($request, 200);
        $this->assertCount(1, $this->rows());
    }

    /** @return array<string, mixed> */
    private function browserRequest(): array {
        return [
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST'      => 'example.com',
            'REQUEST_URI'    => '/blog/post?utm_source=chatgpt.com',
            'HTTP_USER_AGENT'=> 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            'REMOTE_ADDR'    => '203.0.113.4',
            'HTTP_REFERER'   => 'https://chatgpt.com/',
        ];
    }
}
