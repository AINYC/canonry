/**
 * The brand-perception core: the branded query planner, the verdict extractor
 * and its arbiter, source typing, aggregation, and the Gemini host adapter.
 *
 * A separate instrument from `./visibility`, not a mode of it. Perception asks
 * BRANDED questions and reports what the engine says; visibility asks non-brand
 * ones and reports whether the brand appears at all. They share the probe
 * runner and the brand matcher, and nothing else — never a denominator, a rate,
 * or a table.
 *
 * Nothing here reads environment, storage, or HTTP state. Only the planner and
 * the verdict extractor make provider calls, and both are handed their
 * credential.
 */
export * from './perception/types.js'
export * from './perception/planner.js'
export * from './perception/verdict-extract.js'
export * from './perception/source-type.js'
export * from './perception/summary.js'
export * from './perception/gemini-perception-probe.js'
