/**
 * The check job: its runtime contracts, its record identity and lifetime
 * rules, and the generic admission/lease machinery a host runs them through.
 *
 * The phase orchestration that decides what a check MEASURES stays with the
 * val that owns that product surface.
 */
export * from './runtime/types.js'
export * from './runtime/records.js'
export * from './jobs/admission.js'
