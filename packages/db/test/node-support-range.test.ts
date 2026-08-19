import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test, expect, describe } from 'vitest'

/**
 * `scripts/check-node.mjs` blocks an install on a Node major that `better-sqlite3`
 * has no prebuilt binary for, converting a couple hundred lines of node-gyp C++
 * output into one legible line.
 *
 * Its `SUPPORTED_MAJORS` list applies Canonry's Node 22+ policy to
 * better-sqlite3's own `engines.node`. A dependency bump that narrows that range
 * would otherwise leave the guard silently wrong and hand the reader back the
 * node-gyp wall of text the guard exists to prevent.
 *
 * So the compatible subset is asserted rather than trusted.
 *
 * WHY THE CEILING IS DERIVED AND NOT WRITTEN DOWN
 * This file used to hardcode `< 26` in three places. That made the guard and the
 * test agree with each other while both disagreed with reality: better-sqlite3
 * had shipped Node 26 prebuilds since 12.10.0, but the repo stayed pinned at
 * 12.6.2 and refused to install on Node 26 — telling the reader to change their
 * Node and explicitly NOT to touch dependencies, when updating the dependency
 * was the actual fix. A guard that hardcodes the value it is supposed to be
 * checking cannot catch that. Everything below derives from
 * better-sqlite3's `engines.node`, so the next major lands as a failing test.
 *
 * WIDENING IS NOT ENOUGH ON ITS OWN
 * Claiming a major nothing runs is the same mistake pointed the other way, so
 * the last test asserts the CI matrix actually exercises the highest supported
 * major.
 */

const require = createRequire(import.meta.url)

/** Canonry's own floor, independent of what the native dep supports. */
const CANONRY_MIN_MAJOR = 22

/** The major Docker images, .nvmrc, and the published build all pin. */
const DEPLOY_MAJOR = 22

function repoRoot(): string {
  // packages/db/test -> repo root
  return path.resolve(__dirname, '..', '..', '..')
}

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot(), ...segments), 'utf8')
}

function guardMajors(): number[] {
  const source = readRepoFile('scripts', 'check-node.mjs')
  const match = /const SUPPORTED_MAJORS = \[([^\]]*)\]/.exec(source)
  if (!match) throw new Error('SUPPORTED_MAJORS not found in scripts/check-node.mjs')
  return match[1]!
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

function betterSqlite3Majors(): number[] {
  const pkgPath = require.resolve('better-sqlite3/package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { engines?: { node?: string } }
  const range = pkg.engines?.node
  if (!range) throw new Error('better-sqlite3 declares no engines.node')
  // e.g. "20.x || 22.x || 23.x || 24.x || 25.x || 26.x"
  return range
    .split('||')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

/**
 * Majors the CI test matrix actually installs and runs the suite on.
 *
 * Reads the `include:` entries, which are deliberately asymmetric (Node 22
 * sharded 4x, the highest major unsharded) to hold CI cost down — so this
 * counts DISTINCT majors and says nothing about how each one is split.
 * `\bnode:` cannot match the `node-version:` key the setup step passes.
 */
function ciMatrixMajors(): number[] {
  const source = readRepoFile('.github', 'workflows', 'ci.yml')
  const majors = [...source.matchAll(/\bnode:\s*'(\d+)'/g)].map((m) => Number.parseInt(m[1]!, 10))
  if (majors.length === 0) throw new Error('node matrix not found in .github/workflows/ci.yml')
  return [...new Set(majors)].sort((a, b) => a - b)
}

function declaredEnginesCeiling(pkgRelPath: string[]): { declared: string; ceiling: number } {
  const pkg = JSON.parse(readRepoFile(...pkgRelPath)) as { engines?: { node?: string } }
  const declared = pkg.engines?.node ?? ''
  return { declared, ceiling: Number.parseInt(/<\s*(\d+)/.exec(declared)?.[1] ?? '0', 10) }
}

describe('Node support range', () => {
  test('the install guard matches Canonry-supported better-sqlite3 majors', () => {
    // Derived, not hardcoded: whatever better-sqlite3 supports at or above
    // Canonry's floor is exactly what the guard must allow. A dependency bump
    // that adds OR drops a major fails here.
    const expected = betterSqlite3Majors().filter((major) => major >= CANONRY_MIN_MAJOR)
    expect(guardMajors()).toEqual(expected)
  })

  test('the guard and declared engine range enforce Node 22+', () => {
    const majors = guardMajors()
    expect(majors).toContain(CANONRY_MIN_MAJOR)
    expect(majors).not.toContain(20)

    // The ceiling is exclusive, so it must sit exactly one past the highest
    // supported major — never a literal that can rot.
    const expectedCeiling = Math.max(...majors) + 1
    const root = declaredEnginesCeiling(['package.json'])
    const published = declaredEnginesCeiling(['packages', 'canonry', 'package.json'])

    expect(root.declared).toBe(`>=${CANONRY_MIN_MAJOR}.14.0 <${expectedCeiling}`)
    expect(published.declared).toBe(root.declared)
  })

  test('every Dockerfile uses the Node 22 base', () => {
    // Deliberately still pinned while the supported range is wider: widening
    // what a CONTRIBUTOR may use must not quietly move what ships.
    for (const dockerfile of ['Dockerfile', 'Dockerfile.api', 'Dockerfile.worker', 'Dockerfile.web']) {
      const source = readRepoFile(dockerfile)
      const majors = [...source.matchAll(/^FROM .*node:(\d+)-bookworm-slim(?:\s|$)/gm)].map(
        (match) => Number.parseInt(match[1]!, 10),
      )
      expect(majors.length).toBeGreaterThan(0)
      expect(majors.every((major) => major === DEPLOY_MAJOR)).toBe(true)
    }
  })

  test('the guard rejects a major with no prebuilt binary', () => {
    // The case that motivated this: an agent on a brand-new Node fell through
    // to compiling better-sqlite3 from source and read the node-gyp failure as
    // a repo bug. The guard must never promise a major the native dep has no
    // prebuild for — expressed against the dep's own range, so this keeps
    // meaning the same thing after the next Node release.
    const beyondPrebuilds = Math.max(...betterSqlite3Majors()) + 1
    expect(guardMajors()).not.toContain(beyondPrebuilds)
  })

  test('the declared engines range does not promise more than the guard allows', () => {
    // An unbounded `>=X` range asserts that every FUTURE major is supported,
    // which is exactly the claim that misled the install. Require a ceiling.
    const { declared, ceiling } = declaredEnginesCeiling(['package.json'])
    expect(declared).toMatch(/<\s*\d+/)
    expect(ceiling).toBeGreaterThan(Math.max(...guardMajors()))
  })

  test('CI runs the suite on the deploy major and the highest supported major', () => {
    // Support has to be earned, not declared. Without this, widening
    // SUPPORTED_MAJORS silently promises a major nothing ever runs — the same
    // unevidenced claim as the stale ceiling, just in the opposite direction.
    const ci = ciMatrixMajors()
    const highest = Math.max(...guardMajors())

    expect(ci).toContain(DEPLOY_MAJOR)
    expect(ci).toContain(highest)
    // And CI must not claim to test a major the guard refuses to install on.
    for (const major of ci) expect(guardMajors()).toContain(major)
  })
})
