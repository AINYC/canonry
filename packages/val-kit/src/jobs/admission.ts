/**
 * Host-agnostic admission and lease machinery for a public check.
 *
 * Everything here is generic: it names no product, no phase, and no signal.
 * The orchestration that decides WHAT a check measures — the phase runner, its
 * work budget, the output sanitizers, and every sentence a visitor reads —
 * stays with the val that owns that product surface.
 */
import type { CheckRecord, JobDispatcher, PublicCheckRunner } from '../runtime/types.js'

/** Shared with admission so a new paid check holds capacity before quota spend. */
export const PUBLIC_CHECK_EXECUTION_LEASE_NAME = 'public-check-execution'
export const PUBLIC_CHECK_EXECUTION_LEASE_MS = 55_000

/** Executes in the request lifetime. Val Town does not guarantee fire-and-forget work after a response. */
export function createRequestBoundDispatcher(runner: PublicCheckRunner): JobDispatcher {
  return { dispatch: (checkId, dispatchOptions) => runner.run(checkId, dispatchOptions) }
}

/**
 * A fresh queued record. `TResult` is the product's result schema; the record
 * starts with `result: null`, so the parameter is named by the caller rather
 * than inferred — `newCheckRecord<CheckResult>({ ... })`.
 */
export function newCheckRecord<TResult = unknown>(
  input: { id: string; fingerprint: string; domain: string; now: Date; userQueries?: readonly string[] },
): CheckRecord<TResult> {
  const timestamp = input.now.toISOString()
  return {
    id: input.id,
    fingerprint: input.fingerprint,
    domain: input.domain,
    userQueries: [...(input.userQueries ?? [])],
    status: 'queued',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
  }
}
