import { describe, expect, it } from 'vitest'
import { formatAutoSyncNotice, type SkillsAutoSyncResult } from '../src/skills-autosync.js'

/**
 * The notice exists to report the ONE thing auto-sync deliberately did not do:
 * replace a file the user edited. A silent refresh of a stale file is the
 * system working and must stay silent, or the line becomes noise and gets
 * ignored precisely when it matters.
 */
describe('formatAutoSyncNotice', () => {
  const base: SkillsAutoSyncResult = { ran: true, reason: 'version-changed', updated: [], conflicts: [] }

  it('says nothing when the sync did not run', () => {
    expect(formatAutoSyncNotice({ ...base, ran: false, reason: 'skipped' })).toBeNull()
  })

  it('says nothing when only stale files were refreshed', () => {
    expect(formatAutoSyncNotice({ ...base, updated: ['canonry/SKILL.md', 'aero/SKILL.md'] })).toBeNull()
  })

  it('reports preserved local edits, and names the recovery command', () => {
    const notice = formatAutoSyncNotice({ ...base, conflicts: ['canonry/SKILL.md'] })
    expect(notice).toMatch(/1 locally edited skill file /)
    expect(notice).toMatch(/skills install --user --force/)
  })

  it('pluralizes', () => {
    const notice = formatAutoSyncNotice({ ...base, conflicts: ['a.md', 'b.md'] })
    expect(notice).toMatch(/2 locally edited skill files/)
  })
})
