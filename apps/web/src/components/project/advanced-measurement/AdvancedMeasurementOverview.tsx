import { Fragment, useEffect, useMemo, useState } from 'react'
import type { MetricTone } from '../../../view-models.js'

import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'

export type AdvancedMeasurementClass = 'non-brand' | 'branded'

export type AdvancedMeasurementEvidenceKind =
  | 'this-property'
  | 'another-property'
  | 'owned-unassigned'
  | 'external'
  | 'multiple-properties'
  | 'invalid-url'

export type AdvancedMeasurementMetric =
  | { numerator: number; denominator: number; reason?: never }
  | { numerator: null; denominator: null; reason: string }

export interface AdvancedMeasurementProperty {
  id: string
  name: string
  mentionCoverage: AdvancedMeasurementMetric
  citationCoverage: AdvancedMeasurementMetric
  status: { label: string; tone: MetricTone }
  assignedQueries: readonly string[]
  urls: readonly string[]
  evidence: readonly AdvancedMeasurementEvidence[]
  historical?: boolean
}

export interface AdvancedMeasurementEvidence {
  id: string
  kind: AdvancedMeasurementEvidenceKind
  query: string
  url: string
  tone: MetricTone
  historical?: boolean
}

export interface AdvancedMeasurementAggregate {
  metrics: {
    propertiesMentioned: AdvancedMeasurementMetric
    mentionCoverage: AdvancedMeasurementMetric
    citationCoverage: AdvancedMeasurementMetric
  }
  /** Properties excluded from a complete measurement, shown alongside the property headline. */
  unavailablePropertyCount?: number
  properties: readonly AdvancedMeasurementProperty[]
  shareOfVoice?: readonly AdvancedMeasurementShareOfVoice[]
}

export interface AdvancedMeasurementShareOfVoice {
  name: string
  coverage: AdvancedMeasurementMetric
}

export interface AdvancedMeasurementGroup {
  id: string
  label: string
  confirmedCompetitorCount: number
  aggregate: AdvancedMeasurementAggregate
}

export interface AdvancedMeasurementScope {
  aggregate: AdvancedMeasurementAggregate
  groups: readonly AdvancedMeasurementGroup[]
}

export interface AdvancedMeasurementFlaggedResult {
  id: string
  property: string
  summary: string
  tone: MetricTone
}

export interface AdvancedMeasurementOverviewReport {
  /** `plan-v1` has an active plan but cannot split results by query class yet. */
  classReporting: 'available' | 'plan-v1'
  latestMeasurement: {
    status: { label: string; tone: MetricTone }
    completedSlots: number
    totalSlots: number
    /** Already formatted by the caller for the viewer's locale. */
    date: string
  }
  /** The active plan's aggregate, used for the version-one fallback. */
  overall: AdvancedMeasurementScope
  /** Each scope is calculated upstream. The component never recomputes an aggregate. */
  classScopes?: {
    nonBrand: AdvancedMeasurementScope
    branded: AdvancedMeasurementScope
  }
  flaggedResults: readonly AdvancedMeasurementFlaggedResult[]
}

export interface AdvancedMeasurementOverviewProps {
  report: AdvancedMeasurementOverviewReport
  /** Editors see the one safe action appropriate to the active setup. */
  canEdit: boolean
  onRunMeasurement?: () => void | Promise<void>
  onRepublishSetup?: () => void | Promise<void>
  isRunningMeasurement?: boolean
  isRepublishingSetup?: boolean
}

const ALL_PROPERTIES = '__all_properties__'
const PROPERTY_LIST_LIMIT = 50
const DETAIL_LIST_LIMIT = 50

const evidenceLabels: Record<AdvancedMeasurementEvidenceKind, string> = {
  'this-property': 'Matches this Property',
  'another-property': 'Matches another Property',
  'owned-unassigned': 'Site URL not included in a Property',
  external: 'External URL',
  'multiple-properties': 'Matches multiple Properties',
  'invalid-url': 'Invalid URL',
}

