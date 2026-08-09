import {
  technicalAeoCrawl,
  technicalAeoCrawlPages,
  technicalAeoDeadLinks,
  technicalAeoInternalLinks,
  technicalAeoLinkNeighbors,
  technicalAeoPages,
  technicalAeoRun,
  technicalAeoScore,
  technicalAeoStructure,
  technicalAeoTrend,
} from '../commands/technical-aeo.js'
import { usageError } from '../cli-error.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  stringOption,
} from '../cli-command-helpers.js'

function parseOptionalBoolean(
  input: CliCommandInput,
  key: string,
  config: { command: string; usage: string },
): boolean | undefined {
  const value = getString(input.values, key)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw usageError(`Error: --${key} must be true or false\nUsage: ${config.usage}`, {
    message: `--${key} must be true or false`,
    details: { command: config.command, usage: config.usage, option: key, value },
  })
}

export const TECHNICAL_AEO_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['technical-aeo', 'score'],
    usage: 'canonry technical-aeo score <project> [--run-id <id>] [--format json]',
    options: {
      'run-id': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'technical-aeo.score',
        'canonry technical-aeo score <project> [--run-id <id>] [--format json]',
      )
      await technicalAeoScore(project, { runId: getString(input.values, 'run-id'), format: input.format })
    },
  },
  {
    path: ['technical-aeo', 'pages'],
    usage: 'canonry technical-aeo pages <project> [--run-id <id>] [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      status: stringOption(),
      sort: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo pages <project> [--run-id <id>] [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.pages', usage)
      await technicalAeoPages(project, {
        runId: getString(input.values, 'run-id'),
        status: getString(input.values, 'status'),
        sort: getString(input.values, 'sort'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.pages',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'trend'],
    usage: 'canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.trend', usage)
      await technicalAeoTrend(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.trend',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'run'],
    usage: 'canonry technical-aeo run <project> [--sitemap-url <url>] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--check-dead-links] [--wait] [--format json]',
    options: {
      'sitemap-url': stringOption(),
      limit: stringOption(),
      'max-pages': stringOption(),
      'max-edges': stringOption(),
      'max-depth': stringOption(),
      'check-dead-links': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo run <project> [--sitemap-url <url>] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--check-dead-links] [--wait] [--format json]'
      const project = requireProject(input, 'technical-aeo.run', usage)
      await technicalAeoRun(project, {
        sitemapUrl: getString(input.values, 'sitemap-url'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.run',
          usage,
          message: '--limit must be an integer',
        }),
        maxPages: parseIntegerOption(input, 'max-pages', {
          command: 'technical-aeo.run', usage, message: '--max-pages must be an integer',
        }),
        maxEdges: parseIntegerOption(input, 'max-edges', {
          command: 'technical-aeo.run', usage, message: '--max-edges must be an integer',
        }),
        maxDepth: parseIntegerOption(input, 'max-depth', {
          command: 'technical-aeo.run', usage, message: '--max-depth must be an integer',
        }),
        checkDeadLinks: getBoolean(input.values, 'check-dead-links'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'crawl'],
    usage: 'canonry technical-aeo crawl <project> [--run-id <id>] [--format json]',
    options: { 'run-id': stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo crawl <project> [--run-id <id>] [--format json]'
      const project = requireProject(input, 'technical-aeo.crawl', usage)
      await technicalAeoCrawl(project, { runId: getString(input.values, 'run-id'), format: input.format })
    },
  },
  {
    path: ['technical-aeo', 'crawl-pages'],
    usage: 'canonry technical-aeo crawl-pages <project> [--run-id <id>] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      'inventory-eligible': stringOption(),
      'fetch-state': stringOption(),
      'indexability-state': stringOption(),
      'audit-state': stringOption(),
      sort: stringOption(),
      cursor: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo crawl-pages <project> [--run-id <id>] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.crawl-pages', usage)
      const sort = getString(input.values, 'sort')
      if (sort !== undefined && !['url', 'path', 'score-asc', 'score-desc'].includes(sort)) {
        throw usageError(`Error: --sort must be url, path, score-asc, or score-desc\nUsage: ${usage}`, {
          message: '--sort must be url, path, score-asc, or score-desc',
          details: { command: 'technical-aeo.crawl-pages', usage, option: 'sort', value: sort },
        })
      }
      await technicalAeoCrawlPages(project, {
        runId: getString(input.values, 'run-id'),
        inventoryEligible: parseOptionalBoolean(input, 'inventory-eligible', { command: 'technical-aeo.crawl-pages', usage }),
        fetchState: getString(input.values, 'fetch-state'),
        indexabilityState: getString(input.values, 'indexability-state'),
        auditState: getString(input.values, 'audit-state'),
        sort: sort as 'url' | 'path' | 'score-asc' | 'score-desc' | undefined,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.crawl-pages', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'structure'],
    usage: 'canonry technical-aeo structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: { 'run-id': stringOption(), 'parent-path': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.structure', usage)
      await technicalAeoStructure(project, {
        runId: getString(input.values, 'run-id'),
        parentPath: getString(input.values, 'parent-path'),
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.structure', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'links'],
    usage: 'canonry technical-aeo links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      'source-url': stringOption(),
      'target-url': stringOption(),
      followable: { type: 'boolean', default: false },
      nofollow: { type: 'boolean', default: false },
      cursor: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.links', usage)
      const followable = getBoolean(input.values, 'followable')
      const nofollow = getBoolean(input.values, 'nofollow')
      if (followable && nofollow) {
        throw usageError(`Error: --followable and --nofollow cannot be combined\nUsage: ${usage}`, {
          message: '--followable and --nofollow cannot be combined',
          details: { command: 'technical-aeo.links', usage },
        })
      }
      await technicalAeoInternalLinks(project, {
        runId: getString(input.values, 'run-id'),
        sourceUrl: getString(input.values, 'source-url'),
        targetUrl: getString(input.values, 'target-url'),
        followable: followable ? true : nofollow ? false : undefined,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.links', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'links', 'neighbors'],
    usage: 'canonry technical-aeo links neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]',
    options: { 'run-id': stringOption(), 'node-key': stringOption(), url: stringOption(), limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo links neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]'
      const project = requireProject(input, 'technical-aeo.links.neighbors', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (!nodeKey && !url) {
        throw usageError(`Error: --node-key or --url is required\nUsage: ${usage}`, {
          message: '--node-key or --url is required', details: { command: 'technical-aeo.links.neighbors', usage },
        })
      }
      await technicalAeoLinkNeighbors(project, {
        runId: getString(input.values, 'run-id'),
        nodeKey,
        url,
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.links.neighbors', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'dead-links'],
    usage: 'canonry technical-aeo dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: { 'run-id': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.dead-links', usage)
      await technicalAeoDeadLinks(project, {
        runId: getString(input.values, 'run-id'),
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.dead-links', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
]
