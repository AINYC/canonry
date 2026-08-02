import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getMeasurementPlan = vi.fn()
const listMeasurementPlanVersions = vi.fn()
const getMeasurementPlanVersion = vi.fn()
const publishMeasurementPlan = vi.fn()
const retireMeasurementPlanSegment = vi.fn()
const discoverMeasurementTargets = vi.fn()
const getMeasurementReport = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getMeasurementPlan,
    listMeasurementPlanVersions,
    getMeasurementPlanVersion,
    publishMeasurementPlan,
    retireMeasurementPlanSegment,
    discoverMeasurementTargets,
    getMeasurementReport,
  }),
}))

const { MEASUREMENT_PLAN_CLI_COMMANDS } = await import('../src/cli-commands/measurement-plan.js')

const PLAN = {
  schemaVersion: 1,
  targets: [{
    stableKey: 'nyc-brand', label: 'New York brand', aliases: ['Example Solar'],
    urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/new-york', pathCase: 'sensitive' }],
  }],
  groups: [{
    stableKey: 'nyc', label: 'New York', targetKeys: ['nyc-brand'],
    competitors: ['rival.example'],
  }],
  targetQuerySelections: [],
}

function command(pathname: string) {
  const found = MEASUREMENT_PLAN_CLI_COMMANDS.find(entry => entry.path.join(' ') === pathname)
  expect(found, pathname).toBeTruthy()
  return found!
}

