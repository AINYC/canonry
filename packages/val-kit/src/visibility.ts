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
