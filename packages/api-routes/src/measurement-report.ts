/**
 * Pure measurement-report engine.
 *
 * This module deliberately owns no database, provider, network, or route
 * concerns. Callers supply a frozen plan, expected execution/provider slots,
 * and stored observations. That keeps historical reconstruction explicit and
 * prevents a read from mutating or re-fetching evidence.
 */

import { normalizeMeasurementHost } from '@ainyc/canonry-contracts'

export type MeasurementAttributionClass =
  | 'assigned'
  | 'sibling'
  | 'ownedUnmapped'
  | 'external'
  | 'ambiguous'
  | 'invalid'

export type MeasurementUsageEdgeType = 'baseline' | 'target'
export type MeasurementUrlMatchMode = 'exact' | 'prefix' | 'host'
export type MeasurementMetricReason =
  | 'incomplete'
  | 'evidence-incomplete'
  | 'no-population'
  | 'aliasless'
  | 'no-competitors'
  | 'no-project-aliases'

export interface MeasurementTargetUrlInput {
  id: string
  mode: MeasurementUrlMatchMode
  host: string
  path?: string
  pathCase?: 'sensitive' | 'insensitive'
}

export interface MeasurementTargetInput {
  id: string
  label: string
  aliases: readonly string[]
  urls: readonly MeasurementTargetUrlInput[]
}

export interface MeasurementCompetitorInput {
  /** Revision-pinned domain used for a comparable SoV row. */
  domain: string
  aliases: readonly string[]
}

export interface MeasurementGroupInput {
  id: string
  label: string
  targetIds: readonly string[]
  competitors: readonly MeasurementCompetitorInput[]
}

export interface MeasurementExpectedSlotInput {
  id: string
  executionId: string
  queryText: string
  provider: string
  location: string | null
  requestedModel?: string | null
}

export type MeasurementUsageEdgeInput =
  | {
      id: string
      type: 'baseline'
      executionId: string
    }
  | {
      id: string
      type: 'target'
      executionId: string
      targetId: string
    }

export interface MeasurementObservationInput {
  id: string
  executionId: string | null
  queryText: string
  provider: string
  location: string | null
  answerText: string | null
  /** Live/post-v111 evidence. When non-null this always wins. */
  citedUrls: readonly string[] | null
  citedUrlsComplete: boolean
  /** Offline-only recovery supplied by the caller from stored raw evidence. */
  historicalCitedUrls?: readonly string[]
  historicalCitedUrlsComplete?: boolean
}

export interface MeasurementReportInput {
  revision: number
  ownedHosts: readonly string[]
  /** Revision-pinned project identity. Never derive this from current project state. */
  projectBrandNames: readonly string[]
  /** Revision-pinned canonical project domain for the symmetric SoV output. */
  projectDomain: string
  targets: readonly MeasurementTargetInput[]
  groups: readonly MeasurementGroupInput[]
  expectedSlots: readonly MeasurementExpectedSlotInput[]
  usageEdges: readonly MeasurementUsageEdgeInput[]
  observations: readonly MeasurementObservationInput[]
}

export interface MeasurementAttributionResult {
  classification: MeasurementAttributionClass
  normalizedUrl: string | null
  matchedTargetIds: string[]
  matchedUrlIds: string[]
}

export interface MeasurementAttributionEvidence extends MeasurementAttributionResult {
  observationId: string
  expectedSlotId: string
  executionId: string
  usageEdgeId: string
  usageEdgeType: MeasurementUsageEdgeType
  provider: string
  queryText: string
  location: string | null
  sourceUrl: string
  bridged: boolean
  historical: boolean
  evidenceComplete: boolean
}

export type MeasurementRate =
  | { numerator: number; denominator: number; rate: number; reason?: never }
  | { numerator: null; denominator: null; rate: null; reason: MeasurementMetricReason }

export interface MeasurementCompleteness {
  executed: number
  expected: number
  /**
   * Executed observations whose citation capture is complete. This is the exact
   * denominator basis of every source-dependent rate, so a reader can always see
   * how many of the executed observations a coverage rate was computed over.
   * Equal to `executed` when `sourceComplete` is true.
   */
  sourceCompleteObservations: number
  complete: boolean
  sourceComplete: boolean
  answerComplete: boolean
}

export interface MeasurementProviderCoverage {
  provider: string
  completeness: MeasurementCompleteness
  answerCoverage: MeasurementRate
}

