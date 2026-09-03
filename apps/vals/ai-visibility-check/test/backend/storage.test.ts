/**
 * Capacity behaviour where the store meets THIS val's runner and HTTP app.
 *
 * The store-level parity cases — admission, quota, reuse, and the global lease
 * over both `CheckStore` implementations — belong to `@canonry/val-kit` and are
 * tested there. What is left here cannot move with them: it drives
 * `createPublicCheckRunner` and `createValTownApp`, which are this val's own
 * orchestration, against the same two stores.
 */
import { DatabaseSync } from 'node:sqlite'
import type { ValTownConfig } from 'npm:@canonry/val-kit@0.1.0/config'
import {
  type CheckRecord,
  checkFingerprint,
  type CheckStore,
  createRequestBoundDispatcher,
  newCheckRecord,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
} from 'npm:@canonry/val-kit@0.1.0/jobs'
import { LocalBypassHumanVerifier } from 'npm:@canonry/val-kit@0.1.0/security'
import {
  MemoryCheckStore,
  ValSqliteCheckStore,
  type ValSqliteClient,
  type ValSqliteResult,
  type ValSqliteStatement,
} from 'npm:@canonry/val-kit@0.1.0/storage'
import { createValTownApp } from '../../src/app/app.ts'
import { createPublicCheckRunner } from '../../src/jobs/public-check.ts'
import { CHECK_FINGERPRINT_NAMESPACE, type CheckResult } from '../../src/runtime/check-result.ts'
import type { SiteHealthRunner } from '../../src/site-health/types.ts'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function candidate(id: string, domain = 'example.com', now = NOW): CheckRecord<CheckResult> {
  return newCheckRecord<CheckResult>({
    id,
    fingerprint: checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, domain),
    domain,
    now,
  })
}

interface StoreFixture {
  store: CheckStore<CheckResult>
  quotaRowCount(): Promise<number>
  checkRowCount(): Promise<number>
  close(): void
}

class NodeSqliteClient implements ValSqliteClient {
  readonly database = new DatabaseSync(':memory:')
  readonly batchModes: Array<'write'> = []
  private batchTail: Promise<void> = Promise.resolve()

  execute(input: string | ValSqliteStatement): Promise<ValSqliteResult> {
    return Promise.resolve(executeStatement(this.database, input))
  }

  batch(statements: ValSqliteStatement[], mode: 'write'): Promise<ValSqliteResult[]> {
    this.batchModes.push(mode)
    return this.runBatch(statements)
  }

