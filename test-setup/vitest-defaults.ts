/**
 * Shared vitest setup — runs once per worker before any test imports.
 *
 * Wired into the root workspace config and every package's `test` script via
 * `vitest.package.config.ts`. Package-local Vitest configs must include the
 * same setup file when they bypass the shared package config.
 *
 * Hardens the test environment against accidental side effects:
 *   1. Disables canonry telemetry. Even packages that don't import the
 *      telemetry module benefit — invokeCli-style tests sometimes pull
 *      in code paths that fire `cli.command` events.
 *   2. Redirects `CANONRY_CONFIG_DIR` at a throwaway directory, so no test can
 *      write to the operator's real `~/.canonry/config.yaml`.
 *   3. Replaces `globalThis.fetch` with a guard that throws on any
 *      non-localhost request, so a test that forgets to mock fetch
 *      can't silently hit the real internet.
 *
 * The fetch guard is compatible with the standard save-and-restore
 * pattern (`const orig = globalThis.fetch; globalThis.fetch = mockFn; ...; globalThis.fetch = orig`)
 * — tests capture this guard as `orig`, install their mock, and put
 * the guard back on cleanup. The guard stays in effect between tests.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.CANONRY_TELEMETRY_DISABLED = '1'

const TELEMETRY_HOSTS = new Set([
  'ainyc.ai',
  'www.ainyc.ai',
  'canonry.ai',
  'www.canonry.ai',
])

const realFetch = globalThis.fetch

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  )
}

function urlOf(input: string | URL | Request): URL | null {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
  } catch {
    return null
  }
  return null
}

/**
 * Point every test at a throwaway config directory.
 *
 * Several code paths persist to the operator's config as a side effect of
 * ordinary work — `executeGscSync` writes refreshed OAuth tokens back through
 * `saveConfigPatch`, for instance. A test that calls one with fixture
 * credentials will happily overwrite the real `~/.canonry/config.yaml`; on
 * 2026-08-06 that replaced twelve live Google connections with a single
 * `example.com` fixture and broke the operator's Search Console auth.
 *
 * Same reasoning as the network guard below: a unit test must not reach
 * outside its own sandbox, and a config write is a side effect on the
 * developer's machine every bit as real as an HTTP call.
 *
 * An explicitly-set `CANONRY_CONFIG_DIR` is respected — a test that wants a
 * specific directory has already opted in.
 */
if (!process.env.CANONRY_CONFIG_DIR?.trim()) {
  process.env.CANONRY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-test-config-'))
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input)
  if (url) {
    if (TELEMETRY_HOSTS.has(url.hostname)) {
      throw new Error(
        `[test] Blocked telemetry request to ${url.href}. ` +
        `Tests must mock globalThis.fetch when exercising trackEvent — see test-setup/vitest-defaults.ts.`,
      )
    }
    if (!isLocalHost(url.hostname)) {
      throw new Error(
        `[test] Blocked external network request to ${url.href}. ` +
        `Tests must not hit external services. Mock globalThis.fetch or stub the client.`,
      )
    }
  }
  return realFetch(input as Parameters<typeof realFetch>[0], init)
}) as typeof globalThis.fetch
