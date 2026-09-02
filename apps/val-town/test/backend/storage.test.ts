import { DatabaseSync } from 'node:sqlite'
import { createValTownApp } from '../../src/app/app.ts'
import type { ValTownConfig } from '../../src/config/index.ts'
import {
  createPublicCheckRunner,
  createRequestBoundDispatcher,
  newCheckRecord,
  PUBLIC_CHECK_EXECUTION_LEASE_NAME,
} from '../../src/jobs/public-check.ts'
import type { CheckAdmissionInput, CheckRecord, CheckStore, SiteHealthRunner } from '../../src/runtime/types.ts'
import { LocalBypassHumanVerifier } from '../../src/security/turnstile.ts'
import { checkFingerprint } from '../../src/runtime/records.ts'
import { MemoryCheckStore } from '../../src/storage/memory.ts'
import {
  ValSqliteCheckStore,
  type ValSqliteClient,
  type ValSqliteResult,
  type ValSqliteStatement,
} from '../../src/storage/val-sqlite.ts'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const DAY = '2026-09-01'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function requireRecord(result: Awaited<ReturnType<CheckStore['admit']>>): CheckRecord {
  if (!('record' in result)) throw new Error(`expected an admitted check, got ${result.kind}`)
  return result.record
}

function candidate(id: string, domain = 'example.com', now = NOW): CheckRecord {
  return newCheckRecord({ id, fingerprint: checkFingerprint(domain), domain, now })
}

function admission(record: CheckRecord, now = NOW_ISO): CheckAdmissionInput {
  return {
    candidate: record,
    now,
    clientQuota: { scope: 'client', subject: 'client-a', day: DAY, max: 3 },
    globalQuota: { scope: 'global', subject: 'all', day: DAY, max: 100 },
  }
}

interface StoreFixture {
  store: CheckStore
  quotaCount(scope: string, subject: string, day: string): Promise<number>
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

  protected async runBatch(
    statements: ValSqliteStatement[],
    beforeStatement?: (statement: ValSqliteStatement, index: number) => Promise<void>,
  ): Promise<ValSqliteResult[]> {
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
      for (const [index, statement] of statements.entries()) {
        await beforeStatement?.(statement, index)
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

/** Holds one atomic write batch at the old admission-lease boundary. */
class DelayedBatchNodeSqliteClient extends NodeSqliteClient {
  readonly firstBatchAtCandidateInsert = gate()
  readonly releaseFirstBatch = gate()
  readonly secondBatchRequested = gate()
  private batchCount = 0

  override batch(statements: ValSqliteStatement[], mode: 'write'): Promise<ValSqliteResult[]> {
    this.batchModes.push(mode)
    const batchNumber = ++this.batchCount
    if (batchNumber === 2) this.secondBatchRequested.release()
    return this.runBatch(statements, async (_statement, index) => {
      if (batchNumber === 1 && index === 1) {
        this.firstBatchAtCandidateInsert.release()
        await this.releaseFirstBatch.promise
      }
    })
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

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const fixtures: Array<{ name: string; create(): StoreFixture }> = [
  {
    name: 'memory',
    create() {
      const store = new MemoryCheckStore()
      return {
        store,
        quotaCount(scope, subject, day) {
          return Promise.resolve(store.quota.get(`${scope}:${subject}:${day}`) ?? 0)
        },
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
        store: new ValSqliteCheckStore(sqlite),
        quotaCount(scope, subject, day) {
          const row = sqlite.database.prepare(
            'SELECT count FROM canonry_quota WHERE scope = ? AND subject = ? AND day = ?',
          ).get(scope, subject, day) as { count?: number } | undefined
          return Promise.resolve(row?.count ?? 0)
        },
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
  Deno.test(`${fixtureFactory.name} admission reclaims an expired running lease on resubmit`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const stale = {
        ...candidate(`stale-${fixtureFactory.name}`),
        status: 'running' as const,
        leaseOwner: 'crashed-isolate',
        leaseUntil: '2026-09-01T11:59:59.000Z',
      }
      await fixture.store.create(stale)

      const result = await fixture.store.admit(admission(candidate(`resubmit-${fixtureFactory.name}`)))
      equal(result.kind, 'reclaimed')
      equal(requireRecord(result).id, stale.id)
      const stored = await fixture.store.get(stale.id)
      equal(stored?.status, 'queued')
      equal(stored?.leaseOwner, null)
      equal(stored?.leaseUntil, null)
      equal(await fixture.quotaCount('client', 'client-a', DAY), 0)
      equal(await fixture.quotaCount('global', 'all', DAY), 0)
    } finally {
      fixture.close()
    }
  })

  Deno.test(`${fixtureFactory.name} admission coalesces concurrent same-domain requests before quota spend`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const results = await Promise.all(
        Array.from(
          { length: 12 },
          (_unused, index) => fixture.store.admit(admission(candidate(`same-domain-${fixtureFactory.name}-${index}`))),
        ),
      )
      const created = results.filter((result) => result.kind === 'created')
      const busy = results.filter((result) => result.kind === 'busy')
      equal(created.length, 1)
      equal(busy.length, 0)
      const id = requireRecord(created[0]!).id
      for (const result of results) equal(requireRecord(result).id, id)
      equal(await fixture.quotaCount('client', 'client-a', DAY), 1)
      equal(await fixture.quotaCount('global', 'all', DAY), 1)
    } finally {
      fixture.close()
    }
  })

  Deno.test(`${fixtureFactory.name} global lease renews for its holder and rejects another holder`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const originalExpiry = new Date(NOW.getTime() + 20_000)
      const renewalAt = new Date(NOW.getTime() + 10_000)
      const renewedExpiry = new Date(NOW.getTime() + 60_000)
      equal(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'first-isolate',
          NOW_ISO,
          originalExpiry.toISOString(),
        ),
        true,
      )
      equal(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'first-isolate',
          renewalAt.toISOString(),
          renewedExpiry.toISOString(),
        ),
        true,
      )
      equal(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'second-isolate',
          new Date(NOW.getTime() + 21_000).toISOString(),
          new Date(NOW.getTime() + 80_000).toISOString(),
        ),
        false,
      )
    } finally {
      fixture.close()
    }
  })

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

