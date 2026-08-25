<?php
/**
 * Temporary compatibility route for HTML cached while plugin 1.1.0 was live.
 *
 * Version 1.1.1 no longer emits or records browser beacons. Existing page
 * caches can nevertheless retain the old script after the plugin upgrade.
 * Swallow those residual POSTs with 204 instead of generating site-wide 404
 * noise. This route never reads the request and never writes an event.
 */

declare(strict_types=1);

namespace Canonry\TrafficLogger;

final class LegacyBeaconRoute {
    public const ROUTE_NAMESPACE = 'canonry/v1';
    public const ROUTE = '/pv';

    public static function register(): void {
        if (!function_exists('register_rest_route')) return;
        register_rest_route(self::ROUTE_NAMESPACE, self::ROUTE, [
            'methods' => 'POST',
            'callback' => ['\\Canonry\\TrafficLogger\\LegacyBeaconRoute', 'handle'],
            'permission_callback' => '__return_true',
        ]);
    }

    /** @return mixed */
    public static function handle() {
        if (class_exists('\\WP_REST_Response')) {
            return new \WP_REST_Response(null, 204);
        }
        return ['status' => 204];
    }
}
