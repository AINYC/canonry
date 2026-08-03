import { useState } from 'react'

import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'

export type AdvancedMeasurementAccess = 'editor' | 'viewer'

export type AdvancedMeasurementAvailability =
  | { status: 'available' }
  | { status: 'unavailable'; message: string }

export interface AdvancedMeasurementProperty {
  id: string
  label: string
  urlCount?: number
}

export type AdvancedMeasurementQuerySource =
  | 'saved-project-queries'
  | 'query-sets'
  | 'generated-drafts-from-templates'
  | 'unavailable-tracked-query'

export type AdvancedMeasurementQueryState = 'available' | 'missing'

export interface AdvancedMeasurementQuery {
  id: string
  text?: string
  source?: AdvancedMeasurementQuerySource
  state?: AdvancedMeasurementQueryState
  sourceDetail?: string
  /** Retained while callers migrate. This is intentionally not shown in the setup UI. */
  assignmentClass?: 'branded' | 'non-brand'
  propertyIds?: readonly string[]
}

export interface AdvancedMeasurementApplySelection {
  queryIds: readonly string[]
  propertyIds: readonly string[]
}

export interface AdvancedMeasurementQueriesStepProps {
  access?: AdvancedMeasurementAccess
  availability?: AdvancedMeasurementAvailability
  properties: readonly AdvancedMeasurementProperty[]
  queries: readonly AdvancedMeasurementQuery[]
  selectedPropertyIds: readonly string[]
  selectedQueryIds: readonly string[]
  isApplying?: boolean
  isBusy?: boolean
  canContinue?: boolean
  onSelectedPropertyIdsChange: (propertyIds: readonly string[]) => void
  onSelectedQueryIdsChange: (queryIds: readonly string[]) => void
  onApplySelectedQueries: (selection: AdvancedMeasurementApplySelection) => void | Promise<void>
  onClearQueryAssignments?: (queryId: string) => void | Promise<void>
  /** Compatibility fallback for callers that have not split clearing from removal yet. */
  onRemoveQuery: (queryId: string) => void | Promise<void>
  /**
   * Adds new tracked questions to the project from inside setup. Without this the
   * step can only consume questions that already exist, which sends a first-time
   * operator out of the wizard to create them and back again.
   */
  onCreateQueries?: (texts: readonly string[]) => void | Promise<unknown>
  /** Assigns already-created questions, each to the one Property it names. */
  onApplyPairedQuestions?: (pairs: readonly { targetKey: string; queryId: string }[]) => void | Promise<void>
  /** Writes one question per Property and assigns each to the Property it names. */
  onCreateAndPairQuestions?: (pairs: readonly { propertyId: string; text: string }[]) => void | Promise<void>
  isCreatingQueries?: boolean
  createQueriesError?: string | null
  /** Opens the project's normal query-management surface for anything setup does not cover. */
  onManageProjectQueries?: () => void
  onBack?: () => void
  onContinue: () => void
}

export interface AdvancedMeasurementGroup {
  id: string
  name: string
  propertyIds: readonly string[]
  competitors: readonly string[]
}

export interface AdvancedMeasurementGroupDraft {
  name: string
  propertyIds: readonly string[]
  competitorDomains: string
}

export interface AdvancedMeasurementGroupsStepProps {
  access?: AdvancedMeasurementAccess
  availability?: AdvancedMeasurementAvailability
  properties: readonly AdvancedMeasurementProperty[]
  groups: readonly AdvancedMeasurementGroup[]
  groupDraft: AdvancedMeasurementGroupDraft
  isSaving?: boolean
  onGroupDraftChange: (draft: AdvancedMeasurementGroupDraft) => void
  onSaveGroup: (draft: AdvancedMeasurementGroupDraft) => void | Promise<void>
  onEditGroup?: (group: AdvancedMeasurementGroup) => void
  onRemoveGroup?: (groupId: string) => void | Promise<void>
  onClearGroupDraft?: () => void
  /** Compatibility-only. The UI has a single continuation action. */
  onSkipGroups?: () => void
  onBack?: () => void
  onContinue: () => void
}

export interface AdvancedMeasurementReviewCounts {
  properties: number
  queries: number
  groups: number
}

export interface AdvancedMeasurementFlaggedException {
  id: string
  title: string
  detail?: string
  tone?: 'caution' | 'negative' | 'neutral'
}

export interface AdvancedMeasurementSitemapReviewItem {
  url: string
  reason: string
}

export interface AdvancedMeasurementCoverageReviewItem {
  property: string
  savedUrls: readonly string[]
  currentSitemapUrls: readonly string[]
}

export interface AdvancedMeasurementReviewedChanges {
  title: string
  items: readonly string[]
}

