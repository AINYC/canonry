import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  TrafficConnectCloudflareRequest,
  TrafficConnectCloudflareResponse,
} from '@ainyc/canonry-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli-error.js'
import type { CanonryConfig } from '../src/config.js'
import { trafficConnectCloudflare } from '../src/commands/traffic.js'

const response: TrafficConnectCloudflareResponse = {
  sourceId: 'source-cloudflare-test',
  deliveryMode: 'direct-push',
  workerScript: 'export default { async fetch(request, env) { return fetch(request) } }',
  wranglerToml: 'main = "worker.js"\n[secrets]\nrequired = ["CANONRY_BEARER_TOKEN", "CANONRY_HMAC_SECRET"]\n',
  workerVersion: '1.0.0',
  instructions: 'Attach `example.com/*` manually. Set Request limit failure mode to Fail open before activation.',
}

const scratchDirectories: string[] = []

function scratch(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cloudflare-command-test-'))
  scratchDirectories.push(directory)
  return directory
}

function localConfig(bearerToken: string, hmacSecret: string): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    cloudflareTraffic: {
      connections: [{
        projectName: 'demo',
        sourceId: response.sourceId,
        deliveryMode: 'direct-push',
        bearerToken,
        hmacSecret,
        workerVersion: response.workerVersion,
        expectedBotListVersion: '2026-08-09',
        zoneId: 'zone_test',
        accountId: null,
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }],
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of scratchDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('trafficConnectCloudflare', () => {
  it('emits only a sanitized summary and writes no local secret to either artifact', async () => {
    const bearerToken = 'cnry_cfw_command-bearer-secret'
    const hmacSecret = 'command-hmac-secret'
    const outputDirectory = path.join(scratch(), 'worker')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      outputDirectory,
      format: 'json',
    }, {
      client: { trafficConnectCloudflare: async () => response },
      loadLocalConfig: () => localConfig(bearerToken, hmacSecret),
    })

    const stdout = logs.join('\n')
    const workerScript = fs.readFileSync(path.join(outputDirectory, 'worker.js'), 'utf-8')
    const wranglerToml = fs.readFileSync(path.join(outputDirectory, 'wrangler.toml'), 'utf-8')
    for (const output of [stdout, workerScript, wranglerToml]) {
      expect(output).not.toContain(bearerToken)
      expect(output).not.toContain(hmacSecret)
    }
    expect(stdout).not.toContain(response.workerScript)
    expect(JSON.parse(stdout)).toMatchObject({
      sourceId: response.sourceId,
      deliveryMode: 'direct-push',
      deployment: 'not-requested',
      routeAttachment: 'required-manual',
      autoDeployAvailable: true,
      requestLimitFailureMode: {
        required: 'fail-open',
        status: 'required-during-manual-route-attachment',
        configuredBy: 'cloudflare-dashboard',
        configuredByWrangler: false,
      },
    })
  })

  it('passes the account id to the connect API', async () => {
    let request: TrafficConnectCloudflareRequest | undefined
    await trafficConnectCloudflare('demo', {
      accountId: 'account_test',
      zoneId: 'zone_test',
      outputDirectory: path.join(scratch(), 'worker'),
      format: 'json',
    }, {
      client: {
        trafficConnectCloudflare: async (_project, body) => {
          request = body
          return response
        },
      },
      loadLocalConfig: () => localConfig('bearer', 'hmac'),
    })

    expect(request).toMatchObject({
      deliveryMode: 'direct-push',
      accountId: 'account_test',
      zoneId: 'zone_test',
    })
  })

  it('requires an explicit Fail open acknowledgement before deployment', async () => {
    await expect(trafficConnectCloudflare('demo', {
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
    }, {
      client: { trafficConnectCloudflare: async () => response },
    })).rejects.toMatchObject({
      code: 'TRAFFIC_CLOUDFLARE_FAIL_OPEN_CONFIRMATION_REQUIRED',
    })
  })

  it('does not connect when Wrangler lacks a required deploy flag', async () => {
    const outputDirectory = path.join(scratch(), 'worker')
    let connectCalled = false

    await expect(trafficConnectCloudflare('demo', {
      outputDirectory,
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
      confirmFailOpen: true,
    }, {
      client: {
        trafficConnectCloudflare: async () => {
          connectCalled = true
          return response
        },
      },
      preflightWrangler: async () => { throw new Error('missing --secrets-file') },
    })).rejects.toMatchObject({
      code: 'TRAFFIC_CLOUDFLARE_WRANGLER_UNSUPPORTED',
    })

    expect(connectCalled).toBe(false)
    expect(fs.existsSync(outputDirectory)).toBe(false)
  })

  it('prints the Fail open and source-overlap requirements', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      outputDirectory: path.join(scratch(), 'worker'),
    }, {
      client: { trafficConnectCloudflare: async () => response },
      loadLocalConfig: () => localConfig('bearer', 'hmac'),
    })

    expect(logs.join('\n')).toMatch(/Request limit failure mode to Fail open/)
    expect(logs.join('\n')).toMatch(/Overlapping adapters double-count/)
  })

  it('deploys the Worker without claiming a route and prints the exact manual steps', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.join(' ')))

    await trafficConnectCloudflare('demo', {
      outputDirectory: path.join(scratch(), 'worker'),
      zoneId: 'zone_test',
      deploy: true,
      confirmRoute: true,
      confirmFailOpen: true,
    }, {
      client: { trafficConnectCloudflare: async () => response },
      loadLocalConfig: () => localConfig('bearer', 'hmac'),
      preflightWrangler: async () => {},
      deployWorker: async () => {},
    })

    const stdout = logs.join('\n')
    expect(stdout).toContain('Worker deployed; route not attached')
    expect(stdout).toContain('Attach `example.com/*` manually')
    expect(stdout).toContain('Request limit failure mode to Fail open before activation')
  })

  it('writes artifacts but refuses auto-deploy when the CLI cannot read server credentials', async () => {
    const outputDirectory = path.join(scratch(), 'worker')
    let deployCalled = false
    let thrown: unknown

    try {
      await trafficConnectCloudflare('demo', {
        outputDirectory,
        zoneId: 'zone_test',
        deploy: true,
        confirmRoute: true,
        confirmFailOpen: true,
      }, {
        client: { trafficConnectCloudflare: async () => response },
        loadLocalConfig: () => null,
        preflightWrangler: async () => {},
        deployWorker: async () => { deployCalled = true },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe('TRAFFIC_CLOUDFLARE_DEPLOY_CONFIG_UNSHARED')
    expect((thrown as CliError).displayMessage).toMatch(/server operator/i)
    expect(deployCalled).toBe(false)
    expect(fs.existsSync(path.join(outputDirectory, 'worker.js'))).toBe(true)
    expect(fs.existsSync(path.join(outputDirectory, 'wrangler.toml'))).toBe(true)
  })
})
