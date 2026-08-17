import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { createGoogleMarketingCliCommands } from '../src/cli-commands/google-marketing.js'
import { REGISTERED_CLI_COMMANDS } from '../src/cli-commands.js'
import type { GoogleMarketingCliClient } from '../src/commands/google-marketing.js'

function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = ''
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk)
    return true
  })
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output += `${args.map(String).join(' ')}\n`
  })
  return fn().finally(() => {
    writeSpy.mockRestore()
    logSpy.mockRestore()
  }).then(() => output)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Google Marketing CLI', () => {
  it('registers separate Google Ads, GTM, and conversion-contract namespaces', () => {
    const commandIds = REGISTERED_CLI_COMMANDS.map(command => command.path.join(' '))
    expect(commandIds).toEqual(expect.arrayContaining([
      'google-ads status',
      'google-ads customers',
      'google-ads sync',
      'gtm accounts',
      'gtm workspaces',
      'gtm sync',
      'conversion-tracking contracts integrity',
    ]))
    expect(commandIds).not.toContain('ads google-status')
    expect(commandIds).not.toContain('google-ads connect')
    expect(commandIds).not.toContain('gtm connect')
  })

  it('streams live Google Ads discovery as JSONL without mixing it into OpenAI ads', async () => {
    const client = {
      listGoogleAdsCustomers: vi.fn().mockResolvedValue({
        customers: [{ customerId: '123-456-7890', descriptiveName: 'Example Hotel', manager: false, status: 'enabled' }],
        totalAccessible: 1,
        truncated: false,
        fetchedAt: '2026-08-14T12:00:00.000Z',
      }),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const output = await captureStdout(async () => {
      await dispatchRegisteredCommand(['google-ads', 'customers', 'example', '--format', 'jsonl'], 'text', commands)
    })

    expect(client.listGoogleAdsCustomers).toHaveBeenCalledWith('example')
    expect(output.trim()).toBe(JSON.stringify({
      project: 'example',
      fetchedAt: '2026-08-14T12:00:00.000Z',
      customerId: '123-456-7890',
      descriptiveName: 'Example Hotel',
      manager: false,
      status: 'enabled',
    }))
  })

  it('normalizes returned GTM resource paths before container and workspace reads', async () => {
    const client = {
      listGtmContainers: vi.fn().mockResolvedValue({
        accountId: '1', containers: [], totalAccessible: 0, truncated: false,
        fetchedAt: '2026-08-14T12:00:00.000Z',
      }),
      listGtmWorkspaces: vi.fn().mockResolvedValue({
        accountId: '1', containerId: '2', workspaces: [], totalAccessible: 0, truncated: false,
        fetchedAt: '2026-08-14T12:00:00.000Z',
      }),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    await captureStdout(async () => {
      await dispatchRegisteredCommand([
        'gtm', 'containers', 'example', '--account', 'accounts/1', '--format', 'json',
      ], 'text', commands)
      await dispatchRegisteredCommand([
        'gtm', 'workspaces', 'example', '--account', 'accounts/1',
        '--container', 'accounts/1/containers/2', '--format', 'json',
      ], 'text', commands)
    })

    expect(client.listGtmContainers).toHaveBeenCalledWith('example', '1')
    expect(client.listGtmWorkspaces).toHaveBeenCalledWith('example', '1', '2')
  })

  it('keeps contract integrity agent-friendly as findings JSONL', async () => {
    const client = {
      getConversionTrackingIntegrity: vi.fn().mockResolvedValue({
        assessment: {
          contract: { id: 'contract_purchase' },
          status: 'runtime-unverified',
          evaluatedAt: '2026-08-14T12:00:00.000Z',
          findings: [{
            code: 'runtime-event-not-observed',
            subject: 'purchase',
            outcome: 'unknown',
            status: 'runtime-unverified',
            evidenceIds: [],
          }],
        },
      }),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const output = await captureStdout(async () => {
      await dispatchRegisteredCommand([
        'conversion-tracking', 'contracts', 'integrity', 'example', 'contract_purchase', '--format', 'jsonl',
      ], 'text', commands)
    })

    expect(client.getConversionTrackingIntegrity).toHaveBeenCalledWith('example', 'contract_purchase')
    expect(output.trim()).toBe(JSON.stringify({
      project: 'example',
      contractId: 'contract_purchase',
      integrityStatus: 'runtime-unverified',
      evaluatedAt: '2026-08-14T12:00:00.000Z',
      code: 'runtime-event-not-observed',
      subject: 'purchase',
      outcome: 'unknown',
      status: 'runtime-unverified',
      evidenceIds: [],
    }))
  })
})
