import {
  GOOGLE_ADS_DEFAULT_CUSTOMER_CLIENT_DEPTH,
  GOOGLE_ADS_DEFAULT_CUSTOMER_CLIENTS,
  GOOGLE_ADS_MAX_CAMPAIGN_FILTER_IDS,
  GOOGLE_ADS_MAX_CUSTOMER_CLIENT_DEPTH,
  GOOGLE_ADS_MAX_CUSTOMER_CLIENTS,
  GOOGLE_ADS_MAX_DAILY_METRICS_DAYS,
  GOOGLE_ADS_MAX_RESULT_ROWS,
} from './constants.js'
import { GoogleAdsApiError } from './types.js'
import type {
  GoogleAdsCustomerClientsOptions,
  GoogleAdsDailyMetricsOptions,
  GoogleAdsListOptions,
} from './types.js'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function selectQuery(
  fields: readonly string[],
  resource: string,
  clauses: readonly string[],
): string {
  return [
    'SELECT',
    ...fields.map((field, index) => `  ${field}${index === fields.length - 1 ? '' : ','}`),
    `FROM ${resource}`,
    ...clauses,
  ].join('\n')
}

function validatedLimit(limit: number | undefined): number {
  const value = limit ?? GOOGLE_ADS_MAX_RESULT_ROWS
  if (!Number.isInteger(value) || value < 1 || value > GOOGLE_ADS_MAX_RESULT_ROWS) {
    throw new GoogleAdsApiError(
      `Limit must be an integer between 1 and ${GOOGLE_ADS_MAX_RESULT_ROWS}`,
      400,
    )
  }
  return value
}

export function normalizeGoogleAdsCustomerId(value: string, label = 'Customer ID'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GoogleAdsApiError(`${label} is required`, 400)
  }

  const normalized = value.trim().replaceAll('-', '')
  if (!/^\d{10}$/.test(normalized)) {
    throw new GoogleAdsApiError(`${label} must contain exactly 10 digits`, 400)
  }
  return normalized
}

export function normalizeGoogleAdsCustomerClientsOptions(
  options: GoogleAdsCustomerClientsOptions = {},
): Required<GoogleAdsCustomerClientsOptions> {
  const maxDepth = options.maxDepth ?? GOOGLE_ADS_DEFAULT_CUSTOMER_CLIENT_DEPTH
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > GOOGLE_ADS_MAX_CUSTOMER_CLIENT_DEPTH
  ) {
    throw new GoogleAdsApiError(
      `Customer-client depth must be an integer between 0 and ${GOOGLE_ADS_MAX_CUSTOMER_CLIENT_DEPTH}`,
      400,
    )
  }

  const maxCustomers = options.maxCustomers ?? GOOGLE_ADS_DEFAULT_CUSTOMER_CLIENTS
  if (
    !Number.isInteger(maxCustomers) ||
    maxCustomers < 1 ||
    maxCustomers > GOOGLE_ADS_MAX_CUSTOMER_CLIENTS
  ) {
    throw new GoogleAdsApiError(
      `Customer-client limit must be an integer between 1 and ${GOOGLE_ADS_MAX_CUSTOMER_CLIENTS}`,
      400,
    )
  }

  return { maxDepth, maxCustomers }
}

export function buildCustomerDetailsQuery(): string {
  return selectQuery([
    'customer.resource_name',
    'customer.id',
    'customer.descriptive_name',
    'customer.currency_code',
    'customer.time_zone',
    'customer.manager',
    'customer.test_account',
    'customer.status',
    'customer.auto_tagging_enabled',
    'customer.conversion_tracking_setting.conversion_tracking_id',
    'customer.conversion_tracking_setting.conversion_tracking_status',
    'customer.conversion_tracking_setting.cross_account_conversion_tracking_id',
    'customer.conversion_tracking_setting.google_ads_conversion_customer',
  ], 'customer', ['LIMIT 1'])
}

export function buildCustomerClientsQuery(
  options: GoogleAdsCustomerClientsOptions = {},
): string {
  const { maxDepth, maxCustomers } = normalizeGoogleAdsCustomerClientsOptions(options)
  return selectQuery([
    'customer_client.resource_name',
    'customer_client.client_customer',
    'customer_client.id',
    'customer_client.descriptive_name',
    'customer_client.currency_code',
    'customer_client.time_zone',
    'customer_client.manager',
    'customer_client.test_account',
    'customer_client.hidden',
    'customer_client.status',
    'customer_client.level',
  ], 'customer_client', [
    `WHERE customer_client.level <= ${maxDepth}`,
    'ORDER BY customer_client.level ASC, customer_client.id ASC',
    `LIMIT ${maxCustomers + 1}`,
  ])
}

function parseIsoDate(value: string, label: string): number {
  const match = DATE_PATTERN.exec(value)
  if (!match) {
    throw new GoogleAdsApiError(`${label} must use YYYY-MM-DD format`, 400)
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(timestamp)
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new GoogleAdsApiError(`${label} must be a real calendar date`, 400)
  }
  return timestamp
}

