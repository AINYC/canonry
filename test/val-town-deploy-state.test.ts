import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { buildValTownState, PLACEHOLDER_ID, writeValTownState } from '../scripts/write-val-town-state.mjs'
import { verifyValTownTarget } from '../scripts/verify-val-town-target.mjs'

/**
 * `.vt/state.json` is the only thing that tells `vt push` WHICH Val it is
 * updating, and it is gitignored, so a clean runner has none. Both deploy
 * workflows now generate it from the val + branch id pinned in the workflow
 * itself.
 *
 * That makes the workflow env the single source of the deployment target, so
 * these tests guard the two ways that could quietly stop being true: the
 * generated file drifting from the shape `vt` accepts, and a workflow
 * generating state for a Val other than the one it deploys — the copy-paste
 * that the "deployment identity is never shared or parameterised" rule exists
 * to prevent.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const VAL_ID = 'b1194860-7c77-41d7-b0b7-f3529a80e15b'
const BRANCH_ID = 'a4524491-dcb3-470a-a361-437a88df6a63'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function makeValDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-state-'))
  tempDirs.push(dir)
  return dir
}

describe('the generated Val Town state file', () => {
  /**
   * Asserted field by field against `VTStateSchema` in `@valtown/vt`: `val.id`
   * and `branch.id` are uuids, `branch.version` and `lastRun.pid` are `gte(0)`,
   * and `lastRun.time` must parse as a date. A state file `vt` rejects fails
   * the deploy after the credentials check, with an error about "wrong shape"
   * rather than about the target.
   */
  test('matches the shape vt validates', () => {
    const now = new Date('2026-09-03T12:00:00.000Z')
    const state = buildValTownState({ valId: VAL_ID, branchId: BRANCH_ID, now })

    expect(state).toEqual({
      val: { id: VAL_ID },
      branch: { id: BRANCH_ID, version: 0 },
      lastRun: { pid: 0, time: '2026-09-03T12:00:00.000Z' },
    })
    expect(state.branch.version).toBeGreaterThanOrEqual(0)
    expect(state.lastRun.pid).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(state.lastRun.time))).toBe(false)
  })

  test('refuses the all-zero placeholder that a workflow carries before its Val exists', () => {
    expect(() => buildValTownState({ valId: PLACEHOLDER_ID, branchId: BRANCH_ID })).toThrow(/placeholder/)
    expect(() => buildValTownState({ valId: VAL_ID, branchId: PLACEHOLDER_ID })).toThrow(/placeholder/)
  })

  test('refuses a missing or malformed id rather than writing an unpushable target', () => {
    expect(() => buildValTownState({ valId: '', branchId: BRANCH_ID })).toThrow(/required/)
    expect(() => buildValTownState({ valId: VAL_ID, branchId: undefined })).toThrow(/required/)
    expect(() => buildValTownState({ valId: 'not-a-uuid', branchId: BRANCH_ID })).toThrow(/must be a UUID/)
  })

  /**
   * The property that replaces the old fixed-target comparison step: a file
   * already on the runner cannot redirect the push, because the workflow
   * overwrites it. If this ever became a "write only when absent", an ambient
   * state file would silently choose the deployment target again.
   */
  test('overwrites a state file the runner already had', () => {
    const valDir = makeValDir()
    fs.mkdirSync(path.join(valDir, '.vt'), { recursive: true })
    fs.writeFileSync(
      path.join(valDir, '.vt', 'state.json'),
      JSON.stringify({ val: { id: '11111111-1111-1111-1111-111111111111' } }),
    )

    const { stateFile } = writeValTownState({ valDir, valId: VAL_ID, branchId: BRANCH_ID })

    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).val.id).toBe(VAL_ID)
  })

  test('creates the .vt directory when the runner has none', () => {
    const valDir = makeValDir()

    const { stateFile } = writeValTownState({ valDir, valId: VAL_ID, branchId: BRANCH_ID })

    expect(stateFile).toBe(path.join(valDir, '.vt', 'state.json'))
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).branch.id).toBe(BRANCH_ID)
  })
})

interface WorkflowStep {
  name?: string
  run?: string
}

interface Workflow {
  jobs?: Record<string, { env?: Record<string, string>; steps?: WorkflowStep[] }>
}

