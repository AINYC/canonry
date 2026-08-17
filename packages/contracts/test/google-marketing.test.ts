import { describe, expect, test } from 'vitest'
import {
  ConversionTrackingIntegrityStatuses,
  ConversionTrackingFindingCodes,
  ConversionTrackingRuntimeObservations,
  ConversionTrackingStaticCheckStates,
  GoogleAdsConnectionStates,
  GoogleAdsEffectiveGoalSources,
  GtmGoogleAdsTagAssessmentRecognitions,
  GtmGoogleAdsTagMappingSources,
  deriveConversionTrackingIntegrityStatus,
  deriveGoogleAdsEffectiveGoalGraph,
  conversionTrackingContractSchema,
  conversionTrackingContractWriteRequestSchema,
  canonicalizeGoogleAdsCustomerSelection,
  canonicalizeGtmAccountId,
  canonicalizeGtmContainerId,
  canonicalizeGtmResourceSelection,
  canonicalizeGtmWorkspaceId,
  googleAdsCampaignMetricsQuerySchema,
  googleAdsCustomerSelectionRequestSchema,
  googleAdsConnectionMetadataDtoSchema,
  googleAdsConnectionStatusDtoSchema,
  googleAdsInventoryDtoSchema,
  googleMarketingOAuthConnectRequestSchema,
  googleMarketingOAuthConnectResponseSchema,
  gtmGoogleAdsTagAssessmentDtoSchema,
  gtmResourceSelectionRequestSchema,
  gtmRawSnapshotDtoSchema,
} from '../src/index.js'

const NOW = '2026-08-14T12:00:00.000Z'

const connection = {
  id: 'google_ads_connection_1',
  projectId: 'project_1',
  scopes: ['https://www.googleapis.com/auth/adwords'],
  selection: { loginCustomerId: '100', customerId: '200', selectedAt: NOW },
  lastValidatedAt: NOW,
  lastInventorySnapshotAt: NOW,
  lastMetricsSnapshotAt: null,
  createdAt: NOW,
  updatedAt: NOW,
}

const selectedCustomer = {
  resourceName: 'customers/200',
  customerId: '200',
  parentCustomerId: '100',
  descriptiveName: 'Example Hotel',
  currencyCode: 'USD',
  timeZone: 'America/New_York',
  manager: false,
  hidden: false,
  testAccount: false,
  level: 1,
  status: 'enabled',
}

