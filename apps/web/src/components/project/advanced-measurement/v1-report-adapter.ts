import type { MeasurementPlanResponse, MeasurementReportResponse } from '@ainyc/canonry-api-client'

import type {
  AdvancedMeasurementEvidence,
  AdvancedMeasurementMetric,
  AdvancedMeasurementOverviewReport,
  AdvancedMeasurementProperty,
} from './AdvancedMeasurementOverview.js'

type ActivePlan = NonNullable<MeasurementPlanResponse['active']>
type PlanV1 = Extract<ActivePlan['plan'], { schemaVersion: 1 }>
type ReportTarget = MeasurementReportResponse['targets'][number]
type ReportEvidence = MeasurementReportResponse['evidence'][number]

const unavailableMetric: AdvancedMeasurementMetric = {
  numerator: null,
  denominator: null,
  reason: 'plan_v1',
}

function matcherLabel(matcher: PlanV1['targets'][number]['urls'][number]): string {
  if (matcher.kind === 'exact') return matcher.url
  if (matcher.kind === 'prefix') return `https://${matcher.host}${matcher.pathPrefix}`
  return `https://${matcher.host}`
}

function metric(rate: ReportTarget['mentionCoverage']): AdvancedMeasurementMetric {
  if (rate.numerator === null) {
    return { numerator: null, denominator: null, reason: rate.reason }
  }
  return { numerator: rate.numerator, denominator: rate.denominator }
}

function evidenceKind(classification: ReportEvidence['classification']): AdvancedMeasurementEvidence['kind'] {
  if (classification === 'assigned') return 'this-property'
  if (classification === 'sibling') return 'another-property'
  if (classification === 'ownedUnmapped') return 'owned-unassigned'
  if (classification === 'external') return 'external'
  if (classification === 'ambiguous') return 'multiple-properties'
  return 'invalid-url'
}

function evidenceTone(classification: ReportEvidence['classification']): AdvancedMeasurementEvidence['tone'] {
  if (classification === 'assigned') return 'positive'
  if (classification === 'external') return 'neutral'
  if (classification === 'invalid') return 'negative'
  return 'caution'
}

function reportDate(value: string | null): string {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Date unavailable'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function measuredTargetId(evidence: ReportEvidence): string | null {
  if (evidence.usageEdgeType !== 'target' || !evidence.usageEdgeId.startsWith('target:')) return null
  return evidence.usageEdgeId.slice('target:'.length).split(':', 1)[0] ?? null
}

export function adaptVersionOneMeasurementReport(
  active: ActivePlan,
  report: MeasurementReportResponse,
): AdvancedMeasurementOverviewReport {
  if (active.plan.schemaVersion !== 1) throw new Error('Version-one report adapter received a different setup version.')
  const plan = active.plan
  const targetConfig = new Map(plan.targets.map(target => [target.stableKey, target]))
  const queryText = new Map(plan.querySnapshots.map(query => [query.queryId, query.queryText]))
  const selections = new Map<string, string[]>()
  for (const selection of plan.targetQuerySelections) {
    const current = selections.get(selection.targetKey) ?? []
    current.push(...selection.queryIds.map(queryId => queryText.get(queryId)).filter((value): value is string => Boolean(value)))
    selections.set(selection.targetKey, [...new Set(current)])
  }

  const properties: AdvancedMeasurementProperty[] = report.targets.map(target => {
    const configured = targetConfig.get(target.id)
    const matchedEvidence = report.evidence.filter(item => measuredTargetId(item) === target.id)
    const evidence = matchedEvidence.map(item => ({
        id: `${item.observationId}:${item.usageEdgeId}:${item.sourceUrl}`,
        kind: evidenceKind(item.classification),
        query: item.queryText,
        url: item.sourceUrl,
        tone: evidenceTone(item.classification),
        historical: item.historical || item.bridged,
      }))
    const historical = matchedEvidence.some(item => item.historical || item.bridged)
    const status = !report.run
      ? { label: 'Not measured', tone: 'neutral' as const }
      : !target.completeness.complete
        ? { label: 'Incomplete', tone: 'caution' as const }
        : configured?.mentionNotApplicable
          ? { label: 'No aliases', tone: 'caution' as const }
          : { label: 'Complete', tone: 'positive' as const }

    return {
      id: target.id,
      name: target.label,
      mentionCoverage: metric(target.mentionCoverage),
      citationCoverage: metric(target.citationCoverage),
      status,
      assignedQueries: selections.get(target.id) ?? [],
      urls: configured?.urls.map(matcherLabel) ?? [],
      evidence,
      historical,
    }
  })
  const propertyById = new Map(properties.map(property => [property.id, property]))
  const groupConfig = new Map(plan.groups.map(group => [group.stableKey, group]))

  return {
    classReporting: 'plan-v1',
    latestMeasurement: {
      status: report.run?.status === 'completed'
        ? { label: 'Complete', tone: 'positive' }
        : report.run?.status === 'partial'
          ? { label: 'Partial result', tone: 'caution' }
          : { label: 'Not measured', tone: 'neutral' },
      completedSlots: 0,
      totalSlots: 0,
      date: reportDate(report.run?.finishedAt ?? report.run?.createdAt ?? null),
    },
    overall: {
      aggregate: {
        metrics: {
          propertiesMentioned: unavailableMetric,
          mentionCoverage: unavailableMetric,
          citationCoverage: unavailableMetric,
        },
        properties,
      },
      groups: report.groups.map(group => ({
        id: group.id,
        label: group.label,
        confirmedCompetitorCount: groupConfig.get(group.id)?.competitors?.length ?? 0,
        aggregate: {
          metrics: {
            propertiesMentioned: unavailableMetric,
            mentionCoverage: unavailableMetric,
            citationCoverage: unavailableMetric,
          },
          properties: group.targetIds.map(id => propertyById.get(id)).filter((value): value is AdvancedMeasurementProperty => Boolean(value)),
        },
      })),
    },
    flaggedResults: [],
  }
}
