import type { SetupState } from './setup-state.js'

/**
 * Commands where the nudge would be noise: the ones that ARE the setup path,
 * the ones that manage it, and unknown input (the usage error is the message
 * there). Matched on the registered command root, so `settings.provider`
 * and every other `settings.*` stay exempt together.
 */
const NUDGE_EXEMPT_ROOTS = new Set([
  'init',
  'serve',
  'bootstrap',
  'settings',
  'telemetry',
  'unknown',
])

/**
 * One stderr line for the install that is going nowhere.
 *
 * Half of new installs run `init` and never another command, and the largest
 * identified reason is running without a provider. There is no re-engagement
 * channel for an anonymous CLI, so the only place to catch a stalled setup is
 * the next command the user happens to run, whatever it is. This is that
 * touch: every human-mode command on an unconfigured install ends with one
 * line naming the blocker and the two ways to clear it.
 *
 * Deliberately unconditional while the state persists (no cooldown): an
 * install with zero providers cannot run a sweep at all, so the line is load
 * bearing, not promotional. It goes to stderr, and only when stderr is a TTY,
 * for the same reason as the upgrade banner: it must never pollute
 * `--format json` output or interleave into captured logs.
 */
export function buildSetupNudgeLine(input: {
  /** Resolved registry path, e.g. `status` or `settings.provider`. */
  command: string
  machineFormat: boolean
  stderrIsTTY: boolean
  /**
   * LAZY, and the laziness is a contract. Reading setup state opens config
   * and the database, which the CLI's own tests pin as forbidden for
   * telemetry-control commands and disabled-telemetry runs. The cheap gates
   * above the read make sure it only ever happens for a human-mode command
   * that could actually show the line.
   */
  getSetupState: () => SetupState | undefined
}): string | null {
  if (input.machineFormat || !input.stderrIsTTY) return null
  const [root = input.command] = input.command.split('.')
  if (NUDGE_EXEMPT_ROOTS.has(root)) return null
  // No setup state means no config at all: pre-init, where `init` itself is
  // the guidance and this line would be premature.
  const setupState = input.getSetupState()
  if (!setupState) return null
  if (setupState.provider_count > 0) return null
  return (
    '\n→ No AI provider is configured, so answer sweeps cannot run yet.\n' +
    '  Finish setup in the dashboard:  canonry serve\n' +
    '  Or by CLI:  canonry settings provider gemini --api-key <key>\n'
  )
}