export interface AdvancedMeasurementReviewStepProps {
  access?: AdvancedMeasurementAccess
  availability?: AdvancedMeasurementAvailability
  counts: AdvancedMeasurementReviewCounts
  flaggedExceptions: readonly AdvancedMeasurementFlaggedException[]
  sitemapReview?: {
    exceptionCount: number
    coverageReviewCount: number
    coverageResolution: 'keep-existing' | 'replace-with-imported'
    items?: readonly AdvancedMeasurementSitemapReviewItem[]
    coverageItems?: readonly AdvancedMeasurementCoverageReviewItem[]
    onCoverageResolutionChange: (resolution: 'keep-existing' | 'replace-with-imported') => void
    onResolve: () => void | Promise<void>
  }
  onBack?: () => void
  onReviewChanges?: () => void | Promise<void>
  isReviewing?: boolean
  canReviewChanges?: boolean
  reviewedChanges?: AdvancedMeasurementReviewedChanges | null
  reviewChangesError?: string | null
  canPublish: boolean
  isPublishing?: boolean
  onPublish: () => void | Promise<void>
}

const INITIAL_REVIEW_ITEM_LIMIT = 20
const REVIEW_ITEM_PAGE_SIZE = 50

const PROPERTY_CHECKLIST_PAGE_SIZE = 50
const QUERY_LIST_PAGE_SIZE = 50
const RECOVERY_PREVIEW_LIMIT = 10

function isViewer(access: AdvancedMeasurementAccess | undefined): boolean {
  return access === 'viewer'
}

function isUnavailable(availability: AdvancedMeasurementAvailability | undefined): availability is Extract<AdvancedMeasurementAvailability, { status: 'unavailable' }> {
  return availability?.status === 'unavailable'
}

function changeSelection(values: readonly string[], value: string, checked: boolean): string[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value]
  return values.filter(item => item !== value)
}

function propertyNames(ids: readonly string[], properties: readonly AdvancedMeasurementProperty[]): string {
  const labels = new Map(properties.map(property => [property.id, property.label]))
  const names = ids.map(id => labels.get(id)).filter((name): name is string => Boolean(name))
  if (names.length === 0) return 'Not applied'
  return names.length > 3 ? `${names.length} Properties` : names.join(', ')
}

function isMissingQuery(query: AdvancedMeasurementQuery): boolean {
  return query.state === 'missing' || query.source === 'unavailable-tracked-query' || !query.source
}

function queryLabel(query: AdvancedMeasurementQuery): string {
  return isMissingQuery(query) ? 'Unavailable tracked question' : query.text?.trim() || 'Unavailable tracked question'
}

function isNameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value)
}

function includesWholePropertyName(text: string, label: string): boolean {
  const haystack = text.toLocaleLowerCase()
  const needle = label.trim().toLocaleLowerCase()
  if (!needle) return false

  let offset = haystack.indexOf(needle)
  while (offset >= 0) {
    const before = offset === 0 ? undefined : haystack[offset - 1]
    const after = haystack[offset + needle.length]
    if (!isNameCharacter(before) && !isNameCharacter(after)) return true
    offset = haystack.indexOf(needle, offset + needle.length)
  }
  return false
}

function PropertyChecklist({
  properties,
  selectedPropertyIds,
  onSelectedPropertyIdsChange,
  legend,
}: {
  properties: readonly AdvancedMeasurementProperty[]
  selectedPropertyIds: readonly string[]
  onSelectedPropertyIdsChange: (propertyIds: readonly string[]) => void
  legend: string
}) {
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredProperties = normalizedSearch
    ? properties.filter(property => property.label.toLocaleLowerCase().includes(normalizedSearch))
    : properties
  const visibleProperties = showAll ? filteredProperties : filteredProperties.slice(0, PROPERTY_CHECKLIST_PAGE_SIZE)
  const hasHiddenProperties = visibleProperties.length < filteredProperties.length

  function selectAllShown(): void {
    const selected = new Set([...selectedPropertyIds, ...visibleProperties.map(property => property.id)])
    onSelectedPropertyIdsChange(properties.filter(property => selected.has(property.id)).map(property => property.id))
  }

  return (
    <fieldset>
      <legend className="text-sm font-medium text-heading">{legend}</legend>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <label className="block min-w-48 flex-1">
          <span className="text-sm font-medium text-heading">Search Properties</span>
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
            className="mt-1 block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={visibleProperties.length === 0} onClick={selectAllShown}>Select all shown</Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={selectedPropertyIds.length === 0} onClick={() => onSelectedPropertyIdsChange([])}>Clear selection</Button>
        </div>
      </div>

      {filteredProperties.length === 0 ? <p className="mt-3 text-sm text-secondary">No Properties match this search.</p> : (
        <>
          <p className="mt-3 text-sm text-secondary">Showing {visibleProperties.length} of {filteredProperties.length} Properties</p>
          <div className="mt-2 max-h-96 divide-y divide-default overflow-y-auto border-y border-default">
            {visibleProperties.map(property => {
              const selected = selectedPropertyIds.includes(property.id)
              return (
                <label key={property.id} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 py-2 text-sm text-primary">
                  <span className="flex items-center gap-3">
                    <input
                      aria-label={`Select ${property.label}`}
                      checked={selected}
                      type="checkbox"
                      onChange={event => onSelectedPropertyIdsChange(changeSelection(selectedPropertyIds, property.id, event.currentTarget.checked))}
                    />
                    <span>{property.label}</span>
                  </span>
                  {property.urlCount === undefined ? null : <span className="tabular-nums text-secondary">{property.urlCount} URLs</span>}
                </label>
              )
            })}
          </div>
          {hasHiddenProperties ? <Button type="button" size="sm" variant="outline" className="mt-3 min-h-11" onClick={() => setShowAll(true)}>Show all Properties</Button> : null}
        </>
      )}
    </fieldset>
  )
}

