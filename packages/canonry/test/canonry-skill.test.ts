import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface CanonrySkillFrontmatter {
  compatibility?: unknown
  metadata?: { agent?: unknown }
}

interface CanonryAgentMetadata {
  requires?: { bins?: unknown }
  install?: Array<{ package?: unknown; command?: unknown }>
}

describe('canonry skill metadata', () => {
  it('requires the global package and keeps initialization in the operator terminal', () => {
    const skillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const body = fs.readFileSync(skillPath, 'utf-8')
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(body)
    expect(frontmatterMatch).not.toBeNull()
    const frontmatter = parse(frontmatterMatch![1]!) as CanonrySkillFrontmatter
    expect(frontmatter.compatibility).toContain('Node.js 22.14+')
    expect(typeof frontmatter.metadata?.agent).toBe('string')
    const agent = JSON.parse(frontmatter.metadata!.agent as string) as CanonryAgentMetadata

    expect(agent.requires?.bins).toEqual(['canonry'])
    expect(agent.install).toEqual(expect.arrayContaining([
      expect.objectContaining({
        package: '@canonry/canonry',
        command: 'npm install -g @canonry/canonry',
      }),
    ]))
    expect(body).not.toContain('"command": "npx @canonry/canonry@latest init"')
    expect(body).toContain('cnry init --skip-skills --skip-mcp')
    expect(agent.install).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ package: 'canonry' }),
    ]))
  })
})
