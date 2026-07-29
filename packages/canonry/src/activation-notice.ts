import { loadConfigRaw, saveConfigPatch } from './config.js'

/**
 * The one thing Canonry ever asks for, shown at the one moment it has earned
 * the right to ask.
 *
 * There are ~50 installs for every GitHub star, and the activated cohort is
 * already larger than the star count, so the users who could vouch for the
 * project outnumber the ones who have. They are also unreachable: telemetry is
 * anonymous by design, so the only channel to an activated user is the terminal
 * they are looking at when their first sweep lands.
 *
 * ONCE, EVER. The marker is written BEFORE the line is printed, so a crash
 * between the two under-asks rather than over-asks. It is a config field, not
 * telemetry: it must work identically for users who opted out of tracking,
 * and it is their machine's memory of having been asked, not ours.
 *
 * TTY-gated so a supervised server (pm2, systemd) never writes a marketing
 * line into production logs. Best-effort throughout: no failure here may
 * surface anywhere near a run.
 */
const ACTIVATION_NOTICE =
  '\n★ First sweep finished. Your AI visibility baseline is in the dashboard.\n' +
  '  If Canonry is useful, a GitHub star helps others find it:\n' +
  '  https://github.com/Canonry/canonry\n\n'

export function maybeShowActivationNotice(
  io: {
    isTTY?: boolean
    write?: (line: string) => void
  } = {},
): void {
  const isTTY = io.isTTY ?? Boolean(process.stderr.isTTY)
  const write = io.write ?? ((line: string) => process.stderr.write(line))
  try {
    if (!isTTY) return
    const raw = loadConfigRaw()
    if (!raw || raw.activationNoticeShown === true) return
    saveConfigPatch({ activationNoticeShown: true })
    write(ACTIVATION_NOTICE)
  } catch {
    // No config, unwritable config, weird stream: all mean "do not ask".
  }
}