export type MeasurementSovDomain =
  | { domain: string; own: boolean; presentIn: number; of: number; reason?: never }
  | { domain: string; own: boolean; presentIn: null; of: null; reason: MeasurementMetricReason }

export interface MeasurementSov {
  /** One frozen project row and one row per competitor domain. */
  domains: MeasurementSovDomain[]
  providers: Array<{ provider: string; domains: MeasurementSovDomain[] }>
}

export interface MeasurementGroupReport {
  id: string
  label: string
  /** Revision-pinned member ids for Target drill-down. */
  targetIds: string[]
  completeness: MeasurementCompleteness
  answerCoverage: MeasurementRate
  targetCoverage: MeasurementRate
  sov: MeasurementSov
  providers: MeasurementProviderCoverage[]
}

export interface MeasurementTargetProviderReport {
  provider: string
  completeness: MeasurementCompleteness
  citationCoverage: MeasurementRate
  mentionCoverage: MeasurementRate
}

export interface MeasurementTargetReport {
  id: string
  label: string
  completeness: MeasurementCompleteness
  citationCoverage: MeasurementRate
  mentionCoverage: MeasurementRate
  providers: MeasurementTargetProviderReport[]
}

export interface MeasurementReport {
  revision: number
  groups: MeasurementGroupReport[]
  targets: MeasurementTargetReport[]
  evidence: MeasurementAttributionEvidence[]
  diagnostics: {
    bridgedObservationIds: string[]
    historicalObservationIds: string[]
    evidenceIncompleteObservationIds: string[]
    ambiguousObservationIds: string[]
    unmatchedObservationIds: string[]
  }
}

/** One comparable name and the revision-pinned aliases it is recognized by. */
export interface MeasurementNamedIdentityInput {
  key: string
  aliases: readonly string[]
}

export interface MeasurementOverviewInput extends MeasurementReportInput {
  /** The Properties this scope selects. Every metric is taken over slots reachable from them. */
  scopeTargetIds: readonly string[]
  /**
   * Identities for the shared-denominator named share. The caller supplies them
   * only where the spec allows one, so the kernel never has to know which scope
   * it is serving.
   */
  namedIdentities?: readonly MeasurementNamedIdentityInput[]
}

export interface MeasurementOverviewPropertyRow {
  targetId: string
  mentionCoverage: MeasurementRate
  citationCoverage: MeasurementRate
  flags: number
}

export interface MeasurementNamedShareOfVoice {
  /** One shared denominator: the sum of named presence credits, not a slot count. */
  denominator: number
  entries: Array<{ key: string; credits: number; share: number }>
}

export interface MeasurementOverview {
  eligibleSlots: number
  answeredSlots: number
  /** Run-level provenance, independent of whether any recovered source URL produced an evidence row. */
  includesHistoricalData: boolean
  propertiesMentioned: MeasurementRate
  mentionCoverage: MeasurementRate
  citationCoverage: MeasurementRate
  brandPresence: MeasurementRate
  namedShareOfVoice: MeasurementNamedShareOfVoice | null
  properties: MeasurementOverviewPropertyRow[]
  flags: number
}

interface ParsedSourceUrl {
  normalizedUrl: string
  host: string
  path: string
}

interface RouteClaim {
  targetId: string
  urlId: string
  modeRank: number
  pathLength: number
}

interface PreparedObservation {
  input: MeasurementObservationInput
  slot: MeasurementExpectedSlotInput
  bridged: boolean
  historical: boolean
  sourceComplete: boolean
  sourceUrls: string[]
  mentionedTargetIds: ReadonlySet<string>
}

interface PreparedReport {
  observationsBySlot: ReadonlyMap<string, PreparedObservation>
  evidence: MeasurementAttributionEvidence[]
  diagnostics: MeasurementReport['diagnostics']
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function normalizedHost(value: string): string {
  try {
    return normalizeMeasurementHost(value)
  } catch {
    return value.trim().toLocaleLowerCase('en').replace(/\.$/, '').replace(/^www\./, '')
  }
}

function normalizedPath(value: string | undefined): string {
  if (!value) return '/'
  const absolute = value.startsWith('/') ? value : `/${value}`
  let pathname = absolute
  try {
    pathname = new URL(`https://measurement.invalid${absolute}`).pathname
  } catch {
    // An invalid configured matcher simply cannot claim a valid source URL.
  }
  const pieces: string[] = []
  let slash = false
  for (const character of pathname) {
    if (character === '/') {
      if (!slash) pieces.push(character)
      slash = true
    } else {
      pieces.push(character)
      slash = false
    }
  }
  while (pieces.length > 1 && pieces.at(-1) === '/') pieces.pop()
  return pieces.join('') || '/'
}

function parseSourceUrl(value: string): ParsedSourceUrl | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    const host = normalizedHost(parsed.hostname)
    const path = normalizedPath(parsed.pathname)
    parsed.pathname = path
    return { normalizedUrl: parsed.toString(), host, path }
  } catch {
    return null
  }
}