Deno.test('SQLite admission stays atomic when a same-domain retry arrives after the former lease window', async () => {
  const sqlite = new DelayedBatchNodeSqliteClient()
  const store = new ValSqliteCheckStore(sqlite)
  const domain = 'lease-race.example'
  const afterFormerLease = new Date(NOW.getTime() + 10_001)

  try {
    await store.initialize()
    const first = store.admit(admission(candidate('lease-race-first', domain, NOW), NOW_ISO))
    await sqlite.firstBatchAtCandidateInsert.promise

    let secondSettled = false
    const second = store.admit(admission(
      candidate('lease-race-second', domain, afterFormerLease),
      afterFormerLease.toISOString(),
    )).then((result) => {
      secondSettled = true
      return result
    })
    await sqlite.secondBatchRequested.promise
    await Promise.resolve()
    equal(secondSettled, false, 'the later admission must wait for the atomic write batch')

    sqlite.releaseFirstBatch.release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    equal(firstResult.kind, 'created')
    equal(secondResult.kind, 'reused')
    equal(requireRecord(firstResult).id, requireRecord(secondResult).id)
    equal(sqlite.batchModes.join(','), 'write,write')
    equal(await quotaCount(sqlite, 'client', 'client-a', DAY), 1)
    equal(await quotaCount(sqlite, 'global', 'all', DAY), 1)
    const rows = sqlite.database.prepare('SELECT id FROM canonry_checks WHERE fingerprint = ?').all(
      checkFingerprint(domain),
    )
    equal(rows.length, 1)
  } finally {
    sqlite.close()
  }
})

Deno.test('SQLite admission preserves quota caps without leaving a pending check', async () => {
  const clientLimited = new NodeSqliteClient()
  const globalLimited = new NodeSqliteClient()

  try {
    const clientStore = new ValSqliteCheckStore(clientLimited)
    await clientStore.initialize()
    equal(await clientStore.claimQuota('client', 'client-a', DAY, 1), true)
    const clientResult = await clientStore.admit({
      ...admission(candidate('client-capped', 'client-capped.example')),
      clientQuota: { scope: 'client', subject: 'client-a', day: DAY, max: 1 },
    })
    equal(clientResult.kind, 'quota-exhausted')
    if (clientResult.kind === 'quota-exhausted') equal(clientResult.scope, 'client')
    equal(await quotaCount(clientLimited, 'client', 'client-a', DAY), 1)
    equal(checkCount(clientLimited, checkFingerprint('client-capped.example')), 0)

    const globalStore = new ValSqliteCheckStore(globalLimited)
    await globalStore.initialize()
    equal(await globalStore.claimQuota('global', 'all', DAY, 1), true)
    const globalResult = await globalStore.admit({
      ...admission(candidate('global-capped', 'global-capped.example')),
      globalQuota: { scope: 'global', subject: 'all', day: DAY, max: 1 },
    })
    equal(globalResult.kind, 'quota-exhausted')
    if (globalResult.kind === 'quota-exhausted') equal(globalResult.scope, 'global')
    equal(await quotaCount(globalLimited, 'client', 'client-a', DAY), 0)
    equal(await quotaCount(globalLimited, 'global', 'all', DAY), 1)
    equal(checkCount(globalLimited, checkFingerprint('global-capped.example')), 0)
  } finally {
    clientLimited.close()
    globalLimited.close()
  }
})

function quotaCount(sqlite: NodeSqliteClient, scope: string, subject: string, day: string): Promise<number> {
  const row = sqlite.database.prepare(
    'SELECT count FROM canonry_quota WHERE scope = ? AND subject = ? AND day = ?',
  ).get(scope, subject, day) as { count?: number } | undefined
  return Promise.resolve(row?.count ?? 0)
}

function checkCount(sqlite: NodeSqliteClient, fingerprint: string): number {
  const row = sqlite.database.prepare('SELECT COUNT(*) AS count FROM canonry_checks WHERE fingerprint = ?').get(
    fingerprint,
  ) as {
    count?: number
  }
  return row.count ?? 0
}

function createPublicTestApp(store: CheckStore) {
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
