/**
 * Reports when better-sqlite3's PREBUILT binary coverage has moved away from
 * what this repo claims to support.
 *
 * WHY THIS EXISTS
 * `packages/db/test/node-support-range.test.ts` can prove the guard agrees with
 * the INSTALLED better-sqlite3, and that the installed copy matches the
 * lockfile. It cannot prove the lockfile matches reality, because a test must
 * not depend on the network. That blind spot is not hypothetical: the repo sat
 * on 12.6.2 for months while 12.10.0 had shipped the Node 26 prebuild, and the
 * guard, the test and the lockfile all agreed with each other the entire time.
 *
 * So the only part that needs the network lives here, on a schedule.
 *
 * WHY IT FAILS INSTEAD OF OPENING A PR
 * `bump-aeo-audit.yml` is the house pattern for this and its own header records
 * how it broke: the final create-PR step needs a PAT the org does not grant, so
 * every gate ran green, the last step died, and the pin silently froze from
 * 2026-06-22 until it was bumped by hand. A red run on the Actions tab needs no
 * token and cannot half-succeed, so this job just fails and says what changed.
 *
 * Exit 0 = in sync. Exit 1 = drift (read the output). Exit 2 = the check itself
 * could not run, which is NOT the same as "in sync" and must not be read as it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CANONRY_MIN_MAJOR = 22

function read(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8')
}

async function getJson(url) {
  const headers = { 'user-agent': 'canonry-prebuild-check' }
  // Lifts the unauthenticated GitHub limit from 60/hr; absent locally, which is fine.
  if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`)
  return response.json()
}

/** The better-sqlite3 version pnpm-lock.yaml resolves to. */
export function lockedVersion() {
  const source = read('pnpm-lock.yaml')
  const versions = [...source.matchAll(/^ {2}better-sqlite3@(\d+\.\d+\.\d+):$/gm)].map(m => m[1])
  const unique = [...new Set(versions)]
  if (unique.length !== 1) {
    throw new Error(`expected exactly one better-sqlite3 in pnpm-lock.yaml, found: ${unique.join(', ') || 'none'}`)
  }
  return unique[0]
}

/** SUPPORTED_MAJORS as scripts/check-node.mjs declares it. */
export function guardMajors() {
  const match = /const SUPPORTED_MAJORS = \[([^\]]*)\]/.exec(read('scripts', 'check-node.mjs'))
  if (!match) throw new Error('SUPPORTED_MAJORS not found in scripts/check-node.mjs')
  return match[1].split(',').map(part => Number.parseInt(part.trim(), 10)).filter(Number.isFinite).sort((a, b) => a - b)
}

/**
 * ABI -> Node major, from Node's own release index rather than a table here.
 * A hardcoded map is the same mistake this whole guard exists to prevent: it
 * would need editing for a Node major that does not exist yet.
 */
async function abiToMajor() {
  const releases = await getJson('https://nodejs.org/dist/index.json')
  const map = new Map()
  for (const release of releases) {
    const abi = Number.parseInt(release.modules, 10)
    const major = Number.parseInt(String(release.version).replace(/^v/, ''), 10)
    if (Number.isFinite(abi) && Number.isFinite(major)) map.set(abi, major)
  }
  return map
}

/** Node majors implied by a release's prebuild asset names. Pure; see the test below it. */
export function majorsFromAssetNames(assetNames, abis) {
  const majors = new Set()
  for (const name of assetNames) {
    const match = /-node-v(\d+)-/.exec(name)
    if (!match) continue
    const major = abis.get(Number.parseInt(match[1], 10))
    if (major !== undefined) majors.add(major)
  }
  return [...majors].sort((a, b) => a - b)
}

/**
 * Prebuild coverage for one release: `{ majors }`, or `{ error }` when it could
 * not be determined.
 *
 * Zero matching assets is NOT swallowed as "nothing changed". better-sqlite3
 * 13.x publishes no per-ABI release assets at all — it bundles Node-API builds
 * in the npm tarball as `prebuilds/<platform>.node`, which are ABI-stable, which
 * is why its `engines.node` relaxed to an unbounded `>=22`. Upstream changing
 * how it ships binaries is the single most useful thing this job can report, so
 * it must never reach the caller as an absence.
 */
