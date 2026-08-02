export type AdvancedMeasurementSurface =
  | 'simple-overview'
  | 'advanced-overview-v1'
  | 'advanced-overview'

export type AdvancedMeasurementSetupAction = 'set-up' | 'continue' | 'republish' | 'edit'

export interface AdvancedMeasurementStatus {
  activePlanSchemaVersion: number | null
  hasDraft: boolean
}

export interface AdvancedMeasurementMode {
  surface: AdvancedMeasurementSurface
  setupAction: AdvancedMeasurementSetupAction
}

/**
 * The active published setup chooses the landing surface. An unpublished draft
 * never replaces the existing project overview.
 */
export function resolveAdvancedMeasurementMode(status: AdvancedMeasurementStatus): AdvancedMeasurementMode {
  if (status.activePlanSchemaVersion === null) {
    return {
      surface: 'simple-overview',
      setupAction: status.hasDraft ? 'continue' : 'set-up',
    }
  }

  if (status.activePlanSchemaVersion < 2) {
    return { surface: 'advanced-overview-v1', setupAction: 'republish' }
  }

  return { surface: 'advanced-overview', setupAction: 'edit' }
}
