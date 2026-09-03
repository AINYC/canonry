/**
 * Everything the kit exposes, in one import.
 *
 * Prefer the subpaths (`@canonry/val-kit/visibility`, `/jobs`, …) in a val:
 * they say which part of the seam a file depends on, and they keep an unused
 * group out of the module graph.
 */
export * from './visibility.js'
export * from './security.js'
export * from './storage.js'
export * from './jobs.js'
export * from './mcp.js'
export * from './ui.js'
export * from './config.js'

/**
 * `VisibilitySource` is declared twice in the seam, with two different shapes:
 * the adapter-facing source in `visibility/contracts.ts` (optional title, plus
 * the provider-attributed `domain`) and the display-safe source stored on a
 * check record in `runtime/types.ts`. Two star re-exports of one name are
 * AMBIGUOUS, which drops the name from this barrel entirely rather than
 * failing, so the winner is named here: the adapter shape, which is the one a
 * provider integration writes. The record shape keeps its own subpath and is
 * imported from `@canonry/val-kit/jobs`.
 */
export type { VisibilitySource } from './visibility/contracts.js'
