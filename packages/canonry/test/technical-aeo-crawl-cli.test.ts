import { describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  triggerSiteAudit: vi.fn(),
  getTechnicalAeoCrawl: vi.fn(),
  getTechnicalAeoCrawlPages: vi.fn(),
  getTechnicalAeoStructure: vi.fn(),
  getTechnicalAeoInternalLinks: vi.fn(),
  getTechnicalAeoInternalLinkNeighbors: vi.fn(),
  getTechnicalAeoDeadLinks: vi.fn(),
  getSiteHealthSubgraph: vi.fn(),
  getSiteHealthPath: vi.fn(),
  getSiteHealthChanges: vi.fn(),
}))

vi.mock('../src/client.js', () => ({
  createApiClient: () => mocked,
}))

import { TECHNICAL_AEO_CLI_COMMANDS } from '../src/cli-commands/technical-aeo.js'
import {
  technicalAeoChanges,
  technicalAeoCrawlPages,
  technicalAeoDeadLinks,
  technicalAeoInternalLinks,
  technicalAeoStructure,
} from '../src/commands/technical-aeo.js'

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
  it('leaves omitted budgets for the API to normalize into the shared default identity', async () => {
    mocked.triggerSiteAudit.mockResolvedValue({ runId: 'run-defaults', status: 'queued' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'run']).run({
        positionals: ['acme'],
        values: { wait: false },
        format: 'json',
        dryRun: false,
      })
    } finally {
      log.mockRestore()
    }

    expect(mocked.triggerSiteAudit).toHaveBeenLastCalledWith('acme', expect.objectContaining({
      limit: undefined,
      maxPages: undefined,
      maxEdges: undefined,
      checkDeadLinks: false,
    }))
  })

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

  it('registers bounded graph reads under Technical AEO and Site Health aliases', () => {
    expect(TECHNICAL_AEO_CLI_COMMANDS.map((spec) => spec.path.join(' '))).toEqual(expect.arrayContaining([
      'technical-aeo crawl',
      'technical-aeo crawl-pages',
      'technical-aeo structure',
      'technical-aeo links',
      'technical-aeo links neighbors',
      'technical-aeo dead-links',
      'technical-aeo subgraph',
      'technical-aeo path',
      'technical-aeo changes',
      'site-health overview',
      'site-health pages',
      'site-health structure',
      'site-health links',
      'site-health neighbors',
      'site-health dead-links',
      'site-health subgraph',
      'site-health path',
      'site-health changes',
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

  it('uses Site Health usage in alias handler errors', async () => {
    await expect(command(['site-health', 'path']).run({
      positionals: ['acme'],
      values: {},
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--to-node-key or --to-url is required',
      displayMessage: expect.stringContaining('Usage: canonry site-health path <project>'),
      details: expect.objectContaining({
        command: 'site-health.path',
        usage: expect.stringContaining('canonry site-health path <project>'),
      }),
    })
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

  it('preserves crawl-page pagination metadata in JSONL', async () => {
    mocked.getTechnicalAeoCrawlPages.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      total: 2,
      nextCursor: 'page-2',
      pages: [{ url: 'https://acme.test/', nodeKey: 'page:root' }],
    })

    const output = captureStdout(() => technicalAeoCrawlPages('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-crawl-pages-header',
        project: 'acme',
        runId: 'run-1',
        total: 2,
        nextCursor: 'page-2',
      },
      { project: 'acme', runId: 'run-1', url: 'https://acme.test/', nodeKey: 'page:root' },
    ])
  })

  it('preserves structure pagination metadata in JSONL', async () => {
    mocked.getTechnicalAeoStructure.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      parentPath: '/guides',
      total: 2,
      nextCursor: 'path-2',
      children: [{ path: '/guides/a', pageCount: 1, inventoryEligibleCount: 1 }],
    })

    const output = captureStdout(() => technicalAeoStructure('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-structure-header',
        project: 'acme',
        runId: 'run-1',
        parentPath: '/guides',
        returned: 1,
        nextCursor: 'path-2',
      },
      {
        project: 'acme',
        runId: 'run-1',
        parentPath: '/guides',
        path: '/guides/a',
        pageCount: 1,
        inventoryEligibleCount: 1,
      },
    ])
  })

  it('preserves internal-link pagination metadata in JSONL', async () => {
    mocked.getTechnicalAeoInternalLinks.mockResolvedValue({
      project: 'acme',
      runId: 'run-1',
      total: 2,
      nextCursor: 'link-2',
      edges: [{ sourceUrl: 'https://acme.test/', targetUrl: 'https://acme.test/a', followable: true, occurrences: 1 }],
    })

    const output = captureStdout(() => technicalAeoInternalLinks('acme', { format: 'jsonl' }))
    await output.run

    expect(output.lines().map((line) => JSON.parse(line))).toEqual([
      {
        kind: 'technical-aeo-internal-links-header',
        project: 'acme',
        runId: 'run-1',
        total: 2,
        nextCursor: 'link-2',
      },
      {
        project: 'acme',
        runId: 'run-1',
        sourceUrl: 'https://acme.test/',
        targetUrl: 'https://acme.test/a',
        followable: true,
        occurrences: 1,
      },
    ])
  })

  it('preserves scan IDs and continuation metadata for paged Site Health changes in JSONL', async () => {
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      versions: { crawlSchema: '1', normalization: '1', indexability: '1', linkScore: '1' },
      filters: { scope: 'all', change: 'all' },
      summaryState: 'exact',
      summary: {
        pages: { added: 1, removed: 0, changed: 2 },
        links: { added: 3, removed: 4, changed: 5 },
      },
      total: 10,
      nextCursor: 'changes-2',
      changes: [{ entity: 'page', change: 'added', key: 'page:/new', changedFields: [], before: null, after: null }],
    })

    const output = captureStdout(() => technicalAeoChanges('acme', { format: 'jsonl' }))
    await output.run

    const rows = output.lines().map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({
      kind: 'site-health-changes-header',
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      total: 10,
      nextCursor: 'changes-2',
      filters: { scope: 'all', change: 'all' },
      summaryState: 'exact',
    })
    expect(rows[1]).toMatchObject({
      project: 'acme',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      entity: 'page',
      change: 'added',
      key: 'page:/new',
    })
  })

  it('preserves filters and nullable continuation metadata in JSONL', async () => {
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      versions: { crawlSchema: '1', normalization: '1', indexability: '1', linkScore: '1' },
      filters: { scope: 'pages', change: 'changed' },
      summaryState: 'omitted-on-continuation',
      summary: null,
      total: null,
      nextCursor: null,
      changes: [{
        entity: 'page',
        change: 'changed',
        key: 'page:/pricing',
        changedFields: ['inventoryEligible'],
        before: { url: 'https://acme.test/pricing' },
        after: { url: 'https://acme.test/pricing' },
      }],
    })

    const output = captureStdout(() => technicalAeoChanges('acme', { cursor: 'changes-2', format: 'jsonl' }))
    await output.run

    const rows = output.lines().map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({
      kind: 'site-health-changes-header',
      filters: { scope: 'pages', change: 'changed' },
      summaryState: 'omitted-on-continuation',
      summary: null,
      total: null,
      nextCursor: null,
    })
    expect(rows[1]).toMatchObject({
      entity: 'page',
      change: 'changed',
      key: 'page:/pricing',
      changedFields: ['inventoryEligible'],
    })
  })

  it('renders continuation records without assuming an exact summary', async () => {
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'ready',
      fromRunId: 'run-before',
      toRunId: 'run-after',
      versions: { crawlSchema: '1', normalization: '1', indexability: '1', linkScore: '1' },
      filters: { scope: 'links', change: 'added' },
      summaryState: 'omitted-on-continuation',
      summary: null,
      total: null,
      nextCursor: null,
      changes: [{
        entity: 'link',
        change: 'added',
        key: 'link:pricing-to-contact',
        changedFields: [],
        before: null,
        after: { sourceUrl: 'https://acme.test/pricing', targetUrl: 'https://acme.test/contact' },
      }],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await technicalAeoChanges('acme', { cursor: 'changes-2' })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('link added: https://acme.test/pricing → https://acme.test/contact'))
    } finally {
      log.mockRestore()
    }
  })

  it('forwards an individually selected scan ID for Site Health changes', async () => {
    mocked.getSiteHealthChanges.mockClear()
    mocked.getSiteHealthChanges.mockResolvedValue({
      project: 'acme',
      state: 'unavailable',
      reason: 'insufficient-history',
      fromRunId: null,
      toRunId: 'run-after',
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await command(['technical-aeo', 'changes']).run({
        positionals: ['acme'],
        values: { 'to-run-id': 'run-after' },
        format: 'json',
        dryRun: false,
      })
    } finally {
      log.mockRestore()
    }

    expect(mocked.getSiteHealthChanges).toHaveBeenCalledWith('acme', {
      fromRunId: undefined,
      toRunId: 'run-after',
      scope: undefined,
      change: undefined,
      cursor: undefined,
      limit: undefined,
      format: 'json',
    })
  })
})
