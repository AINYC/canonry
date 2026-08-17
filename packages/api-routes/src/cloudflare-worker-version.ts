/**
 * Semver of the Canonry-issued Cloudflare Worker bundle. Bump when the
 * Worker's edge-side filter, payload shape, or auth header set changes so the
 * doctor check can identify deployments still running an older revision.
 */
export const CURRENT_CLOUDFLARE_WORKER_VERSION = '1.0.1'
