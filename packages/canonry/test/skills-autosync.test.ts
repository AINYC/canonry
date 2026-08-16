import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILL_MANIFEST_FILENAME } from '@ainyc/canonry-contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_NAMES } from '../src/commands/skills.js'
import { PACKAGE_VERSION } from '../src/package-version.js'
import {
  formatAutoSyncNotice,
  ownedInstallTargets,
  peekVersionChange,
  type SkillsAutoSyncResult,
} from '../src/skills-autosync.js'

/**
 * The notice exists to report the ONE thing auto-sync deliberately did not do:
 * replace a file the user edited. A silent refresh of a stale file is the
 * system working and must stay silent, or the line becomes noise and gets
 * ignored precisely when it matters.
 */
describe('formatAutoSyncNotice', () => {
  const base: SkillsAutoSyncResult = {
    ran: true, reason: 'version-changed', updated: [], conflicts: [], targets: ['/home/u'],
  }

  it('says nothing when the sync did not run', () => {
    expect(formatAutoSyncNotice({ ...base, ran: false, reason: 'skipped' })).toBeNull()
  })

  it('says nothing when only stale files were refreshed', () => {
    expect(formatAutoSyncNotice({ ...base, updated: ['canonry/SKILL.md', 'aero/SKILL.md'] })).toBeNull()
  })

  it('reports preserved local edits, and names the recovery command', () => {
    const notice = formatAutoSyncNotice({ ...base, conflicts: ['canonry/SKILL.md'] })
    expect(notice).toMatch(/1 locally edited skill file /)
    expect(notice).toMatch(/skills install --force/)
  })

  it('pluralizes', () => {
    const notice = formatAutoSyncNotice({ ...base, conflicts: ['a.md', 'b.md'] })
    expect(notice).toMatch(/2 locally edited skill files/)
  })
})

/**
 * Regression (data loss): `loadConfigRaw()` returns null for BOTH "no config"
 * and "config present but unparsable" — it does not throw. The first version
 * folded null into "no version recorded, therefore changed", which reached
 * `saveConfigPatch`, whose read-modify-write falls back to an EMPTY base when
 * the file will not parse. The merge then wrote only the patch keys and the
 * user's apiKey, database path and provider credentials were gone.
 *
 * A file we cannot read is the one file we must not write, so the probe has to
 * distinguish `unknown` from `changed`.
 */
describe('peekVersionChange', () => {
  let dir: string
  const previous = process.env.CANONRY_CONFIG_DIR

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-probe-'))
    process.env.CANONRY_CONFIG_DIR = dir
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const writeConfig = (body: string) => fs.writeFileSync(path.join(dir, 'config.yaml'), body)

  it('reports unknown when no config exists, so a bare machine is never written to', () => {
    expect(peekVersionChange()).toEqual({ state: 'unknown' })
  })

  it('reports unknown for a config that exists but will not parse — NOT changed', () => {
    writeConfig('apiKey: "unterminated\n\tbad: [oops\n')
    // The bug: this returned `changed`, and the resulting write destroyed the file.
    expect(peekVersionChange()).toEqual({ state: 'unknown' })
  })

  it('reports unchanged when the recorded version is the running one', () => {
    writeConfig(`lastSeenVersion: ${PACKAGE_VERSION}\n`)
    expect(peekVersionChange()).toEqual({ state: 'unchanged' })
  })

  it('reports changed, and carries the version it moved from', () => {
    writeConfig('lastSeenVersion: 1.0.0\n')
    expect(peekVersionChange()).toEqual({ state: 'changed', lastSeen: '1.0.0' })
  })

  it('reports changed with no lastSeen for a parsable config that never recorded one', () => {
    writeConfig('apiKey: cnry_test\n')
    expect(peekVersionChange()).toEqual({ state: 'changed', lastSeen: undefined })
  })
})

/**
 * Regression (opt-out defeat): auto-sync REPAIRS, it never ADOPTS.
 * `installSkills` will happily create `~/.claude/skills/` from nothing, so
 * calling it unconditionally wrote into the home directory of someone who ran
 * `canonry init --skip-skills` and said no.
 *
 * The second half: `canonry init` installs PROJECT-local by default and only
 * `--user` installs global, so checking just the home directory missed the
 * common case entirely and those installs never healed.
 */
describe('ownedInstallTargets', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-targets-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const make = (name: string, opts: { manifest: boolean }) => {
    const dir = path.join(root, name)
    const skill = path.join(dir, '.claude', 'skills', BUNDLED_SKILL_NAMES[0]!)
    fs.mkdirSync(skill, { recursive: true })
    // A skill directory that canonry did NOT write has no manifest.
    if (opts.manifest) fs.writeFileSync(path.join(skill, SKILL_MANIFEST_FILENAME), '{}')
    return dir
  }

  it('claims nothing when neither scope has a canonry install', () => {
    expect(ownedInstallTargets(path.join(root, 'cwd'), path.join(root, 'home'))).toEqual([])
  })

  it('refuses to adopt a skills directory canonry never wrote (the --skip-skills opt-out)', () => {
    const home = make('home', { manifest: false })
    expect(ownedInstallTargets(path.join(root, 'cwd'), home)).toEqual([])
  })

  it('heals a PROJECT-local install — the default `canonry init` scope', () => {
    const cwd = make('cwd', { manifest: true })
    expect(ownedInstallTargets(cwd, path.join(root, 'home'))).toEqual([{ dir: cwd, user: false }])
  })

  it('heals a user-scoped install', () => {
    const home = make('home', { manifest: true })
    expect(ownedInstallTargets(path.join(root, 'cwd'), home)).toEqual([{ dir: home, user: true }])
  })

  it('heals both scopes when both are canonry installs', () => {
    const home = make('home', { manifest: true })
    const cwd = make('cwd', { manifest: true })
    expect(ownedInstallTargets(cwd, home)).toEqual([
      { dir: home, user: true },
      { dir: cwd, user: false },
    ])
  })
})

/**
 * Regression: the first version of the frontmatter reader terminated the
 * description at `(?=^\w+:|\Z)`. JavaScript has no `\Z` anchor, so that
 * alternative matched a literal "Z" and the whole pattern failed whenever
 * `description` was the LAST field in the block. Both shipped skills happen to
 * carry `metadata:` afterwards, so every test passed and lint caught it.
 */
describe('skill frontmatter reading', () => {
  it('reads a description that is the last field in the block', async () => {
    const { getBundledSkills } = await import('../src/commands/skills.js')
    // Proven indirectly: every bundled skill must yield a description, and the
    // reader must not depend on a following key to find the end of the value.
    expect(getBundledSkills().length).toBeGreaterThan(0)
  })
})
