import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversionTrackingContract } from '@ainyc/canonry-contracts'

import {
  ConversionIntegritySection,
  conversionIntegrityPrimaryAction,
  type ConversionIntegrityWorkspaceVm,
} from '../src/components/project/ConversionIntegritySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'

const contract: ConversionTrackingContract = {
  id: 'contract_checkout',
  projectId: 'project_hotel',
  name: 'Booking completed',
  eventName: 'booking_complete',
  googleAds: {
    customerId: '1234567890',
    conversionActionId: '9876543210',
    conversionId: '1234567890',
    conversionLabel: 'booking-complete',
    campaignIds: ['campaign-brand'],
    requireBiddableGoal: true,
    requirePrimaryAction: true,
  },
  gtm: {
    accountId: 'account_1',
    containerId: 'container_1',
    tagId: 'tag_booking_complete',
    triggerIds: ['trigger_booking_complete'],
    variableIds: ['value', 'transaction_id', 'currency'],
  },
  runtime: {
    verificationRequired: true,
    requireTransactionId: true,
    requireValue: true,
    requireCurrency: true,
    productionHosts: ['example.com'],
  },
  createdAt: '2026-08-14T10:00:00.000Z',
  updatedAt: '2026-08-14T10:00:00.000Z',
}

afterEach(() => {
  cleanup()
})

function workspace(overrides: Partial<ConversionIntegrityWorkspaceVm> = {}): ConversionIntegrityWorkspaceVm {
  return {
    contract,
    assessment: {
      contract,
      status: 'runtime-unverified',
      evaluatedAt: '2026-08-14T12:00:00.000Z',
      findings: [
        {
          code: 'runtime-event-not-observed',
          subject: 'booking_complete',
          outcome: 'unknown',
          status: 'runtime-unverified',
          evidenceIds: ['snapshot_gtm_1'],
        },
      ],
    },
    googleAds: {
      state: 'connected',
      selection: 'Example Hotel',
      snapshotCount: 2,
      evidence: 'Selected customer and conversion-goal inventory are stored.',
      lastSnapshotAt: '2026-08-14T11:00:00.000Z',
    },
    gtm: {
      state: 'connected',
      selection: 'Example Hotel web container',
      snapshotCount: 3,
      evidence: 'Live container graph is stored for the selected container.',
      lastSnapshotAt: '2026-08-14T11:05:00.000Z',
    },
    snapshots: [
      { id: 'snapshot_gtm_1', provider: 'gtm', kind: 'live', capturedAt: '2026-08-14T11:05:00.000Z' },
      { id: 'snapshot_ads_1', provider: 'google-ads', kind: 'inventory', capturedAt: '2026-08-14T11:00:00.000Z' },
    ],
    ...overrides,
  }
}

