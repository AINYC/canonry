import {
  AdvancedMeasurementGroupsStep,
  AdvancedMeasurementQueriesStep,
  AdvancedMeasurementReviewStep,
  type AdvancedMeasurementGroupsStepProps,
  type AdvancedMeasurementQueriesStepProps,
  type AdvancedMeasurementReviewStepProps,
} from './SetupQueriesGroupsReview.js'
import {
  SetupImportProperties,
  type AdvancedMeasurementImportPropertiesProps,
} from './SetupImportProperties.js'
import {
  AdvancedMeasurementSetupWizard,
  type AdvancedMeasurementSetupStep,
} from './AdvancedMeasurementSetupWizard.js'

type ImportPropertiesProps = Omit<AdvancedMeasurementImportPropertiesProps, 'activeStep' | 'canEdit'>
type QueriesProps = Omit<AdvancedMeasurementQueriesStepProps, 'access' | 'onManageProjectQueries'>
type GroupsProps = Omit<AdvancedMeasurementGroupsStepProps, 'access'>
type ReviewProps = Omit<AdvancedMeasurementReviewStepProps, 'access'>

interface SetupBaseProps {
  hasDraft: boolean
  canEdit: boolean
  onDiscard?: () => void
  onStepChange?: (step: AdvancedMeasurementSetupStep) => void
  onManageProjectQueries?: () => void
}

export type AdvancedMeasurementSetupProps = SetupBaseProps & (
  | { currentStep: 'import' | 'properties'; importProperties: ImportPropertiesProps }
  | { currentStep: 'queries'; queries: QueriesProps }
  | { currentStep: 'groups'; groups: GroupsProps }
  | { currentStep: 'review'; review: ReviewProps }
)

function stepContent(props: AdvancedMeasurementSetupProps) {
  const access = props.canEdit ? 'editor' as const : 'viewer' as const

  if (props.currentStep === 'import' || props.currentStep === 'properties') {
    return (
      <SetupImportProperties
        {...props.importProperties}
        activeStep={props.currentStep}
        canEdit={props.canEdit}
      />
    )
  }
  if (props.currentStep === 'queries') {
    return <AdvancedMeasurementQueriesStep {...props.queries} access={access} onManageProjectQueries={props.onManageProjectQueries} />
  }
  if (props.currentStep === 'groups') {
    return <AdvancedMeasurementGroupsStep {...props.groups} access={access} />
  }
  if ('review' in props) {
    return <AdvancedMeasurementReviewStep {...props.review} access={access} />
  }

  return null
}

export function AdvancedMeasurementSetup(props: AdvancedMeasurementSetupProps) {
  return (
    <AdvancedMeasurementSetupWizard
      currentStep={props.currentStep as AdvancedMeasurementSetupStep}
      hasDraft={props.hasDraft}
      canEdit={props.canEdit}
      onDiscard={props.onDiscard}
      onStepChange={props.onStepChange}
    >
      {stepContent(props)}
    </AdvancedMeasurementSetupWizard>
  )
}
