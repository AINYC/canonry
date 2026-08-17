import {
  GTM_GOOGLE_ADS_CONVERSION_ASSESSMENT_SCHEMA_VERSION,
  GTM_GOOGLE_ADS_CONVERSION_RECOGNIZER_VERSION,
} from './constants.js'
import { checksumJson } from './checksum.js'
import type {
  GtmCondition,
  GtmGoogleAdsConversionAssessment,
  GtmGoogleAdsFieldMapping,
  GtmGoogleAdsRecognizerOptions,
  GtmGoogleAdsReviewReason,
  GtmGoogleAdsUnknownReason,
  GtmHostnameFilter,
  GtmParameter,
  GtmTag,
  GtmTrigger,
} from './types.js'

const GOOGLE_ADS_CONVERSION_TAG_TYPE = 'awct'
const URL_TRIGGER_TYPES = new Set([
  'pageview',
  'domReady',
  'windowLoaded',
  'init',
  'consentInit',
  'serverPageview',
  'historyChange',
])

function unknownReason(tagType: string | undefined): GtmGoogleAdsUnknownReason {
  if (tagType === 'html') return 'custom-html'
  if (tagType === 'cvt' || tagType?.startsWith('cvt_')) return 'custom-template'
  return 'unsupported-tag-type'
}

function parametersByKey(parameters: GtmParameter[] | undefined): Map<string, GtmParameter[]> {
  const byKey = new Map<string, GtmParameter[]>()
  for (const parameter of parameters ?? []) {
    if (!parameter.key) continue
    const values = byKey.get(parameter.key) ?? []
    values.push(parameter)
    byKey.set(parameter.key, values)
  }
  return byKey
}

function scalarMapping(byKey: Map<string, GtmParameter[]>, key: string): GtmGoogleAdsFieldMapping | null {
  const parameters = byKey.get(key)
  if (parameters?.length !== 1) return null
  const parameter = parameters[0]
  if (typeof parameter.value !== 'string' || parameter.list || parameter.map) return null

  const trimmed = parameter.value.trim()
  const hasVariable = parameter.value.includes('{{') && parameter.value.includes('}}')
  const onlyVariable = trimmed.startsWith('{{') && trimmed.endsWith('}}')
  return {
    parameterKey: key,
    value: parameter.value,
    source: onlyVariable ? 'variable' : hasVariable ? 'mixed' : 'literal',
  }
}

function conditions(trigger: GtmTrigger): GtmCondition[] {
  return [
    ...(trigger.customEventFilter ?? []),
    ...(trigger.filter ?? []),
    ...(trigger.autoEventFilter ?? []),
  ]
}

function conditionParameter(condition: GtmCondition, key: string): string | null {
  const parameter = condition.parameter?.find((candidate) => candidate.key === key)
  return typeof parameter?.value === 'string' ? parameter.value : null
}

function normalizedVariableName(value: string): string {
  const trimmed = value.trim()
  const unwrapped = trimmed.startsWith('{{') && trimmed.endsWith('}}')
    ? trimmed.slice(2, -2)
    : trimmed
  return unwrapped.trim().toLowerCase()
}

function isEventVariable(value: string): boolean {
  const normalized = normalizedVariableName(value)
  return normalized === '_event' || normalized === 'event' || normalized === 'event name'
}

function isHostnameVariable(value: string): boolean {
  const normalized = normalizedVariableName(value)
  return normalized === 'page hostname' || normalized === '_hostname'
}

function customEventNames(trigger: GtmTrigger): string[] {
  const names: string[] = []
  for (const condition of trigger.customEventFilter ?? []) {
    const left = conditionParameter(condition, 'arg0')
    const right = conditionParameter(condition, 'arg1')
    if (left && right && isEventVariable(left)) names.push(right)
  }
  return names
}

function filterMatchesHostname(operator: string, filterValue: string, hostname: string): boolean {
  const expected = hostname.toLowerCase()
  const value = filterValue.toLowerCase()
  if (operator === 'equals') return expected === value
  if (operator === 'contains') return expected.includes(value)
  if (operator === 'startsWith') return expected.startsWith(value)
  if (operator === 'endsWith') return expected.endsWith(value)
  if (operator === 'matchRegex' || operator === 'urlMatches') {
    try {
      return new RegExp(filterValue, 'i').test(hostname)
    } catch {
      return false
    }
  }
  return false
}

function hostnameFilters(trigger: GtmTrigger, expectedHostname?: string): GtmHostnameFilter[] {
  const filters: GtmHostnameFilter[] = []
  for (const condition of conditions(trigger)) {
    const left = conditionParameter(condition, 'arg0')
    const right = conditionParameter(condition, 'arg1')
    if (!left || !right || !isHostnameVariable(left)) continue
    const negated = conditionParameter(condition, 'negate') === 'true'
    filters.push({
      operator: condition.type ?? 'conditionTypeUnspecified',
      value: right,
      negated,
      matchesExpectedHostname: expectedHostname === undefined
        ? null
        : !negated && filterMatchesHostname(condition.type ?? '', right, expectedHostname),
    })
  }
  return filters
}

function triggerStrategy(triggers: GtmTrigger[]): GtmGoogleAdsConversionAssessment['trigger']['strategy'] {
  if (triggers.length === 0) return 'none'
  const categories = new Set(triggers.map((trigger) => {
    if (trigger.type === 'customEvent') return 'custom-event'
    if (trigger.type && URL_TRIGGER_TYPES.has(trigger.type)) return 'url-based'
    return 'unknown'
  }))
  if (categories.size > 1) return 'mixed'
  return [...categories][0] as 'custom-event' | 'url-based' | 'unknown'
}

