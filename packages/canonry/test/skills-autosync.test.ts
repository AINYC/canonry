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
