export type OnboardingStage = 'site' | 'fixes' | 'visibility'

const ONBOARDING_STAGES = [
  { id: 'site', label: 'Site audit', optional: false },
  { id: 'fixes', label: 'Review fixes', optional: false },
  { id: 'visibility', label: 'AI Visibility', optional: true },
] as const satisfies ReadonlyArray<{
  id: OnboardingStage
  label: string
  optional?: boolean
}>

export function OnboardingProgress({ current }: { current: OnboardingStage }) {
  const currentIndex = ONBOARDING_STAGES.findIndex((stage) => stage.id === current)

  return (
    <ol
      aria-label="Onboarding progress"
      className="grid border-y border-default sm:grid-cols-3 sm:divide-x sm:divide-default"
    >
      {ONBOARDING_STAGES.map((stage, index) => {
        const complete = index < currentIndex
        const active = index === currentIndex

        return (
          <li
            key={stage.id}
            aria-current={active ? 'step' : undefined}
            className="flex min-h-14 items-center gap-3 px-3 py-2.5 first:pl-0 last:pr-0"
          >
            <span
              aria-hidden="true"
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums ${
                active
                  ? 'border-accent bg-accent text-on-inverse'
                  : complete
                    ? 'border-positive bg-positive-soft text-positive'
                    : 'border-default bg-surface-subtle text-muted'
              }`}
            >
              {complete ? '✓' : index + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-sm font-medium ${active || complete ? 'text-heading' : 'text-secondary'}`}>
                {stage.label}
              </span>
              <span className="block text-[13px] text-secondary">
                {complete ? 'Done' : active ? 'Current' : stage.optional ? 'Optional' : 'Upcoming'}
                {active && stage.optional ? ' · Optional' : null}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
