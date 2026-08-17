import { describe, expect, it } from 'vitest'
import {
  createGoogleMarketingDoctorChecks,
  evaluateGoogleMarketingDoctor,
  googleMarketingDoctorInputFromRows,
  type GoogleMarketingDoctorInput,
} from '../src/doctor/checks/google-marketing.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'

const NOW = new Date('2026-08-14T12:00:00.000Z')
const project: ProjectInfo = {
  id: 'project-1',
  name: 'demo',
  canonicalDomain: 'example.com',
  displayName: 'Demo',
}

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

function healthyInput(): GoogleMarketingDoctorInput {
  return {
    googleAds: {
      credentialsPresent: true,
      grantedScopes: ['https://www.googleapis.com/auth/adwords'],
      selectedLoginCustomerId: '1111111111',
      selectedCustomerId: '2222222222',
      latestSnapshotAt: isoDaysAgo(1),
    },
    gtm: {
      credentialsPresent: true,
      grantedScopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
      selectedAccountId: 'acct-1',
      selectedContainerId: 'container-1',
      selectedWorkspaceId: 'workspace-1',
      latestSnapshotAt: isoDaysAgo(1),
    },
  }
}

function ctx(): DoctorContext {
  return { db: {} as DoctorContext['db'], project }
}

async function outputFor(
  input: GoogleMarketingDoctorInput | null | undefined,
  id: string,
  context: DoctorContext = ctx(),
) {
  const check = createGoogleMarketingDoctorChecks(() => input, () => NOW)
    .find(item => item.id === id)
  if (!check) throw new Error(`Missing test check: ${id}`)
  return check.run(context)
}

