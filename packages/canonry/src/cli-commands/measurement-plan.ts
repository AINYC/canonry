import {
  discoverMeasurementTargets,
  listMeasurementPlanVersions,
  publishMeasurementPlan,
  retireMeasurementPlanSegment,
  showMeasurementPlan,
  showMeasurementReport,
} from '../commands/measurement-plan.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, requireStringOption, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

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
]
