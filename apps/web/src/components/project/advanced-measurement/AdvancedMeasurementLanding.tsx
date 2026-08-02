import type { ReactNode } from 'react'

import { Button } from '../../ui/button.js'
import {
  AdvancedMeasurementOverview,
  type AdvancedMeasurementOverviewReport,
  type AdvancedMeasurementViewRequest,
} from './AdvancedMeasurementOverview.js'
import type { AdvancedMeasurementMode } from './model.js'

export interface AdvancedMeasurementLandingProps {
  mode: AdvancedMeasurementMode
  canEdit: boolean
  simpleOverview: ReactNode
  report?: AdvancedMeasurementOverviewReport
  reportState?: 'loading' | 'ready' | 'error'
  onOpenSetup?: () => void
  onRunMeasurement?: () => void | Promise<void>
  onRetryReport?: () => void
  onViewChange?: (view: AdvancedMeasurementViewRequest) => void
  onLoadMore?: (cursor: string) => void
  onPropertyExpand?: (targetKey: string) => void
  onRetryEvidence?: () => void
  isRunningMeasurement?: boolean
  isOpeningSetup?: boolean
  isViewLoading?: boolean
  isLoadingMore?: boolean
  viewSearch?: string
}

function setupActionLabel(mode: AdvancedMeasurementMode): string {
  if (mode.setupAction === 'continue') return 'Continue advanced setup'
  if (mode.setupAction === 'edit') return 'Edit setup'
  if (mode.setupAction === 'republish') return 'Republish setup'
  return 'Set up advanced measurement'
}

export function AdvancedMeasurementLanding({
  mode,
  canEdit,
  simpleOverview,
  report,
  reportState = 'ready',
  onOpenSetup,
  onRunMeasurement,
  onRetryReport,
  onViewChange,
  onLoadMore,
  onPropertyExpand,
  onRetryEvidence,
  isRunningMeasurement,
  isOpeningSetup,
  isViewLoading,
  isLoadingMore,
  viewSearch,
}: AdvancedMeasurementLandingProps) {
  if (mode.surface === 'simple-overview') {
    return (
      <>
        {canEdit && onOpenSetup ? (
          <div className="mb-5 flex justify-end">
            <Button type="button" variant="outline" disabled={isOpeningSetup} onClick={onOpenSetup}>
              {isOpeningSetup ? 'Opening setup…' : setupActionLabel(mode)}
            </Button>
          </div>
        ) : null}
        {simpleOverview}
      </>
    )
  }

  return (
    <div className="space-y-4">
      {(mode.setupAction === 'edit' || (mode.setupAction === 'republish' && !report)) && canEdit && onOpenSetup ? (
        <div className="flex justify-end">
          <Button type="button" size="sm" variant={mode.setupAction === 'republish' ? 'default' : 'outline'} disabled={isOpeningSetup} onClick={onOpenSetup}>
            {isOpeningSetup ? 'Opening setup…' : setupActionLabel(mode)}
          </Button>
        </div>
      ) : null}
      {reportState === 'loading' ? (
        <div className="h-32 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading advanced measurement report" />
      ) : reportState === 'error' ? (
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
          <p>Could not load the advanced measurement report.</p>
          {onRetryReport ? <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onRetryReport}>Retry report</Button> : null}
        </div>
      ) : report ? (
        <AdvancedMeasurementOverview
          report={report}
          canEdit={canEdit}
          onRunMeasurement={onRunMeasurement}
          onRepublishSetup={onOpenSetup}
          onViewChange={onViewChange}
          onLoadMore={onLoadMore}
          onPropertyExpand={onPropertyExpand}
          onRetryEvidence={onRetryEvidence}
          isRunningMeasurement={isRunningMeasurement}
          isRepublishingSetup={isOpeningSetup}
          isViewLoading={isViewLoading}
          isLoadingMore={isLoadingMore}
          viewSearch={viewSearch}
        />
      ) : (
        <div role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-4 text-sm text-secondary">
          No advanced measurement report is available yet.
        </div>
      )}
    </div>
  )
}