describe('Google Ads effective-goal graph', () => {
  test('keeps primary conversion actions distinct from campaign biddability', () => {
    const inventory = googleAdsInventoryDtoSchema.parse({
      customerId: '200',
      fetchedAt: NOW,
      campaigns: [
        { id: 'campaign_customer', resourceName: 'customers/200/campaigns/1', name: 'Customer goals', status: 'enabled', advertisingChannelType: null, biddingStrategyType: null },
        { id: 'campaign_override', resourceName: 'customers/200/campaigns/2', name: 'Campaign goals', status: 'enabled', advertisingChannelType: null, biddingStrategyType: null },
        { id: 'campaign_custom', resourceName: 'customers/200/campaigns/3', name: 'Custom goals', status: 'paused', advertisingChannelType: null, biddingStrategyType: null },
      ],
      conversionActions: [
        { id: 'action_primary', resourceName: 'customers/200/conversionActions/1', name: 'Booking', status: 'enabled', category: 'PURCHASE', origin: 'WEBSITE', primaryForGoal: true, includeInConversionsMetric: true },
        { id: 'action_secondary', resourceName: 'customers/200/conversionActions/2', name: 'Assist', status: 'enabled', category: 'PURCHASE', origin: 'WEBSITE', primaryForGoal: false, includeInConversionsMetric: false },
      ],
      customerConversionGoals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }],
      campaignConversionGoals: [{ campaignId: 'campaign_override', category: 'PURCHASE', origin: 'WEBSITE', biddable: false }],
      customConversionGoals: [{ id: 'custom_goal', name: 'Confirmed booking', conversionActionIds: ['action_primary', 'missing_action'] }],
      campaignGoalConfigurations: [
        { campaignId: 'campaign_override', goalConfigLevel: 'campaign', customGoalId: null },
        { campaignId: 'campaign_custom', goalConfigLevel: 'campaign', customGoalId: 'custom_goal' },
      ],
    })

    const graph = deriveGoogleAdsEffectiveGoalGraph(inventory)
    const customerGoal = graph.campaigns.find(campaign => campaign.campaignId === 'campaign_customer')?.goals[0]
    const overrideGoal = graph.campaigns.find(campaign => campaign.campaignId === 'campaign_override')?.goals[0]
    const customGoal = graph.campaigns.find(campaign => campaign.campaignId === 'campaign_custom')?.goals[0]

    expect(customerGoal).toMatchObject({
      source: GoogleAdsEffectiveGoalSources['customer-goal'],
      biddable: true,
      primaryConversionActionIds: ['action_primary'],
      secondaryConversionActionIds: ['action_secondary'],
    })
    // The same primary action is not biddable when the campaign override says no.
    expect(overrideGoal).toMatchObject({
      source: GoogleAdsEffectiveGoalSources['campaign-goal'],
      biddable: false,
      primaryConversionActionIds: ['action_primary'],
    })
    expect(customGoal).toMatchObject({
      source: GoogleAdsEffectiveGoalSources['custom-goal'],
      conversionActionIds: ['action_primary', 'missing_action'],
      missingConversionActionIds: ['missing_action'],
    })
  })

  test('uses customer goals when a campaign has no explicit configuration', () => {
    const graph = deriveGoogleAdsEffectiveGoalGraph(googleAdsInventoryDtoSchema.parse({
      customerId: '200',
      fetchedAt: NOW,
      campaigns: [{ id: 'campaign_1', resourceName: 'customers/200/campaigns/1', name: 'Campaign', status: 'enabled', advertisingChannelType: null, biddingStrategyType: null }],
      conversionActions: [],
      customerConversionGoals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }],
      campaignConversionGoals: [],
      customConversionGoals: [],
      campaignGoalConfigurations: [],
    }))

    expect(graph.campaigns[0]).toMatchObject({
      goalConfigLevel: 'customer',
      goals: [{ source: GoogleAdsEffectiveGoalSources['customer-goal'], biddable: true }],
    })
  })
})