function ownedBy(host: string, roots: readonly string[]): boolean {
  return roots.some(root => host === root || host.endsWith(`.${root}`))
}

function routeClaim(
  source: ParsedSourceUrl,
  target: MeasurementTargetInput,
  url: MeasurementTargetUrlInput,
): RouteClaim | null {
  if (source.host !== normalizedHost(url.host)) return null
  if (url.mode === 'host') return { targetId: target.id, urlId: url.id, modeRank: 1, pathLength: 0 }

  const configuredPath = normalizedPath(url.path)
  const sourcePath = url.pathCase === 'insensitive'
    ? source.path.toLocaleLowerCase('en')
    : source.path
  const matcherPath = url.pathCase === 'insensitive'
    ? configuredPath.toLocaleLowerCase('en')
    : configuredPath
  const matches = url.mode === 'exact'
    ? sourcePath === matcherPath
    : matcherPath === '/' || sourcePath === matcherPath || sourcePath.startsWith(`${matcherPath}/`)
  if (!matches) return null
  return {
    targetId: target.id,
    urlId: url.id,
    modeRank: url.mode === 'exact' ? 3 : 2,
    pathLength: matcherPath.length,
  }
}

export function classifyCitedUrl(
  value: string,
  targets: readonly MeasurementTargetInput[],
  ownedHosts: readonly string[],
  usageEdge: MeasurementUsageEdgeInput,
): MeasurementAttributionResult {
  const source = parseSourceUrl(value)
  if (!source) {
    return { classification: 'invalid', normalizedUrl: null, matchedTargetIds: [], matchedUrlIds: [] }
  }

  const claims: RouteClaim[] = []
  for (const target of targets) {
    for (const url of target.urls) {
      const claim = routeClaim(source, target, url)
      if (claim) claims.push(claim)
    }
  }
  claims.sort((left, right) => (
    right.modeRank - left.modeRank
    || right.pathLength - left.pathLength
    || compareText(left.targetId, right.targetId)
    || compareText(left.urlId, right.urlId)
  ))

  const best = claims.at(0)
  if (!best) {
    return {
      classification: ownedBy(source.host, ownedHosts.map(normalizedHost)) ? 'ownedUnmapped' : 'external',
      normalizedUrl: source.normalizedUrl,
      matchedTargetIds: [],
      matchedUrlIds: [],
    }
  }
  const winners = claims.filter(claim => claim.modeRank === best.modeRank && claim.pathLength === best.pathLength)
  const matchedTargetIds = sortedUnique(winners.map(claim => claim.targetId))
  const matchedUrlIds = sortedUnique(winners.map(claim => claim.urlId))
  if (matchedTargetIds.length !== 1) {
    return { classification: 'ambiguous', normalizedUrl: source.normalizedUrl, matchedTargetIds, matchedUrlIds }
  }

  return {
    classification: usageEdge.type === 'target' && usageEdge.targetId === matchedTargetIds[0]
      ? 'assigned'
      : 'sibling',
    normalizedUrl: source.normalizedUrl,
    matchedTargetIds,
    matchedUrlIds,
  }
}

export function normalizeMeasurementLocation(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
  return normalized || null
}

function words(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []
}

/** The exact token identity used when deciding whether two Target aliases are ambiguous. */
export function measurementMentionAliasKey(value: string): string {
  return words(value).join('\u0000')
}

function aliasMatchesAt(textWords: readonly string[], aliasWords: readonly string[], start: number): boolean {
  if (aliasWords.length === 0 || start + aliasWords.length > textWords.length) return false
  for (let index = 0; index < aliasWords.length; index++) {
    if (textWords[start + index] !== aliasWords[index]) return false
  }
  return true
}

