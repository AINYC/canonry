import { describe, expect, it } from 'vitest'
import {
  GOOGLE_ADS_MAX_RESULT_ROWS,
  GoogleAdsClient,
  resolveEffectiveCampaignGoalInputs,
} from '../src/index.js'
import type {
  GoogleAdsCampaign,
  GoogleAdsConversionAction,
  GoogleAdsFetch,
} from '../src/index.js'

const campaignCustomerGoals: GoogleAdsCampaign = {
  resourceName: 'customers/1234567890/campaigns/100',
  id: '100',
  name: 'Customer goals campaign',
  status: 'ENABLED',
}

const campaignCustomGoal: GoogleAdsCampaign = {
  resourceName: 'customers/1234567890/campaigns/200',
  id: '200',
  name: 'Custom goal campaign',
  status: 'ENABLED',
}

const purchaseAction: GoogleAdsConversionAction = {
  resourceName: 'customers/1234567890/conversionActions/1',
  id: '1',
  name: 'Purchase',
  status: 'ENABLED',
  type: 'WEBPAGE',
  category: 'PURCHASE',
  origin: 'WEBSITE',
  primaryForGoal: true,
}

const checkoutAction: GoogleAdsConversionAction = {
  resourceName: 'customers/1234567890/conversionActions/2',
  id: '2',
  name: 'Checkout details complete',
  status: 'ENABLED',
  type: 'WEBPAGE',
  category: 'BEGIN_CHECKOUT',
  origin: 'WEBSITE',
  primaryForGoal: false,
}

function goalFixtures() {
  return {
    conversionActions: [
      { conversionAction: purchaseAction },
      { conversionAction: checkoutAction },
    ],
    customerGoals: [
      {
        customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/PURCHASE~WEBSITE',
          category: 'PURCHASE',
          origin: 'WEBSITE',
          biddable: true,
        },
      },
      {
        customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/BEGIN_CHECKOUT~WEBSITE',
          category: 'BEGIN_CHECKOUT',
          origin: 'WEBSITE',
          biddable: false,
        },
      },
    ],
    campaignGoals: [
      {
        campaignConversionGoal: {
          resourceName: 'customers/1234567890/campaignConversionGoals/200~PURCHASE~WEBSITE',
          campaign: campaignCustomGoal.resourceName,
          category: 'PURCHASE',
          origin: 'WEBSITE',
          biddable: false,
        },
        campaign: campaignCustomGoal,
      },
      {
        campaignConversionGoal: {
          resourceName: 'customers/1234567890/campaignConversionGoals/200~BEGIN_CHECKOUT~WEBSITE',
          campaign: campaignCustomGoal.resourceName,
          category: 'BEGIN_CHECKOUT',
          origin: 'WEBSITE',
          biddable: true,
        },
        campaign: campaignCustomGoal,
      },
    ],
    customGoals: [
      {
        customConversionGoal: {
          resourceName: 'customers/1234567890/customConversionGoals/9',
          id: '9',
          name: 'Checkout proxy',
          status: 'ENABLED',
          conversionActions: [
            checkoutAction.resourceName,
            'customers/1234567890/conversionActions/999',
          ],
        },
      },
    ],
    campaignConfigs: [
      {
        conversionGoalCampaignConfig: {
          resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/100',
          campaign: campaignCustomerGoals.resourceName,
          goalConfigLevel: 'CUSTOMER' as const,
        },
        campaign: campaignCustomerGoals,
      },
      {
        conversionGoalCampaignConfig: {
          resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/200',
          campaign: campaignCustomGoal.resourceName,
          goalConfigLevel: 'CAMPAIGN' as const,
          customConversionGoal: 'customers/1234567890/customConversionGoals/9',
        },
        campaign: campaignCustomGoal,
      },
    ],
  }
}