describe('Google marketing boundary schemas', () => {
  test('validates selection forms without hiding canonical persistence behind schema transforms', () => {
    const adsInput = { loginCustomerId: '111-222-3333', customerId: '123-456-7890' }
    expect(googleAdsCustomerSelectionRequestSchema.parse(adsInput)).toEqual(adsInput)
    expect(canonicalizeGoogleAdsCustomerSelection(adsInput)).toEqual({
      loginCustomerId: '1112223333',
      customerId: '1234567890',
    })
    expect(googleAdsCustomerSelectionRequestSchema.safeParse({ customerId: '12345' }).success).toBe(false)

    const gtmInput = {
      accountId: 'accounts/1',
      containerId: 'accounts/1/containers/2',
      workspaceId: 'accounts/1/containers/2/workspaces/3',
    }
    expect(gtmResourceSelectionRequestSchema.parse(gtmInput)).toEqual(gtmInput)
    expect(canonicalizeGtmResourceSelection(gtmInput)).toEqual({
      accountId: '1',
      containerId: '2',
      workspaceId: '3',
    })
    expect(gtmResourceSelectionRequestSchema.safeParse({
      ...gtmInput,
      containerId: 'accounts/other/containers/2',
    }).success).toBe(false)
    expect(gtmResourceSelectionRequestSchema.safeParse({
      ...gtmInput,
      workspaceId: 'accounts/1/containers/other/workspaces/3',
    }).success).toBe(false)
  })

  test('accepts exact returned GTM resource paths but rejects URL-significant ID segments', () => {
    expect(canonicalizeGtmAccountId('accounts/1')).toBe('1')
    expect(canonicalizeGtmContainerId('accounts/1/containers/2', '1')).toBe('2')
    expect(canonicalizeGtmWorkspaceId('accounts/1/containers/2/workspaces/3', '1', '2')).toBe('3')

    for (const unsafe of ['.', '..', 'a?query', 'a#fragment', 'a\\segment', 'a%2Fb']) {
      expect(canonicalizeGtmAccountId(unsafe)).toBeNull()
      expect(canonicalizeGtmResourceSelection({
        accountId: unsafe,
        containerId: '2',
      })).toBeNull()
    }

    expect(canonicalizeGtmResourceSelection({
      accountId: 'accounts/1',
      containerId: 'accounts/1/containers/2',
      workspaceId: 'accounts/1/containers/2/workspaces/3',
    })).toEqual({ accountId: '1', containerId: '2', workspaceId: '3' })
  })

  test('requires connection state and selected-customer data to agree', () => {
    expect(googleAdsConnectionStatusDtoSchema.safeParse({
      connected: false,
      status: GoogleAdsConnectionStates['not-connected'],
      connection: null,
      selectedCustomer: null,
    }).success).toBe(true)

    expect(googleAdsConnectionStatusDtoSchema.safeParse({
      connected: false,
      status: GoogleAdsConnectionStates['not-connected'],
      connection,
      selectedCustomer: null,
    }).success).toBe(false)

    expect(googleAdsConnectionStatusDtoSchema.safeParse({
      connected: true,
      status: GoogleAdsConnectionStates.connected,
      connection,
      selectedCustomer,
    }).success).toBe(true)
  })

  test('rejects secrets from strict connection and OAuth response DTOs', () => {
    expect(googleAdsConnectionMetadataDtoSchema.safeParse({ ...connection, accessToken: 'secret' }).success).toBe(false)

    expect(googleMarketingOAuthConnectRequestSchema.safeParse({
      provider: 'google-ads',
      publicUrl: 'https://canonry.example',
      developerToken: 'developer-token-input-only',
    }).success).toBe(true)
    expect(googleMarketingOAuthConnectResponseSchema.safeParse({
      provider: 'google-ads',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
      redirectUri: 'https://canonry.example/api/v1/google-marketing/callback',
      expiresAt: NOW,
      developerToken: 'must-not-echo',
    }).success).toBe(false)
  })

  test('bounds metric reads by unique campaigns, real calendar dates, and duration', () => {
    expect(googleAdsCampaignMetricsQuerySchema.safeParse({
      campaignIds: ['campaign_1', 'campaign_2'],
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    }).success).toBe(true)
    expect(googleAdsCampaignMetricsQuerySchema.safeParse({
      campaignIds: ['campaign_1', 'campaign_1'],
      startDate: '2026-01-01',
      endDate: '2026-01-02',
    }).success).toBe(false)
    expect(googleAdsCampaignMetricsQuerySchema.safeParse({
      campaignIds: ['campaign_1'],
      startDate: '2026-02-30',
      endDate: '2026-03-01',
    }).success).toBe(false)
    expect(googleAdsCampaignMetricsQuerySchema.safeParse({
      campaignIds: ['campaign_1'],
      startDate: '2026-01-01',
      endDate: '2026-02-01',
    }).success).toBe(false)
  })
})