function unknownAssessment(
  tag: GtmTag,
  reason: GtmGoogleAdsUnknownReason,
  triggers: readonly GtmTrigger[],
  options: GtmGoogleAdsRecognizerOptions,
): GtmGoogleAdsConversionAssessment {
  const firingTriggerIds = [...(tag.firingTriggerId ?? [])]
  const triggerById = new Map<string, GtmTrigger>()
  for (const trigger of triggers) {
    if (typeof trigger.triggerId === 'string') triggerById.set(trigger.triggerId, trigger)
  }
  const resolved = firingTriggerIds
    .map((id) => triggerById.get(id))
    .filter((trigger): trigger is GtmTrigger => trigger !== undefined)

  return {
    schemaVersion: GTM_GOOGLE_ADS_CONVERSION_ASSESSMENT_SCHEMA_VERSION,
    recognizerVersion: GTM_GOOGLE_ADS_CONVERSION_RECOGNIZER_VERSION,
    recognition: { status: 'unknown', reason },
    review: { status: 'needs-review', reasons: ['tag-unknown'] },
    tag: {
      id: tag.tagId ?? null,
      name: tag.name ?? null,
      type: tag.type ?? null,
      checksum: checksumJson(tag),
    },
    conversion: null,
    trigger: {
      strategy: triggerStrategy(resolved),
      firingTriggerIds,
      resolvedTriggerIds: resolved.flatMap((trigger) => trigger.triggerId ? [trigger.triggerId] : []),
      unresolvedTriggerIds: firingTriggerIds.filter((id) => !triggerById.has(id)),
      customEventNames: [...new Set(resolved.flatMap(customEventNames))],
      hostnameFilters: resolved.flatMap((trigger) => hostnameFilters(trigger, options.expectedHostname)),
    },
  }
}

/**
 * Recognize and assess only GTM's documented Google Ads Conversion Tracking
 * tag shape (`awct`). Opaque/custom tags are intentionally never inferred.
 */
export function recognizeGoogleAdsConversionTag(
  tag: GtmTag,
  triggers: readonly GtmTrigger[],
  options: GtmGoogleAdsRecognizerOptions = {},
): GtmGoogleAdsConversionAssessment {
  if (tag.type !== GOOGLE_ADS_CONVERSION_TAG_TYPE) {
    return unknownAssessment(tag, unknownReason(tag.type), triggers, options)
  }

  const byKey = parametersByKey(tag.parameter)
  const conversionId = scalarMapping(byKey, 'conversionId')
  const conversionLabel = scalarMapping(byKey, 'conversionLabel')
  if (!conversionId || !conversionLabel) {
    return unknownAssessment(tag, 'malformed-google-ads-conversion-tag', triggers, options)
  }

  const conversionValue = scalarMapping(byKey, 'conversionValue')
  const transactionId = scalarMapping(byKey, 'orderId')
  const currency = scalarMapping(byKey, 'currencyCode')
  const firingTriggerIds = [...(tag.firingTriggerId ?? [])]
  const triggerById = new Map<string, GtmTrigger>()
  for (const trigger of triggers) {
    if (typeof trigger.triggerId === 'string') triggerById.set(trigger.triggerId, trigger)
  }
  const resolved = firingTriggerIds
    .map((id) => triggerById.get(id))
    .filter((trigger): trigger is GtmTrigger => trigger !== undefined)
  const unresolvedTriggerIds = firingTriggerIds.filter((id) => !triggerById.has(id))
  const strategy = triggerStrategy(resolved)
  const eventNames = [...new Set(resolved.flatMap(customEventNames))]
  const hostFilters = resolved.flatMap((trigger) => hostnameFilters(trigger, options.expectedHostname))

  const reasons: GtmGoogleAdsReviewReason[] = []
  if (tag.paused) reasons.push('tag-paused')
  if (firingTriggerIds.length === 0) reasons.push('no-firing-trigger')
  if (unresolvedTriggerIds.length > 0) reasons.push('unresolved-firing-trigger')
  if (strategy === 'url-based') reasons.push('url-based-trigger')
  if (strategy === 'mixed') reasons.push('mixed-trigger-strategies')
  if (strategy === 'custom-event' && eventNames.length === 0) reasons.push('missing-custom-event-name')
  if (
    strategy === 'custom-event' &&
    options.expectedEventName &&
    !eventNames.includes(options.expectedEventName)
  ) reasons.push('unexpected-custom-event-name')
  if (hostFilters.length === 0) reasons.push('missing-hostname-filter')
  if (
    options.expectedHostname &&
    hostFilters.length > 0 &&
    !hostFilters.some((filter) => filter.matchesExpectedHostname)
  ) reasons.push('unexpected-hostname-filter')
  if (!conversionValue) reasons.push('missing-conversion-value')
  if (!transactionId) reasons.push('missing-transaction-id')

  return {
    schemaVersion: GTM_GOOGLE_ADS_CONVERSION_ASSESSMENT_SCHEMA_VERSION,
    recognizerVersion: GTM_GOOGLE_ADS_CONVERSION_RECOGNIZER_VERSION,
    recognition: { status: 'recognized', kind: 'google-ads-conversion' },
    review: { status: reasons.length === 0 ? 'pass' : 'needs-review', reasons },
    tag: {
      id: tag.tagId ?? null,
      name: tag.name ?? null,
      type: tag.type ?? null,
      checksum: checksumJson(tag),
    },
    conversion: {
      id: conversionId,
      label: conversionLabel,
      value: conversionValue,
      transactionId,
      currency,
    },
    trigger: {
      strategy,
      firingTriggerIds,
      resolvedTriggerIds: resolved.flatMap((trigger) => trigger.triggerId ? [trigger.triggerId] : []),
      unresolvedTriggerIds,
      customEventNames: eventNames,
      hostnameFilters: hostFilters,
    },
  }
}