async function describePrebuilds(version, abis) {
  let release
  try {
    release = await getJson(`https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v${version}`)
  } catch (error) {
    return { error: `could not read the v${version} release: ${error.message}` }
  }
  const assetNames = (release.assets ?? []).map(asset => asset.name)
  const majors = majorsFromAssetNames(assetNames, abis)
  if (majors.length === 0) {
    return {
      error:
        `v${version} publishes no node-v<abi> prebuild assets (${assetNames.length} assets on the release).\n` +
        '    That is how 13.x ships: Node-API builds bundled in the npm tarball under\n' +
        '    prebuilds/<platform>.node, ABI-stable, no per-major binary. If the pin has moved\n' +
        '    to that model, this check no longer describes reality — retire it rather than\n' +
        '    letting it report a coverage set that no longer exists.',
    }
  }
  return { majors }
}

async function main() {
  const locked = lockedVersion()
  const latest = (await getJson('https://registry.npmjs.org/better-sqlite3/latest')).version
  const abis = await abiToMajor()

  const lockedCoverage = await describePrebuilds(locked, abis)
  const guard = guardMajors()
  const drift = []

  if (lockedCoverage.error) {
    // The pinned version's own coverage is the baseline for everything else, so
    // there is nothing to compare and no honest way to pass.
    drift.push(`pinned better-sqlite3 ${locked}: ${lockedCoverage.error}`)
  } else {
    const lockedPrebuilds = lockedCoverage.majors
    const expected = lockedPrebuilds.filter(major => major >= CANONRY_MIN_MAJOR)

    if (String(guard) !== String(expected)) {
      drift.push(
        `SUPPORTED_MAJORS is [${guard}] but better-sqlite3 ${locked} ships prebuilds for ` +
          `[${lockedPrebuilds}] (>= Node ${CANONRY_MIN_MAJOR}: [${expected}]).\n` +
          '    Fix scripts/check-node.mjs and the PREBUILT_MAJORS entry in ' +
          'packages/db/test/node-support-range.test.ts.',
      )
    }

    if (locked !== latest) {
      // A newer upstream release is INFORMATION, never a failure: the pin is a
      // deliberate choice and this job going red weekly for an upgrade nobody
      // has decided to take is how a useful alarm gets ignored. Only the pinned
      // version being misdescribed (above) makes this job fail. Every branch
      // here still says what it actually found — reporting "unchanged" for a
      // comparison that never happened is the bug this replaced.
      const latestCoverage = await describePrebuilds(latest, abis)
      if (latestCoverage.error) {
        console.log(`note: better-sqlite3 ${latest} is available (pinned ${locked}), coverage NOT comparable:`)
        console.log(`  ${latestCoverage.error}`)
      } else if (String(latestCoverage.majors) !== String(lockedPrebuilds)) {
        console.log(
          `note: better-sqlite3 ${latest} is available (pinned ${locked}) and its prebuild ` +
            `coverage differs: [${lockedPrebuilds}] -> [${latestCoverage.majors}]. ` +
            'Bumping means updating SUPPORTED_MAJORS and PREBUILT_MAJORS to match.',
        )
      } else {
        console.log(`note: better-sqlite3 ${latest} is available (pinned ${locked}); prebuild coverage unchanged.`)
      }
    }
  }

  if (drift.length > 0) {
    console.error('\nbetter-sqlite3 prebuild coverage has drifted:\n')
    for (const item of drift) console.error(`  - ${item}\n`)
    process.exit(1)
  }

  console.log(`in sync: better-sqlite3 ${locked}, prebuilds [${lockedCoverage.majors}], SUPPORTED_MAJORS [${guard}].`)
}

// Importable for testing; only runs the check when invoked directly.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) main().catch(error => {
  // Exit 2, never 1: "the check could not run" must not read as "drift found",
  // and must not read as success either.
  console.error(`could not complete the prebuild check: ${error.message}`)
  process.exit(2)
})