function containsAnyAlias(answerText: string, aliases: readonly string[]): boolean {
  const textWords = words(answerText)
  const candidates = aliases.map(words).filter(alias => alias.length > 0)
  for (let start = 0; start < textWords.length; start++) {
    if (candidates.some(alias => aliasMatchesAt(textWords, alias, start))) return true
  }
  return false
}

function mentionedTargets(answerText: string | null, targets: readonly MeasurementTargetInput[]): ReadonlySet<string> {
  const result = new Set<string>()
  if (answerText === null) return result
  const textWords = words(answerText)
  const aliases = targets.flatMap(target => target.aliases.map(alias => ({ targetId: target.id, words: words(alias) })))
    .filter(alias => alias.words.length > 0)

  for (let start = 0; start < textWords.length;) {
    const matches = aliases.filter(alias => aliasMatchesAt(textWords, alias.words, start))
    if (matches.length === 0) {
      start++
      continue
    }
    const longest = Math.max(...matches.map(match => match.words.length))
    const owners = sortedUnique(matches.filter(match => match.words.length === longest).map(match => match.targetId))
    if (owners.length === 1) result.add(owners[0]!)
    start += longest
  }
  return result
}

function observationSource(observation: MeasurementObservationInput): {
  urls: string[]
  historical: boolean
  complete: boolean
} {
  if (observation.citedUrls !== null) {
    return {
      urls: sortedUnique(observation.citedUrls),
      historical: false,
      complete: observation.citedUrlsComplete,
    }
  }
  return {
    urls: sortedUnique(observation.historicalCitedUrls ?? []),
    historical: true,
    complete: observation.historicalCitedUrlsComplete === true,
  }
}

function prepareReport(input: MeasurementReportInput): PreparedReport {
  const ambiguous = new Set<string>()
  const unmatched = new Set<string>()
  const bridged = new Set<string>()
  const candidates = new Map<string, MeasurementObservationInput[]>()

  for (const observation of input.observations) {
    const slots = observation.executionId !== null
      ? input.expectedSlots.filter(slot => slot.executionId === observation.executionId && slot.provider === observation.provider)
      : input.expectedSlots.filter(slot => (
        slot.queryText === observation.queryText
        && slot.provider === observation.provider
        && normalizeMeasurementLocation(slot.location) === normalizeMeasurementLocation(observation.location)
      ))
    if (slots.length === 0) {
      unmatched.add(observation.id)
      continue
    }
    if (slots.length !== 1) {
      ambiguous.add(observation.id)
      continue
    }
    const slot = slots[0]!
    const rows = candidates.get(slot.id) ?? []
    rows.push(observation)
    candidates.set(slot.id, rows)
  }

  const observationsBySlot = new Map<string, PreparedObservation>()
  const historical = new Set<string>()
  const evidenceIncomplete = new Set<string>()
  for (const slot of [...input.expectedSlots].sort((left, right) => compareText(left.id, right.id))) {
    const rows = candidates.get(slot.id) ?? []
    if (rows.length > 1) {
      for (const row of rows) ambiguous.add(row.id)
      continue
    }
    const observation = rows.at(0)
    if (!observation || ambiguous.has(observation.id)) continue
    const source = observationSource(observation)
    const isBridged = observation.executionId === null
    if (isBridged) bridged.add(observation.id)
    if (source.historical) historical.add(observation.id)
    if (!source.complete) evidenceIncomplete.add(observation.id)
    observationsBySlot.set(slot.id, {
      input: observation,
      slot,
      bridged: isBridged,
      historical: source.historical,
      sourceComplete: source.complete,
      sourceUrls: source.urls,
      mentionedTargetIds: mentionedTargets(observation.answerText, input.targets),
    })
  }

  const edgesByExecution = new Map<string, MeasurementUsageEdgeInput[]>()
  for (const edge of input.usageEdges) {
    const edges = edgesByExecution.get(edge.executionId) ?? []
    edges.push(edge)
    edgesByExecution.set(edge.executionId, edges)
  }

  const evidence: MeasurementAttributionEvidence[] = []
  for (const observation of observationsBySlot.values()) {
    const edges = [...(edgesByExecution.get(observation.slot.executionId) ?? [])]
      .sort((left, right) => compareText(left.id, right.id))
    for (const edge of edges) {
      for (const sourceUrl of observation.sourceUrls) {
        evidence.push({
          observationId: observation.input.id,
          expectedSlotId: observation.slot.id,
          executionId: observation.slot.executionId,
          usageEdgeId: edge.id,
          usageEdgeType: edge.type,
          provider: observation.slot.provider,
          queryText: observation.slot.queryText,
          location: observation.slot.location,
          sourceUrl,
          bridged: observation.bridged,
          historical: observation.historical,
          evidenceComplete: observation.sourceComplete,
          ...classifyCitedUrl(sourceUrl, input.targets, input.ownedHosts, edge),
        })
      }
    }
  }
  evidence.sort((left, right) => (
    compareText(left.expectedSlotId, right.expectedSlotId)
    || compareText(left.usageEdgeId, right.usageEdgeId)
    || compareText(left.sourceUrl, right.sourceUrl)
    || compareText(left.classification, right.classification)
  ))

  return {
    observationsBySlot,
    evidence,
    diagnostics: {
      bridgedObservationIds: sortedUnique([...bridged].filter(id => !ambiguous.has(id))),
      historicalObservationIds: sortedUnique([...historical]),
      evidenceIncompleteObservationIds: sortedUnique([...evidenceIncomplete]),
      ambiguousObservationIds: sortedUnique([...ambiguous]),
      unmatchedObservationIds: sortedUnique([...unmatched]),
    },
  }
}