function dailyMetricClauses(options: GoogleAdsDailyMetricsOptions): string[] {
  const start = parseIsoDate(options.startDate, 'Start date')
  const end = parseIsoDate(options.endDate, 'End date')
  if (start > end) {
    throw new GoogleAdsApiError('Start date must be on or before end date', 400)
  }

  const inclusiveDays = Math.floor((end - start) / 86_400_000) + 1
  if (inclusiveDays > GOOGLE_ADS_MAX_DAILY_METRICS_DAYS) {
    throw new GoogleAdsApiError(
      `Daily metrics range cannot exceed ${GOOGLE_ADS_MAX_DAILY_METRICS_DAYS} days`,
      400,
    )
  }

  const filters = [
    `segments.date BETWEEN '${options.startDate}' AND '${options.endDate}'`,
  ]

  // Excluding REMOVED here silently drops the historical spend of a campaign
  // deleted mid-window, while coverage still reads complete. When campaignIds
  // scopes the query the filter is redundant anyway; it is kept only for the
  // unscoped form, where it bounds an otherwise account-wide scan.
  if (options.campaignIds === undefined) {
    filters.push("campaign.status != 'REMOVED'")
  }

  if (options.campaignIds !== undefined) {
    if (!Array.isArray(options.campaignIds) || options.campaignIds.length === 0) {
      throw new GoogleAdsApiError('Campaign IDs must be a non-empty array when provided', 400)
    }
    if (options.campaignIds.length > GOOGLE_ADS_MAX_CAMPAIGN_FILTER_IDS) {
      throw new GoogleAdsApiError(
        `Campaign ID filter cannot exceed ${GOOGLE_ADS_MAX_CAMPAIGN_FILTER_IDS} IDs`,
        400,
      )
    }
    const normalized = options.campaignIds.map((id) => {
      const value = id.trim()
      if (!/^\d+$/.test(value)) {
        throw new GoogleAdsApiError('Campaign IDs must contain digits only', 400)
      }
      return value
    })
    const unique = [...new Set(normalized)]
    filters.push(`campaign.id IN (${unique.join(', ')})`)
  }

  return [
    `WHERE ${filters.join('\n  AND ')}`,
    'ORDER BY segments.date ASC, campaign.id ASC',
    `LIMIT ${validatedLimit(options.limit)}`,
  ]
}

/**
 * Spend per campaign over a window, highest first, INCLUDING removed campaigns.
 *
 * Exists because the daily-metrics query has to be scoped to at most
 * GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS ids, and picking those by campaign
 * id ascending selects an arbitrary subset: it can spend the whole budget of
 * the cap on dormant campaigns while the account's biggest spender is left out
 * of the totals entirely.
 *
 * No `segments.date` in the SELECT, so the API aggregates to one row per
 * campaign over the range rather than returning a row per campaign-day.
 */
export function buildCampaignSpendRankingQuery(options: GoogleAdsDailyMetricsOptions): string {
  const start = parseIsoDate(options.startDate, 'Start date')
  const end = parseIsoDate(options.endDate, 'End date')
  if (start > end) {
    throw new GoogleAdsApiError('Start date must be on or before end date', 400)
  }

  return selectQuery([
    'campaign.id',
    'campaign.status',
    'metrics.cost_micros',
  ], 'campaign', [
    `WHERE segments.date BETWEEN '${options.startDate}' AND '${options.endDate}'`,
    'ORDER BY metrics.cost_micros DESC',
    `LIMIT ${validatedLimit(options.limit)}`,
  ])
}

export function buildCampaignsQuery(options: GoogleAdsListOptions = {}): string {
  const clauses: string[] = []
  if (!options.includeRemoved) clauses.push("WHERE campaign.status != 'REMOVED'")
  clauses.push('ORDER BY campaign.id ASC', `LIMIT ${validatedLimit(options.limit)}`)

  return selectQuery([
    'campaign.resource_name',
    'campaign.id',
    'campaign.name',
    'campaign.status',
    'campaign.primary_status',
    'campaign.serving_status',
    'campaign.advertising_channel_type',
    'campaign.advertising_channel_sub_type',
    'campaign.campaign_budget',
    'campaign.bidding_strategy',
    'campaign.bidding_strategy_type',
    'campaign.maximize_conversions.target_cpa_micros',
    'campaign.maximize_conversion_value.target_roas',
    'campaign.target_cpa.target_cpa_micros',
    'campaign.target_roas.target_roas',
    'campaign.target_impression_share.cpc_bid_ceiling_micros',
    'campaign.target_impression_share.location',
    'campaign.target_impression_share.location_fraction_micros',
    'campaign.target_spend.cpc_bid_ceiling_micros',
    'campaign.target_spend.target_spend_micros',
    'campaign_budget.resource_name',
    'campaign_budget.id',
    'campaign_budget.name',
    'campaign_budget.amount_micros',
    'campaign_budget.total_amount_micros',
    'campaign_budget.status',
    'campaign_budget.explicitly_shared',
    'bidding_strategy.resource_name',
    'bidding_strategy.id',
    'bidding_strategy.name',
    'bidding_strategy.status',
    'bidding_strategy.type',
    'bidding_strategy.maximize_conversions.target_cpa_micros',
    'bidding_strategy.maximize_conversion_value.target_roas',
    'bidding_strategy.target_cpa.target_cpa_micros',
    'bidding_strategy.target_roas.target_roas',
  ], 'campaign', clauses)
}