describe('sanitized GTM Google Ads assessments', () => {
  const literal = (value: string) => ({
    source: GtmGoogleAdsTagMappingSources.literal,
    literal: value,
    variableRef: null,
  })
  const variableRef = (value: string) => ({
    source: GtmGoogleAdsTagMappingSources['variable-ref'],
    literal: null,
    variableRef: value,
  })

  test('keeps conversion literals and variable references while rejecting raw template bodies', () => {
    const assessment = {
      tagId: 'tag_1',
      tagType: 'awct',
      recognition: GtmGoogleAdsTagAssessmentRecognitions.recognized,
      recognitionReason: null,
      conversionId: literal('AW-123456'),
      conversionLabel: literal('booking_label'),
      value: variableRef('{{booking_value}}'),
      transactionId: variableRef('{{transaction_id}}'),
      currency: variableRef('{{currency}}'),
      triggerStrategy: 'custom-event',
      triggerIds: ['trigger_purchase'],
      triggerPredicates: [{
        triggerId: 'trigger_purchase',
        triggerType: 'customEvent',
        eventPredicates: [{ operator: 'equals', value: 'purchase', negated: false, ignoreCase: false }],
        hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: false, ignoreCase: false }],
        unsupportedConditionCount: 0,
      }],
      reviewReasons: [],
    }

    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse(assessment).success).toBe(true)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({ ...assessment, templateBody: '<script>secret</script>' }).success).toBe(false)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({
      ...assessment,
      recognition: GtmGoogleAdsTagAssessmentRecognitions.unknown,
      recognitionReason: null,
    }).success).toBe(false)
  })

  test('rejects arbitrary literals and PII at the persisted assessment boundary', () => {
    const assessment = {
      tagId: 'tag_1',
      tagType: 'awct',
      recognition: GtmGoogleAdsTagAssessmentRecognitions.recognized,
      recognitionReason: null,
      conversionId: literal('AW-123456'),
      conversionLabel: literal('booking_label'),
      value: literal('125.50'),
      transactionId: variableRef('{{transaction_id}}'),
      currency: literal('USD'),
      triggerStrategy: 'custom-event',
      triggerIds: ['trigger_purchase'],
      triggerPredicates: [{
        triggerId: 'trigger_purchase',
        triggerType: 'customEvent',
        eventPredicates: [{ operator: 'equals', value: 'purchase', negated: false, ignoreCase: false }],
        hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: false, ignoreCase: false }],
        unsupportedConditionCount: 0,
      }],
      reviewReasons: [],
    }

    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse(assessment).success).toBe(true)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({
      ...assessment,
      conversionId: literal('AW-123456-sk_live_never_persist'),
    }).success).toBe(false)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({
      ...assessment,
      conversionLabel: literal('booking_guest@example.test'),
    }).success).toBe(false)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({
      ...assessment,
      value: literal('125.50 api-key'),
    }).success).toBe(false)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({
      ...assessment,
      transactionId: literal('guest@example.test'),
    }).success).toBe(false)
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse({
      ...assessment,
      currency: literal('USD-secret'),
    }).success).toBe(false)
  })

  test('requires snapshot metadata and payload kinds to match', () => {
    expect(gtmRawSnapshotDtoSchema.safeParse({
      metadata: {
        id: 'snapshot_1', projectId: 'project_1', connectionId: 'gtm_connection_1', runId: 'run_1',
        kind: 'accounts', accountId: null, containerId: null, workspaceId: null,
        payloadChecksum: 'a'.repeat(64), rawPayloadSha256: null, rawPayloadBytes: null,
        redactedFieldCount: 0, capturedAt: NOW, createdAt: NOW,
      },
      payload: {
        kind: 'live',
        data: {
          source: 'live',
          version: { accountId: 'account_1', containerId: 'container_1', id: 'version_1', path: 'accounts/account_1/containers/container_1/versions/version_1', name: 'Live', description: null, fingerprint: null, deleted: false },
          graph: { accountId: 'account_1', containerId: 'container_1', workspaceId: null, tags: [], triggers: [], variables: [], googleAdsTagAssessments: [] },
          fetchedAt: NOW,
        },
      },
    }).success).toBe(false)
  })
})

