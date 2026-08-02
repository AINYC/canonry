/**
 * The last thing between a view-only account and a request that was always
 * going to be refused.
 *
 * The dashboard has dozens of controls that change something, and wrapping each
 * one is a discipline that will eventually be missed. This sits underneath, in
 * the mutation layer every one of them goes through, so a control that slips
 * past the wrapper still fails in the dashboard with a sentence that makes
 * sense — instead of firing, waiting, and surfacing a 403.
 *
 * It is NOT the security boundary. The server refuses the same request whether
 * or not this ran. This is about not lying to somebody about what their account
 * can do.
 */
import type { AccountState } from '../contexts/account-context.js'
import { VIEW_ONLY_LABEL } from '../contexts/account-context.js'

/** Thrown when a view-only account reaches a mutation. Carries the plain reason. */
export class ViewOnlyError extends Error {
  constructor() {
    super(VIEW_ONLY_LABEL)
    this.name = 'ViewOnlyError'
  }
}

/**
 * Refuse the caller when the signed-in account cannot write.
 *
 * Passes for an administrator and for an install with no accounts at all —
 * which is every install that existed before sign-in did.
 */
export function assertCanWrite(account: AccountState): void {
  if (account.canWrite) return
  throw new ViewOnlyError()
}
