<?php

declare(strict_types=1);

require_once __DIR__ . '/../plugin/canonry-traffic-logger.php';

use Canonry\TrafficLogger\LegacyBeaconRoute;
use Canonry\TrafficLogger\Recorder;
use Canonry\TrafficLogger\Test\TestCase;

final class LegacyBeaconRouteTest extends TestCase {
    public function setUp(): void {
        wpshim_reset();
        \Canonry\TrafficLogger\Plugin::activate();
    }

    public function test_cached_legacy_beacon_posts_are_acknowledged_without_logging(): void {
        $response = LegacyBeaconRoute::handle();
        $this->assertTrue($response instanceof \WP_REST_Response);
        $this->assertSame(204, $response->status);

        global $wpdb;
        $rows = $wpdb->rows[$wpdb->prefix . Recorder::TABLE] ?? [];
        $this->assertCount(0, $rows);
    }
}
