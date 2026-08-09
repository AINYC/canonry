import { describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  triggerSiteAudit: vi.fn(),
  getTechnicalAeoCrawl: vi.fn(),
  getTechnicalAeoCrawlPages: vi.fn(),
  getTechnicalAeoStructure: vi.fn(),
  getTechnicalAeoInternalLinks: vi.fn(),
  getTechnicalAeoInternalLinkNeighbors: vi.fn(),
  getTechnicalAeoDeadLinks: vi.fn(),
}))

vi.mock('../src/client.js', () => ({
  createApiClient: () => mocked,
}))

import { TECHNICAL_AEO_CLI_COMMANDS } from '../src/cli-commands/technical-aeo.js'
import { technicalAeoDeadLinks } from '../src/commands/technical-aeo.js'

function command(path: string[]) {
  const spec = TECHNICAL_AEO_CLI_COMMANDS.find((candidate) => candidate.path.join(' ') === path.join(' '))
  expect(spec, path.join(' ')).toBeTruthy()
  return spec!
}

function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let output = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk)
    return true
  })
  return {
    run: fn().finally(() => spy.mockRestore()),
    lines: () => output.split('\n').filter(Boolean),
  }
}

describe('Technical AEO full-crawl CLI', () => {
  it('keeps dead-link checks off unless --check-dead-links is explicitly supplied', async () => {
    mocked.triggerSiteAudit.mockResolvedValue({ runId: 'run-1', status: 'queued' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'run']).run({
        positionals: ['acme'],
        values: { 'max-pages': '50000', 'max-edges': '1000000', 'max-depth': '12', wait: false },
        format: 'json',
        dryRun: false,
      })
    } finally {
      log.mockRestore()
    }

    expect(mocked.triggerSiteAudit).toHaveBeenLastCalledWith('acme', {
      sitemapUrl: undefined,
      limit: undefined,
      maxPages: 50_000,
      maxEdges: 1_000_000,
      maxDepth: 12,
      checkDeadLinks: false,
    })
  })

  it('registers bounded graph reads under Technical AEO', () => {
    expect(TECHNICAL_AEO_CLI_COMMANDS.map((spec) => spec.path.join(' '))).toEqual(expect.arrayContaining([
      'technical-aeo crawl',
      'technical-aeo crawl-pages',
      'technical-aeo structure',
      'technical-aeo links',
      'technical-aeo links neighbors',
      'technical-aeo dead-links',
    ]))
  })

  it('requires a page selector before calling the bounded neighbors endpoint', async () => {
    await expect(command(['technical-aeo', 'links', 'neighbors']).run({
      positionals: ['acme'],
      values: {},
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--node-key or --url is required',
    })
    expect(mocked.getTechnicalAeoInternalLinkNeighbors).not.toHaveBeenCalled()
  })

  it('writes a JSONL header for completed dead-link checks with zero findings', async () => {
    mocked.getTechnicalAeoDeadLinks.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      state: 'complete',
      checkDeadLinks: true,
      checked: 12,
      found: 0,
      total: 0,
      nextCursor: null,
      deadLinks: [],
    })

    const output = captureStdout(() => technicalAeoDeadLinks('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-dead-links-header',
        project: 'acme',
        runId: 'run-1',
        state: 'complete',
        checkDeadLinks: true,
        checked: 12,
        found: 0,
        total: 0,
        nextCursor: null,
      },
    ])
  })
})