describe('Google marketing Doctor checks', () => {
  it('maps DB-shaped rows without reading credential values and selects the newest Ads snapshot', () => {
    const input = googleMarketingDoctorInputFromRows({
      credentials: { googleAds: true, gtm: false },
      googleAds: {
        selectedLoginCustomerId: '1111111111',
        selectedCustomerId: '2222222222',
        scopes: ['https://www.googleapis.com/auth/adwords'],
        lastInventorySnapshotAt: isoDaysAgo(9),
        lastMetricsSnapshotAt: isoDaysAgo(1),
      },
      gtm: {
        selectedAccountId: 'acct-1',
        selectedContainerId: 'container-1',
        selectedWorkspaceId: null,
        scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
        lastSnapshotAt: isoDaysAgo(2),
      },
    })

    expect(input.googleAds).toMatchObject({
      credentialsPresent: true,
      latestSnapshotAt: isoDaysAgo(1),
    })
    expect(input.gtm).toMatchObject({ credentialsPresent: false, latestSnapshotAt: isoDaysAgo(2) })
    expect(Object.keys(input.googleAds ?? {})).not.toContain('accessToken')
    expect(Object.keys(input.gtm ?? {})).not.toContain('refreshToken')

    const malformed = googleMarketingDoctorInputFromRows({
      credentials: { googleAds: true, gtm: false },
      googleAds: {
        selectedLoginCustomerId: null,
        selectedCustomerId: null,
        scopes: [],
        lastInventorySnapshotAt: 'invalid-date',
        lastMetricsSnapshotAt: isoDaysAgo(1),
      },
      gtm: null,
    })
    expect(malformed.googleAds?.latestSnapshotAt).toBe('invalid-date')
  })

  it('reports the complete healthy read-only configuration and the GTM runtime limitation', () => {
    const outputs = evaluateGoogleMarketingDoctor(healthyInput(), NOW)
    expect(outputs.map(output => output.code)).toEqual([
      'google-ads.auth.credentials-metadata-present',
      'google-ads.auth.scopes-ok',
      'google-ads.account.context-selected',
      'google-ads.data.snapshot-fresh',
      'gtm.auth.credentials-metadata-present',
      'gtm.auth.scopes-ok',
      'gtm.container.context-selected',
      'gtm.data.snapshot-fresh',
      'gtm.runtime.firing-not-proven',
    ])
    expect(outputs.every(output => output.status === 'ok' || output.status === 'skipped')).toBe(true)
    expect(outputs.at(-1)).toMatchObject({
      status: 'skipped',
      summary: expect.stringContaining('does not prove that a tag fired'),
      details: { runtimeFiringProven: false },
    })
  })

  it('never calls fetch while running registry-shaped checks', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('Doctor must not call providers')
    }) as typeof fetch
    try {
      const checks = createGoogleMarketingDoctorChecks(() => healthyInput(), () => NOW)
      await Promise.all(checks.map(check => check.run(ctx())))
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetchCalls).toBe(0)
  })

  it('skips all configured checks when the typed status source is unavailable', async () => {
    const check = createGoogleMarketingDoctorChecks(() => undefined, () => NOW)
    const outputs = await Promise.all(check.map(item => item.run(ctx())))
    expect(outputs.every(output => output.status === 'skipped')).toBe(true)
    expect(new Set(outputs.map(output => output.code))).toEqual(new Set(['google-marketing.status-unavailable']))
  })

  it('skips all configured checks without a project context', async () => {
    const check = createGoogleMarketingDoctorChecks(() => healthyInput(), () => NOW)
    const noProject: DoctorContext = { db: {} as DoctorContext['db'], project: null }
    const outputs = await Promise.all(check.map(item => item.run(noProject)))
    expect(new Set(outputs.map(output => output.code))).toEqual(new Set(['google-marketing.no-project']))
  })

  it.each([
    ['Google Ads', 'google-ads.auth.connection', 'googleAds', 'google-ads.auth.not-connected'],
    ['GTM', 'gtm.auth.connection', 'gtm', 'gtm.auth.not-connected'],
  ] as const)('%s reports an unconfigured project without inventing credential state', async (_label, id, provider, code) => {
    const input = healthyInput()
    input[provider] = null
    const output = await outputFor(input, id)
    expect(output).toMatchObject({ status: 'skipped', code })
    expect(output.details).toHaveProperty('requiredScopes')
  })

  it.each([
    ['googleAds', 'google-ads.auth.connection', 'google-ads.auth.credentials-metadata-missing'],
    ['gtm', 'gtm.auth.connection', 'gtm.auth.credentials-metadata-missing'],
  ] as const)('%s reports boolean-only credential metadata absence', async (provider, id, code) => {
    const input = healthyInput()
    input[provider]!.credentialsPresent = false
    const output = await outputFor(input, id)
    expect(output).toMatchObject({ status: 'fail', code, details: { credentialsPresent: false } })
    expect(Object.keys(output.details ?? {})).toEqual(['credentialsPresent'])
  })

  it.each([
    ['googleAds', 'google-ads.auth.scopes', 'google-ads.auth.required-scope-missing'],
    ['gtm', 'gtm.auth.scopes', 'gtm.auth.required-scope-missing'],
  ] as const)('%s identifies each missing required OAuth scope', async (provider, id, code) => {
    const input = healthyInput()
    input[provider]!.grantedScopes = []
    const output = await outputFor(input, id)
    expect(output).toMatchObject({ status: 'fail', code })
    expect(output.details).toMatchObject({ grantedScopes: [], missingScopes: expect.any(Array) })
  })

  it('does not describe the broad Google Ads OAuth scope as read-only', async () => {
    const ads = await outputFor(healthyInput(), 'google-ads.auth.scopes')
    const gtm = await outputFor(healthyInput(), 'gtm.auth.scopes')

    expect(ads.summary).toBe('Google Ads has the required OAuth scope.')
    expect(ads.summary).not.toContain('read-only')
    expect(gtm.summary).toBe('Google Tag Manager has the required read-only OAuth scope.')
  })

  it('checks the selected Ads login/customer context and GTM account/container/workspace context', async () => {
    const adsMissing = healthyInput()
    adsMissing.googleAds!.selectedCustomerId = null
    await expect(outputFor(adsMissing, 'google-ads.account.context')).resolves.toMatchObject({
      status: 'fail',
      code: 'google-ads.account.customer-not-selected',
      details: { loginCustomerId: '1111111111', customerId: null },
    })

    const gtmNoContainer = healthyInput()
    gtmNoContainer.gtm!.selectedContainerId = null
    await expect(outputFor(gtmNoContainer, 'gtm.container.context')).resolves.toMatchObject({
      status: 'fail',
      code: 'gtm.container.account-or-container-not-selected',
    })

    const gtmNoWorkspace = healthyInput()
    gtmNoWorkspace.gtm!.selectedWorkspaceId = null
    await expect(outputFor(gtmNoWorkspace, 'gtm.container.context')).resolves.toMatchObject({
      status: 'warn',
      code: 'gtm.container.workspace-not-selected',
      details: { accountId: 'acct-1', containerId: 'container-1', workspaceId: null },
    })
  })

  it.each([
    [null, 'snapshot-never-captured', 'warn'],
    ['invalid-date', 'snapshot-timestamp-invalid', 'fail'],
    [new Date(NOW.getTime() + 60_000).toISOString(), 'snapshot-in-future', 'warn'],
    [isoDaysAgo(31), 'snapshot-stale', 'fail'],
    [isoDaysAgo(8), 'snapshot-aging', 'warn'],
  ] as const)('grades Google Ads snapshot freshness (%s)', async (latestSnapshotAt, suffix, status) => {
    const input = healthyInput()
    input.googleAds!.latestSnapshotAt = latestSnapshotAt
    const output = await outputFor(input, 'google-ads.data.recent-snapshot')
    expect(output).toMatchObject({ status, code: `google-ads.data.${suffix}` })
  })

  it.each([
    [null, 'snapshot-never-captured', 'warn'],
    ['invalid-date', 'snapshot-timestamp-invalid', 'fail'],
    [new Date(NOW.getTime() + 60_000).toISOString(), 'snapshot-in-future', 'warn'],
    [isoDaysAgo(31), 'snapshot-stale', 'fail'],
    [isoDaysAgo(8), 'snapshot-aging', 'warn'],
  ] as const)('grades GTM snapshot freshness (%s)', async (latestSnapshotAt, suffix, status) => {
    const input = healthyInput()
    input.gtm!.latestSnapshotAt = latestSnapshotAt
    const output = await outputFor(input, 'gtm.data.recent-snapshot')
    expect(output).toMatchObject({ status, code: `gtm.data.${suffix}` })
  })

  it('keeps the GTM runtime-firing warning explicit even when configuration is healthy', async () => {
    const output = await outputFor(healthyInput(), 'gtm.runtime.firing')
    expect(output).toMatchObject({
      status: 'skipped',
      code: 'gtm.runtime.firing-not-proven',
      summary: 'GTM API configuration does not prove that a tag fired in a real browser session.',
    })
  })

  it('does not claim a GTM runtime result when GTM is not connected', async () => {
    const input = healthyInput()
    input.gtm = null
    await expect(outputFor(input, 'gtm.runtime.firing')).resolves.toMatchObject({
      status: 'skipped',
      code: 'gtm.runtime.not-connected',
    })
  })
})
