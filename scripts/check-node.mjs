#!/usr/bin/env node
/**
 * Fail the install early, and legibly, on a Node version this repo cannot build.
 *
 * WHY THIS EXISTS
 * `better-sqlite3` is a NATIVE module. On a Node major it has no prebuilt binary
 * for, `pnpm install` falls through to compiling from source and dies in
 * node-gyp with a couple hundred lines of C++ output. Nothing in that wall of
 * text says "wrong Node version", so the reader — very often an agent, which
 * cannot see the terminal scrollback a human would — concludes the repo is
 * broken and starts changing dependencies.
 *
 * Canonry declares its supported Node range in package metadata. This guard
 * adds a focused diagnostic for a Node major whose native dependency prebuild
 * is unavailable, rather than leaving the user in node-gyp output.
 *
 * WHY `preinstall` TOLERATES THIS FILE BEING ABSENT
 * The wiring is `test ! -f scripts/check-node.mjs || node scripts/check-node.mjs`,
 * not a bare `node scripts/check-node.mjs`. The Dockerfiles copy the manifests
 * and install BEFORE copying the rest of the tree (standard layer caching), so
 * this file does not exist at install time inside the image and a bare
 * invocation fails the Docker build with "Cannot find module".
 *
 * Skipping there is correct, not a workaround: every image pins Node 22, so the
 * Dockerfile, rather than an arbitrary local runtime, controls that version.
 *
 * KEEPING THIS HONEST
 * `SUPPORTED_MAJORS` is the intersection of Canonry's Node 22+ policy and
 * better-sqlite3's supported majors. It is asserted against the installed
 * package by `packages/db/test/node-support-range.test.ts`, so a dependency
 * bump that narrows OR widens support fails a test rather than silently
 * drifting — which is exactly how this list went stale once already: it was
 * pinned at 25 while better-sqlite3 had shipped Node 26 prebuilds since
 * 12.10.0, and the test hardcoded the same ceiling so the two agreed on a
 * fact that had expired.
 *
 * That test also asserts CI actually runs the highest major listed here, so
 * "supported" stays a claim with evidence behind it.
 */

// Canonry supports Node 22+; better-sqlite3 ships prebuilds for 22.x-26.x.
// Derived, not guessed — see the test above before editing.
const SUPPORTED_MAJORS = [22, 23, 24, 25, 26]

const major = Number.parseInt(process.versions.node.split('.')[0], 10)
const bypassed = process.env.CANONRY_SKIP_NODE_CHECK === '1'

if (!SUPPORTED_MAJORS.includes(major) && bypassed) {
  process.stderr.write(
    `  ! Node ${process.versions.node} is unsupported; continuing because ` +
      'CANONRY_SKIP_NODE_CHECK=1. A native build failure here is expected.\n',
  )
} else if (!SUPPORTED_MAJORS.includes(major)) {
  const supported = SUPPORTED_MAJORS.join(', ')
  process.stderr.write(
    [
      '',
      '  ✖ Unsupported Node version for this repository.',
      '',
      `      you are running   Node ${process.versions.node}`,
      `      supported majors  ${supported}`,
      '',
      '    This is not a bug in the repo. `better-sqlite3` is a native module and',
      '    ships prebuilt binaries only for the majors above. On anything else the',
      '    install tries to compile from source and fails deep inside node-gyp,',
      '    which looks like an unrelated build error.',
      '',
      '    Fix: switch to a supported Node.',
      `      nvm use 22        (or fnm/volta/asdf — see .nvmrc)`,
      '      Docker images and the published build run Node 22.',
      '',
      '    If your Node is NEWER than every major above, better-sqlite3 may since',
      '    have added a prebuild for it. Check whether a newer release lists your',
      '    major in `engines.node`; if so, updating the dependency and this list',
      '    together is the correct fix, not a workaround:',
      '      pnpm update better-sqlite3 -r',
      '',
      '    To proceed anyway, set CANONRY_SKIP_NODE_CHECK=1. If no prebuild exists',
      '    for your major, expect the native build to fail.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
