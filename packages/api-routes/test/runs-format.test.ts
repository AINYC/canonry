import { describe, expect, it } from 'vitest'
import { formatRun } from '../src/runs.js'

const legacyRun = {
  id: 'run_1',
  projectId: 'project_1',
  kind: 'answer-visibility',
  status: 'completed',
  trigger: 'manual',
  location: null,
  queries: ['sample query'],
  startedAt: '2026-08-01T00:00:00.000Z',
  finishedAt: '2026-08-01T00:01:00.000Z',
  error: null,
  createdAt: '2026-08-01T00:01:00.000Z',
}

describe('formatRun measurement provenance compatibility', () => {
  it('preserves the pre-plan response shape when no provenance exists', () => {
    expect(formatRun(legacyRun)).toEqual({
      id: 'run_1',
      projectId: 'project_1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      location: null,
      queries: ['sample query'],
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:01:00.000Z',
      error: null,
      createdAt: '2026-08-01T00:01:00.000Z',
    })
  })

  it('returns both measurement-plan fields for a provenance-aware run', () => {
    expect(formatRun({
      ...legacyRun,
      measurementPlanVersionId: 'plan_v2',
      measurementManifest: { executionIds: ['execution_1'] },
    })).toMatchObject({
      measurementPlanVersionId: 'plan_v2',
      measurementManifest: { executionIds: ['execution_1'] },
    })
  })
})
