import { useNavigate, useSearch, useRouterState } from '@tanstack/react-router'
import { rootRoute } from '../router/routes.js'

export type EvidenceSignal = 'mentions' | 'citations'

export function useDrawer() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as {
    runId?: string
    evidenceId?: string
    evidenceSignal?: EvidenceSignal
    evidenceLocation?: string
  }
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  const runId = search.runId ?? null
  const evidenceId = search.evidenceId ?? null
  const evidenceSignal = search.evidenceSignal ?? null
  const evidenceLocation = search.evidenceLocation ?? null

  const openRun = (id: string): void => {
    void navigate({
      to: currentPath,
      from: rootRoute.to,
      search: (prev) => ({
        ...prev,
        runId: id,
        evidenceId: undefined,
        evidenceSignal: undefined,
        evidenceLocation: undefined,
      }),
    })
  }

  const openEvidence = (
    id: string,
    signal?: EvidenceSignal,
    location?: string,
  ): void => {
    void navigate({
      to: currentPath,
      from: rootRoute.to,
      search: (prev) => ({
        ...prev,
        evidenceId: id,
        evidenceSignal: signal,
        evidenceLocation: location,
        runId: undefined,
      }),
    })
  }

  const closeDrawer = (): void => {
    void navigate({
      to: currentPath,
      from: rootRoute.to,
      search: (prev) => ({
        ...prev,
        runId: undefined,
        evidenceId: undefined,
        evidenceSignal: undefined,
        evidenceLocation: undefined,
      }),
    })
  }

  return {
    runId,
    evidenceId,
    evidenceSignal,
    evidenceLocation,
    openRun,
    openEvidence,
    closeDrawer,
  }
}