describe('resolveEffectiveCampaignGoalInputs', () => {
  it('uses customer goals at CUSTOMER level and requires primary_for_goal', () => {
    const result = resolveEffectiveCampaignGoalInputs(goalFixtures())
    const customer = result.find((entry) => entry.campaign.id === '100')

    expect(customer?.categoryGoalSource).toBe('CUSTOMER')
    expect(customer?.categoryOriginGoals).toHaveLength(2)
    expect(customer?.conversionActions.map((entry) => entry.conversionAction.id)).toEqual(['1'])
    expect(customer?.conversionActions[0]?.includedBy).toEqual([{
      source: 'CUSTOMER_GOAL',
      goalResourceName: 'customers/1234567890/customerConversionGoals/PURCHASE~WEBSITE',
      category: 'PURCHASE',
      origin: 'WEBSITE',
    }])
  })

  it('lets a custom goal include a secondary action and reports unresolved action resources', () => {
    const result = resolveEffectiveCampaignGoalInputs(goalFixtures())
    const campaign = result.find((entry) => entry.campaign.id === '200')

    expect(campaign?.categoryGoalSource).toBe('CAMPAIGN')
    expect(campaign?.customGoal?.name).toBe('Checkout proxy')
    expect(campaign?.conversionActions.map((entry) => entry.conversionAction.id)).toEqual(['2'])
    expect(campaign?.conversionActions[0]?.includedBy).toEqual([{
      source: 'CUSTOM_GOAL',
      goalResourceName: 'customers/1234567890/customConversionGoals/9',
    }])
    expect(campaign?.missingConversionActionResourceNames).toEqual([
      'customers/1234567890/conversionActions/999',
    ])
  })
})

describe('GoogleAdsClient goal input composite', () => {
  it('retrieves every goal layer and returns request provenance', async () => {
    const fixtures = goalFixtures()
    const requestedResources: string[] = []
    const fetch: GoogleAdsFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
      const match = /FROM ([a-z_]+)/.exec(body.query)
      if (!match) throw new Error('Missing GAQL resource')
      const resource = match[1]!
      requestedResources.push(resource)

      const results = resource === 'conversion_action'
        ? fixtures.conversionActions
        : resource === 'customer_conversion_goal'
          ? fixtures.customerGoals
          : resource === 'campaign_conversion_goal'
            ? fixtures.campaignGoals
            : resource === 'custom_conversion_goal'
              ? fixtures.customGoals
              : resource === 'conversion_goal_campaign_config'
                ? fixtures.campaignConfigs
                : []
      return new Response(JSON.stringify([{ results, requestId: `req-${resource}` }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = new GoogleAdsClient({
      accessToken: 'access-token',
      developerToken: 'developer-token',
    }, { fetch })

    const result = await client.getConversionGoals('1234567890')

    expect(new Set(requestedResources)).toEqual(new Set([
      'conversion_action',
      'customer_conversion_goal',
      'campaign_conversion_goal',
      'custom_conversion_goal',
      'conversion_goal_campaign_config',
    ]))
    expect(result.data.effectiveCampaignGoalInputs).toHaveLength(2)
    expect(result.data.campaignGoalsComplete).toBe(true)
    expect(result.metadata.requests).toHaveLength(5)
    expect(result.metadata.requests.map((request) => request.requestId)).toEqual([
      'req-conversion_action',
      'req-customer_conversion_goal',
      'req-campaign_conversion_goal',
      'req-custom_conversion_goal',
      'req-conversion_goal_campaign_config',
    ])
  })

  it('marks campaign-goal evidence incomplete at the bounded row cap', async () => {
    const cappedCampaignGoals = Array.from({ length: GOOGLE_ADS_MAX_RESULT_ROWS }, (_, index) => ({
      campaignConversionGoal: {
        resourceName: `customers/1234567890/campaignConversionGoals/${index}~PURCHASE~WEBSITE`,
        campaign: `customers/1234567890/campaigns/${index}`,
        category: 'PURCHASE',
        origin: 'WEBSITE',
        biddable: true,
      },
      campaign: {
        resourceName: `customers/1234567890/campaigns/${index}`,
        id: String(index),
        name: `Campaign ${index}`,
        status: 'ENABLED',
      },
    }))
    let campaignGoalsQuery = ''
    const fetch: GoogleAdsFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
      const resource = /FROM ([a-z_]+)/.exec(body.query)?.[1]
      if (resource === 'campaign_conversion_goal') campaignGoalsQuery = body.query
      const results = resource === 'campaign_conversion_goal' ? cappedCampaignGoals : []
      return new Response(JSON.stringify([{ results }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = new GoogleAdsClient({
      accessToken: 'access-token',
      developerToken: 'developer-token',
    }, { fetch })

    const result = await client.getConversionGoals('1234567890')

    expect(campaignGoalsQuery).toContain(`LIMIT ${GOOGLE_ADS_MAX_RESULT_ROWS}`)
    expect(result.data.campaignGoalsComplete).toBe(false)
  })
})