  private async runBatch(statements: ValSqliteStatement[]): Promise<ValSqliteResult[]> {
    const previous = this.batchTail
    let release!: () => void
    this.batchTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    let began = false
    try {
      this.database.exec('BEGIN IMMEDIATE')
      began = true
      const results: ValSqliteResult[] = []
      for (const statement of statements) {
        results.push(executeStatement(this.database, statement))
      }
      this.database.exec('COMMIT')
      began = false
      return results
    } catch (error) {
      if (began) this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }

  close(): void {
    this.database.close()
  }
}

function executeStatement(database: DatabaseSync, input: string | ValSqliteStatement): ValSqliteResult {
  if (typeof input === 'string') {
    database.exec(input)
    return { rows: [] }
  }
  const args = Array.isArray(input.args) ? input.args : Object.values(input.args ?? {})
  const statement = database.prepare(input.sql)
  if (/^\s*SELECT\b|\bRETURNING\b/i.test(input.sql)) {
    return { rows: statement.all(...args) as unknown[] }
  }
  statement.run(...args)
  return { rows: [] }
}

const fixtures: Array<{ name: string; create(): StoreFixture }> = [
  {
    name: 'memory',
    create() {
      const store = new MemoryCheckStore<CheckResult>()
      return {
        store,
        quotaRowCount() {
          return Promise.resolve(store.quota.size)
        },
        checkRowCount() {
          return Promise.resolve(store.checks.size)
        },
        close() {},
      }
    },
  },
  {
    name: 'SQLite',
    create() {
      const sqlite = new NodeSqliteClient()
      return {
        store: new ValSqliteCheckStore<CheckResult>(sqlite),
        quotaRowCount() {
          const row = sqlite.database.prepare('SELECT COUNT(*) AS count FROM canonry_quota').get() as { count?: number }
          return Promise.resolve(row.count ?? 0)
        },
        checkRowCount() {
          const row = sqlite.database.prepare('SELECT COUNT(*) AS count FROM canonry_checks').get() as {
            count?: number
          }
          return Promise.resolve(row.count ?? 0)
        },
        close() {
          sqlite.close()
        },
      }
    },
  },
]

for (const fixtureFactory of fixtures) {
  Deno.test(`${fixtureFactory.name} requeues a global-capacity loser without making it terminal`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const queued = candidate(`capacity-${fixtureFactory.name}`)
      await fixture.store.create(queued)
      await fixture.store.claimGlobalLease(
        'public-check-execution',
        'other-isolate',
        NOW_ISO,
        new Date(NOW.getTime() + 60_000).toISOString(),
      )
      const neverRunSiteHealth: SiteHealthRunner = {
        run(): Promise<never> {
          return Promise.reject(new Error('should not run while capacity is held'))
        },
      }
      const runner = createPublicCheckRunner({
        store: fixture.store,
        visibilityProbe: null,
        siteHealthRunner: neverRunSiteHealth,
        ttlMs: 86_400_000,
        now: () => NOW,
      })

      equal(await runner.run(queued.id), 'busy')
      const stored = await fixture.store.get(queued.id)
      equal(stored?.status, 'queued')
      equal(stored?.leaseOwner, null)
      equal(stored?.errorCode, null)
    } finally {
      fixture.close()
    }
  })

  Deno.test(`${fixtureFactory.name} runner releases a handed-off lease when its job is already gone`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const owner = 'admission-owner'
      equal(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          owner,
          NOW_ISO,
          new Date(NOW.getTime() + 60_000).toISOString(),
        ),
        true,
      )
      const runner = createPublicCheckRunner({
        store: fixture.store,
        visibilityProbe: null,
        siteHealthRunner: { run: () => Promise.reject(new Error('missing job must not execute')) },
        ttlMs: 86_400_000,
        now: () => NOW,
      })

      equal(await runner.run('missing-check', { executionLeaseOwner: owner }), 'ignored')
      equal(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'next-isolate',
          NOW_ISO,
          new Date(NOW.getTime() + 60_000).toISOString(),
        ),
        true,
      )
    } finally {
      fixture.close()
    }
  })

  Deno.test(`${fixtureFactory.name} app rejects held capacity before admission and succeeds after release`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const app = createPublicTestApp(fixture.store)
      const holder = 'other-isolate'
      equal(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          holder,
          NOW_ISO,
          new Date(NOW.getTime() + 60_000).toISOString(),
        ),
        true,
      )

      const rejected = await app.fetch(publicCheckRequest('capacity.example'))
      equal(rejected.status, 503)
      equal(await fixture.checkRowCount(), 0)
      equal(await fixture.quotaRowCount(), 0)

      await fixture.store.releaseGlobalLease(PUBLIC_CHECK_EXECUTION_LEASE_NAME, holder)
      const accepted = await app.fetch(publicCheckRequest('capacity.example'))
      equal(accepted.status, 200)
      equal(await fixture.checkRowCount(), 1)
      equal(await fixture.quotaRowCount(), 2)
    } finally {
      fixture.close()
    }
  })
}

function createPublicTestApp(store: CheckStore<CheckResult>) {
  const config: ValTownConfig = {
    environment: 'test',
    checkTtlMs: 86_400_000,
    perClientDailyLimit: 3,
    globalDailyLimit: 100,
    quotaSalt: 'test-salt',
    humanVerifier: new LocalBypassHumanVerifier(),
    turnstileSiteKey: null,
    humanVerificationStatus: 'not-required',
    geminiApiKey: null,
    geminiModel: null,
    publicChecksEnabled: true,
    publicChecksUnavailableMessage: null,
    mcpStartChecksEnabled: true,
    mcpPerClientDailyLimit: 2,
  }
  const runner = createPublicCheckRunner({
    store,
    visibilityProbe: null,
    siteHealthRunner: {
      run: () =>
        Promise.resolve({
          schemaVersion: '1',
          label: '5-page Technical AEO sample',
          domain: 'capacity.example',
          rootUrl: 'https://capacity.example/',
          finalRootUrl: 'https://capacity.example/',
          status: 'complete',
          score: 80,
          pagesDiscovered: 1,
          pagesFetched: 1,
          pagesObserved: 1,
          elapsedMs: 1,
          terminationReason: null,
          warnings: [],
          factors: [],
          pages: [],
          siteMap: null,
          attemptedHosts: ['capacity.example'],
          error: null,
        }),
    },
    ttlMs: config.checkTtlMs,
    now: () => NOW,
  })
  return createValTownApp({
    store,
    config,
    dispatcher: createRequestBoundDispatcher(runner),
    renderPage: () => '<html><body>demo</body></html>',
    assets: { styles: '', script: '', mark: '', glyph: '' },
    now: () => NOW,
  })
}

function publicCheckRequest(domain: string): Request {
  return new Request('https://val.test/api/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.99' },
    body: JSON.stringify({ domain }),
  })
}