function deployWorkflows(): { file: string; valDir: string; workflow: Workflow }[] {
  const valDirs = fs
    .readdirSync(path.join(repoRoot, 'apps', 'vals'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  return valDirs.map((valDir) => {
    const file = `deploy-${valDir}.yml`
    const source = path.join(repoRoot, '.github', 'workflows', file)

    if (!fs.existsSync(source)) {
      throw new Error(`apps/vals/${valDir} has no .github/workflows/${file}; every Val owns its own deploy workflow`)
    }

    return { file, valDir, workflow: parseYaml(fs.readFileSync(source, 'utf8')) as Workflow }
  })
}

describe('every Val deploy workflow', () => {
  const workflows = deployWorkflows()

  test.each(workflows.map(({ file, valDir, workflow }) => [file, valDir, workflow] as const))(
    '%s materializes state for its own Val directory',
    (_file, valDir, workflow) => {
      const steps = workflow.jobs?.deploy?.steps ?? []
      const writes = steps.filter((step) => step.run?.includes('write-val-town-state.mjs'))

      expect(writes).toHaveLength(1)
      // The parameterisation hazard: a copied workflow that still points at the
      // Val it was copied from would deploy this Val's code over that one.
      expect(writes[0]!.run).toContain(`apps/vals/${valDir}`)
    },
  )

  test.each(workflows.map(({ file, workflow }) => [file, workflow] as const))(
    '%s pins its deployment target in the workflow env',
    (_file, workflow) => {
      const env = workflow.jobs?.deploy?.env ?? {}

      expect(typeof env.VAL_TOWN_EXPECTED_VAL_ID).toBe('string')
      expect(typeof env.VAL_TOWN_EXPECTED_BRANCH_ID).toBe('string')
    },
  )

  test.each(workflows.map(({ file, workflow }) => [file, workflow] as const))(
    '%s verifies the pinned target resolves before pushing',
    (_file, workflow) => {
      const steps = workflow.jobs?.deploy?.steps ?? []
      const verifyAt = steps.findIndex((step) => step.run?.includes('verify-val-town-target.mjs'))
      const pushAt = steps.findIndex((step) => step.run?.includes('vt@0.1.59 push'))

      expect(verifyAt).toBeGreaterThanOrEqual(0)
      // A preflight after the push is not a preflight.
      expect(verifyAt).toBeLessThan(pushAt)
    },
  )

  /**
   * The step this replaced aborted when `.vt/state.json` was absent, which on a
   * clean runner is always. Leaving one behind would fail the deploy before the
   * generated file is ever written.
   */
  test.each(workflows.map(({ file, workflow }) => [file, workflow] as const))(
    '%s no longer requires a pre-provisioned state file',
    (_file, workflow) => {
      const steps = workflow.jobs?.deploy?.steps ?? []
      const readsBeforeWriting = steps.filter(
        (step) => step.run?.includes('.vt/state.json') && !step.run.includes('write-val-town-state.mjs'),
      )

      expect(readsBeforeWriting).toEqual([])
    },
  )
})

/**
 * The preflight that answers "are these the RIGHT ids", as opposed to every
 * other guard on this path, which answers "is the workflow the only source of
 * them". Driven through a stub so both failure modes are exercised without a
 * Val Town credential; the response shapes come from Val Town's published
 * OpenAPI document.
 */
describe('the Val Town target preflight', () => {
  const VAL_NAME = 'brand-perception-check'

  function stubApi(routes: Record<string, { status?: number; body?: Record<string, unknown> }>) {
    const calls: string[] = []
    const fetchImpl = (url: string) => {
      const path = url.replace('https://api.val.town', '')
      calls.push(path)
      const hit = routes[path] ?? { status: 404 }
      return Promise.resolve({
        ok: (hit.status ?? 200) < 400,
        status: hit.status ?? 200,
        json: () => Promise.resolve(hit.body ?? {}),
      })
    }
    return { fetchImpl, calls }
  }

  const okRoutes = {
    [`/v2/vals/${VAL_ID}`]: { body: { id: VAL_ID, name: VAL_NAME } },
    [`/v2/vals/${VAL_ID}/branches/${BRANCH_ID}`]: { body: { id: BRANCH_ID, name: 'main', version: 3 } },
  }

  test('accepts a Val whose name and branch both match', async () => {
    const { fetchImpl, calls } = stubApi(okRoutes)

    const result = await verifyValTownTarget({
      valId: VAL_ID,
      branchId: BRANCH_ID,
      expectedValName: VAL_NAME,
      apiKey: 'k',
      fetchImpl,
    })

    expect(result).toEqual({ valName: VAL_NAME, branchName: 'main', checkedName: true })
    expect(calls).toEqual([`/v2/vals/${VAL_ID}`, `/v2/vals/${VAL_ID}/branches/${BRANCH_ID}`])
  })

  /** The unrecoverable mistake: a valid id for the wrong Val. */
  test('refuses a Val id that resolves to a different name', async () => {
    const { fetchImpl } = stubApi({
      ...okRoutes,
      [`/v2/vals/${VAL_ID}`]: { body: { id: VAL_ID, name: 'ai-visibility-check' } },
    })

    await expect(
      verifyValTownTarget({ valId: VAL_ID, branchId: BRANCH_ID, expectedValName: VAL_NAME, apiKey: 'k', fetchImpl }),
    ).rejects.toThrow(/is "ai-visibility-check", not "brand-perception-check"/)
  })

  /** The likeliest slip: a branch id pasted from a different Val. 404 is the guard firing. */
  test('refuses a branch that does not belong to the Val', async () => {
    const { fetchImpl } = stubApi({ [`/v2/vals/${VAL_ID}`]: { body: { id: VAL_ID, name: VAL_NAME } } })

    await expect(
      verifyValTownTarget({ valId: VAL_ID, branchId: BRANCH_ID, expectedValName: VAL_NAME, apiKey: 'k', fetchImpl }),
    ).rejects.toThrow(/does not belong to Val/)
  })

  test('refuses a Val id that resolves to nothing', async () => {
    const { fetchImpl } = stubApi({})

    await expect(
      verifyValTownTarget({ valId: VAL_ID, branchId: BRANCH_ID, apiKey: 'k', fetchImpl }),
    ).rejects.toThrow(/No Val resolves to the pinned/)
  })

  /**
   * Branch ownership is still enforced without a pinned name, and the caller is
   * told the weaker check ran — a silent pass would misrepresent the coverage.
   */
  test('verifies branch ownership when no name is pinned, and says the name went unchecked', async () => {
    const { fetchImpl } = stubApi(okRoutes)

    const result = await verifyValTownTarget({ valId: VAL_ID, branchId: BRANCH_ID, apiKey: 'k', fetchImpl })

    expect(result.checkedName).toBe(false)
    expect(result.valName).toBe(VAL_NAME)
  })

  test('refuses to run without a credential rather than skipping the check', async () => {
    const { fetchImpl } = stubApi(okRoutes)

    await expect(verifyValTownTarget({ valId: VAL_ID, branchId: BRANCH_ID, fetchImpl })).rejects.toThrow(
      /VAL_TOWN_API_KEY is required/,
    )
  })
})
