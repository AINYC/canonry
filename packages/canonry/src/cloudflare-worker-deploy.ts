import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLOUDFLARE_WORKER_BINDINGS,
  CLOUDFLARE_WORKER_GENERATED_MARKER,
  CLOUDFLARE_WRANGLER_GENERATED_MARKER,
} from '@ainyc/canonry-integration-cloudflare-worker'

export interface CloudflareWorkerArtifacts {
  outputDirectory: string
  workerScriptPath: string
  wranglerTomlPath: string
}

export interface CloudflareDirectPushSecrets {
  bearerToken: string
  hmacSecret: string
}

export type WranglerRunner = (
  command: string,
  args: readonly string[],
  opts: { cwd: string },
) => Promise<void>

export type WranglerHelpRunner = (
  command: string,
  args: readonly string[],
  opts: { cwd: string },
) => Promise<string>

function projectSlug(project: string): string {
  return project
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'
}

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function resolveCloudflareWorkerOutputDirectory(
  project: string,
  outputDirectory?: string,
  cwd = process.cwd(),
): string {
  return path.resolve(cwd, outputDirectory ?? `canonry-cloudflare-${projectSlug(project)}`)
}

/**
 * Create or validate the destination before calling the connect endpoint.
 * Existing regular artifact files are allowed so reconnect and upgrade can
 * refresh files that the Canonry generator owns.
 */
export function prepareCloudflareWorkerOutputDirectory(outputDirectory: string): CloudflareWorkerArtifacts {
  const resolved = path.resolve(outputDirectory)
  const outputStat = lstatIfPresent(resolved)
  if (outputStat) {
    const stat = outputStat
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`output directory is not a regular directory: ${resolved}`)
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  }

  const artifacts = {
    outputDirectory: resolved,
    workerScriptPath: path.join(resolved, 'worker.js'),
    wranglerTomlPath: path.join(resolved, 'wrangler.toml'),
  }

  for (const artifactPath of [artifacts.workerScriptPath, artifacts.wranglerTomlPath]) {
    const stat = lstatIfPresent(artifactPath)
    if (!stat) continue
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`artifact path is not a regular file: ${artifactPath}`)
    }
    const contents = fs.readFileSync(artifactPath, 'utf-8')
    if (!isRecognizablyCanonryGenerated(artifactPath, contents)) {
      throw new Error(`refusing to overwrite an operator-owned artifact: ${artifactPath}`)
    }
  }

  return artifacts
}

function readRegularArtifact(filePath: string): string | null {
  const stat = lstatIfPresent(filePath)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`artifact path is not a regular file: ${filePath}`)
  }
  return fs.readFileSync(filePath, 'utf-8')
}

function isRecognizablyCanonryGenerated(filePath: string, contents: string): boolean {
  if (path.basename(filePath) === 'worker.js') {
    return contents.startsWith(`${CLOUDFLARE_WORKER_GENERATED_MARKER}\n`)
  }
  if (path.basename(filePath) !== 'wrangler.toml') return false
  if (contents.startsWith(`${CLOUDFLARE_WRANGLER_GENERATED_MARKER}\n`)) return true

  // Accept the marker-free format generated before safe upgrades existed.
  return /^name = "canonry-traffic-[^"]+"$/m.test(contents)
    && /^main = "worker\.js"$/m.test(contents)
    && /^CANONRY_DELIVERY_MODE = "direct-push"$/m.test(contents)
    && /^CANONRY_SOURCE_ID = /m.test(contents)
    && /^CANONRY_INGEST_URL = /m.test(contents)
    && /^CANONRY_WORKER_VERSION = /m.test(contents)
    && contents.includes('[secrets]')
    && contents.includes(CLOUDFLARE_WORKER_BINDINGS.bearerToken)
    && contents.includes(CLOUDFLARE_WORKER_BINDINGS.hmacSecret)
}

function writePrivateTemporaryFile(filePath: string, contents: string): string {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  const fd = fs.openSync(temporaryPath, 'wx', 0o600)
  let closed = false
  try {
    fs.writeFileSync(fd, contents, 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    closed = true
  } catch (error) {
    if (!closed) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the write error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // Preserve the write error.
    }
    throw error
  }
  return temporaryPath
}

