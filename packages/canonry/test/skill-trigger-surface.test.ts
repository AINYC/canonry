import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

/**
 * A skill is MODEL-DECIDED: nothing forces it to load, so the description and
 * when_to_use are the entire trigger surface. Both descriptions once omitted
 * `cnry`, the token an operator actually types, which is the single likeliest
 * phrase to appear in a request that should load the skill.
 */
const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../../../skills')

function frontmatter(skill: string): string {
  const raw = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8')
  const parts = raw.split('---')
  if (parts.length < 3) throw new Error(`${skill}: no frontmatter`)
  return parts[1]!
}

function field(fm: string, key: string): string {
  const m = new RegExp(`^${key}: ([\\s\\S]*?)(?=^\\w[\\w_]*:|\\Z)`, 'm').exec(fm)
  return m ? m[1]!.trim() : ''
}

describe.each(['canonry', 'aero'])('%s skill trigger surface', (skill) => {
  const fm = frontmatter(skill)

  it('names the CLI the operator actually types', () => {
    expect(fm).toMatch(/cnry/)
  })

  it('says WHEN to load, not just what the skill is', () => {
    // The trigger phrases have to live in `description`: the Agent Skills spec
    // allows six frontmatter fields and `when_to_use` is not one of them, which
    // plugin-bundle.test.ts enforces. Claude Code accepts it; the spec path
    // hard-errors, and this tree is bundled for both.
    expect(field(fm, 'description')).toMatch(/\b(use|load)\b/i)
  })

  it('keeps description inside the 1024-char cap the bundle test enforces', () => {
    const len = field(fm, 'description').length
    expect(len).toBeLessThanOrEqual(1024)
    expect(len).toBeGreaterThan(200)
  })

  it('does not declare when_to_use, which is invalid on the spec path', () => {
    expect(fm).not.toMatch(/^when_to_use:/m)
  })

  it('does not declare a top-level version, which is a hard validation error', () => {
    expect(fm).not.toMatch(/^version:/m)
  })

  it('does not declare paths, which LIMITS proactive loading rather than triggering it', () => {
    expect(fm).not.toMatch(/^paths:/m)
  })
})