const metricReasons: Record<string, string> = {
  plan_v1: 'Republish setup to enable Non-brand and Branded reporting.',
  incomplete: 'The latest measurement is incomplete.',
  'evidence-incomplete': 'Some source evidence is incomplete.',
  'no-population': 'No measurements are available for this selection.',
  unavailable: 'This measurement is unavailable.',
}

const planV1Metric: AdvancedMeasurementMetric = {
  numerator: null,
  denominator: null,
  reason: 'plan_v1',
}

function isMeasured(metric: AdvancedMeasurementMetric): metric is Extract<AdvancedMeasurementMetric, { numerator: number }> {
  if (metric.numerator === null) return false
  return Number.isFinite(metric.numerator)
    && Number.isFinite(metric.denominator)
    && metric.numerator >= 0
    && metric.denominator > 0
    && metric.numerator <= metric.denominator
}

function metricLabel(metric: AdvancedMeasurementMetric): string {
  if (!isMeasured(metric)) return 'N/A'
  return `${metric.numerator} of ${metric.denominator} (${Math.round((metric.numerator / metric.denominator) * 100)}%)`
}

function metricReason(metric: AdvancedMeasurementMetric): string {
  if (isMeasured(metric)) return ''
  const reason = (metric as { reason?: string }).reason ?? 'unavailable'
  return metricReasons[reason] ?? reason
}

function slotProgressLabel(completed: number, total: number): string {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || completed < 0 || total <= 0 || completed > total) {
    return 'Measurement progress unavailable'
  }
  return `${completed} of ${total} slots completed`
}

function MetricValue({
  metric,
  compact = false,
}: {
  metric: AdvancedMeasurementMetric
  compact?: boolean
}) {
  const valueClassName = compact
    ? isMeasured(metric) ? 'text-sm font-medium text-primary' : 'text-sm font-medium text-secondary'
    : isMeasured(metric) ? 'text-lg font-semibold text-heading' : 'text-lg font-semibold text-secondary'
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-1 tabular-nums">
      <span className={valueClassName}>{metricLabel(metric)}</span>
    </span>
  )
}

function Truncation({
  shown,
  total,
  onShowAll,
  itemLabel,
}: {
  shown: number
  total: number
  onShowAll: () => void
  itemLabel: string
}) {
  if (shown >= total) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
      <span>Showing {shown} of {total}</span>
      <Button size="sm" variant="outline" onClick={onShowAll}>Show all {total} {itemLabel}</Button>
    </div>
  )
}

function CappedStringList({
  title,
  values,
  emptyLabel,
  valueClassName = 'text-secondary',
}: {
  title: string
  values: readonly string[]
  emptyLabel: string
  valueClassName?: string
}) {
  const [limit, setLimit] = useState(DETAIL_LIST_LIMIT)
  const shown = values.slice(0, limit)

  return (
    <section aria-label={title}>
      <h4 className="text-sm font-medium text-heading">{title}</h4>
      {values.length === 0 ? <p className="mt-2 text-sm text-secondary">{emptyLabel}</p> : (
        <>
          <ul className="mt-2 space-y-1.5 text-sm">
            {shown.map((value, index) => <li key={`${value}:${index}`} className={valueClassName}>{value}</li>)}
          </ul>
          <Truncation
            shown={shown.length}
            total={values.length}
            itemLabel={title.toLocaleLowerCase()}
            onShowAll={() => setLimit(Number.MAX_SAFE_INTEGER)}
          />
        </>
      )}
    </section>
  )
}