export function writeCloudflareWorkerArtifacts(
  artifacts: CloudflareWorkerArtifacts,
  contents: { workerScript: string; wranglerToml: string },
): void {
  const requested = [
    { filePath: artifacts.workerScriptPath, contents: contents.workerScript },
    { filePath: artifacts.wranglerTomlPath, contents: contents.wranglerToml },
  ]
  const changes = requested.flatMap((artifact) => {
    const previous = readRegularArtifact(artifact.filePath)
    if (previous === artifact.contents) return []
    if (previous !== null && !isRecognizablyCanonryGenerated(artifact.filePath, previous)) {
      throw new Error(`refusing to overwrite an operator-owned artifact: ${artifact.filePath}`)
    }
    return [{ ...artifact, previous }]
  })

  const pending: Array<(typeof changes)[number] & { temporaryPath: string }> = []
  const applied: typeof pending = []
  try {
    for (const change of changes) {
      pending.push({
        ...change,
        temporaryPath: writePrivateTemporaryFile(change.filePath, change.contents),
      })
    }
    for (const change of pending) {
      if (readRegularArtifact(change.filePath) !== change.previous) {
        throw new Error(`artifact changed during update: ${change.filePath}`)
      }
      if (change.previous === null) {
        fs.linkSync(change.temporaryPath, change.filePath)
        fs.unlinkSync(change.temporaryPath)
      } else {
        fs.renameSync(change.temporaryPath, change.filePath)
      }
      applied.push(change)
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      try {
        if (readRegularArtifact(change.filePath) !== change.contents) continue
        if (change.previous === null) {
          fs.unlinkSync(change.filePath)
        } else {
          const restorePath = writePrivateTemporaryFile(change.filePath, change.previous)
          fs.renameSync(restorePath, change.filePath)
        }
      } catch {
        // Preserve the original write error. Rollback is best-effort.
      }
    }
    throw error
  } finally {
    for (const change of pending) {
      try {
        if (fs.existsSync(change.temporaryPath)) fs.unlinkSync(change.temporaryPath)
      } catch {
        // Preserve the write result. Temporary-file cleanup is best-effort.
      }
    }
  }
}

export function assertCloudflareArtifactsDoNotContainSecrets(
  contents: { workerScript: string; wranglerToml: string; instructions?: string },
  secrets: CloudflareDirectPushSecrets,
): void {
  const artifactText = [contents.workerScript, contents.wranglerToml, contents.instructions ?? '']
  for (const secret of [secrets.bearerToken, secrets.hmacSecret]) {
    if (secret && artifactText.some((value) => value.includes(secret))) {
      throw new Error('Cloudflare setup response unexpectedly contained a cleartext secret')
    }
  }
}

export function redactCloudflareSecrets(message: string, secrets: CloudflareDirectPushSecrets): string {
  let redacted = message
  for (const secret of [secrets.bearerToken, secrets.hmacSecret]) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redacted
}

async function runWrangler(command: string, args: readonly string[], opts: { cwd: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      shell: false,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(
        signal
          ? `Wrangler exited after signal ${signal}`
          : `Wrangler exited with code ${code ?? 'unknown'}`,
      ))
    })
  })
}

async function runWranglerHelp(
  command: string,
  args: readonly string[],
  opts: { cwd: string },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: unknown) => { output += String(chunk) })
    child.stderr.on('data', (chunk: unknown) => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(output)
        return
      }
      reject(new Error(
        signal
          ? `Wrangler help exited after signal ${signal}`
          : `Wrangler help exited with code ${code ?? 'unknown'}`,
      ))
    })
  })
}

/** Make sure that deployment can use the secret-file and strict safety flags. */
export async function preflightCloudflareWrangler(opts: {
  run?: WranglerHelpRunner
  cwd?: string
} = {}): Promise<void> {
  const help = await (opts.run ?? runWranglerHelp)(
    'wrangler',
    ['deploy', '--help'],
    { cwd: path.resolve(opts.cwd ?? process.cwd()) },
  )
  const missing = ['--secrets-file', '--strict'].filter(flag => !help.includes(flag))
  if (missing.length > 0) {
    throw new Error(`Wrangler deploy does not support required flags: ${missing.join(', ')}`)
  }
}

/**
 * Deploy through Wrangler without placing either secret in argv, stdout,
 * Worker source, or wrangler.toml. The only cleartext handoff is an exact
 * private temporary JSON file, removed in `finally` on success or failure.
 */
export async function deployCloudflareWorker(opts: {
  wranglerTomlPath: string
  secrets: CloudflareDirectPushSecrets
  run?: WranglerRunner
  tempRoot?: string
}): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(opts.tempRoot ?? os.tmpdir(), 'canonry-cloudflare-secrets-'))
  const secretsPath = path.join(tempDirectory, 'secrets.json')

  try {
    fs.chmodSync(tempDirectory, 0o700)
    fs.writeFileSync(
      secretsPath,
      JSON.stringify({
        [CLOUDFLARE_WORKER_BINDINGS.bearerToken]: opts.secrets.bearerToken,
        [CLOUDFLARE_WORKER_BINDINGS.hmacSecret]: opts.secrets.hmacSecret,
      }),
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
    )
    fs.chmodSync(secretsPath, 0o600)

    const runner = opts.run ?? runWrangler
    await runner(
      'wrangler',
      [
        'deploy',
        '--config',
        path.resolve(opts.wranglerTomlPath),
        '--secrets-file',
        secretsPath,
        '--strict',
      ],
      { cwd: path.dirname(path.resolve(opts.wranglerTomlPath)) },
    )
  } finally {
    try {
      if (fs.existsSync(secretsPath)) fs.unlinkSync(secretsPath)
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true })
    }
  }
}
