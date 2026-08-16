import { installSkills } from './commands/skills.js'
import { configExists, loadConfigRaw, saveConfigPatch } from './config.js'
import { PACKAGE_VERSION } from './package-version.js'

/**
 * Keep the skills already installed on this machine in step with the engine
 * that is actually running.
 *
 * The problem this solves: `canonry skills install` copies the bundled skill
 * trees onto disk, and nothing ever re-runs it. Upgrade the engine and the
 * agent keeps reading a playbook for the previous version — it will cite a flag
 * that no longer exists, or miss a command that now does. Unlike a stale shell
 * completion, which fails loudly and harmlessly (TAB does nothing), a stale
 * playbook fails silently and confidently: the agent asserts something wrong
 * and the cost lands as a failed run.
 *
 * Why not a package-manager hook: npm's `allowScripts` is off by default and
 * a global install cannot approve scripts at all, so a `postinstall` would fail
 * hardest for exactly the people most likely to be running an agent in a
 * hardened environment. Healing on the next invocation needs no package-manager
 * cooperation, and additionally covers hand-deleted files, a partial install,
 * and a `$HOME` shared across machines — none of which a version bump implies.
 */

/** Re-verify at most this often when the version has NOT changed. */
const DEFAULT_SYNC_INTERVAL_SECONDS = 24 * 60 * 60

/**
 * Has the running build changed since the last recorded invocation?
 *
 * Split out of `detectAndTrackUpgrade` deliberately. That function opens with
 * `if (!isTelemetryEnabled()) return`, so on a telemetry-disabled install the
 * version was never recorded and an upgrade was never noticed. Tying a
 * correctness behaviour to an analytics opt-in means the users who opt out get
 * a quietly worse product. This probe is analytics-free; the telemetry path
 * still emits `cli.upgraded` on top of it.
 *
 * Returns the previously seen version, or null when unchanged / unknowable.
 * Does NOT write: the caller records the new version once the work it gates has
 * actually run, so a crash mid-heal retries rather than marking itself done.
 */
export function peekVersionChange(): { lastSeen: string | undefined } | null {
  if (!configExists()) return null
  try {
    const raw = loadConfigRaw()
    const lastSeen = raw?.lastSeenVersion
    if (lastSeen === PACKAGE_VERSION) return null
    return { lastSeen }
  } catch {
    return null
  }
}

function syncIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CANONRY_SKILLS_SYNC_SECS
  if (!raw) return DEFAULT_SYNC_INTERVAL_SECONDS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SYNC_INTERVAL_SECONDS
}

function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CANONRY_NO_AUTO_SKILLS_SYNC
  return raw === '1' || raw === 'true'
}

export interface SkillsAutoSyncResult {
  ran: boolean
  reason: 'version-changed' | 'interval-elapsed' | 'skipped'
  /** Relative paths refreshed because they were stale against the new bundle. */
  updated: string[]
  /** Relative paths left alone because they carry local edits. */
  conflicts: string[]
}

/**
 * Refresh only the files that are STALE against the bundled copy.
 *
 * Three properties, all load-bearing:
 *
 * 1. It never installs where canonry has not installed before. `installSkills`
 *    reconciles against the manifest it wrote, so a directory with no manifest
 *    is not ours to touch. Re-verifying a copy we placed is a different act
 *    from writing into someone's home for the first time, and only the latter
 *    needs their consent (it already has it, via `skills install`).
 * 2. It never overwrites a local edit. `installSkills` classifies each file as
 *    missing / unchanged / stale / edited and, without `--force`, replaces only
 *    the first two. We deliberately do not pass `force`.
 * 3. It is silent on success. A heal that had nothing to say says nothing.
 */
export async function autoSyncSkills(env: NodeJS.ProcessEnv = process.env): Promise<SkillsAutoSyncResult> {
  const skipped: SkillsAutoSyncResult = { ran: false, reason: 'skipped', updated: [], conflicts: [] }
  if (isDisabled(env)) return skipped
  if (!configExists()) return skipped

  const versionChange = peekVersionChange()
  let reason: SkillsAutoSyncResult['reason'] | null = versionChange ? 'version-changed' : null

  if (!reason) {
    // A version bump is not the only way a copy goes wrong, so also re-verify
    // on a timer. The comparison is bundled-file hash vs installed-file hash,
    // entirely local, so it costs no network and can run this often safely.
    const intervalSeconds = syncIntervalSeconds(env)
    if (intervalSeconds === 0) return skipped
    try {
      const raw = loadConfigRaw()
      const last = raw?.lastSkillsVerifiedAt ? Date.parse(raw.lastSkillsVerifiedAt) : 0
      const elapsed = (Date.now() - (Number.isFinite(last) ? last : 0)) / 1000
      if (elapsed < intervalSeconds) return skipped
      reason = 'interval-elapsed'
    } catch {
      return skipped
    }
  }

  const updated: string[] = []
  const conflicts: string[] = []

  try {
    const summary = await installSkills({ user: true })
    for (const result of summary.results) {
      for (const p of result.updated ?? []) updated.push(p)
      for (const p of result.conflicts ?? []) conflicts.push(p)
    }
  } catch {
    // Never let a skills refresh break the command the user actually ran.
    return skipped
  }

  try {
    saveConfigPatch({
      lastSeenVersion: PACKAGE_VERSION,
      lastSkillsVerifiedAt: new Date().toISOString(),
    })
  } catch {
    // A failed write just means we re-check next time. Not worth surfacing.
  }

  return { ran: true, reason, updated, conflicts }
}

/**
 * The one line worth printing, or null.
 *
 * Only local edits are worth a word: those are the files we deliberately did
 * NOT refresh, so the user is now running an engine whose playbook they have
 * diverged from. A silent stale-file refresh is the system working.
 */
export function formatAutoSyncNotice(result: SkillsAutoSyncResult): string | null {
  if (!result.ran || result.conflicts.length === 0) return null
  const count = result.conflicts.length
  return `canonry: ${count} locally edited skill file${count === 1 ? '' : 's'} kept as-is `
    + `(engine is now v${PACKAGE_VERSION}). Run "canonry skills install --user --force" to take the new version.`
}
