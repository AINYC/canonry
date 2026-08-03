import type { MeasurementQueryClassFilter } from '@ainyc/canonry-contracts'
import {
  discoverMeasurementTargets,
  listMeasurementPlanVersions,
  publishMeasurementPlan,
  retireMeasurementPlanSegment,
  showMeasurementPlan,
  showMeasurementProperty,
  showMeasurementPropertyEvidence,
  showMeasurementReport,
} from '../commands/measurement-plan.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, requireStringOption, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const QUERY_CLASSES: readonly MeasurementQueryClassFilter[] = ['all', 'branded', 'non-brand']

function queryClassOption(input: CliCommandInput): MeasurementQueryClassFilter | undefined {
  const value = getString(input.values, 'query-class')
  if (value === undefined) return undefined
  const match = QUERY_CLASSES.find(candidate => candidate === value)
  if (!match) throw usageError(`--query-class must be one of ${QUERY_CLASSES.join(', ')}`)
  return match
}

/** Filters every per-Property read shares, so the two commands cannot drift apart. */
function propertyScope(input: CliCommandInput, command: string, usage: string) {
  return {
    targetKey: requireStringOption(input, 'target-key', { command, usage, message: '--target-key is required' }),
    queryClass: queryClassOption(input),
    provider: getString(input.values, 'provider'),
    location: getString(input.values, 'location'),
    runId: getString(input.values, 'run-id'),
    format: input.format,
  }
}

const PROPERTY_SCOPE_OPTIONS = {
  'target-key': stringOption(),
  'query-class': stringOption(),
  provider: stringOption(),
  location: stringOption(),
  'run-id': stringOption(),
}

export const MEASUREMENT_PLAN_CLI_COMMANDS: readonly CliCommandSpec[] = [
  { path: ['measurement-plan', 'show'], usage: 'canonry measurement-plan show <project> [--revision N] [--format json]', options: { revision: stringOption() }, run: async input => {
    const value = getString(input.values, 'revision')
    const revision = value === undefined ? undefined : Number(value)
    if (revision !== undefined && (!Number.isInteger(revision) || revision <= 0)) throw usageError('--revision must be a positive integer')
    await showMeasurementPlan(requireProject(input, 'measurement-plan.show', 'canonry measurement-plan show <project> [--revision N]'), revision)
  } },
  { path: ['measurement-plan', 'versions'], usage: 'canonry measurement-plan versions <project> [--format json]', run: input => listMeasurementPlanVersions(requireProject(input, 'measurement-plan.versions', 'canonry measurement-plan versions <project>')) },
  { path: ['measurement-plan', 'publish'], usage: 'canonry measurement-plan publish <project> <yaml|json|-> [--format json]', run: input => {
    const project = requireProject(input, 'measurement-plan.publish', 'canonry measurement-plan publish <project> <yaml|json|->')
    const source = input.positionals[1]
    if (!source) throw usageError('plan file path or - is required')
    return publishMeasurementPlan(project, source)
  } },
  { path: ['measurement-plan', 'retire'], usage: 'canonry measurement-plan retire <project> <stable-key> [--format json]', run: input => {
    const project = requireProject(input, 'measurement-plan.retire', 'canonry measurement-plan retire <project> <stable-key>')
    const stableKey = input.positionals[1]
    if (!stableKey) throw usageError('stable segment key is required')
    return retireMeasurementPlanSegment(project, stableKey)
  } },
  {
    path: ['measurement-plan', 'discover'],
    usage: 'canonry measurement-plan discover <project> --sitemap-url <url> --rule <yaml|json|-> [--max-urls N] [--format json]',
    options: { 'sitemap-url': stringOption(), rule: stringOption(), 'max-urls': stringOption() },
    run: input => {
      const usage = 'canonry measurement-plan discover <project> --sitemap-url <url> --rule <yaml|json|-> [--max-urls N]'
      const project = requireProject(input, 'measurement-plan.discover', usage)
      const sitemapUrl = requireStringOption(input, 'sitemap-url', {
        command: 'measurement-plan.discover', usage, message: '--sitemap-url is required',
      })
      const rule = requireStringOption(input, 'rule', {
        command: 'measurement-plan.discover', usage, message: '--rule is required',
      })
      const maxUrlsValue = getString(input.values, 'max-urls')
      const maxUrls = maxUrlsValue === undefined ? undefined : Number(maxUrlsValue)
      if (maxUrls !== undefined && (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > 10_000)) {
        throw usageError('--max-urls must be an integer from 1 to 10000')
      }
      return discoverMeasurementTargets(project, sitemapUrl, rule, maxUrls)
    },
  },
  {
    path: ['measurement-plan', 'report'],
    usage: 'canonry measurement-plan report <project> --revision N [--format json]',
    options: { revision: stringOption() },
    run: input => {
      const project = requireProject(input, 'measurement-plan.report', 'canonry measurement-plan report <project> --revision N')
      const value = getString(input.values, 'revision')
      const revision = value === undefined ? undefined : Number(value)
      if (revision === undefined || !Number.isInteger(revision) || revision <= 0) {
        throw usageError('--revision must be a positive integer')
      }
      return showMeasurementReport(project, revision)
    },
  },
  {
    path: ['measurement-plan', 'property'],
    usage: 'canonry measurement-plan property <project> --target-key <key> [--query-class all|branded|non-brand] [--provider <p>] [--location <l>] [--run-id <id>] [--format json]',
    options: PROPERTY_SCOPE_OPTIONS,
    run: input => {
      const usage = 'canonry measurement-plan property <project> --target-key <key>'
      const project = requireProject(input, 'measurement-plan.property', usage)
      return showMeasurementProperty(project, propertyScope(input, 'measurement-plan.property', usage))
    },
  },
  {
    path: ['measurement-plan', 'property-evidence'],
    usage: 'canonry measurement-plan property-evidence <project> --target-key <key> [--query-class all|branded|non-brand] [--provider <p>] [--location <l>] [--run-id <id>] [--cursor <c>] [--limit N] [--format json|jsonl]',
    options: { ...PROPERTY_SCOPE_OPTIONS, cursor: stringOption(), limit: stringOption() },
    run: input => {
      const usage = 'canonry measurement-plan property-evidence <project> --target-key <key>'
      const project = requireProject(input, 'measurement-plan.property-evidence', usage)
      const limitValue = getString(input.values, 'limit')
      const limit = limitValue === undefined ? undefined : Number(limitValue)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        throw usageError('--limit must be an integer from 1 to 100')
      }
      return showMeasurementPropertyEvidence(project, {
        ...propertyScope(input, 'measurement-plan.property-evidence', usage),
        cursor: getString(input.values, 'cursor'),
        ...(limit === undefined ? {} : { limit }),
      })
    },
  },
]
