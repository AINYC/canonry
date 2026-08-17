import type {
  GoogleAdsCategoryGoalSource,
  GoogleAdsConversionGoalData,
  GoogleAdsConversionAction,
  GoogleAdsEffectiveCampaignGoalInputs,
  GoogleAdsEffectiveCategoryOriginGoal,
  GoogleAdsEffectiveConversionActionInput,
  GoogleAdsGoalInclusion,
} from './types.js'

type GoalInputs = Omit<
  GoogleAdsConversionGoalData,
  'campaignGoalsComplete' | 'effectiveCampaignGoalInputs'
>

function addInclusion(
  included: Map<string, GoogleAdsEffectiveConversionActionInput>,
  action: GoogleAdsConversionAction,
  inclusion: GoogleAdsGoalInclusion,
): void {
  const existing = included.get(action.resourceName)
  if (existing) {
    existing.includedBy.push(inclusion)
    return
  }
  included.set(action.resourceName, { conversionAction: action, includedBy: [inclusion] })
}

export function resolveEffectiveCampaignGoalInputs(
  inputs: GoalInputs,
): GoogleAdsEffectiveCampaignGoalInputs[] {
  const actions = inputs.conversionActions.map((row) => row.conversionAction)
  const actionsByResource = new Map(actions.map((action) => [action.resourceName, action]))
  const customGoalsByResource = new Map(
    inputs.customGoals.map((row) => [row.customConversionGoal.resourceName, row.customConversionGoal]),
  )

  return inputs.campaignConfigs.map((row) => {
    const config = row.conversionGoalCampaignConfig
    let categoryGoalSource: GoogleAdsCategoryGoalSource = 'UNKNOWN'
    let categoryOriginGoals: GoogleAdsEffectiveCategoryOriginGoal[] = []

    if (config.goalConfigLevel === 'CUSTOMER') {
      categoryGoalSource = 'CUSTOMER'
      categoryOriginGoals = inputs.customerGoals.map(({ customerConversionGoal: goal }) => ({
        resourceName: goal.resourceName,
        source: 'CUSTOMER',
        category: goal.category,
        origin: goal.origin,
        biddable: goal.biddable === true,
      }))
    } else if (config.goalConfigLevel === 'CAMPAIGN') {
      categoryGoalSource = 'CAMPAIGN'
      categoryOriginGoals = inputs.campaignGoals
        .filter(({ campaignConversionGoal: goal }) => goal.campaign === config.campaign)
        .map(({ campaignConversionGoal: goal }) => ({
          resourceName: goal.resourceName,
          source: 'CAMPAIGN',
          category: goal.category,
          origin: goal.origin,
          biddable: goal.biddable === true,
        }))
    }

    const included = new Map<string, GoogleAdsEffectiveConversionActionInput>()
    for (const goal of categoryOriginGoals) {
      if (!goal.biddable) continue
      for (const action of actions) {
        if (
          action.primaryForGoal !== false &&
          action.category === goal.category &&
          action.origin === goal.origin
        ) {
          addInclusion(included, action, {
            source: goal.source === 'CUSTOMER' ? 'CUSTOMER_GOAL' : 'CAMPAIGN_GOAL',
            goalResourceName: goal.resourceName,
            category: goal.category,
            origin: goal.origin,
          })
        }
      }
    }

    let customGoal = null
    let missingCustomGoalResourceName: string | undefined
    const missingConversionActionResourceNames: string[] = []
    if (config.goalConfigLevel === 'CAMPAIGN' && config.customConversionGoal) {
      customGoal = customGoalsByResource.get(config.customConversionGoal) ?? null
      if (!customGoal) {
        missingCustomGoalResourceName = config.customConversionGoal
      } else {
        for (const resourceName of customGoal.conversionActions ?? []) {
          const action = actionsByResource.get(resourceName)
          if (!action) {
            missingConversionActionResourceNames.push(resourceName)
            continue
          }
          addInclusion(included, action, {
            source: 'CUSTOM_GOAL',
            goalResourceName: customGoal.resourceName,
          })
        }
      }
    }

    return {
      campaign: row.campaign,
      config,
      categoryGoalSource,
      categoryOriginGoals,
      customGoal,
      conversionActions: [...included.values()],
      ...(missingCustomGoalResourceName ? { missingCustomGoalResourceName } : {}),
      missingConversionActionResourceNames,
    }
  })
}
