/**
 * Verify that the Val Town ids a deploy workflow pins actually name the Val it
 * means to deploy, before anything is pushed.
 *
 * The deployment target is two UUIDs typed into a workflow file by hand. Every
 * other guard on this path checks that the workflow is the only SOURCE of those
 * ids; nothing until now checked that the ids are the RIGHT ones. A transposed
 * character resolves to a different Val, and `vt push` makes that Val match this
 * directory — deleting its remote-only files. That is the one mistake on this
 * path with no recovery from inside CI.
 *
 * Two questions are asked of the API, and they fail for different reasons:
 *
 *   1. Does the pinned branch belong to the pinned Val?
 *      `GET /v2/vals/{val_id}/branches/{branch_id}` 404s when it does not. This
 *      runs unconditionally and needs nothing pinned beyond the two ids already
 *      there, so it costs nothing to keep honest. It catches the likeliest slip:
 *      a branch id pasted from a different Val.
 *
 *   2. Is the pinned Val the one we mean?
 *      `GET /v2/vals/{val_id}` returns `name`. This runs only when the workflow
 *      pins `VAL_TOWN_EXPECTED_VAL_NAME`, because a name we do not know cannot
 *      be asserted, and inventing one would turn a safety net into a wrong
 *      answer. A workflow that pins it gets the check; one that does not says so
 *      in its output rather than passing silently.
 *
 * Response shapes are taken from Val Town's published OpenAPI document
 * (`https://api.val.town/openapi.json`): `Val` requires `name` and `id`, and
 * `Branch` requires `name`, `id`, and `version`.
 *
 * Usage:
 *   VAL_TOWN_API_KEY=<key> VAL_TOWN_EXPECTED_VAL_ID=<uuid> \
 *   VAL_TOWN_EXPECTED_BRANCH_ID=<uuid> [VAL_TOWN_EXPECTED_VAL_NAME=<name>] \
 *     node scripts/verify-val-town-target.mjs
 */
import { pathToFileURL } from 'node:url'

export const VAL_TOWN_API_BASE_URL = 'https://api.val.town'

/**
 * The slice of `fetch` this script uses, declared so a test can inject a stub
 * without building a whole `Response`.
 *
 * @typedef {(url: string, init: { headers: Record<string, string> }) => Promise<{
 *   ok: boolean
 *   status: number
 *   json: () => Promise<Record<string, unknown>>
 * }>} JsonFetch
 */

/**
 * Read a string field the API documents as required. The document says `name`
 * is always there; this says what happens if it one day is not, instead of
 * comparing against `undefined` and reporting a mismatch that is really a
 * shape change.
 */
function requiredString(payload, field, describe) {
  const value = payload[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${describe} did not include a "${field}" string, so the target cannot be verified.`)
  }
  return value
}

/**
 * Read one JSON resource, turning every non-200 into a sentence that says which
 * of the two questions failed. A 404 here is not "missing data" — it is the
 * guard firing.
 */
async function getJson({ baseUrl, path, apiKey, fetchImpl, describe }) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`${describe} — Val Town answered ${response.status} for ${path}.`)
  }

  return await response.json()
}

/**
 * Resolve and check the target. Returns `{ valName, branchName }` so the
 * workflow log records what it pushed at, not just that a check passed.
 *
 * @param {object} options
 * @param {string} [options.valId]
 * @param {string} [options.branchId]
 * @param {string} [options.expectedValName]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {JsonFetch} [options.fetchImpl]
 */
export async function verifyValTownTarget({
  valId,
  branchId,
  expectedValName,
  apiKey,
  baseUrl = VAL_TOWN_API_BASE_URL,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('VAL_TOWN_API_KEY is required to verify the deployment target.')
  if (!valId) throw new Error('VAL_TOWN_EXPECTED_VAL_ID is required.')
  if (!branchId) throw new Error('VAL_TOWN_EXPECTED_BRANCH_ID is required.')

  const val = await getJson({
    baseUrl,
    path: `/v2/vals/${valId}`,
    apiKey,
    fetchImpl,
    describe: `No Val resolves to the pinned VAL_TOWN_EXPECTED_VAL_ID ${valId}`,
  })

  const valName = requiredString(val, 'name', `Val ${valId}`)

  if (expectedValName && valName !== expectedValName) {
    throw new Error(
      `The pinned Val id ${valId} is "${valName}", not "${expectedValName}". ` +
        'Refusing to push: this workflow would overwrite a Val it does not own the identity of.',
    )
  }

  const branch = await getJson({
    baseUrl,
    path: `/v2/vals/${valId}/branches/${branchId}`,
    apiKey,
    fetchImpl,
    describe: `Branch ${branchId} does not belong to Val ${valId}`,
  })

  return {
    valName,
    branchName: requiredString(branch, 'name', `Branch ${branchId}`),
    checkedName: Boolean(expectedValName),
  }
}

async function main() {
  try {
    const expectedValName = process.env.VAL_TOWN_EXPECTED_VAL_NAME
    const { valName, branchName, checkedName } = await verifyValTownTarget({
      valId: process.env.VAL_TOWN_EXPECTED_VAL_ID,
      branchId: process.env.VAL_TOWN_EXPECTED_BRANCH_ID,
      expectedValName,
      apiKey: process.env.VAL_TOWN_API_KEY,
    })

    console.log(`Deployment target resolves to Val "${valName}", branch "${branchName}".`)

    if (!checkedName) {
      console.log(
        '::notice::VAL_TOWN_EXPECTED_VAL_NAME is not pinned in this workflow, so only branch ownership was verified. Pin the name to also catch a wrong Val id.',
      )
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
