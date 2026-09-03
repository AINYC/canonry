/**
 * The visibility core: contracts, the target/brand matcher, the evidence
 * runner, share of voice, and the Gemini adapter.
 *
 * Nothing here reads environment, storage, or HTTP state. Only the Gemini
 * adapter makes provider calls, and it is handed its credential; the host owns
 * credentials, quotas, and scheduling.
 */
export * from './visibility/contracts.js'
export * from './visibility/runtime.js'
export * from './visibility/brand.js'
export * from './visibility/runner.js'
export * from './visibility/share.js'
export * from './visibility/mention-extract.js'
export * from './visibility/gemini.js'
export * from './visibility/gemini-probe.js'

/**
 * The instrument's own output and its port, re-exported here because that is
 * what they are: a `VisibilityReport` is what a probe PRODUCES, not what a
 * product stores. They are declared in `runtime/types.ts`, which `./jobs` also
 * re-exports, so both specifiers keep resolving to one declaration and no
 * consumer has to move.
 *
 * Named rather than starred: `runtime/types.ts` also declares the display-safe
 * `VisibilitySource`, and a second star export of that name would be ambiguous
 * and silently drop the adapter-facing one this barrel already owns.
 */
export type {
  VisibilityEvidence,
  VisibilityProbeInput,
  VisibilityProbePort,
  VisibilityReport,
  VisibilitySummary,
} from './runtime/types.js'