function CappedEvidenceList({ evidence }: { evidence: readonly AdvancedMeasurementEvidence[] }) {
  const [limit, setLimit] = useState(DETAIL_LIST_LIMIT)
  const shown = evidence.slice(0, limit)

  return (
    <section aria-label="Evidence">
      <h4 className="text-sm font-medium text-heading">Evidence</h4>
      {evidence.length === 0 ? <p className="mt-2 text-sm text-secondary">No source evidence is available.</p> : (
        <>
          <div className="mt-2 overflow-x-auto rounded-md border border-default">
            <table className="evidence-table min-w-[640px]">
              <thead><tr><th>Status</th><th>Query</th><th>URL</th></tr></thead>
              <tbody>{shown.map(item => (
                <tr key={item.id}>
                  <td>
                    <span className="flex flex-wrap items-center gap-1">
                      <ToneBadge tone={item.tone}>{evidenceLabels[item.kind]}</ToneBadge>
                      {item.historical ? <ToneBadge tone="caution">Historical</ToneBadge> : null}
                    </span>
                  </td>
                  <td className="text-secondary">{item.query}</td>
                  <td className="break-all text-secondary">{item.url}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Truncation
            shown={shown.length}
            total={evidence.length}
            itemLabel="evidence items"
            onShowAll={() => setLimit(Number.MAX_SAFE_INTEGER)}
          />
        </>
      )}
    </section>
  )
}

function PropertyDetails({ property }: { property: AdvancedMeasurementProperty }) {
  return (
    <div className="space-y-5 py-2">
      <CappedStringList title="Assigned queries" values={property.assignedQueries} emptyLabel="No queries are assigned." />
      <CappedStringList title="URLs" values={property.urls} emptyLabel="No URLs are assigned." valueClassName="break-all text-secondary" />
      <CappedEvidenceList evidence={property.evidence} />
    </div>
  )
}

function CompetitorShareOfVoice({ values }: { values: readonly AdvancedMeasurementShareOfVoice[] }) {
  return (
    <section aria-labelledby="advanced-measurement-share-of-voice" className="border-y border-default py-4">
      <h2 id="advanced-measurement-share-of-voice" className="text-sm font-medium text-heading">Competitor share of voice</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="evidence-table min-w-[420px]">
          <thead><tr><th>Name</th><th>Share of voice</th></tr></thead>
          <tbody>{values.map(value => (
            <tr key={value.name}>
              <td className="font-medium text-heading">{value.name}</td>
              <td className="text-secondary"><MetricValue metric={value.coverage} compact /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  )
}

export function AdvancedMeasurementOverview({
  report,
  canEdit,
  onRunMeasurement,
  onRepublishSetup,
  isRunningMeasurement = false,
  isRepublishingSetup = false,
}: AdvancedMeasurementOverviewProps) {
  const classReportingAvailable = report.classReporting === 'available' && report.classScopes != null
  const [selectedClass, setSelectedClass] = useState<AdvancedMeasurementClass>('non-brand')
  const [selectedView, setSelectedView] = useState(ALL_PROPERTIES)
  const [search, setSearch] = useState('')
  const [propertyLimit, setPropertyLimit] = useState(PROPERTY_LIST_LIMIT)
  const [expandedPropertyIds, setExpandedPropertyIds] = useState<ReadonlySet<string>>(new Set())

  const scope = classReportingAvailable
    ? selectedClass === 'non-brand' ? report.classScopes!.nonBrand : report.classScopes!.branded
    : report.overall

  useEffect(() => {
    if (selectedView === ALL_PROPERTIES || scope.groups.some(group => group.id === selectedView)) return
    setSelectedView(ALL_PROPERTIES)
  }, [scope, selectedView])

  const selectedGroup = scope.groups.find(group => group.id === selectedView)
  const aggregate = selectedGroup?.aggregate ?? scope.aggregate
  const classMetric = (metric: AdvancedMeasurementMetric): AdvancedMeasurementMetric => (
    classReportingAvailable ? metric : planV1Metric
  )
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredProperties = useMemo(() => (
    normalizedSearch
      ? aggregate.properties.filter(property => property.name.toLocaleLowerCase().includes(normalizedSearch))
      : aggregate.properties
  ), [aggregate.properties, normalizedSearch])
  const shownProperties = filteredProperties.slice(0, propertyLimit)
  const showShareOfVoice = selectedGroup != null
    && selectedClass === 'non-brand'
    && classReportingAvailable
    && selectedGroup.confirmedCompetitorCount > 0
    && (aggregate.shareOfVoice?.length ?? 0) > 0
  const unavailableProperties = classReportingAvailable ? aggregate.unavailablePropertyCount ?? 0 : 0
  const headlineUnavailableReason = [
    classMetric(aggregate.metrics.propertiesMentioned),
    classMetric(aggregate.metrics.mentionCoverage),
    classMetric(aggregate.metrics.citationCoverage),
  ].map(metricReason).find(Boolean)
  const statusMessage = !classReportingAvailable
    ? (canEdit ? metricReasons.plan_v1 : 'Non-brand and Branded reporting is unavailable until setup is republished.')
    : headlineUnavailableReason
      ?? (unavailableProperties > 0
        ? `${unavailableProperties} ${unavailableProperties === 1 ? 'property is' : 'properties are'} unavailable.`
        : report.flaggedResults.length > 0
          ? `${report.flaggedResults.length} flagged ${report.flaggedResults.length === 1 ? 'result needs' : 'results need'} review.`
          : 'No action needed.')

  function toggleProperty(propertyId: string) {
    setExpandedPropertyIds(current => {
      const next = new Set(current)
      if (next.has(propertyId)) next.delete(propertyId)
      else next.add(propertyId)
      return next
    })
  }

  return (
    <section aria-label="Advanced measurement overview" className="space-y-5">
      <header className="border-b border-default pb-4">
        <div role="status" aria-label="Measurement status and next action" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ToneBadge tone={report.latestMeasurement.status.tone}>{report.latestMeasurement.status.label}</ToneBadge>
          <span className="text-sm text-secondary tabular-nums">{slotProgressLabel(report.latestMeasurement.completedSlots, report.latestMeasurement.totalSlots)}</span>
          <span className="text-sm text-secondary">{report.latestMeasurement.date}</span>
          <span className="text-sm text-secondary">{statusMessage}</span>
          {canEdit && classReportingAvailable && onRunMeasurement ? (
            <Button className="ml-auto" size="sm" onClick={() => { void onRunMeasurement() }} disabled={isRunningMeasurement}>
              {isRunningMeasurement ? 'Starting measurement…' : 'Run measurement'}
            </Button>
          ) : canEdit && !classReportingAvailable ? (
            <Button className="ml-auto" size="sm" onClick={() => { void onRepublishSetup?.() }} disabled={!onRepublishSetup || isRepublishingSetup}>
              {isRepublishingSetup ? 'Opening setup…' : 'Republish setup'}
            </Button>
          ) : null}
        </div>
      </header>

      <dl className="grid gap-4 border-y border-default py-4 md:grid-cols-3">
        <div>
          <dt className="text-sm text-secondary">Properties mentioned</dt>
          <dd className="mt-1"><MetricValue metric={classMetric(aggregate.metrics.propertiesMentioned)} /></dd>
        </div>
        <div>
          <dt className="text-sm text-secondary">Mention coverage</dt>
          <dd className="mt-1"><MetricValue metric={classMetric(aggregate.metrics.mentionCoverage)} /></dd>
        </div>
        <div>
          <dt className="text-sm text-secondary">Citation coverage</dt>
          <dd className="mt-1"><MetricValue metric={classMetric(aggregate.metrics.citationCoverage)} /></dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-end gap-4 border-b border-default pb-4">
        <div className="space-y-1">
          <label htmlFor="advanced-measurement-group" className="block text-sm font-medium text-heading">Group</label>
          <select
            id="advanced-measurement-group"
            value={selectedView}
            onChange={event => setSelectedView(event.target.value)}
            className="h-9 rounded-md border border-default bg-surface px-3 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-mono-400"
          >
            <option value={ALL_PROPERTIES}>All properties</option>
            {scope.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
          </select>
        </div>
        <fieldset disabled={!classReportingAvailable} className="space-y-1">
          <legend className="text-sm font-medium text-heading">Query type</legend>
          <div className="flex items-center gap-3 text-sm text-secondary">
            <label className="flex items-center gap-1.5"><input type="radio" name="advanced-measurement-class" disabled={!classReportingAvailable} checked={selectedClass === 'non-brand'} onChange={() => setSelectedClass('non-brand')} /> Non-brand</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="advanced-measurement-class" disabled={!classReportingAvailable} checked={selectedClass === 'branded'} onChange={() => setSelectedClass('branded')} /> Branded</label>
          </div>
        </fieldset>
        <div className="min-w-52 flex-1 space-y-1">
          <label htmlFor="advanced-measurement-search" className="block text-sm font-medium text-heading">Search properties</label>
          <input
            id="advanced-measurement-search"
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search properties"
            className="h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-primary placeholder-mono-600 focus:outline-none focus:ring-2 focus:ring-mono-400"
          />
        </div>
      </div>

      {showShareOfVoice ? <CompetitorShareOfVoice values={aggregate.shareOfVoice ?? []} /> : null}

      <section aria-labelledby="advanced-measurement-properties-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="advanced-measurement-properties-title" className="text-base font-semibold text-heading">Properties</h2>
          <span className="text-sm text-secondary">{filteredProperties.length} {filteredProperties.length === 1 ? 'property' : 'properties'}</span>
        </div>
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="evidence-table min-w-[720px]">
            <caption className="sr-only">Property measurement results</caption>
            <thead><tr><th>Property</th><th>Mention</th><th>Citation</th><th>Status</th><th><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {shownProperties.map(property => {
                const expanded = expandedPropertyIds.has(property.id)
                return (
                  <Fragment key={property.id}>
                    <tr key={property.id}>
                      <td className="font-medium text-heading">{property.name}</td>
                      <td className="text-secondary"><MetricValue metric={classMetric(property.mentionCoverage)} compact /></td>
                      <td className="text-secondary"><MetricValue metric={classMetric(property.citationCoverage)} compact /></td>
                      <td>
                        <span className="flex flex-wrap items-center gap-1">
                          <ToneBadge tone={property.status.tone}>{property.status.label}</ToneBadge>
                          {property.historical ? <ToneBadge tone="caution">Historical</ToneBadge> : null}
                        </span>
                      </td>
                      <td className="text-right"><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => toggleProperty(property.id)}>{expanded ? `Hide details for ${property.name}` : `Show details for ${property.name}`}</Button></td>
                    </tr>
                    {expanded ? <tr key={`${property.id}:details`}><td colSpan={5} className="bg-surface-subtle px-4"><PropertyDetails property={property} /></td></tr> : null}
                  </Fragment>
                )
              })}
              {shownProperties.length === 0 ? <tr><td colSpan={5} className="py-8 text-center text-sm text-secondary">No properties match this search.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Truncation
          shown={shownProperties.length}
          total={filteredProperties.length}
          itemLabel="properties"
          onShowAll={() => setPropertyLimit(Number.MAX_SAFE_INTEGER)}
        />
      </section>

      {report.flaggedResults.length > 0 ? (
        <section aria-label="Flagged results" className="border-t border-default pt-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-heading">Flagged results ({report.flaggedResults.length})</summary>
            <ul className="mt-3 space-y-3">
              {report.flaggedResults.map(result => (
                <li key={result.id} className="flex flex-wrap items-start gap-2 text-sm">
                  <ToneBadge tone={result.tone}>Flagged</ToneBadge>
                  <span className="font-medium text-heading">{result.property}</span>
                  <span className="text-secondary">{result.summary}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </section>
  )
}