describe('measurement-plan CLI commands', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    getMeasurementPlan.mockResolvedValue({ active: null })
    listMeasurementPlanVersions.mockResolvedValue({ versions: [] })
    getMeasurementPlanVersion.mockResolvedValue({ version: { revision: 1 } })
    publishMeasurementPlan.mockResolvedValue({ active: { revision: 1 } })
    retireMeasurementPlanSegment.mockResolvedValue({ stableKey: 'nyc', retiredAt: '2026-07-31T00:00:00.000Z' })
    discoverMeasurementTargets.mockResolvedValue({ proposed: [], aliases: [], shared: [], unmatched: [], excluded: [], diagnostics: [] })
    getMeasurementReport.mockResolvedValue({ revision: 1, run: null, groups: [], targets: [], evidence: [], diagnostics: {} })
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-plan-cli-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('registers show, versions, and publish with their stable usage forms', () => {
    expect(command('measurement-plan show').usage)
      .toBe('canonry measurement-plan show <project> [--revision N] [--format json]')
    expect(command('measurement-plan versions').usage)
      .toBe('canonry measurement-plan versions <project> [--format json]')
    expect(command('measurement-plan publish').usage)
      .toBe('canonry measurement-plan publish <project> <yaml|json|-> [--format json]')
    expect(command('measurement-plan retire').usage)
      .toBe('canonry measurement-plan retire <project> <stable-key> [--format json]')
    expect(command('measurement-plan discover').usage)
      .toBe('canonry measurement-plan discover <project> --sitemap-url <url> --rule <yaml|json|-> [--max-urls N] [--format json]')
    expect(command('measurement-plan report').usage)
      .toBe('canonry measurement-plan report <project> --revision N [--format json]')
  })

  it('retires a stable measurement segment key', async () => {
    await command('measurement-plan retire').run({ positionals: ['acme', 'old-nyc'], values: {}, format: 'json' } as never)
    expect(retireMeasurementPlanSegment).toHaveBeenCalledWith('acme', 'old-nyc')
  })

  it('reads the active plan by default and an immutable revision when requested', async () => {
    await command('measurement-plan show').run({
      positionals: ['acme'], values: {}, format: 'json', dryRun: false,
    })
    expect(getMeasurementPlan).toHaveBeenCalledWith('acme')

    await command('measurement-plan show').run({
      positionals: ['acme'], values: { revision: '2' }, format: 'json', dryRun: false,
    })
    expect(getMeasurementPlanVersion).toHaveBeenCalledWith('acme', 2)

    await command('measurement-plan versions').run({
      positionals: ['acme'], values: {}, format: 'json', dryRun: false,
    })
    expect(listMeasurementPlanVersions).toHaveBeenCalledWith('acme')
  })

  it.each([
    ['JSON', 'plan.json', JSON.stringify(PLAN, null, 2)],
    ['YAML', 'plan.yaml', `schemaVersion: 1\ntargets:\n  - stableKey: nyc-brand\n    label: New York brand\n    aliases:\n      - Example Solar\n    urls:\n      - kind: prefix\n        host: example.com\n        pathPrefix: /new-york\n        pathCase: sensitive\ngroups:\n  - stableKey: nyc\n    label: New York\n    targetKeys:\n      - nyc-brand\n    competitors:\n      - rival.example\n`],
  ])('parses and publishes %s input without changing its plan payload', async (_label, filename, contents) => {
    const inputPath = path.join(tmpDir, filename)
    fs.writeFileSync(inputPath, contents)

    await command('measurement-plan publish').run({
      positionals: ['acme', inputPath], values: {}, format: 'json', dryRun: false,
    })

    expect(publishMeasurementPlan).toHaveBeenCalledWith('acme', {
      expectedActiveRevision: null,
      plan: PLAN,
    })
  })

  it('accepts - as stdin input for publish', async () => {
    const readFile = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify(PLAN))

    await command('measurement-plan publish').run({
      positionals: ['acme', '-'], values: {}, format: 'json', dryRun: false,
    })

    expect(readFile).toHaveBeenCalledWith(0, 'utf8')
    expect(publishMeasurementPlan).toHaveBeenCalledWith('acme', {
      expectedActiveRevision: null,
      plan: PLAN,
    })
  })

  it('publishes against the active revision read immediately before the write', async () => {
    const inputPath = path.join(tmpDir, 'plan.json')
    fs.writeFileSync(inputPath, JSON.stringify(PLAN))
    getMeasurementPlan.mockResolvedValueOnce({ active: { revision: 4 } })

    await command('measurement-plan publish').run({
      positionals: ['acme', inputPath], values: {}, format: 'json', dryRun: false,
    })

    expect(getMeasurementPlan).toHaveBeenCalledWith('acme')
    expect(publishMeasurementPlan).toHaveBeenCalledWith('acme', {
      expectedActiveRevision: 4,
      plan: PLAN,
    })
  })

  it.each([
    ['JSON', 'rule.json', JSON.stringify({
      primary: { host: 'example.com', pathTemplate: '/locations/{slug}' },
      aliases: [{ host: 'directory.example', pathTemplate: '/{slug}' }],
    })],
    ['YAML', 'rule.yaml', [
      'primary:',
      '  host: example.com',
      '  pathTemplate: /locations/{slug}',
      'aliases:',
      '  - host: directory.example',
      '    pathTemplate: /{slug}',
      '',
    ].join('\n')],
  ])('discovers targets from a sitemap using a validated %s rule', async (_label, filename, contents) => {
    const rulePath = path.join(tmpDir, filename)
    fs.writeFileSync(rulePath, contents)

    await command('measurement-plan discover').run({
      positionals: ['acme'],
      values: {
        'sitemap-url': 'https://example.com/sitemap.xml',
        rule: rulePath,
        'max-urls': '250',
      },
      format: 'json',
      dryRun: false,
    })

    expect(discoverMeasurementTargets).toHaveBeenCalledWith('acme', {
      sitemapUrl: 'https://example.com/sitemap.xml',
      maxUrls: 250,
      rule: {
        primary: { host: 'example.com', pathTemplate: '/locations/{slug}' },
        aliases: [{ host: 'directory.example', pathTemplate: '/{slug}' }],
      },
    })
  })

  it('requires a positive discovery cap and report revision', async () => {
    const rulePath = path.join(tmpDir, 'rule.json')
    fs.writeFileSync(rulePath, JSON.stringify({
      primary: { host: 'example.com', pathTemplate: '/locations/{slug}' },
    }))

    expect(() => command('measurement-plan discover').run({
      positionals: ['acme'],
      values: {
        'sitemap-url': 'https://example.com/sitemap.xml',
        rule: rulePath,
        'max-urls': '0',
      },
      format: 'json',
      dryRun: false,
    })).toThrow('--max-urls must be an integer from 1 to 10000')

    expect(() => command('measurement-plan report').run({
      positionals: ['acme'], values: { revision: 'nope' }, format: 'json', dryRun: false,
    })).toThrow('--revision must be a positive integer')
  })

  it('reads a revision-pinned measurement report', async () => {
    await command('measurement-plan report').run({
      positionals: ['acme'], values: { revision: '3' }, format: 'json', dryRun: false,
    })

    expect(getMeasurementReport).toHaveBeenCalledWith('acme', 3)
  })
})
