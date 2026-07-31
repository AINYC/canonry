import { TrafficSourceTypes, type TrafficSourceType } from '@ainyc/canonry-contracts'

/**
 * Bounds on incremental traffic sync, shared by the sync route and the doctor
 * checks so the discard cliff is stated once. A duplicated literal here would
 * drift from the route and make the health check quietly wrong about when data
 * starts being lost.
 */

// A watermark that drifted far behind (source idle while its schedule was
// paused/missing, or a drain that cannot keep up) would otherwise make the
// adaptive drain grind through days of sub-windows in a single sync. Clamp the
// start to at most this far before the sync instant. The skipped pre-cap span is
// surfaced as a warn, never silently dropped — a backfill recovers it.
export const VERCEL_MAX_SYNC_WINDOW_MS = 24 * 60 * 60_000

// Wall-clock budget for a single incremental Vercel sync's adaptive drain. The
// drain checks this before each sub-window pull; on hit it stops and reports how
// far it got, and the route commits that partial window + advances `lastSyncedAt`
// to it. Without this bound a dense or slow window runs for many minutes —
// timing out the caller and leaving an orphaned 'running' run.
export const DEFAULT_VERCEL_SYNC_DEADLINE_MS = 4 * 60_000

/** Floor/ceiling for the env override, so a typo cannot disable the bound. */
const MIN_VERCEL_SYNC_DEADLINE_MS = 30_000
const MAX_VERCEL_SYNC_DEADLINE_MS = 15 * 60_000

/**
 * How far back a single incremental sync can reach, per source type. A source
 * whose watermark falls past this stops being able to catch up: each sync
 * clamps its start forward and the skipped span is lost until backfilled.
 *
 * Only adapters with a bounded catch-up window appear here. Cursor-resumable
 * adapters (cloud-run, wordpress) can always resume from where they left off,
 * so they have no cliff and are absent by design rather than by omission.
 */
export const TRAFFIC_SOURCE_MAX_CATCHUP_MS: Partial<Record<TrafficSourceType, number>> = {
  [TrafficSourceTypes.vercel]: VERCEL_MAX_SYNC_WINDOW_MS,
}

/**
 * Resolve the per-sync drain budget from the environment.
 *
 * This exists because the drain rate is the only lever that decides whether a
 * source catches up or falls further behind, and until now it was reachable
 * only from tests. A source whose drain advances less wall-clock per sync than
 * the interval between syncs loses ground every cycle and eventually crosses
 * the discard cliff, so an operator needs to raise this without shipping code.
 *
 * Returns undefined when unset or unparseable, leaving the caller's default in
 * place. Values are clamped rather than rejected so a bad env cannot take the
 * bound off entirely.
 */
export function resolveVercelSyncDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.CANONRY_VERCEL_SYNC_DEADLINE_MS
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(MAX_VERCEL_SYNC_DEADLINE_MS, Math.max(MIN_VERCEL_SYNC_DEADLINE_MS, Math.trunc(parsed)))
}
