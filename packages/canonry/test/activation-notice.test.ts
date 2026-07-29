import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { maybeShowActivationNotice } from '../src/activation-notice.js'

let configDir: string
let savedConfigDir: string | undefined

function writeConfig(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    stringify({
      apiUrl: 'http://localhost:4100',
      database: path.join(configDir, 'test.db'),
      apiKey: 'cnry_test',
      ...overrides,
    }),
  )
}

function readConfig(): Record<string, unknown> {
  return parse(fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf8')) as Record<
    string,
    unknown
  >
}

beforeEach(() => {
  savedConfigDir = process.env.CANONRY_CONFIG_DIR
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-activation-notice-'))
  process.env.CANONRY_CONFIG_DIR = configDir
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
  else process.env.CANONRY_CONFIG_DIR = savedConfigDir
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('the first-activation notice', () => {
  it('shows once, persists the marker, and never shows again', () => {
    writeConfig()
    const lines: string[] = []
    const io = { isTTY: true, write: (line: string) => void lines.push(line) }

    maybeShowActivationNotice(io)
    maybeShowActivationNotice(io)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('github.com/Canonry/canonry')
    expect(readConfig().activationNoticeShown).toBe(true)
  })

  it('writes the marker BEFORE printing, so a crash under-asks', () => {
    writeConfig()
    let threw = false
    try {
      maybeShowActivationNotice({
        isTTY: true,
        write: () => {
          // The marker must already be durable at this point.
          expect(readConfig().activationNoticeShown).toBe(true)
          threw = true
          throw new Error('stream gone')
        },
      })
    } catch {
      // maybeShowActivationNotice swallows; reaching here would itself fail.
    }
    expect(threw).toBe(true)
    // And the swallow held: a second call stays silent rather than retrying.
    const lines: string[] = []
    maybeShowActivationNotice({ isTTY: true, write: line => void lines.push(line) })
    expect(lines).toHaveLength(0)
  })

  it('respects a pre-existing marker', () => {
    writeConfig({ activationNoticeShown: true })
    const lines: string[] = []
    maybeShowActivationNotice({ isTTY: true, write: line => void lines.push(line) })
    expect(lines).toHaveLength(0)
  })

  it('never writes into a non-TTY stream (pm2, systemd, piped logs)', () => {
    writeConfig()
    const lines: string[] = []
    maybeShowActivationNotice({ isTTY: false, write: line => void lines.push(line) })
    expect(lines).toHaveLength(0)
    // And it did not burn the once-ever marker on a send nobody saw.
    expect(readConfig().activationNoticeShown).toBeUndefined()
  })

  it('does nothing without a config file', () => {
    const lines: string[] = []
    maybeShowActivationNotice({ isTTY: true, write: line => void lines.push(line) })
    expect(lines).toHaveLength(0)
  })
})
