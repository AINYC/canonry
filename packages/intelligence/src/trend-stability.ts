/**
 * Re-export only. The predicate moved to `@ainyc/canonry-contracts` when the
 * browser needed it as well — `apps/web` depends on contracts and not on this
 * package, and the dashboard sparkline is one of the consumers the original
 * doc comment named. Kept here so existing imports do not have to move.
 */
export { MIN_TREND_POINTS, isTrendBaseline } from '@ainyc/canonry-contracts'
