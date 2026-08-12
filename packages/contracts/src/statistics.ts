/**
 * Small, exact statistical helpers shared across the platform.
 *
 * Kept in `contracts` (pure, no I/O) per the Shared Utilities rule so the
 * report, the API, and the CLI all attach the SAME interval to a proportion
 * instead of each hand-rolling one — see `visibility-compare`, which reports
 * every monthly rate as `point (Wilson low–high)`.
 */

import { z } from 'zod'

export interface ConfidenceInterval {
  /** Lower bound of the interval, clamped to [0, 1]. */
  low: number
  /** Upper bound of the interval, clamped to [0, 1]. */
  high: number
}

/** Rounds to `dp` decimal places (default 4) with no negative-zero. */
function round(value: number, dp = 4): number {
  const f = 10 ** dp
  return (Math.round(value * f) + 0) / f
}

/**
 * Wilson score interval for a binomial proportion — the display default for
 * mention / cited / share-of-voice rates.
 *
 * Preferred over the normal (Wald) interval because it behaves at the extremes
 * these AEO datasets actually hit: at `successes = 0` it returns `[0, upper]`
 * rather than the degenerate `[0, 0]` Wald gives, and it never overshoots
 * `[0, 1]`. Default `z = 1.96` (95%).
 *
 * Returns `null` when `n === 0` — a proportion over no samples is undefined, and
 * a caller must render "no data", not a fabricated interval.
 *
 * Caveat for the caller: this treats the `n` snapshots as independent Bernoulli
 * draws. AEO snapshots CLUSTER within query and sweep, so the true interval is
 * wider; the rigorous version is a cluster bootstrap over sweeps, which is only
 * meaningful at K >= 5 sweeps. Wilson is the honest, reproducible display floor.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): ConfidenceInterval | null {
  if (!Number.isFinite(n) || n <= 0) return null
  const s = Math.max(0, Math.min(successes, n))
  const p = s / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    low: round(Math.max(0, center - margin)),
    high: round(Math.min(1, center + margin)),
  }
}

/**
 * Least-squares fit of one evenly-spaced series, expressed so a caller can draw
 * it without re-deriving anything.
 *
 * `slope` is in the series' own units PER STEP — for a daily series that is
 * "per day", which is the number worth reporting; the caller multiplies by
 * `n - 1` itself if it wants the whole-window change. `start` / `end` are the
 * fitted values at the first and last index, i.e. the two endpoints of the
 * trend line, so a chart draws it as one straight segment with no per-point
 * evaluation.
 */
export const linearTrendSchema = z.object({
  /** Change in the fitted value per one-index step. */
  slope: z.number(),
  /** Fitted value at index 0. */
  intercept: z.number(),
  /** Coefficient of determination in [0, 1]. `1` for a series with no variance. */
  r2: z.number(),
  /** Fitted value at the first index. */
  start: z.number(),
  /** Fitted value at the last index. */
  end: z.number(),
  /** Count of finite observations the fit used (not the series length). */
  n: z.number(),
})
export type LinearTrend = z.infer<typeof linearTrendSchema>

/**
 * Ordinary-least-squares trend over a series indexed by position.
 *
 * Deliberately generic: it takes bare numbers, not dated points, so any
 * evenly-spaced series (GSC clicks per day, sweep mention rate per run, spend
 * per week) fits with the same call. The INDEX is the x value, so gaps are
 * handled by passing `null` — the point is skipped while the surviving points
 * keep their true positions, which is what a daily series with a missing day
 * needs. Dropping the entry instead would silently compress the x-axis and
 * bend the line.
 *
 * Returns `null` when fewer than two finite observations survive — a line
 * through one point is undefined, and a caller must render "no trend" rather
 * than a fabricated slope of 0. Two surviving observations always sit at two
 * DIFFERENT indices (the index is the array position), so the x-variance is
 * non-zero whenever the fit runs and there is no degenerate-denominator case
 * to guard.
 *
 * `r2` is `1` when the series has no variance (a constant series IS perfectly
 * described by its flat fit); it is otherwise `1 - ssRes / ssTot`, clamped to
 * `[0, 1]` so floating-point residue cannot emit `-0.0000001`.
 */
export function linearTrend(values: readonly (number | null | undefined)[]): LinearTrend | null {
  const points: { x: number; y: number }[] = []
  for (const [index, value] of values.entries()) {
    if (typeof value === 'number' && Number.isFinite(value)) points.push({ x: index, y: value })
  }
  const n = points.length
  if (n < 2) return null

  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n
  let sxx = 0
  let sxy = 0
  for (const p of points) {
    sxx += (p.x - meanX) ** 2
    sxy += (p.x - meanX) * (p.y - meanY)
  }
  const slope = sxy / sxx
  const intercept = meanY - slope * meanX

  let ssRes = 0
  let ssTot = 0
  for (const p of points) {
    ssRes += (p.y - (slope * p.x + intercept)) ** 2
    ssTot += (p.y - meanY) ** 2
  }
  const r2 = ssTot === 0 ? 1 : Math.min(1, Math.max(0, 1 - ssRes / ssTot))

  const firstX = points[0]!.x
  const lastX = points[n - 1]!.x
  return {
    slope: round(slope),
    intercept: round(intercept),
    r2: round(r2),
    start: round(slope * firstX + intercept),
    end: round(slope * lastX + intercept),
    n,
  }
}