function slotsForEdges(
  expectedSlots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
): MeasurementExpectedSlotInput[] {
  const executionIds = new Set(edges.map(edge => edge.executionId))
  const slots = new Map<string, MeasurementExpectedSlotInput>()
  for (const slot of expectedSlots) {
    if (executionIds.has(slot.executionId)) slots.set(slot.id, slot)
  }
  return [...slots.values()].sort((left, right) => compareText(left.id, right.id))
}

function completeness(
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementCompleteness {
  const observations = slots.flatMap(slot => {
    const observation = prepared.observationsBySlot.get(slot.id)
    return observation ? [observation] : []
  })
  const complete = observations.length === slots.length
  const sourceCompleteObservations = observations.filter(observation => observation.sourceComplete).length
  return {
    executed: observations.length,
    expected: slots.length,
    sourceCompleteObservations,
    complete,
    sourceComplete: complete && sourceCompleteObservations === observations.length,
    answerComplete: complete && observations.every(observation => observation.input.answerText !== null),
  }
}

/**
 * Cited URLs come from live web sources, so a fraction of them never resolves and
 * some observations land with partial citation capture. Those rows are not zeros
 * and they are not grounds to refuse the whole population: they simply leave the
 * denominator. Every source-dependent rate is computed over exactly this basis,
 * and `MeasurementCompleteness.sourceCompleteObservations` reports its size.
 */
function sourceCompleteSlots(
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementExpectedSlotInput[] {
  return slots.filter(slot => prepared.observationsBySlot.get(slot.id)?.sourceComplete === true)
}

function coverageRate(
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const status = completeness(slots, prepared)
  if (slots.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  if (!status.complete) return { numerator: null, denominator: null, rate: null, reason: 'incomplete' }

  const basis = sourceCompleteSlots(slots, prepared)
  if (basis.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }

  const edgeIds = new Set(edges.map(edge => edge.id))
  const assignedSlots = new Set(prepared.evidence
    .filter(row => edgeIds.has(row.usageEdgeId) && row.classification === 'assigned')
    .map(row => row.expectedSlotId))
  const numerator = basis.filter(slot => assignedSlots.has(slot.id)).length
  return { numerator, denominator: basis.length, rate: numerator / basis.length }
}

function targetCoverageRate(
  targetIds: readonly string[],
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const status = completeness(slots, prepared)
  const denominator = sortedUnique(targetIds).length
  if (denominator === 0 || slots.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  if (!status.complete) return { numerator: null, denominator: null, rate: null, reason: 'incomplete' }

  const basis = new Set(sourceCompleteSlots(slots, prepared).map(slot => slot.id))
  if (basis.size === 0) return { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }

  const edgeIds = new Set(edges.map(edge => edge.id))
  // A target cited only by a partially captured observation cannot count here: its
  // evidence sits outside the basis the rate is reported over.
  const citedTargets = new Set(prepared.evidence
    .filter(row => edgeIds.has(row.usageEdgeId) && row.classification === 'assigned' && basis.has(row.expectedSlotId))
    .flatMap(row => row.matchedTargetIds))
  const numerator = sortedUnique(targetIds).filter(id => citedTargets.has(id)).length
  return { numerator, denominator, rate: numerator / denominator }
}

function mentionRate(
  target: MeasurementTargetInput,
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const numerator = slots.filter(slot => prepared.observationsBySlot.get(slot.id)?.mentionedTargetIds.has(target.id)).length
  if (target.aliases.every(alias => words(alias).length === 0)) {
    return { numerator: null, denominator: null, rate: null, reason: 'aliasless' }
  }
  if (slots.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  const status = completeness(slots, prepared)
  if (!status.complete || !status.answerComplete) {
    return { numerator: null, denominator: null, rate: null, reason: 'incomplete' }
  }
  return { numerator, denominator: slots.length, rate: numerator / slots.length }
}

function providersFor(slots: readonly MeasurementExpectedSlotInput[]): string[] {
  return sortedUnique(slots.map(slot => slot.provider))
}

function buildSovForSlots(
  slots: readonly MeasurementExpectedSlotInput[],
  competitors: readonly MeasurementCompetitorInput[],
  projectBrandNames: readonly string[],
  projectDomain: string,
  prepared: PreparedReport,
): MeasurementSov {
  const sortedCompetitors = [...competitors].sort((left, right) => compareText(left.domain, right.domain))
  const rows = [
    { domain: projectDomain, own: true, aliases: projectBrandNames },
    ...sortedCompetitors.map(competitor => ({
      domain: competitor.domain,
      own: false,
      aliases: competitor.aliases,
    })),
  ]

  const calculate = (selected: readonly MeasurementExpectedSlotInput[]): MeasurementSovDomain[] => {
    const status = completeness(selected, prepared)
    let reason: MeasurementMetricReason | null = null
    if (selected.length === 0) reason = 'no-population'
    else if (!status.complete || !status.answerComplete) reason = 'incomplete'
    else if (projectBrandNames.every(alias => words(alias).length === 0)) reason = 'no-project-aliases'
    else if (sortedCompetitors.length === 0) reason = 'no-competitors'

    return rows.map(row => {
      if (reason !== null) return { domain: row.domain, own: row.own, presentIn: null, of: null, reason }
      if (row.aliases.every(alias => words(alias).length === 0)) {
        return { domain: row.domain, own: row.own, presentIn: null, of: null, reason: 'aliasless' }
      }
      const presentIn = selected.filter(slot => {
        const answer = prepared.observationsBySlot.get(slot.id)?.input.answerText
        return answer !== null && answer !== undefined && containsAnyAlias(answer, row.aliases)
      }).length
      return { domain: row.domain, own: row.own, presentIn, of: selected.length }
    })
  }

  return {
    domains: calculate(slots),
    providers: providersFor(slots).map(provider => ({
      provider,
      domains: calculate(slots.filter(slot => slot.provider === provider)),
    })),
  }
}

function buildGroupReport(
  group: MeasurementGroupInput,
  input: MeasurementReportInput,
  prepared: PreparedReport,
): MeasurementGroupReport {
  const targetIds = new Set(group.targetIds)
  // Groups are reporting lenses only. Their population is the unique slot set
  // reached by member target edges; shared executions are counted once.
  const edges = input.usageEdges.filter((edge): edge is Extract<MeasurementUsageEdgeInput, { type: 'target' }> => (
    edge.type === 'target' && targetIds.has(edge.targetId)
  ))
  const slots = slotsForEdges(input.expectedSlots, edges)
  return {
    id: group.id,
    label: group.label,
    targetIds: sortedUnique(group.targetIds),
    completeness: completeness(slots, prepared),
    answerCoverage: coverageRate(slots, edges, prepared),
    targetCoverage: targetCoverageRate(group.targetIds, slots, edges, prepared),
    sov: buildSovForSlots(slots, group.competitors, input.projectBrandNames, input.projectDomain, prepared),
    providers: providersFor(slots).map(provider => {
      const providerSlots = slots.filter(slot => slot.provider === provider)
      return {
        provider,
        completeness: completeness(providerSlots, prepared),
        answerCoverage: coverageRate(providerSlots, edges, prepared),
      }
    }),
  }
}

function buildTargetReport(
  target: MeasurementTargetInput,
  input: MeasurementReportInput,
  prepared: PreparedReport,
): MeasurementTargetReport {
  const edges = input.usageEdges.filter((edge): edge is Extract<MeasurementUsageEdgeInput, { type: 'target' }> => (
    edge.type === 'target' && edge.targetId === target.id
  ))
  const slots = slotsForEdges(input.expectedSlots, edges)
  return {
    id: target.id,
    label: target.label,
    completeness: completeness(slots, prepared),
    citationCoverage: coverageRate(slots, edges, prepared),
    mentionCoverage: mentionRate(target, slots, prepared),
    providers: providersFor(slots).map(provider => {
      const providerSlots = slots.filter(slot => slot.provider === provider)
      return {
        provider,
        completeness: completeness(providerSlots, prepared),
        citationCoverage: coverageRate(providerSlots, edges, prepared),
        mentionCoverage: mentionRate(target, providerSlots, prepared),
      }
    }),
  }
}

function unavailable(reason: MeasurementMetricReason): MeasurementRate {
  return { numerator: null, denominator: null, rate: null, reason }
}

function scopeEdges(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
): Array<Extract<MeasurementUsageEdgeInput, { type: 'target' }>> {
  return input.usageEdges.filter((edge): edge is Extract<MeasurementUsageEdgeInput, { type: 'target' }> => (
    edge.type === 'target' && targetIds.has(edge.targetId)
  ))
}

/**
 * Slots whose answer text actually landed. Every answer-dependent overview rate
 * is taken over these rather than over the whole expected population: a run that
 * answered half its slots has measured half, not zero.
 */
function answeredSlots(
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementExpectedSlotInput[] {
  return slots.filter(slot => {
    const answer = prepared.observationsBySlot.get(slot.id)?.input.answerText
    return answer !== null && answer !== undefined
  })
}

function mentionableTargets(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
): MeasurementTargetInput[] {
  return input.targets.filter(target => (
    targetIds.has(target.id) && target.aliases.some(alias => words(alias).length > 0)
  ))
}

function scopeMentionRate(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const mentionable = mentionableTargets(input, targetIds)
  if (mentionable.length === 0) return unavailable('aliasless')
  if (slots.length === 0) return unavailable('no-population')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const ids = mentionable.map(target => target.id)
  const numerator = answered.filter(slot => {
    const mentioned = prepared.observationsBySlot.get(slot.id)?.mentionedTargetIds
    return mentioned !== undefined && ids.some(id => mentioned.has(id))
  }).length
  return { numerator, denominator: answered.length, rate: numerator / answered.length }
}

function scopeCitationRate(
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  prepared: PreparedReport,
): MeasurementRate {
  if (slots.length === 0) return unavailable('no-population')
  const basis = sourceCompleteSlots(slots, prepared)
  if (basis.length === 0) return unavailable('evidence-incomplete')

  const edgeIds = new Set(edges.map(edge => edge.id))
  const assignedSlots = new Set(prepared.evidence
    .filter(row => edgeIds.has(row.usageEdgeId) && row.classification === 'assigned')
    .map(row => row.expectedSlotId))
  const numerator = basis.filter(slot => assignedSlots.has(slot.id)).length
  return { numerator, denominator: basis.length, rate: numerator / basis.length }
}

function presenceIn(
  slots: readonly MeasurementExpectedSlotInput[],
  aliases: readonly string[],
  prepared: PreparedReport,
): number {
  return slots.filter(slot => {
    const answer = prepared.observationsBySlot.get(slot.id)?.input.answerText
    return answer !== null && answer !== undefined && containsAnyAlias(answer, aliases)
  }).length
}

/**
 * Independent identity presence, never a share of anything. Nobody else's
 * appearance moves this number, which is exactly what separates it from the
 * shared-denominator named share below.
 */
function scopeBrandPresence(
  input: MeasurementOverviewInput,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  if (slots.length === 0) return unavailable('no-population')
  if (input.projectBrandNames.every(alias => words(alias).length === 0)) return unavailable('no-project-aliases')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const numerator = presenceIn(answered, input.projectBrandNames, prepared)
  return { numerator, denominator: answered.length, rate: numerator / answered.length }
}

function scopePropertiesMentioned(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const mentionable = mentionableTargets(input, targetIds)
  if (mentionable.length === 0) return unavailable('aliasless')
  if (slots.length === 0) return unavailable('no-population')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const mentioned = new Set(answered.flatMap(slot => (
    [...(prepared.observationsBySlot.get(slot.id)?.mentionedTargetIds ?? [])]
  )))
  const numerator = mentionable.filter(target => mentioned.has(target.id)).length
  return { numerator, denominator: mentionable.length, rate: numerator / mentionable.length }
}

function scopeNamedShareOfVoice(
  identities: readonly MeasurementNamedIdentityInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementNamedShareOfVoice | null {
  if (identities.length === 0 || answered.length === 0) return null

  const credited = identities.map(identity => ({
    key: identity.key,
    credits: presenceIn(answered, identity.aliases, prepared),
  }))
  // One answer may name several identities, so this sums credits rather than
  // slots. A denominator of zero is no share at all, not a row of zeroes.
  const denominator = credited.reduce((total, row) => total + row.credits, 0)
  if (denominator === 0) return null
  return {
    denominator,
    entries: credited.map(row => ({ ...row, share: row.credits / denominator })),
  }
}

/**
 * Cited URLs that tied between this Property and another at equal precedence.
 * They earn no credit anywhere (§12), so they are surfaced as work for the
 * operator instead of quietly vanishing from both denominators.
 */
function ambiguousFlags(
  targetId: string,
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  prepared: PreparedReport,
): number {
  const slotIds = new Set(slots.map(slot => slot.id))
  const edgeIds = new Set(edges.map(edge => edge.id))
  const seen = new Set<string>()
  for (const row of prepared.evidence) {
    if (row.classification !== 'ambiguous') continue
    if (!slotIds.has(row.expectedSlotId) || !edgeIds.has(row.usageEdgeId)) continue
    if (!row.matchedTargetIds.includes(targetId)) continue
    seen.add(`${row.expectedSlotId}\u0000${row.sourceUrl}`)
  }
  return seen.size
}

/**
 * Scoped aggregate over one run's evidence.
 *
 * The caller narrows `expectedSlots` and `usageEdges` before calling — that is
 * how the provider, location and question-class filters are applied — so the
 * kernel only has to reach the unique slots the selected Properties share. Two
 * Properties reusing one execution contribute one slot, never two.
 */
export function buildMeasurementOverview(input: MeasurementOverviewInput): MeasurementOverview {
  const prepared = prepareReport(input)
  const targetIds = new Set(input.scopeTargetIds)
  const edges = scopeEdges(input, targetIds)
  const slots = slotsForEdges(input.expectedSlots, edges)
  const answered = answeredSlots(slots, prepared)

  const properties = sortedUnique([...targetIds]).map(targetId => {
    const ownEdges = scopeEdges(input, new Set([targetId]))
    const ownSlots = slotsForEdges(input.expectedSlots, ownEdges)
    return {
      targetId,
      mentionCoverage: scopeMentionRate(input, new Set([targetId]), ownSlots, answeredSlots(ownSlots, prepared), prepared),
      citationCoverage: scopeCitationRate(ownSlots, ownEdges, prepared),
      flags: ambiguousFlags(targetId, ownSlots, ownEdges, prepared),
    }
  })

  return {
    eligibleSlots: slots.length,
    answeredSlots: answered.length,
    includesHistoricalData: prepared.diagnostics.bridgedObservationIds.length > 0
      || prepared.diagnostics.historicalObservationIds.length > 0,
    propertiesMentioned: scopePropertiesMentioned(input, targetIds, slots, answered, prepared),
    mentionCoverage: scopeMentionRate(input, targetIds, slots, answered, prepared),
    citationCoverage: scopeCitationRate(slots, edges, prepared),
    brandPresence: scopeBrandPresence(input, slots, answered, prepared),
    namedShareOfVoice: scopeNamedShareOfVoice(input.namedIdentities ?? [], answered, prepared),
    properties,
    flags: properties.reduce((total, row) => total + row.flags, 0),
  }
}

export function buildMeasurementReport(input: MeasurementReportInput): MeasurementReport {
  const prepared = prepareReport(input)
  return {
    revision: input.revision,
    groups: [...input.groups]
      .sort((left, right) => compareText(left.id, right.id))
      .map(group => buildGroupReport(group, input, prepared)),
    targets: [...input.targets]
      .sort((left, right) => compareText(left.id, right.id))
      .map(target => buildTargetReport(target, input, prepared)),
    evidence: prepared.evidence,
    diagnostics: prepared.diagnostics,
  }
}