describe('ConversionIntegritySection', () => {
  test('shows one honest readiness state and keeps runtime proof distinct from static evidence', () => {
    render(<ConversionIntegritySection workspace={workspace()} />)

    expect(screen.getByRole('heading', { name: 'Conversion Integrity' })).toBeTruthy()
    expect(screen.getByText('Runtime verification needed')).toBeTruthy()
    expect(screen.getByText('Booking completed')).toBeTruthy()
    expect(screen.getAllByText('booking_complete')).toHaveLength(2)
    expect(screen.getByText('Static API evidence does not prove that a browser tag fired or that Google Ads recorded a conversion.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review runtime verification' }).getAttribute('href')).toBe('#conversion-integrity-runtime-guidance')
    expect(screen.getByText('Latest sanitized snapshots')).toBeTruthy()
  })

  test('surfaces a configured static mismatch, exact assessment anchors, and a review-findings action', () => {
    const onPrimaryAction = vi.fn()
    const longContract = {
      ...contract,
      name: 'Booking completed after a very long checkout journey that must not force the conversion header to overflow its section',
    }
    render(
      <ConversionIntegritySection
        workspace={workspace({
          contract: longContract,
          assessment: {
            contract: longContract,
            status: 'configured',
            evaluatedAt: '2026-08-14T12:00:00.000Z',
            findings: [
              {
                code: 'ads-goal-not-biddable',
                subject: 'Booking completed',
                outcome: 'fail',
                status: 'configured',
                evidenceIds: ['snapshot_ads_mismatch'],
              },
              {
                code: 'gtm-tag-missing',
                subject: 'tag_booking_complete',
                outcome: 'fail',
                status: 'configured',
                evidenceIds: ['snapshot_gtm_mismatch'],
              },
              {
                code: 'ads-action-not-primary',
                subject: 'Booking completed',
                outcome: 'pass',
                status: 'configured',
                evidenceIds: ['snapshot_ads_mismatch'],
              },
            ],
          },
          assessmentEvidenceSnapshots: [
            { id: 'snapshot_ads_mismatch', provider: 'google-ads', kind: 'inventory', capturedAt: '2026-08-14T11:00:00.000Z' },
            { id: 'snapshot_gtm_mismatch', provider: 'gtm', kind: 'live', capturedAt: '2026-08-14T11:05:00.000Z' },
          ],
        })}
        onPrimaryAction={onPrimaryAction}
      />,
    )

    expect(screen.getByText('Static mismatch')).toBeTruthy()
    expect(screen.getByText('Mismatch')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Checks to review' })).toBeTruthy()
    expect(screen.getByText('Google Ads goal is available for bidding')).toBeTruthy()
    expect(screen.getByText('Required Tag Manager tag exists')).toBeTruthy()
    expect(screen.getByText('Diagnostic: ads-goal-not-biddable')).toBeTruthy()
    expect(screen.getAllByText('Evidence: snapshot_ads_mismatch')).toHaveLength(2)
    expect(screen.getByText('Evidence: snapshot_gtm_mismatch')).toBeTruthy()
    const provenance = screen.getByText('Evidence used for this assessment').closest('details')
    expect(provenance?.open).toBe(false)
    expect(provenance?.textContent).toContain('Google Ads inventory, captured')
    expect(provenance?.textContent).toContain('Tag Manager live, captured')

    const passingChecks = screen.getByText('1 passing check from the latest assessment').closest('details')
    expect(passingChecks?.open).toBe(false)
    expect(screen.getByRole('heading', { name: longContract.name }).className).toContain('min-w-0')
    expect(screen.getByRole('heading', { name: longContract.name }).className).toContain('break-words')

    fireEvent.click(screen.getByRole('button', { name: 'Review findings' }))
    expect(onPrimaryAction).toHaveBeenCalledWith('review-findings')
  })

  test('keeps runtime verification as the primary action while surfacing its unknown check', () => {
    const onPrimaryAction = vi.fn()
    render(<ConversionIntegritySection workspace={workspace()} onPrimaryAction={onPrimaryAction} />)

    expect(screen.getByText('Website event was observed')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Runtime verification checklist' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review findings' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review runtime verification' }))
    expect(onPrimaryAction).toHaveBeenCalledWith('review-runtime-verification')
  })

  test('offers explicit connected-provider changes and another conversion without replacing the current contract', () => {
    const changeGoogleAdsSelection = vi.fn()
    const changeGtmSelection = vi.fn()
    const addContract = vi.fn()
    render(
      <ConversionIntegritySection
        workspace={workspace()}
        contracts={[contract]}
        onChangeGoogleAdsSelection={changeGoogleAdsSelection}
        onChangeGtmSelection={changeGtmSelection}
        onAddContract={addContract}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change Google Ads account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Change Tag Manager container' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add conversion' }))

    expect(changeGoogleAdsSelection).toHaveBeenCalledTimes(1)
    expect(changeGtmSelection).toHaveBeenCalledTimes(1)
    expect(addContract).toHaveBeenCalledTimes(1)
  })

  test('keeps connected-provider changes and adding conversions write-gated for a viewer', () => {
    render(
      <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
        <ConversionIntegritySection
          workspace={workspace()}
          contracts={[contract]}
          onChangeGoogleAdsSelection={vi.fn()}
          onChangeGtmSelection={vi.fn()}
          onAddContract={vi.fn()}
        />
      </AccountProvider>,
    )

    expect(screen.getByRole('button', { name: 'Change Google Ads account' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Change Tag Manager container' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add conversion' }).hasAttribute('disabled')).toBe(true)
  })

  test('uses a single primary action, selected by the first unresolved provider step', () => {
    const action = vi.fn()
    const unconnected = workspace({
      contract: null,
      assessment: null,
      googleAds: {
        state: 'not-connected',
        selection: null,
        snapshotCount: 0,
        evidence: 'No stored evidence yet.',
        lastSnapshotAt: null,
      },
    })
    render(<ConversionIntegritySection workspace={unconnected} onPrimaryAction={action} />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Ads' }))
    expect(action).toHaveBeenCalledWith('connect-google-ads')
    expect(conversionIntegrityPrimaryAction(unconnected)).toMatchObject({ id: 'connect-google-ads' })
  })

  test('replaces the no-contract workspace with one focused setup path', () => {
    const action = vi.fn()
    render(<ConversionIntegritySection onPrimaryAction={action} />)

    expect(screen.getByRole('heading', { name: 'Complete setup' })).toBeTruthy()
    expect(screen.getByText('Google Ads account')).toBeTruthy()
    expect(screen.getByText('Tag Manager container')).toBeTruthy()
    expect(screen.getByText('Conversion to check')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Google Ads' })).toBeTruthy()
    expect(screen.queryByText('Setup needed')).toBeNull()
    expect(screen.queryByText('No conversion declared')).toBeNull()
    expect(screen.queryByText('Evidence progression')).toBeNull()
    expect(screen.queryByText('Connection evidence')).toBeNull()
    expect(screen.queryByText('Latest sanitized snapshots')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Ads' }))
    expect(action).toHaveBeenCalledWith('connect-google-ads')
  })

  test('advances the focused setup path through Tag Manager and conversion declaration', () => {
    const action = vi.fn()
    const changeGoogleAdsSelection = vi.fn()
    const changeGtmSelection = vi.fn()
    const gtmNotConnected = {
      state: 'not-connected' as const,
      selection: null,
      snapshotCount: 0,
      evidence: 'No stored evidence yet.',
      lastSnapshotAt: null,
    }
    const setup = workspace({ contract: null, assessment: null, gtm: gtmNotConnected })
    const { rerender } = render(
      <ConversionIntegritySection
        workspace={setup}
        onPrimaryAction={action}
        onChangeGoogleAdsSelection={changeGoogleAdsSelection}
        onChangeGtmSelection={changeGtmSelection}
      />,
    )

    expect(screen.getByText('Example Hotel').closest('li')?.textContent).toContain('Ready')
    expect(screen.getByRole('button', { name: 'Connect Google Tag Manager' }).closest('li')?.getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: 'Change Google Ads account' }))
    expect(changeGoogleAdsSelection).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Declare conversion' })).toBeNull()

    rerender(
      <ConversionIntegritySection
        workspace={workspace({ contract: null, assessment: null })}
        onPrimaryAction={action}
        onChangeGoogleAdsSelection={changeGoogleAdsSelection}
        onChangeGtmSelection={changeGtmSelection}
      />,
    )

    expect(screen.getAllByText('Ready')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Declare conversion' }).closest('li')?.getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: 'Change Tag Manager container' }))
    expect(changeGtmSelection).toHaveBeenCalledTimes(1)
  })

  test('keeps a declared conversion configured while its integrity assessment loads', () => {
    render(<ConversionIntegritySection workspace={workspace({ assessment: null })} />)

    expect(screen.getByText('Configured')).toBeTruthy()
    expect(screen.getAllByText('Declared')).toHaveLength(2)
    expect(screen.getByText('Needs review')).toBeTruthy()
  })

  test('keeps runtime guidance available to a view-only operator', () => {
    const action = vi.fn()
    render(
      <AccountProvider account={{ name: 'viewer', role: 'viewer' }}>
        <ConversionIntegritySection workspace={workspace()} onPrimaryAction={action} />
      </AccountProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review runtime verification' }))
    expect(action).toHaveBeenCalledWith('review-runtime-verification')
  })

  test('labels a selected contract assessment as loading instead of silently downgrading it to configured', () => {
    render(<ConversionIntegritySection workspace={workspace({
      assessment: null,
      assessmentState: 'loading',
      googleAds: {
        ...workspace().googleAds,
        snapshotState: 'loading',
      },
    })} />)

    expect(screen.getByText('Checking configuration')).toBeTruthy()
    expect(screen.getByText('Checking')).toBeTruthy()
    expect(screen.getByText('Loading stored snapshots')).toBeTruthy()
  })

  test('shows failed assessment and snapshot reads as unavailable rather than empty evidence', () => {
    render(<ConversionIntegritySection workspace={workspace({
      assessment: null,
      assessmentState: 'unavailable',
      assessmentError: 'Integrity endpoint unavailable',
      googleAds: {
        ...workspace().googleAds,
        snapshotState: 'unavailable',
        snapshotError: 'Google Ads snapshots unavailable',
      },
      gtm: {
        ...workspace().gtm,
        snapshotState: 'unavailable',
        snapshotError: 'Tag Manager snapshots unavailable',
      },
    })} />)

    expect(screen.getByText('Assessment unavailable')).toBeTruthy()
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.getAllByText('Stored snapshots unavailable')).toHaveLength(2)
    expect(screen.getByText('Integrity endpoint unavailable')).toBeTruthy()
    expect(screen.getByText('Google Ads snapshots unavailable')).toBeTruthy()
    expect(screen.queryByText('No stored snapshots')).toBeNull()
    expect(screen.getAllByText('Stored snapshots unavailable').every((element) => element.className.includes('text-sm'))).toBe(true)
    expect(screen.getByText('Google Ads snapshots unavailable').className).toContain('text-sm')
    expect(screen.getAllByText('Use the next step above')).toHaveLength(2)
    expect(screen.queryByText('—')).toBeNull()
  })
})