function ViewerNotice() {
  return <div className="flex items-center gap-2 text-sm text-secondary"><ToneBadge tone="neutral">Viewer access</ToneBadge><span>You can inspect this setup.</span></div>
}

function UnavailableState({ message }: { message: string }) {
  return (
    <div role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-4 text-sm text-caution">
      <div className="flex items-center gap-2"><ToneBadge tone="caution">Unavailable</ToneBadge><h4 className="font-medium">Measurement setup unavailable</h4></div>
      <p className="mt-2 max-w-2xl text-secondary">{message}</p>
    </div>
  )
}

export function AdvancedMeasurementQueriesStep({
  access,
  availability,
  properties,
  queries,
  selectedPropertyIds,
  selectedQueryIds,
  isApplying = false,
  isBusy = false,
  canContinue = true,
  onSelectedPropertyIdsChange,
  onSelectedQueryIdsChange,
  onApplySelectedQueries,
  onClearQueryAssignments,
  onRemoveQuery,
  onCreateQueries,
  onApplyPairedQuestions,
  onCreateAndPairQuestions,
  isCreatingQueries = false,
  createQueriesError = null,
  onManageProjectQueries,
  onBack,
  onContinue,
}: AdvancedMeasurementQueriesStepProps) {
  const [querySearch, setQuerySearch] = useState('')
  const [showAllQueries, setShowAllQueries] = useState(false)
  const [showUnappliedOnly, setShowUnappliedOnly] = useState(false)
  const [newQueriesText, setNewQueriesText] = useState('')
  const [patternText, setPatternText] = useState('')
  const [reviewedSuggestionSignature, setReviewedSuggestionSignature] = useState<string | null>(null)
  if (isUnavailable(availability)) {
    return <section aria-label="Questions"><UnavailableState message={availability.message} /></section>
  }

  const viewer = isViewer(access)
  const canApply = selectedPropertyIds.length > 0 && selectedQueryIds.length > 0 && !isApplying && !isBusy
  const selectedPropertyCount = properties.filter(property => selectedPropertyIds.includes(property.id)).length
  const clearAssignments = onClearQueryAssignments ?? onRemoveQuery
  const normalizedQuerySearch = querySearch.trim().toLocaleLowerCase()
  const filteredQueries = normalizedQuerySearch
    ? queries.filter(query => queryLabel(query).toLocaleLowerCase().includes(normalizedQuerySearch))
    : queries
  const unappliedQueries = filteredQueries.filter(query => (query.propertyIds?.length ?? 0) === 0)
  const listedQueries = showUnappliedOnly ? unappliedQueries : filteredQueries
  const visibleQueries = showAllQueries ? listedQueries : listedQueries.slice(0, QUERY_LIST_PAGE_SIZE)

  /**
   * Questions generated from a pattern each name exactly one Property, and the
   * pairing is recoverable from the text alone. Without this the only route back
   * is 213 manual selections, or the cross product that produced 45,369.
   * A question matching two Property names is left alone rather than guessed at.
   */
  const nameMatchedAssignments = unappliedQueries.flatMap(query => {
    const question = queryLabel(query)
    const named = properties.filter(property => includesWholePropertyName(question, property.label))
    return named.length === 1 ? [{
      targetKey: named[0]!.id,
      queryId: query.id,
      property: named[0]!.label,
      question,
    }] : []
  })
  const nameMatchedPairs = nameMatchedAssignments.map(({ targetKey, queryId }) => ({ targetKey, queryId }))
  const suggestionSignature = nameMatchedPairs.map(pair => `${pair.queryId}:${pair.targetKey}`).join('|')
  const reviewedAllSuggestions = nameMatchedAssignments.length <= RECOVERY_PREVIEW_LIMIT
    || reviewedSuggestionSignature === suggestionSignature
  const shownNameMatchedAssignments = reviewedAllSuggestions
    ? nameMatchedAssignments
    : nameMatchedAssignments.slice(0, RECOVERY_PREVIEW_LIMIT)
  const selectableVisibleQueries = visibleQueries.filter(query => !isMissingQuery(query))
  const parsedNewQueries = [...new Set(
    newQueriesText.split('\n').map(line => line.trim()).filter(Boolean),
  )]
  // One pattern, one question per selected Property. This is the portfolio
  // shape: nobody types "apartments near Harbor Point" two hundred times, and
  // typing two hundred generic questions measures the portfolio rather than the
  // Properties in it.
  const patternPlaceholders = [...patternText.matchAll(/\{([a-z][\w-]*)\}/gi)].map(match => match[1]!)
  const patternTargets = properties.filter(property => selectedPropertyIds.includes(property.id))
  // Each expansion stays tied to the Property it was written for, so it can be
  // assigned to that Property alone. Dropping the pairing here is what forced
  // the caller into a cross product.
  const patternPairs = patternPlaceholders.length === 0 || patternText.trim() === ''
    ? []
    : patternTargets.map(property => ({
      propertyId: property.id,
      text: patternPlaceholders.reduce(
        (text, name) => text.replaceAll(`{${name}}`, property.label),
        patternText.trim(),
      ),
    }))
  const patternExpansions = [...new Set(patternPairs.map(pair => pair.text))]

  function selectAllShownQueries(): void {
    const selected = new Set([...selectedQueryIds, ...selectableVisibleQueries.map(query => query.id)])
    onSelectedQueryIdsChange(queries.filter(query => selected.has(query.id)).map(query => query.id))
  }

  return (
    <section aria-labelledby="advanced-measurement-queries-title" className="space-y-5">
      <div className="section-head">
        <div>
          <h3 id="advanced-measurement-queries-title">Questions</h3>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Choose questions, then apply them to Properties.</p>
        </div>
      </div>

      {viewer ? <ViewerNotice /> : null}

      {viewer ? null : (
        <details className="border-y border-default py-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">{selectedPropertyCount} of {properties.length} Properties selected</summary>
          <div className="pt-3">
            <PropertyChecklist
              legend="Apply to selected Properties"
              properties={properties}
              selectedPropertyIds={selectedPropertyIds}
              onSelectedPropertyIdsChange={onSelectedPropertyIdsChange}
            />
          </div>
        </details>
      )}

      {viewer || !onCreateQueries ? null : (
        <details open={queries.length === 0} className="border-y border-default py-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">Add questions</summary>
          <div className="pt-3">
            <h4 className="m-0 text-sm font-medium text-heading">
              {queries.length === 0 ? 'Add the questions you want to track' : 'Add more questions'}
            </h4>
            <p className="mt-1 mb-2 text-sm text-secondary">One per line. Add them to the project, then apply them to Properties.</p>
            <textarea
              aria-label="New questions, one per line"
              className="w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              rows={4}
              value={newQueriesText}
              onChange={event => setNewQueriesText(event.currentTarget.value)}
              placeholder={'best apartments in dallas\nluxury apartments atlanta\npet friendly apartments austin'}
            />
            {createQueriesError ? (
              <p role="alert" className="mt-2 text-sm text-negative">{createQueriesError}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11"
                disabled={parsedNewQueries.length === 0 || isCreatingQueries || isBusy}
                onClick={() => {
                  void Promise.resolve(onCreateQueries(parsedNewQueries))
                    .then(() => setNewQueriesText(''), () => {})
                }}
              >
                {isCreatingQueries
                  ? 'Adding…'
                  : `Add ${parsedNewQueries.length || ''} question${parsedNewQueries.length === 1 ? '' : 's'}`.replace('  ', ' ')}
              </Button>
              {onManageProjectQueries ? (
                <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={isBusy} onClick={onManageProjectQueries}>
                  Manage project questions
                </Button>
              ) : null}
            </div>

            <div className="mt-4 border-t border-default pt-4">
              <h4 className="m-0 text-sm font-medium text-heading">Write one question for every Property</h4>
              <p className="mt-1 mb-2 text-sm text-secondary">
                Put <code className="rounded bg-bg-elevated px-1">{'{property}'}</code> where the
                Property name belongs. You get one question per selected Property.
              </p>
              <input
                aria-label="Question pattern"
                className="min-h-11 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                value={patternText}
                onChange={event => setPatternText(event.target.value)}
                placeholder="apartments near {property}"
              />
              {patternText.trim() === '' ? null : patternPlaceholders.length === 0 ? (
                <p className="mt-2 text-sm text-caution">
                  Add {'{property}'} to the pattern, or use the box above for a single question.
                </p>
              ) : patternTargets.length === 0 ? (
                <p className="mt-2 text-sm text-caution">Select at least one Property to write questions for.</p>
              ) : (
                <div className="mt-2 rounded-md border border-base bg-bg-elevated p-3">
                  <p className="m-0 text-sm text-secondary">
                    {patternExpansions.length} question{patternExpansions.length === 1 ? '' : 's'}, one per selected Property:
                  </p>
                  <ul className="mt-1 mb-0 list-none space-y-0.5 p-0">
                    {patternExpansions.slice(0, 3).map(text => (
                      <li key={text} className="text-sm text-strong">{text}</li>
                    ))}
                  </ul>
                  {patternExpansions.length > 3 ? (
                    <p className="mt-1 mb-0 text-sm text-secondary">
                      and {patternExpansions.length - 3} more
                    </p>
                  ) : null}
                </div>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2 min-h-11"
                disabled={patternPairs.length === 0 || isCreatingQueries || isBusy || !onCreateAndPairQuestions}
                onClick={() => {
                  if (!onCreateAndPairQuestions) return
                  void Promise.resolve(onCreateAndPairQuestions(patternPairs))
                    .then(() => setPatternText(''), () => {})
                }}
              >
                {isCreatingQueries
                  ? 'Adding…'
                  : `Add ${patternPairs.length || ''} question${patternPairs.length === 1 ? '' : 's'}`.replace('  ', ' ')}
              </Button>
              {patternPairs.length > 0 ? (
                <p className="mt-2 mb-0 text-sm text-secondary">
                  Each question is measured on the one Property it names, so this adds{' '}
                  {patternPairs.length} assignment{patternPairs.length === 1 ? '' : 's'}.
                </p>
              ) : null}
            </div>
          </div>
        </details>
      )}

      {viewer ? null : (
        <div className="space-y-3 border-y border-default py-4">
          {/* With an empty question library these controls can only be disabled. */}
          {queries.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={selectableVisibleQueries.length === 0}
              onClick={selectAllShownQueries}
            >
              Select all shown questions
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={selectedQueryIds.length === 0}
              onClick={() => onSelectedQueryIdsChange([])}
            >
              Clear question selection
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              disabled={!canApply}
              onClick={() => { void onApplySelectedQueries({ queryIds: selectedQueryIds, propertyIds: selectedPropertyIds }) }}
            >
              {isApplying ? 'Applying questions…' : 'Apply selected questions'}
            </Button>
            <p className="text-sm text-secondary">{selectedQueryIds.length} question{selectedQueryIds.length === 1 ? '' : 's'} × {selectedPropertyCount} Properties = {selectedQueryIds.length * selectedPropertyCount} assignments</p>
          </div>
          )}
        </div>
      )}

      {queries.length > 0 ? (
        <div className="space-y-3">
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-heading">Search questions</span>
            <input
              type="search"
              value={querySearch}
              onChange={event => {
                setQuerySearch(event.currentTarget.value)
                setShowAllQueries(false)
              }}
              className="mt-1 block min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400"
              placeholder="Question text"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-sm text-secondary">
              Showing {visibleQueries.length} of {listedQueries.length} questions,{' '}
              {filteredQueries.length - unappliedQueries.length} of {filteredQueries.length} applied
            </p>
            {viewer || unappliedQueries.length === 0 ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11"
                onClick={() => { setShowUnappliedOnly(current => !current); setShowAllQueries(false) }}
              >
                {showUnappliedOnly ? 'Show all questions' : `Show the ${unappliedQueries.length} not applied`}
              </Button>
            )}
          </div>
          {!viewer && nameMatchedPairs.length > 0 && onApplyPairedQuestions ? (
            <details className="rounded-md border border-base bg-bg-elevated p-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">
                Review {nameMatchedPairs.length} suggested question-to-Property match{nameMatchedPairs.length === 1 ? '' : 'es'}
              </summary>
              <p className="mt-2 mb-3 text-sm text-secondary">
                Confirm each question is paired with the Property it names before assigning it.
              </p>
              <div className="overflow-x-auto rounded-md border border-default">
                <table className="evidence-table min-w-[520px]">
                  <caption className="sr-only">Suggested question-to-Property matches</caption>
                  <thead><tr><th>Question</th><th>Property</th></tr></thead>
                  <tbody>
                    {shownNameMatchedAssignments.map(assignment => (
                      <tr key={`${assignment.queryId}:${assignment.targetKey}`}>
                        <td className="text-secondary">{assignment.question}</td>
                        <td className="text-heading">{assignment.property}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nameMatchedAssignments.length > RECOVERY_PREVIEW_LIMIT ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-secondary">
                  <span>Showing {shownNameMatchedAssignments.length} of {nameMatchedAssignments.length} suggested matches</span>
                  {!reviewedAllSuggestions ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => setReviewedSuggestionSignature(suggestionSignature)}
                    >
                      Review all {nameMatchedAssignments.length} matches
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3 min-h-11"
                disabled={isApplying || isBusy || !reviewedAllSuggestions}
                onClick={() => {
                  void Promise.resolve(onApplyPairedQuestions(nameMatchedPairs)).catch(() => {})
                }}
              >
                {isApplying ? 'Assigning…' : `Assign ${nameMatchedPairs.length} suggested match${nameMatchedPairs.length === 1 ? '' : 'es'}`}
              </Button>
            </details>
          ) : null}
        </div>
      ) : null}

      {visibleQueries.length > 0 ? (
        <div className="overflow-x-auto border-y border-default">
          <table className="evidence-table min-w-[620px]">
          <thead>
            <tr>
              {viewer ? null : <th><span className="sr-only">Select question</span></th>}
              <th>Question</th>
              <th>Properties</th>
              {viewer ? null : <th><span className="sr-only">Clear question assignments</span></th>}
            </tr>
          </thead>
          <tbody>
            {visibleQueries.map(query => {
              const missing = isMissingQuery(query)
              const label = queryLabel(query)
              const selected = selectedQueryIds.includes(query.id)
              const hasAssignments = (query.propertyIds?.length ?? 0) > 0
              return (
                <tr key={query.id}>
                  {viewer ? null : missing ? <td aria-hidden="true" /> : (
                    <td className="p-0">
                      <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                        <input
                          aria-label={`Select question ${label}`}
                          checked={selected}
                          type="checkbox"
                          onChange={event => onSelectedQueryIdsChange(changeSelection(selectedQueryIds, query.id, event.currentTarget.checked))}
                          className="size-6 accent-accent"
                        />
                      </label>
                    </td>
                  )}
                  <td>
                    <p className="font-medium text-heading">{label}</p>
                  </td>
                  <td className="text-secondary">{propertyNames(query.propertyIds ?? [], properties)}</td>
                  {viewer ? null : <td className="text-right">{hasAssignments ? <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={isBusy} onClick={() => { void clearAssignments(query.id) }} aria-label={`Clear question assignments for ${label}`}>Clear assignments</Button> : null}</td>}
                </tr>
              )
            })}
          </tbody>
          </table>
        </div>
      ) : queries.length > 0 ? <p className="text-sm text-secondary">No questions match this search.</p> : null}

      {visibleQueries.length < listedQueries.length ? (
        <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => setShowAllQueries(true)}>Show all questions</Button>
      ) : null}

      {viewer ? null : (
        <>
          {canContinue ? null : <p role="status" className="text-sm text-caution">Apply at least one question to a Property before continuing.</p>}
          <div className={`flex flex-wrap items-center gap-3 ${onBack ? 'justify-between' : 'justify-end'}`}>
            {onBack ? <Button type="button" variant="outline" className="min-h-11" disabled={isBusy} onClick={onBack}>Back</Button> : null}
            <Button type="button" variant={canApply ? 'outline' : 'default'} className="min-h-11" disabled={!canContinue || isBusy} onClick={onContinue}>Continue</Button>
          </div>
        </>
      )}
    </section>
  )
}

export function AdvancedMeasurementGroupsStep({
  access,
  availability,
  properties,
  groups,
  groupDraft,
  isSaving = false,
  onGroupDraftChange,
  onSaveGroup,
  onEditGroup,
  onRemoveGroup,
  onClearGroupDraft,
  onBack,
  onContinue,
}: AdvancedMeasurementGroupsStepProps) {
  if (isUnavailable(availability)) {
    return <section aria-label="Groups"><UnavailableState message={availability.message} /></section>
  }

  const viewer = isViewer(access)
  const canSave = groupDraft.name.trim().length > 0 && groupDraft.propertyIds.length > 0 && !isSaving
  const selectedPropertyCount = properties.filter(property => groupDraft.propertyIds.includes(property.id)).length
  const hasUnsavedGroupDraft = groupDraft.name.trim().length > 0 || groupDraft.propertyIds.length > 0 || groupDraft.competitorDomains.trim().length > 0
  const showSavedGroupActions = !viewer && (onEditGroup !== undefined || onRemoveGroup !== undefined)

  function clearGroupForm(): void {
    if (onClearGroupDraft) {
      onClearGroupDraft()
      return
    }
    onGroupDraftChange({ name: '', propertyIds: [], competitorDomains: '' })
  }

  return (
    <section aria-labelledby="advanced-measurement-groups-title" className="space-y-5">
      <div className="section-head">
        <div>
          <h3 id="advanced-measurement-groups-title">Groups</h3>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Optional reporting organization for Properties and competitor comparisons.</p>
        </div>
      </div>

      {viewer ? <ViewerNotice /> : null}

      {viewer ? null : (
        <div className="space-y-4 border-y border-default py-4">
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-heading">Group name</span>
            <input
              aria-label="Group name"
              className="mt-1 min-h-11 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              value={groupDraft.name}
              onChange={event => onGroupDraftChange({ ...groupDraft, name: event.currentTarget.value })}
              placeholder="Waterfront venues"
            />
          </label>
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">{selectedPropertyCount} of {properties.length} Properties selected</summary>
            <div className="pt-3">
              <PropertyChecklist
                legend="Properties in this group"
                properties={properties}
                selectedPropertyIds={groupDraft.propertyIds}
                onSelectedPropertyIdsChange={propertyIds => onGroupDraftChange({ ...groupDraft, propertyIds })}
              />
            </div>
          </details>
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-heading">Competitor domains</span>
            <input
              aria-label="Competitor domains"
              className="mt-1 min-h-11 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              value={groupDraft.competitorDomains}
              onChange={event => onGroupDraftChange({ ...groupDraft, competitorDomains: event.currentTarget.value })}
              placeholder="one.example, two.example"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={!canSave} onClick={() => { void onSaveGroup(groupDraft) }}>
              {isSaving ? 'Saving group…' : 'Save group'}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={!hasUnsavedGroupDraft} onClick={clearGroupForm}>Clear form</Button>
            <p className="text-sm text-secondary">Competitor domains are used only in this group&apos;s competitor report. Groups organize reporting only.</p>
          </div>
          {hasUnsavedGroupDraft ? <p role="status" className="text-sm text-caution">Save this group or clear the form before continuing.</p> : null}
        </div>
      )}

      <div className="overflow-x-auto border-y border-default">
        <table className="evidence-table min-w-[620px]">
          <thead><tr><th>Group</th><th>Properties</th><th>Competitors</th>{showSavedGroupActions ? <th>Actions</th> : null}</tr></thead>
          <tbody>
            {groups.map(group => (
              <tr key={group.id}>
                <td className="font-medium text-heading">{group.name}</td>
                <td className="text-secondary">{propertyNames(group.propertyIds, properties)}</td>
                <td className="text-secondary">{group.competitors.length > 0 ? group.competitors.join(', ') : 'None'}</td>
                {showSavedGroupActions ? (
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      {onEditGroup ? <Button type="button" size="sm" variant="ghost" className="min-h-11" aria-label={`Edit ${group.name}`} onClick={() => onEditGroup(group)}>Edit</Button> : null}
                      {onRemoveGroup ? <Button type="button" size="sm" variant="ghost" className="min-h-11" aria-label={`Remove ${group.name}`} onClick={() => { void onRemoveGroup(group.id) }}>Remove</Button> : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {groups.length === 0 ? <p className="text-sm text-secondary">No groups have been added.</p> : null}

      {viewer ? null : (
        <div className={`flex flex-wrap items-center gap-3 ${onBack ? 'justify-between' : 'justify-end'}`}>
          {onBack ? <Button type="button" variant="outline" className="min-h-11" onClick={onBack}>Back</Button> : null}
          <Button type="button" className="min-h-11" disabled={hasUnsavedGroupDraft} onClick={onContinue}>{groups.length === 0 && !hasUnsavedGroupDraft ? 'Continue without groups' : 'Continue'}</Button>
        </div>
      )}
    </section>
  )
}

export function AdvancedMeasurementReviewStep({
  access,
  availability,
  counts,
  flaggedExceptions,
  sitemapReview,
  onBack,
  onReviewChanges,
  isReviewing = false,
  canReviewChanges = true,
  reviewedChanges,
  reviewChangesError,
  canPublish,
  isPublishing = false,
  onPublish,
}: AdvancedMeasurementReviewStepProps) {
  const [sitemapItemLimit, setSitemapItemLimit] = useState(INITIAL_REVIEW_ITEM_LIMIT)
  const [coverageItemLimit, setCoverageItemLimit] = useState(INITIAL_REVIEW_ITEM_LIMIT)
  const [flaggedExceptionLimit, setFlaggedExceptionLimit] = useState(INITIAL_REVIEW_ITEM_LIMIT)
  if (isUnavailable(availability)) {
    return <section aria-label="Review and publish"><UnavailableState message={availability.message} /></section>
  }

  const viewer = isViewer(access)
  const sitemapItems = sitemapReview?.items ?? []
  const coverageItems = sitemapReview?.coverageItems ?? []
  const shownSitemapItems = sitemapItems.slice(0, sitemapItemLimit)
  const shownCoverageItems = coverageItems.slice(0, coverageItemLimit)
  const shownFlaggedExceptions = flaggedExceptions.slice(0, flaggedExceptionLimit)
  const requiresChangeReview = onReviewChanges !== undefined
  const hasReviewedChanges = reviewedChanges !== null && reviewedChanges !== undefined

  return (
    <section aria-labelledby="advanced-measurement-review-title" className="space-y-5">
      <div className="section-head">
        <div>
          <h3 id="advanced-measurement-review-title">Review &amp; publish</h3>
          <p className="mt-1 max-w-2xl text-sm text-secondary">Confirm the setup details before publishing.</p>
        </div>
      </div>

      {viewer ? <ViewerNotice /> : null}

      {sitemapReview ? (
        <section aria-labelledby="advanced-measurement-sitemap-review-title" className="border-y border-caution-800/40 bg-caution-950/20 py-4">
          <div className="max-w-2xl space-y-3">
            <div>
              <h4 id="advanced-measurement-sitemap-review-title" className="text-sm font-medium text-heading">Sitemap changes need review</h4>
              {sitemapReview.exceptionCount > 0 ? <p className="mt-1 text-sm text-secondary">{sitemapReview.exceptionCount} sitemap {sitemapReview.exceptionCount === 1 ? 'entry needs' : 'entries need'} review.</p> : null}
              {sitemapReview.coverageReviewCount > 0 ? <p className="mt-1 text-sm text-secondary">{sitemapReview.coverageReviewCount} {sitemapReview.coverageReviewCount === 1 ? 'Property has' : 'Properties have'} URL coverage changes.</p> : null}
            </div>
            {sitemapReview.exceptionCount > 0 ? (
              <details className="border-y border-caution-800/30 py-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">URLs not added to Properties ({sitemapReview.exceptionCount})</summary>
                {sitemapItems.length > 0 ? (
                  <ul className="mt-3 space-y-3 text-sm">
                    {shownSitemapItems.map(item => (
                      <li key={`${item.url}-${item.reason}`}>
                        <p className="font-medium text-primary">{item.url}</p>
                        <p className="mt-1 text-secondary">{item.reason}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-2 text-sm text-secondary">Review the affected sitemap URLs before confirming.</p>}
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-secondary">
                  <span>Showing {shownSitemapItems.length} of {sitemapItems.length}</span>
                  {shownSitemapItems.length < sitemapItems.length ? (
                    <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setSitemapItemLimit(limit => limit + REVIEW_ITEM_PAGE_SIZE)}>Show next 50 URLs</Button>
                  ) : null}
                </div>
              </details>
            ) : null}
            {viewer ? <p className="text-sm text-secondary">An editor must finish this review before publishing.</p> : (
              <>
                {sitemapReview.coverageReviewCount > 0 ? (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium text-heading">For changed Property URLs</legend>
                    <p className="text-sm text-secondary">This choice applies to all {sitemapReview.coverageReviewCount} changed {sitemapReview.coverageReviewCount === 1 ? 'Property' : 'Properties'}.</p>
                    <details className="border-y border-caution-800/30 py-3">
                      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-heading">Review Property URL changes ({sitemapReview.coverageReviewCount})</summary>
                      {shownCoverageItems.length > 0 ? (
                        <div className="mt-3 space-y-4">
                          {shownCoverageItems.map(item => (
                            <section key={item.property} aria-label={`${item.property} URL changes`}>
                              <h5 className="text-sm font-medium text-primary">{item.property}</h5>
                              <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
                                <div><p className="font-medium text-secondary">Saved URLs</p><ul className="mt-1 space-y-1">{item.savedUrls.map(url => <li key={url} className="break-all text-secondary">{url}</li>)}</ul></div>
                                <div><p className="font-medium text-secondary">Current sitemap URLs</p>{item.currentSitemapUrls.length > 0 ? <ul className="mt-1 space-y-1">{item.currentSitemapUrls.map(url => <li key={url} className="break-all text-secondary">{url}</li>)}</ul> : <p className="mt-1 text-secondary">No matching URL was found.</p>}</div>
                              </div>
                            </section>
                          ))}
                          <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
                            <span>Showing {shownCoverageItems.length} of {coverageItems.length}</span>
                            {shownCoverageItems.length < coverageItems.length ? (
                              <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setCoverageItemLimit(limit => limit + REVIEW_ITEM_PAGE_SIZE)}>Show next 50 URL changes</Button>
                            ) : null}
                          </div>
                        </div>
                      ) : <p className="mt-2 text-sm text-secondary">Review the affected Properties before confirming.</p>}
                    </details>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-primary">
                      <input
                        type="radio"
                        name="advanced-measurement-coverage-resolution"
                        checked={sitemapReview.coverageResolution === 'keep-existing'}
                        onChange={() => sitemapReview.onCoverageResolutionChange('keep-existing')}
                      />
                      Keep existing Property URLs
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-primary">
                      <input
                        type="radio"
                        name="advanced-measurement-coverage-resolution"
                        checked={sitemapReview.coverageResolution === 'replace-with-imported'}
                        onChange={() => sitemapReview.onCoverageResolutionChange('replace-with-imported')}
                      />
                      Use current sitemap URLs
                    </label>
                  </fieldset>
                ) : null}
                <Button type="button" className="min-h-11" onClick={() => { void sitemapReview.onResolve() }}>Confirm sitemap changes</Button>
              </>
            )}
          </div>
        </section>
      ) : null}

      <div className="overflow-x-auto border-y border-default">
        <table className="evidence-table min-w-[480px]">
          <thead><tr><th>Properties</th><th>Questions</th><th>Groups</th></tr></thead>
          <tbody><tr><td className="tabular-nums text-heading">{counts.properties}</td><td className="tabular-nums text-heading">{counts.queries}</td><td className="tabular-nums text-heading">{counts.groups}</td></tr></tbody>
        </table>
      </div>

      {reviewedChanges ? (
        <section aria-labelledby="advanced-measurement-reviewed-changes-title" className="border-y border-default py-4" aria-live="polite">
          <h4 id="advanced-measurement-reviewed-changes-title" className="text-sm font-medium text-heading">{reviewedChanges.title}</h4>
          {reviewedChanges.items.length > 0 ? (
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-secondary">
              {reviewedChanges.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="advanced-measurement-flagged-exceptions-title" className="space-y-3">
        <h4 id="advanced-measurement-flagged-exceptions-title" className="text-sm font-medium text-heading">Flagged exceptions</h4>
        {flaggedExceptions.length === 0 ? <p className="text-sm text-secondary">No flagged exceptions.</p> : (
          <div className="space-y-3">
            <div className="divide-y divide-default border-y border-default">
              {shownFlaggedExceptions.map(exception => (
                <div key={exception.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div><p className="font-medium text-heading">{exception.title}</p>{exception.detail ? <p className="mt-1 text-sm text-secondary">{exception.detail}</p> : null}</div>
                  <ToneBadge tone={exception.tone ?? 'caution'}>Needs attention</ToneBadge>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
              <span>Showing {shownFlaggedExceptions.length} of {flaggedExceptions.length}</span>
              {shownFlaggedExceptions.length < flaggedExceptions.length ? (
                <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setFlaggedExceptionLimit(limit => limit + REVIEW_ITEM_PAGE_SIZE)}>Show next 50 exceptions</Button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {viewer ? null : (
        <>
          {requiresChangeReview && reviewChangesError ? <p role="alert" className="text-sm text-negative">{reviewChangesError}</p> : null}
          <div className={`flex flex-wrap items-center gap-3 ${onBack ? 'justify-between' : 'justify-end'}`}>
            {onBack ? <Button type="button" variant="outline" className="min-h-11" onClick={onBack}>Back</Button> : null}
            {onReviewChanges !== undefined && !hasReviewedChanges ? (
              <Button type="button" className="min-h-11" disabled={isReviewing || !canReviewChanges} onClick={() => { void onReviewChanges() }}>{isReviewing ? 'Reviewing changes…' : 'Review changes'}</Button>
            ) : (
              <Button type="button" className="min-h-11" disabled={!canPublish || isPublishing} onClick={() => { void onPublish() }}>{isPublishing ? 'Publishing setup…' : 'Publish setup'}</Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
