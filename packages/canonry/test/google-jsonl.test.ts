import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGscPerformance = vi.fn()
const mockGscPerformanceDaily = vi.fn()
const mockGscInspections = vi.fn()
const mockGscCoverageHistory = vi.fn()
const mockGscDeindexed = vi.fn()
const mockGoogleConnections = vi.fn()
const mockGoogleProperties = vi.fn()
const mockGscSitemaps = vi.fn()
const mockGscSubmitSitemaps = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    gscPerformance: mockGscPerformance,
    gscPerformanceDaily: mockGscPerformanceDaily,
    gscInspections: mockGscInspections,
    gscCoverageHistory: mockGscCoverageHistory,
    gscDeindexed: mockGscDeindexed,
    googleConnections: mockGoogleConnections,
    googleProperties: mockGoogleProperties,
    gscSitemaps: mockGscSitemaps,
    gscSubmitSitemaps: mockGscSubmitSitemaps,
  }),
}))

/** Capture `process.stdout.write` (the jsonl path) rather than console.log. */
function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  const run = fn().finally(() => spy.mockRestore())
  return { run, lines: () => buf.split('\n').filter(Boolean) }
}

/** Capture `console.log` (the json path). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; text: () => string } {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => { console.log = origLog })
  return { run, text: () => logs.join('') }
}

const {
  googlePerformance,
  googlePerformanceDaily,
  googleInspections,
  googleCoverageHistory,
  googleDeindexed,
  googleStatus,
  googleProperties,
  googleListSitemaps,
  googleSubmitSitemaps,
} = await import('../src/commands/google.js')
const { runCli } = await import('../src/cli.js')

const PROJECT = 'demo'

const perfRows = [
  { date: '2026-05-01', query: 'a', page: 'https://x/1', clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 },
  { date: '2026-05-02', query: 'b', page: 'https://x/2', clicks: 2, impressions: 80, ctr: 0.025, position: 7.1 },
]

const dailyEnvelope = {
  daily: [
    { date: '2026-05-01', clicks: 5, impressions: 100, ctr: 0.05 },
    { date: '2026-05-02', clicks: 2, impressions: 80, ctr: 0.025 },
    { date: '2026-05-03', clicks: 9, impressions: 200, ctr: 0.045 },
  ],
  totals: { clicks: 16, impressions: 380, ctr: 0.042, days: 3 },
}

const inspectionRows = [
  { id: 'i1', url: 'https://x/1', indexingState: 'INDEXING_ALLOWED', verdict: 'PASS', inspectedAt: '2026-05-01T00:00:00.000Z' },
  { id: 'i2', url: 'https://x/2', indexingState: 'INDEXING_ALLOWED', verdict: 'NEUTRAL', inspectedAt: '2026-05-02T00:00:00.000Z' },
]

const coverageRows = [
  { date: '2026-05-01', indexed: 40, notIndexed: 10, reasonBreakdown: { crawled: 6, discovered: 4 } },
  { date: '2026-05-02', indexed: 42, notIndexed: 8, reasonBreakdown: { crawled: 5 } },
]

const deindexedRows = [
  { url: 'https://x/3', previousState: 'INDEXED', currentState: 'NOT_INDEXED', transitionDate: '2026-05-02' },
]

const connections = [
  { connectionType: 'gsc', propertyId: 'sc-domain:x', scopes: ['s1'], createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-02T00:00:00.000Z' },
]

const sites = [
  { siteUrl: 'https://x/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:x', permissionLevel: 'siteFullUser' },
]

const sitemapsEnvelope = {
  sitemaps: [
    { path: 'https://x/sitemap.xml', lastSubmitted: '2026-05-01', isSitemapsIndex: false, contents: [{ type: 'web', submitted: '10', indexed: '8' }] },
    { path: 'https://x/sitemap-2.xml', lastSubmitted: '2026-05-02' },
  ],
}

describe('google jsonl output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('googlePerformance', () => {
    it('jsonl emits one self-contained row per line, project-tagged', async () => {
      mockGscPerformance.mockResolvedValue(perfRows)
      const cap = captureStdout(() => googlePerformance(PROJECT, { format: 'jsonl' }))
      await cap.run
      const lines = cap.lines()
      expect(lines).toHaveLength(2)
      const records = lines.map((l) => JSON.parse(l))
      expect(records.every((r) => r.project === PROJECT)).toBe(true)
      expect(records[0]).toMatchObject({ project: PROJECT, date: '2026-05-01', query: 'a', clicks: 5 })
    })

    it('jsonl emits ALL rows (human view truncates at 50, jsonl does not)', async () => {
      const many = Array.from({ length: 73 }, (_, i) => ({
        date: '2026-05-01', query: `q${i}`, page: 'p', clicks: i, impressions: i, ctr: 0, position: 1,
      }))
      mockGscPerformance.mockResolvedValue(many)
      const cap = captureStdout(() => googlePerformance(PROJECT, { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(73)
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGscPerformance.mockResolvedValue([])
      const cap = captureStdout(() => googlePerformance(PROJECT, { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the raw rows array', async () => {
      mockGscPerformance.mockResolvedValue(perfRows)
      const cap = captureLog(() => googlePerformance(PROJECT, { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(perfRows)
    })
  })

  describe('googlePerformanceDaily', () => {
    it('jsonl emits one line per daily row, project-tagged', async () => {
      mockGscPerformanceDaily.mockResolvedValue(dailyEnvelope)
      const cap = captureStdout(() => googlePerformanceDaily(PROJECT, { format: 'jsonl' }))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(3)
      expect(records.every((r) => r.project === PROJECT)).toBe(true)
      expect(records[0]).toMatchObject({ project: PROJECT, date: '2026-05-01', clicks: 5, impressions: 100 })
    })

    it('jsonl on empty daily writes nothing', async () => {
      mockGscPerformanceDaily.mockResolvedValue({ daily: [], totals: { clicks: 0, impressions: 0, ctr: 0, days: 0 } })
      const cap = captureStdout(() => googlePerformanceDaily(PROJECT, { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the full envelope', async () => {
      mockGscPerformanceDaily.mockResolvedValue(dailyEnvelope)
      const cap = captureLog(() => googlePerformanceDaily(PROJECT, { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(dailyEnvelope)
    })
  })

  describe('googleInspections', () => {
    it('jsonl emits one line per row, project-tagged', async () => {
      mockGscInspections.mockResolvedValue(inspectionRows)
      const cap = captureStdout(() => googleInspections(PROJECT, { format: 'jsonl' }))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.project === PROJECT)).toBe(true)
      expect(records[0]).toMatchObject({ project: PROJECT, id: 'i1', url: 'https://x/1' })
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGscInspections.mockResolvedValue([])
      const cap = captureStdout(() => googleInspections(PROJECT, { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the raw rows array', async () => {
      mockGscInspections.mockResolvedValue(inspectionRows)
      const cap = captureLog(() => googleInspections(PROJECT, { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(inspectionRows)
    })
  })

  describe('googleCoverageHistory', () => {
    it('jsonl emits one line per snapshot, project-tagged', async () => {
      mockGscCoverageHistory.mockResolvedValue(coverageRows)
      const cap = captureStdout(() => googleCoverageHistory(PROJECT, { format: 'jsonl' }))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.project === PROJECT)).toBe(true)
      expect(records[0]).toMatchObject({ project: PROJECT, date: '2026-05-01', indexed: 40, notIndexed: 10 })
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGscCoverageHistory.mockResolvedValue([])
      const cap = captureStdout(() => googleCoverageHistory(PROJECT, { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the raw rows array', async () => {
      mockGscCoverageHistory.mockResolvedValue(coverageRows)
      const cap = captureLog(() => googleCoverageHistory(PROJECT, { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(coverageRows)
    })
  })

  describe('googleDeindexed', () => {
    it('jsonl emits one line per row, project-tagged', async () => {
      mockGscDeindexed.mockResolvedValue(deindexedRows)
      const cap = captureStdout(() => googleDeindexed(PROJECT, 'jsonl'))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ project: PROJECT, url: 'https://x/3', previousState: 'INDEXED' })
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGscDeindexed.mockResolvedValue([])
      const cap = captureStdout(() => googleDeindexed(PROJECT, 'jsonl'))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the raw rows array', async () => {
      mockGscDeindexed.mockResolvedValue(deindexedRows)
      const cap = captureLog(() => googleDeindexed(PROJECT, 'json'))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(deindexedRows)
    })
  })

  describe('googleStatus', () => {
    it('jsonl emits one line per connection, project-tagged', async () => {
      mockGoogleConnections.mockResolvedValue(connections)
      const cap = captureStdout(() => googleStatus(PROJECT, 'jsonl'))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ project: PROJECT, connectionType: 'gsc', propertyId: 'sc-domain:x' })
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGoogleConnections.mockResolvedValue([])
      const cap = captureStdout(() => googleStatus(PROJECT, 'jsonl'))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the { connections } envelope', async () => {
      mockGoogleConnections.mockResolvedValue(connections)
      const cap = captureLog(() => googleStatus(PROJECT, 'json'))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual({ connections })
    })
  })

  describe('googleProperties', () => {
    it('jsonl emits one line per site, project-tagged', async () => {
      mockGoogleProperties.mockResolvedValue({ sites })
      const cap = captureStdout(() => googleProperties(PROJECT, 'jsonl'))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.project === PROJECT)).toBe(true)
      expect(records[0]).toMatchObject({ project: PROJECT, siteUrl: 'https://x/', permissionLevel: 'siteOwner' })
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGoogleProperties.mockResolvedValue({ sites: [] })
      const cap = captureStdout(() => googleProperties(PROJECT, 'jsonl'))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the { sites } envelope', async () => {
      mockGoogleProperties.mockResolvedValue({ sites })
      const cap = captureLog(() => googleProperties(PROJECT, 'json'))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual({ sites })
    })
  })

  describe('googleListSitemaps', () => {
    it('jsonl emits one line per sitemap, project-tagged', async () => {
      mockGscSitemaps.mockResolvedValue(sitemapsEnvelope)
      const cap = captureStdout(() => googleListSitemaps(PROJECT, { format: 'jsonl' }))
      await cap.run
      const records = cap.lines().map((l) => JSON.parse(l))
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.project === PROJECT)).toBe(true)
      expect(records[0]).toMatchObject({ project: PROJECT, path: 'https://x/sitemap.xml' })
    })

    it('jsonl on empty collection writes nothing', async () => {
      mockGscSitemaps.mockResolvedValue({ sitemaps: [] })
      const cap = captureStdout(() => googleListSitemaps(PROJECT, { format: 'jsonl' }))
      await cap.run
      expect(cap.lines()).toHaveLength(0)
    })

    it('json branch unchanged — prints the full envelope', async () => {
      mockGscSitemaps.mockResolvedValue(sitemapsEnvelope)
      const cap = captureLog(() => googleListSitemaps(PROJECT, { format: 'json' }))
      await cap.run
      expect(JSON.parse(cap.text())).toEqual(sitemapsEnvelope)
    })

    it('human output reports submitted URL totals without deprecated indexed counts', async () => {
      mockGscSitemaps.mockResolvedValue(sitemapsEnvelope)
      const cap = captureLog(() => googleListSitemaps(PROJECT, {}))
      await cap.run
      expect(cap.text()).toContain('Submitted URLs: 10')
      expect(cap.text()).not.toContain('Indexed:')
    })
  })

  describe('googleSubmitSitemaps', () => {
    const submission = {
      summary: { total: 2, accepted: 1, failed: 1 },
      results: [
        { sitemapUrl: 'https://x/sitemap.xml', status: 'accepted', submittedAt: '2026-07-27T00:00:00.000Z' },
        { sitemapUrl: 'https://x/bad.xml', status: 'error', error: 'Google rejected the sitemap' },
      ],
    }

    it('deduplicates explicit URLs and preserves the full response as JSON', async () => {
      mockGscSubmitSitemaps.mockResolvedValue(submission)
      const cap = captureLog(() => googleSubmitSitemaps(PROJECT, {
        sitemapUrls: ['https://x/sitemap.xml', 'https://x/sitemap.xml'],
        format: 'json',
      }))
      await cap.run
      expect(mockGscSubmitSitemaps).toHaveBeenCalledWith(PROJECT, { sitemapUrls: ['https://x/sitemap.xml'] })
      expect(JSON.parse(cap.text())).toEqual(submission)
    })

    it('rejects more than 50 explicit sitemap URLs before calling the API', async () => {
      const sitemapUrls = Array.from({ length: 51 }, (_, index) => `https://x/sitemap-${index}.xml`)
      await expect(() => googleSubmitSitemaps(PROJECT, { sitemapUrls })).rejects.toMatchObject({
        code: 'CLI_USAGE_ERROR',
        details: { sitemapUrls: 51, maxSitemapUrls: 50 },
      })
      expect(mockGscSubmitSitemaps).not.toHaveBeenCalled()
    })

    it('uses the configured GSC sitemap URL', async () => {
      mockGoogleConnections.mockResolvedValue([{ connectionType: 'gsc', sitemapUrl: 'https://x/configured.xml' }])
      mockGscSubmitSitemaps.mockResolvedValue({ summary: { total: 1, accepted: 1, failed: 0 }, results: [] })
      await googleSubmitSitemaps(PROJECT, { configured: true, format: 'json' })
      expect(mockGscSubmitSitemaps).toHaveBeenCalledWith(PROJECT, { sitemapUrls: ['https://x/configured.xml'] })
    })

    it('uses preferred sitemap indexes for --all', async () => {
      mockGscSitemaps.mockResolvedValue({
        sitemaps: [
          { path: 'https://x/sitemap.xml' },
          { path: 'https://x/sitemap-index.xml', isSitemapsIndex: true },
        ],
        preferredSubmissionUrls: ['https://x/sitemap-index.xml'],
      })
      mockGscSubmitSitemaps.mockResolvedValue({ summary: { total: 1, accepted: 1, failed: 0 }, results: [] })
      await googleSubmitSitemaps(PROJECT, { all: true, format: 'json' })
      expect(mockGscSubmitSitemaps).toHaveBeenCalledWith(PROJECT, { sitemapUrls: ['https://x/sitemap-index.xml'] })
    })

    it('falls back to all top-level sitemaps when --all has no indexes', async () => {
      mockGscSitemaps.mockResolvedValue({ sitemaps: [
        { path: 'https://x/sitemap.xml' },
        { path: 'https://x/sitemap.xml' },
        { path: 'https://x/other.xml' },
      ], preferredSubmissionUrls: [] })
      mockGscSubmitSitemaps.mockResolvedValue({ summary: { total: 2, accepted: 2, failed: 0 }, results: [] })
      await googleSubmitSitemaps(PROJECT, { all: true, format: 'json' })
      expect(mockGscSubmitSitemaps).toHaveBeenCalledWith(PROJECT, { sitemapUrls: ['https://x/sitemap.xml', 'https://x/other.xml'] })
    })

    it('expands index children through the list API, chunks at 50, and aggregates --all-files', async () => {
      const childUrls = Array.from({ length: 51 }, (_, index) => `https://x/child-${index}.xml`)
      mockGscSitemaps.mockImplementation((_project: string, params?: { sitemapIndex?: string }) => {
        if (params?.sitemapIndex) return Promise.resolve({ sitemaps: childUrls.map((path) => ({ path })), preferredSubmissionUrls: [] })
        return Promise.resolve({
          sitemaps: [
            { path: 'https://x/index.xml', isSitemapsIndex: true },
            { path: 'https://x/standalone.xml' },
          ],
          preferredSubmissionUrls: ['https://x/index.xml'],
        })
      })
      mockGscSubmitSitemaps.mockImplementation((_project: string, body: { sitemapUrls: string[] }) => Promise.resolve({
        summary: { total: body.sitemapUrls.length, accepted: body.sitemapUrls.length, failed: 0 },
        results: body.sitemapUrls.map((sitemapUrl) => ({ sitemapUrl, status: 'accepted' as const })),
      }))
      const cap = captureLog(() => googleSubmitSitemaps(PROJECT, { allFiles: true, format: 'json' }))
      await cap.run
      expect(mockGscSitemaps).toHaveBeenNthCalledWith(1, PROJECT)
      expect(mockGscSitemaps).toHaveBeenNthCalledWith(2, PROJECT, { sitemapIndex: 'https://x/index.xml' })
      expect(mockGscSubmitSitemaps).toHaveBeenCalledTimes(2)
      expect(mockGscSubmitSitemaps.mock.calls.flatMap(([, body]) => (body as { sitemapUrls: string[] }).sitemapUrls)).not.toContain('https://x/index.xml')
      expect(mockGscSubmitSitemaps.mock.calls.flatMap(([, body]) => (body as { sitemapUrls: string[] }).sitemapUrls)).toContain('https://x/standalone.xml')
      expect(JSON.parse(cap.text())).toMatchObject({ summary: { total: 52, accepted: 52, failed: 0 } })
    })

    it('reports preserved partial results when a later batch fails', async () => {
      const childUrls = Array.from({ length: 100 }, (_, index) => `https://x/child-${index}.xml`)
      mockGscSitemaps.mockImplementation((_project: string, params?: { sitemapIndex?: string }) => {
        if (params?.sitemapIndex) return Promise.resolve({ sitemaps: childUrls.map((path) => ({ path })), preferredSubmissionUrls: [] })
        return Promise.resolve({ sitemaps: [{ path: 'https://x/index.xml', isSitemapsIndex: true }], preferredSubmissionUrls: ['https://x/index.xml'] })
      })
      mockGscSubmitSitemaps
        .mockResolvedValueOnce({ summary: { total: 50, accepted: 49, failed: 1 }, results: [] })
        .mockRejectedValueOnce(new Error('Google unavailable'))
      await expect(() => googleSubmitSitemaps(PROJECT, { allFiles: true })).rejects.toMatchObject({
        code: 'GOOGLE_SITEMAP_SUBMISSION_PARTIAL',
        exitCode: 2,
        details: {
          accepted: 49,
          failed: 1,
          completed: 50,
          attempted: 100,
          unconfirmed: 50,
          remaining: 0,
          unconfirmedBatch: { index: 2, total: 2 },
        },
      })
      expect(mockGscSubmitSitemaps).toHaveBeenCalledTimes(2)
    })

    it('falls back to the parent index when --all-files cannot discover children', async () => {
      mockGscSitemaps.mockImplementation((_project: string, params?: { sitemapIndex?: string }) => {
        if (params?.sitemapIndex) return Promise.resolve({ sitemaps: [], preferredSubmissionUrls: [] })
        return Promise.resolve({
          sitemaps: [{ path: 'https://x/index.xml', isSitemapsIndex: true }],
          preferredSubmissionUrls: ['https://x/index.xml'],
        })
      })
      mockGscSubmitSitemaps.mockResolvedValue({
        summary: { total: 1, accepted: 1, failed: 0 },
        results: [{ sitemapUrl: 'https://x/index.xml', status: 'accepted' }],
      })

      await googleSubmitSitemaps(PROJECT, { allFiles: true, format: 'json' })

      expect(mockGscSubmitSitemaps).toHaveBeenCalledWith(PROJECT, {
        sitemapUrls: ['https://x/index.xml'],
      })
    })

    it('emits one project-tagged result per line for jsonl', async () => {
      mockGscSubmitSitemaps.mockResolvedValue(submission)
      const cap = captureStdout(() => googleSubmitSitemaps(PROJECT, { sitemapUrls: ['https://x/sitemap.xml'], format: 'jsonl' }))
      await cap.run
      expect(cap.lines().map((line) => JSON.parse(line))).toEqual(submission.results.map((result) => ({ project: PROJECT, ...result })))
    })

    it('makes refetch and indexing expectations explicit in human output', async () => {
      mockGscSubmitSitemaps.mockResolvedValue({
        summary: { total: 1, accepted: 1, failed: 0 },
        results: [{ sitemapUrl: 'https://x/sitemap.xml', status: 'accepted' }],
      })
      const cap = captureLog(() => googleSubmitSitemaps(PROJECT, { sitemapUrls: ['https://x/sitemap.xml'] }))
      await cap.run
      expect(cap.text()).toContain('Accepted by Google for sitemap refetch')
      expect(cap.text()).toContain('does not guarantee indexing')
    })

    it('rejects missing or conflicting source modes with CLI_USAGE_ERROR', async () => {
      await expect(() => googleSubmitSitemaps(PROJECT, {})).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
      await expect(() => googleSubmitSitemaps(PROJECT, { sitemapUrls: ['https://x/sitemap.xml'], configured: true })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    })

    it('CLI rejects conflicting source modes before calling the API', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const exitCode = await runCli(['google', 'submit-sitemap', PROJECT, 'https://x/sitemap.xml', '--configured'])
      error.mockRestore()
      expect(exitCode).toBe(1)
      expect(mockGscSubmitSitemaps).not.toHaveBeenCalled()
    })
  })
})