export function buildConversionActionsQuery(options: GoogleAdsListOptions = {}): string {
  const clauses: string[] = []
  if (!options.includeRemoved) clauses.push("WHERE conversion_action.status != 'REMOVED'")
  clauses.push('ORDER BY conversion_action.id ASC', `LIMIT ${validatedLimit(options.limit)}`)

  return selectQuery([
    'conversion_action.resource_name',
    'conversion_action.id',
    'conversion_action.name',
    'conversion_action.status',
    'conversion_action.type',
    'conversion_action.category',
    'conversion_action.origin',
    'conversion_action.owner_customer',
    'conversion_action.primary_for_goal',
    'conversion_action.include_in_conversions_metric',
    'conversion_action.counting_type',
    'conversion_action.click_through_lookback_window_days',
    'conversion_action.view_through_lookback_window_days',
    'conversion_action.attribution_model_settings.attribution_model',
    'conversion_action.value_settings.always_use_default_value',
    'conversion_action.value_settings.default_currency_code',
    'conversion_action.value_settings.default_value',
    'conversion_action.google_analytics_4_settings.event_name',
    'conversion_action.google_analytics_4_settings.property_id',
    'conversion_action.google_analytics_4_settings.property_name',
    'conversion_action.tag_snippets',
  ], 'conversion_action', clauses)
}

export function buildCustomerConversionGoalsQuery(limit?: number): string {
  return selectQuery([
    'customer_conversion_goal.resource_name',
    'customer_conversion_goal.category',
    'customer_conversion_goal.origin',
    'customer_conversion_goal.biddable',
  ], 'customer_conversion_goal', [
    'ORDER BY customer_conversion_goal.category ASC, customer_conversion_goal.origin ASC',
    `LIMIT ${validatedLimit(limit)}`,
  ])
}

export function buildCampaignConversionGoalsQuery(limit?: number): string {
  return selectQuery([
    'campaign_conversion_goal.resource_name',
    'campaign_conversion_goal.campaign',
    'campaign_conversion_goal.category',
    'campaign_conversion_goal.origin',
    'campaign_conversion_goal.biddable',
    'campaign.resource_name',
    'campaign.id',
    'campaign.name',
    'campaign.status',
  ], 'campaign_conversion_goal', [
    "WHERE campaign.status != 'REMOVED'",
    'ORDER BY campaign.id ASC, campaign_conversion_goal.category ASC, campaign_conversion_goal.origin ASC',
    `LIMIT ${validatedLimit(limit)}`,
  ])
}

export function buildCustomConversionGoalsQuery(limit?: number): string {
  return selectQuery([
    'custom_conversion_goal.resource_name',
    'custom_conversion_goal.id',
    'custom_conversion_goal.name',
    'custom_conversion_goal.status',
    'custom_conversion_goal.conversion_actions',
  ], 'custom_conversion_goal', [
    'ORDER BY custom_conversion_goal.id ASC',
    `LIMIT ${validatedLimit(limit)}`,
  ])
}

export function buildConversionGoalCampaignConfigsQuery(limit?: number): string {
  return selectQuery([
    'conversion_goal_campaign_config.resource_name',
    'conversion_goal_campaign_config.campaign',
    'conversion_goal_campaign_config.custom_conversion_goal',
    'conversion_goal_campaign_config.goal_config_level',
    'campaign.resource_name',
    'campaign.id',
    'campaign.name',
    'campaign.status',
  ], 'conversion_goal_campaign_config', [
    "WHERE campaign.status != 'REMOVED'",
    'ORDER BY campaign.id ASC',
    `LIMIT ${validatedLimit(limit)}`,
  ])
}

export function buildDailyCampaignMetricsQuery(options: GoogleAdsDailyMetricsOptions): string {
  return selectQuery([
    'segments.date',
    'campaign.resource_name',
    'campaign.id',
    'campaign.name',
    'campaign.status',
    'metrics.impressions',
    'metrics.clicks',
    'metrics.cost_micros',
    'metrics.average_cpc',
    'metrics.ctr',
    'metrics.conversions',
    'metrics.conversions_value',
    'metrics.all_conversions',
    'metrics.all_conversions_value',
    'metrics.search_impression_share',
  ], 'campaign', dailyMetricClauses(options))
}

export function buildDailyConversionMetricsQuery(options: GoogleAdsDailyMetricsOptions): string {
  return selectQuery([
    'segments.date',
    'segments.conversion_action',
    'segments.conversion_action_name',
    'segments.conversion_action_category',
    'campaign.resource_name',
    'campaign.id',
    'campaign.name',
    'campaign.status',
    'metrics.conversions',
    'metrics.conversions_value',
    'metrics.all_conversions',
    'metrics.all_conversions_value',
  ], 'campaign', dailyMetricClauses(options))
}