describe('conversion tracking evidence statuses', () => {
  test('only upgrades when the static graph is consistent', () => {
    expect(deriveConversionTrackingIntegrityStatus({
      staticCheck: ConversionTrackingStaticCheckStates['not-run'],
      runtimeVerificationRequired: true,
      runtimeObservation: ConversionTrackingRuntimeObservations.observed,
    })).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(deriveConversionTrackingIntegrityStatus({
      staticCheck: ConversionTrackingStaticCheckStates.consistent,
      runtimeVerificationRequired: false,
      runtimeObservation: ConversionTrackingRuntimeObservations['not-run'],
    })).toBe(ConversionTrackingIntegrityStatuses['statically-consistent'])
    expect(deriveConversionTrackingIntegrityStatus({
      staticCheck: ConversionTrackingStaticCheckStates.consistent,
      runtimeVerificationRequired: true,
      runtimeObservation: ConversionTrackingRuntimeObservations['not-observed'],
    })).toBe(ConversionTrackingIntegrityStatuses['runtime-unverified'])
    expect(deriveConversionTrackingIntegrityStatus({
      staticCheck: ConversionTrackingStaticCheckStates.consistent,
      runtimeVerificationRequired: true,
      runtimeObservation: ConversionTrackingRuntimeObservations.observed,
    })).toBe(ConversionTrackingIntegrityStatuses.observed)
    expect(deriveConversionTrackingIntegrityStatus({
      staticCheck: ConversionTrackingStaticCheckStates.inconsistent,
      runtimeVerificationRequired: true,
      runtimeObservation: ConversionTrackingRuntimeObservations.observed,
    })).toBe(ConversionTrackingIntegrityStatuses.configured)
  })

  test('keeps optional GTM-facing conversion identifiers for strong static checks', () => {
    const base = {
      id: 'contract_1',
      projectId: 'project_1',
      name: 'Booking completed',
      eventName: 'purchase',
      googleAds: {
        customerId: '200',
        conversionActionId: 'action_primary',
        campaignIds: [],
        requireBiddableGoal: true,
        requirePrimaryAction: true,
      },
      gtm: { accountId: 'account_1', containerId: 'container_1', tagId: 'tag_1', triggerIds: [], variableIds: [] },
      runtime: {
        verificationRequired: true,
        requireTransactionId: true,
        requireValue: true,
        requireCurrency: true,
        productionHosts: ['example.com'],
      },
      createdAt: NOW,
      updatedAt: NOW,
    }

    expect(conversionTrackingContractSchema.safeParse(base).success).toBe(true)
    expect(conversionTrackingContractSchema.safeParse({
      ...base,
      googleAds: { ...base.googleAds, conversionId: 'AW-123456', conversionLabel: 'booking_label' },
    }).success).toBe(true)
    const write = {
      name: base.name,
      eventName: base.eventName,
      googleAds: base.googleAds,
      gtm: base.gtm,
      runtime: base.runtime,
    }
    expect(conversionTrackingContractWriteRequestSchema.safeParse(write).success).toBe(true)
    expect(conversionTrackingContractWriteRequestSchema.safeParse(base).success).toBe(false)
    expect(conversionTrackingContractSchema.parse({
      ...base,
      runtime: { ...base.runtime, productionHosts: ['https://www.example.com/booking'] },
    }).runtime.productionHosts).toEqual(['https://www.example.com/booking'])
    expect(conversionTrackingContractSchema.safeParse({
      ...base,
      runtime: { ...base.runtime, productionHosts: ['not a host'] },
    }).success).toBe(false)
    expect(ConversionTrackingFindingCodes['gtm-tag-unrecognized']).toBe('gtm-tag-unrecognized')
    expect(ConversionTrackingFindingCodes['gtm-hostname-mismatch']).toBe('gtm-hostname-mismatch')
    expect(ConversionTrackingFindingCodes['gtm-conversion-id-mismatch']).toBe('gtm-conversion-id-mismatch')
  })
})
