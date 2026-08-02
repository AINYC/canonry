import { useEffect, useRef, useState, type ReactNode } from 'react'

import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'

export type AdvancedMeasurementSetupStep = 'import' | 'properties' | 'queries' | 'groups' | 'review'

const setupSteps: readonly { id: AdvancedMeasurementSetupStep; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'properties', label: 'Properties' },
  { id: 'queries', label: 'Queries' },
  { id: 'groups', label: 'Groups (optional)' },
  { id: 'review', label: 'Review and publish' },
]

export interface AdvancedMeasurementSetupWizardProps {
  currentStep: AdvancedMeasurementSetupStep
  hasDraft: boolean
  canEdit: boolean
  onDiscard?: () => void
  children: ReactNode
}

export function AdvancedMeasurementSetupWizard({
  currentStep,
  hasDraft,
  canEdit,
  onDiscard,
  children,
}: AdvancedMeasurementSetupWizardProps) {
  const previousStepRef = useRef<AdvancedMeasurementSetupStep | null>(null)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const [discardArmed, setDiscardArmed] = useState(false)

  useEffect(() => {
    if (!hasDraft) setDiscardArmed(false)
  }, [hasDraft])

  useEffect(() => {
    const previousStep = previousStepRef.current
    previousStepRef.current = currentStep

    if (previousStep === null || previousStep === currentStep) return

    const heading = stepContentRef.current?.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]')
    if (!heading) return

    heading.tabIndex = -1
    heading.focus()
  }, [currentStep])

  return (
    <div className="space-y-6">
      <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:justify-between">
        <div className="min-w-0 w-full sm:flex-1">
          <h2>Advanced measurement setup</h2>
          <p className="mt-1 max-w-2xl text-sm text-secondary">
            Choose the Properties and queries you want to measure.
          </p>
        </div>
        {hasDraft ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:justify-end">
            <ToneBadge tone="caution">Unpublished changes</ToneBadge>
            {canEdit && onDiscard ? discardArmed ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm discard">
                <span className="text-sm text-secondary">Discard all unpublished changes?</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDiscardArmed(false)}>
                  Keep editing
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={onDiscard}>
                  Discard unpublished changes
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => setDiscardArmed(true)}>
                Discard changes
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div role="group" aria-label="Advanced measurement setup progress" className="overflow-x-auto border-b border-default">
        <ol className="flex min-w-max gap-6">
          {setupSteps.map(step => (
            <li key={step.id}>
              <span
                aria-current={currentStep === step.id ? 'step' : undefined}
                className={`block min-h-11 border-b-2 px-1 py-3 text-sm font-medium ${
                  currentStep === step.id
                    ? 'border-strong text-heading'
                    : 'border-transparent text-secondary'
                }`}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div ref={stepContentRef}>{children}</div>
    </div>
  )
}
