/**
 * Write the Val Town deployment state file for one Val.
 *
 * `vt push` learns which Val it is updating from `<val>/.vt/state.json`, and
 * `.gitignore` excludes `apps/vals/<name>/.vt/`, so a fresh CI checkout never has
 * one. The deploy workflows used to fail closed on that gap and ask an operator
 * to provision the file onto the runner out of band — which no runner ever did,
 * and which is why neither Val could deploy from CI.
 *
 * Generating the file here is not a relaxation of that guard; it is the same
 * guard moved to a better source. Before, an unreviewed file on the runner
 * named the deployment target and a comparison step defended it. Now the target
 * is only the pair of IDs pinned in the workflow, this script overwrites
 * whatever the runner happened to have, and an ambient file cannot redirect a
 * push at all — so the comparison has nothing left to catch. Changing where a
 * Val deploys still requires editing a reviewed workflow.
 *
 * `branch.version` is an OUTPUT of a push, never an input to one. `vt push`
 * reads only `val.id` and `branch.id`, then rewrites the version from the
 * remote once the push succeeds (`VTClient.push` in `@valtown/vt`). Seeding `0`
 * is therefore correct rather than a placeholder that happens to work: nothing
 * compares it, and any value we wrote would be replaced on the next push.
 *
 * Usage:
 *   VAL_TOWN_EXPECTED_VAL_ID=<uuid> VAL_TOWN_EXPECTED_BRANCH_ID=<uuid> \
 *     node scripts/write-val-town-state.mjs apps/vals/ai-visibility-check
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The all-zero UUID a workflow carries before its Val exists. It parses as a
 * UUID, so only an explicit check keeps it from being pushed at.
 */
export const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000'

/** `vt` validates both IDs with `z.string().uuid()`; match that, not a v4-only shape. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `vt` writes `.vt/state.json` with four-space indentation; match it so a local re-push produces no diff. */
const JSON_INDENT_SPACES = 4

function assertDeployableId(label, value) {
  if (!value) throw new Error(`${label} is required, and was empty.`)
  if (value === PLACEHOLDER_ID) {
    throw new Error(
      `${label} is still the all-zero placeholder. Create the Val in Val Town and pin its real id in the deploy workflow.`,
    )
  }
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID, and was "${value}".`)
}

/**
 * Build the state object `vt` expects. Split out from the write so the shape is
 * testable without touching a filesystem, and so `now` can be pinned.
 */
export function buildValTownState({ valId, branchId, now = new Date() }) {
  assertDeployableId('VAL_TOWN_EXPECTED_VAL_ID', valId)
  assertDeployableId('VAL_TOWN_EXPECTED_BRANCH_ID', branchId)

  return {
    val: { id: valId },
    branch: { id: branchId, version: 0 },
    // `pid` is bookkeeping for vt's own concurrent-run detection; a generated
    // state has no owning process, and the schema accepts 0.
    lastRun: { pid: 0, time: now.toISOString() },
  }
}

/** Write `<valDir>/.vt/state.json`, creating `.vt/` and overwriting any existing file. */
export function writeValTownState({ valDir, valId, branchId, now = new Date() }) {
  const state = buildValTownState({ valId, branchId, now })
  const stateDir = path.join(valDir, '.vt')
  const stateFile = path.join(stateDir, 'state.json')

  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, JSON_INDENT_SPACES)}\n`)

  return { stateFile, state }
}

function main() {
  const [valDirArg] = process.argv.slice(2)

  if (!valDirArg) {
    console.error('Usage: node scripts/write-val-town-state.mjs <val-directory>')
    process.exit(1)
  }

  const valDir = path.resolve(repoRoot, valDirArg)

  if (!fs.existsSync(path.join(valDir, 'deno.json'))) {
    console.error(`::error::${valDirArg} does not look like a Val (no deno.json).`)
    process.exit(1)
  }

  try {
    const { stateFile, state } = writeValTownState({
      valDir,
      valId: process.env.VAL_TOWN_EXPECTED_VAL_ID,
      branchId: process.env.VAL_TOWN_EXPECTED_BRANCH_ID,
    })
    console.log(`Wrote ${path.relative(repoRoot, stateFile)} targeting val ${state.val.id} branch ${state.branch.id}.`)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
