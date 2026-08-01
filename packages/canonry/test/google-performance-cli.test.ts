import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliCommandSpec } from '../src/cli-dispatch.js'

const gscPerformance = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gscPerformance }),
}))

const { googlePerformance } = await import('../src/commands/google.js')
const { GOOGLE_CLI_COMMANDS } = await import('../src/cli-commands/google.js')

function performanceSpec(): CliCommandSpec {
  const spec = GOOGLE_CLI_COMMANDS.find((entry) => entry.path.join('.') === 'google.performance')
  if (!spec) throw new Error('google performance command is not registered')
  return spec
}

function runSpec(values: Record<string, string | boolean>): Promise<void> {
  return Promise.resolve(performanceSpec().run({
    positionals: ['demo'],
    values,
    format: 'text',
    dryRun: false,
  }))
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => lines.join('\n'))
}

const EMPTY_RESPONSE = {
  rows: [],
  totalMatching: 0,
  truncated: false,
  latestAvailableDate: '2026-07-25',
}

describe('canonry google performance CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gscPerformance.mockResolvedValue(EMPTY_RESPONSE)
  })

  it('errors when both --days and --start are passed instead of silently picking one', async () => {
    await expect(runSpec({ days: '30', start: '2026-07-01' })).rejects.toThrow(/--days/)
    await expect(runSpec({ days: '30', start: '2026-07-01' })).rejects.toThrow(/--start/)
    expect(gscPerformance).not.toHaveBeenCalled()
  })

  it('lets --start/--end drive the window', async () => {
    await captureLog(() => runSpec({ start: '2026-07-01', end: '2026-07-10' }))
    expect(gscPerformance).toHaveBeenCalledWith('demo', expect.objectContaining({
      startDate: '2026-07-01',
      endDate: '2026-07-10',
    }))
  })

  it('passes --limit, --offset and --order-by through to the API', async () => {
    await captureLog(() => runSpec({ limit: '2000', offset: '500', 'order-by': 'impressions' }))
    expect(gscPerformance).toHaveBeenCalledWith('demo', expect.objectContaining({
      limit: '2000',
      offset: '500',
      orderBy: 'impressions',
    }))
  })

  it('names both dates when an empty result sits inside the GSC reporting lag', async () => {
    const output = await captureLog(() => googlePerformance('demo', {
      startDate: '2026-07-28',
      endDate: '2026-07-31',
    }))
    expect(output).toContain('2026-07-31')
    expect(output).toContain('2026-07-25')
    expect(output).toMatch(/lag/i)
    expect(output).not.toMatch(/Run "canonry google sync" first/)
  })

  it('still points at sync when the project holds no GSC data at all', async () => {
    gscPerformance.mockResolvedValue({ ...EMPTY_RESPONSE, latestAvailableDate: null })
    const output = await captureLog(() => googlePerformance('demo', {}))
    expect(output).toMatch(/Run "canonry google sync" first/)
  })

  it('reports the matching total when the page is truncated', async () => {
    gscPerformance.mockResolvedValue({
      rows: [{ date: '2026-07-20', query: 'roof coating', page: '/p', clicks: 9, impressions: 100, ctr: 0.09, position: 3.2 }],
      totalMatching: 1421,
      truncated: true,
      latestAvailableDate: '2026-07-25',
    })
    const output = await captureLog(() => googlePerformance('demo', {}))
    expect(output).toContain('1,421')
  })
})
