import { beforeEach, describe, expect, it, vi } from 'vitest'

const listPlatformProperties = vi.fn()
const upsertPlatformProperty = vi.fn()
const deletePlatformProperty = vi.fn()
const syncPlatformProperty = vi.fn()
const getPlatformPerformance = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listGscPlatformProperties: listPlatformProperties,
    upsertGscPlatformProperty: upsertPlatformProperty,
    deleteGscPlatformProperty: deletePlatformProperty,
    syncGscPlatformProperty: syncPlatformProperty,
    getGscPlatformPerformance: getPlatformPerformance,
  }),
}))

const {
  googlePlatformAdd,
  googlePlatformList,
  googlePlatformPerformance,
  googlePlatformRemove,
  googlePlatformSync,
} = await import('../src/commands/google.js')

const property = {
  id: 'gscprop_youtube',
  projectId: 'project_1',
  siteUrl: 'https://www.youtube.com/@canonry',
  displayName: '@canonry',
  platform: 'youtube',
  kind: 'social-video',
  permissionLevel: 'siteOwner',
  status: 'active',
  lastSyncedAt: '2026-07-29T12:00:00.000Z',
  lastError: null,
  createdAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
}

const performance = {
  properties: [property],
  selectedPropertyId: property.id,
  window: { startDate: '2026-07-01', endDate: '2026-07-29' },
  totals: { clicks: 125, impressions: 5_000, ctr: 0.025, position: 4.25 },
  daily: [
    { date: '2026-07-29', clicks: 125, impressions: 5_000, ctr: 0.025, position: 4.25 },
  ],
  rows: [
    {
      propertyId: property.id,
      siteUrl: property.siteUrl,
      displayName: property.displayName,
      platform: property.platform,
      dimension: 'page',
      value: 'https://www.youtube.com/watch?v=abc',
      clicks: 80,
      impressions: 3_000,
      ctr: 80 / 3_000,
      position: 3.5,
    },
  ],
  pagination: { limit: 50, offset: 0, hasMore: false },
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return fn().finally(() => spy.mockRestore()).then(() => lines.join('\n'))
}

function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  let output = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk)
    return true
  })
  return fn()
    .finally(() => spy.mockRestore())
    .then(() => output.split('\n').filter(Boolean))
}

describe('GSC platform property CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listPlatformProperties.mockResolvedValue({ properties: [property] })
    upsertPlatformProperty.mockResolvedValue(property)
    deletePlatformProperty.mockResolvedValue(undefined)
    syncPlatformProperty.mockResolvedValue({
      id: 'run_1',
      projectId: 'project_1',
      kind: 'gsc-sync',
      status: 'queued',
      trigger: 'manual',
      sourceId: property.id,
      createdAt: '2026-07-30T00:00:00.000Z',
    })
    getPlatformPerformance.mockResolvedValue(performance)
  })

  it('streams one project-tagged property per jsonl line', async () => {
    const lines = await captureStdout(() => googlePlatformList('demo', 'jsonl'))
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ project: 'demo', ...property }])
  })

  it('binds a property idempotently with canonical platform metadata', async () => {
    const output = await captureLog(() => googlePlatformAdd(
      'demo',
      property.siteUrl,
      { platform: 'youtube', displayName: '@canonry', format: 'json' },
    ))

    expect(upsertPlatformProperty).toHaveBeenCalledWith('demo', {
      siteUrl: property.siteUrl,
      displayName: '@canonry',
      platform: 'youtube',
      kind: 'social-video',
    })
    expect(JSON.parse(output)).toEqual(property)
  })

  it('passes property, dimension, and window to the API and renders server metrics', async () => {
    const output = await captureLog(() => googlePlatformPerformance('demo', {
      propertyId: property.id,
      dimension: 'page',
      window: '30d',
    }))

    expect(getPlatformPerformance).toHaveBeenCalledWith('demo', {
      propertyId: property.id,
      dimension: 'page',
      window: '30d',
    })
    expect(output).toContain('125')
    expect(output).toContain('5,000')
    expect(output).toContain('2.50%')
    expect(output).toContain('4.25')
    expect(output).toContain('https://www.youtube.com/watch?v=abc')
  })

  it('removes and syncs by project-bound property id', async () => {
    const removed = await captureLog(() => googlePlatformRemove('demo', property.id))
    const synced = await captureLog(() => googlePlatformSync('demo', property.id, { wait: false }))

    expect(deletePlatformProperty).toHaveBeenCalledWith('demo', property.id)
    expect(syncPlatformProperty).toHaveBeenCalledWith('demo', property.id)
    expect(removed).toContain('Removed')
    expect(synced).toContain('run_1')
  })
})
