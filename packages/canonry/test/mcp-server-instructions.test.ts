import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

/**
 * The `instructions` string is the only activation channel that is both
 * automatic (the client receives it at initialize, the model does not choose
 * to load it) and impossible to make stale (it ships inside the running
 * engine). Two properties have to hold or it stops working.
 */
const SOURCE = fs.readFileSync(
  path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../src/mcp/server.ts'),
  'utf-8',
)

function instructions(): string {
  const m = /const SERVER_INSTRUCTIONS = `([\s\S]*?)`\n/.exec(SOURCE)
  if (!m) throw new Error('SERVER_INSTRUCTIONS not found')
  return m[1]!
}

describe('MCP server instructions', () => {
  it('is wired into the McpServer constructor', () => {
    expect(SOURCE).toMatch(/instructions:\s*SERVER_INSTRUCTIONS/)
  })

  it('stays under the 2KB Claude Code truncates at', () => {
    expect(Buffer.byteLength(instructions(), 'utf-8')).toBeLessThan(2048)
  })

  it('points at the skill rather than replacing it', () => {
    expect(instructions()).toMatch(/canonry.*skill/i)
  })

  it('carries the mention/cited distinction, the one error that yields a wrong number', () => {
    const text = instructions()
    expect(text).toMatch(/mentioned/)
    expect(text).toMatch(/cited/)
    expect(text).toMatch(/never compute one from the other/i)
  })

  it('states the approval rule for quota-spending work', () => {
    expect(instructions()).toMatch(/approval/i)
  })
})
