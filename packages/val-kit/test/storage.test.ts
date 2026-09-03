/**
 * Store-level parity between the two `CheckStore` implementations.
 *
 * Both stores are the kit's, and admission is the one place a public check can
 * spend money, so every rule here is asserted against BOTH: a fix applied to
 * one store and not the other is the failure this file exists to catch (the
 * SQLite fresh-insert path once claimed a slot a zero cap forbids while memory
 * rejected it).
 *
 * `node:sqlite` stands in for Val Town's SQLite over the same `ValSqliteClient`
 * interface the val implements — the store takes the interface, never a
 * binding, so the kit needs no host-specific driver.
 *
 * The app- and runner-level admission tests stay with the val: they drive the
 * phase orchestration, which is that val's product surface, not the kit's.
 */
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { newCheckRecord, PUBLIC_CHECK_EXECUTION_LEASE_NAME } from '../src/jobs/admission.js'
import { checkFingerprint } from '../src/runtime/records.js'
import type { CheckAdmissionInput, CheckRecord, CheckStore } from '../src/runtime/types.js'
import { MemoryCheckStore } from '../src/storage/memory.js'
import {
  ValSqliteCheckStore,
  type ValSqliteClient,
  type ValSqliteResult,
  type ValSqliteStatement,
} from '../src/storage/val-sqlite.js'

/**
 * A product namespace, because the store has none. These cases are about
 * admission, quota, and leases — the machinery every product shares — so the
 * value only has to be stable, not to name a real val.
 */
const NAMESPACE = 'store-parity-v1'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const DAY = '2026-09-01'

function requireRecord(result: Awaited<ReturnType<CheckStore['admit']>>): CheckRecord {
  if (!('record' in result)) throw new Error(`expected an admitted check, got ${result.kind}`)
  return result.record
}

function candidate(id: string, domain = 'example.com', now = NOW): CheckRecord {
  return newCheckRecord({ id, fingerprint: checkFingerprint(NAMESPACE, domain), domain, now })
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
          return Promise.resolve(quotaCountOf(sqlite, scope, subject, day))
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
  test(`${fixtureFactory.name} admission reclaims an expired running lease on resubmit`, async () => {
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
      expect(result.kind).toBe('reclaimed')
      expect(requireRecord(result).id).toBe(stale.id)
      const stored = await fixture.store.get(stale.id)
      expect(stored?.status).toBe('queued')
      expect(stored?.leaseOwner).toBe(null)
      expect(stored?.leaseUntil).toBe(null)
      expect(await fixture.quotaCount('client', 'client-a', DAY)).toBe(0)
      expect(await fixture.quotaCount('global', 'all', DAY)).toBe(0)
    } finally {
      fixture.close()
    }
  })

  test(`${fixtureFactory.name} admission rejects a zero client quota without persisting a check`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      // A cap of 0 must admit nothing on either store. The SQLite fresh-insert
      // path once claimed a slot a zero cap forbids, persisting a check while
      // memory rejected it — a store-parity gap.
      const result = await fixture.store.admit({
        ...admission(candidate(`zero-${fixtureFactory.name}`)),
        clientQuota: { scope: 'client', subject: 'client-a', day: DAY, max: 0 },
      })
      expect(result.kind).toBe('quota-exhausted')
      expect(await fixture.checkRowCount()).toBe(0)
      expect(await fixture.quotaRowCount()).toBe(0)
    } finally {
      fixture.close()
    }
  })

  test(`${fixtureFactory.name} admission coalesces concurrent same-domain requests before quota spend`, async () => {
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
      expect(created.length).toBe(1)
      expect(busy.length).toBe(0)
      const id = requireRecord(created[0]!).id
      for (const result of results) expect(requireRecord(result).id).toBe(id)
      expect(await fixture.quotaCount('client', 'client-a', DAY)).toBe(1)
      expect(await fixture.quotaCount('global', 'all', DAY)).toBe(1)
    } finally {
      fixture.close()
    }
  })

  test(`${fixtureFactory.name} global lease renews for its holder and rejects another holder`, async () => {
    const fixture = fixtureFactory.create()
    try {
      await fixture.store.initialize()
      const originalExpiry = new Date(NOW.getTime() + 20_000)
      const renewalAt = new Date(NOW.getTime() + 10_000)
      const renewedExpiry = new Date(NOW.getTime() + 60_000)
      expect(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'first-isolate',
          NOW_ISO,
          originalExpiry.toISOString(),
        ),
      ).toBe(true)
      expect(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'first-isolate',
          renewalAt.toISOString(),
          renewedExpiry.toISOString(),
        ),
      ).toBe(true)
      expect(
        await fixture.store.claimGlobalLease(
          PUBLIC_CHECK_EXECUTION_LEASE_NAME,
          'second-isolate',
          new Date(NOW.getTime() + 21_000).toISOString(),
          new Date(NOW.getTime() + 80_000).toISOString(),
        ),
      ).toBe(false)
    } finally {
      fixture.close()
    }
  })
}

test('SQLite admission stays atomic when a same-domain retry arrives after the former lease window', async () => {
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
    expect(secondSettled, 'the later admission must wait for the atomic write batch').toBe(false)

    sqlite.releaseFirstBatch.release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.kind).toBe('created')
    expect(secondResult.kind).toBe('reused')
    expect(requireRecord(firstResult).id).toBe(requireRecord(secondResult).id)
    expect(sqlite.batchModes.join(',')).toBe('write,write')
    expect(quotaCountOf(sqlite, 'client', 'client-a', DAY)).toBe(1)
    expect(quotaCountOf(sqlite, 'global', 'all', DAY)).toBe(1)
    const rows = sqlite.database.prepare('SELECT id FROM canonry_checks WHERE fingerprint = ?').all(
      checkFingerprint(NAMESPACE, domain),
    )
    expect(rows.length).toBe(1)
  } finally {
    sqlite.close()
  }
})

test('SQLite admission preserves quota caps without leaving a pending check', async () => {
  const clientLimited = new NodeSqliteClient()
  const globalLimited = new NodeSqliteClient()

  try {
    const clientStore = new ValSqliteCheckStore(clientLimited)
    await clientStore.initialize()
    expect(await clientStore.claimQuota('client', 'client-a', DAY, 1)).toBe(true)
    const clientResult = await clientStore.admit({
      ...admission(candidate('client-capped', 'client-capped.example')),
      clientQuota: { scope: 'client', subject: 'client-a', day: DAY, max: 1 },
    })
    expect(clientResult.kind).toBe('quota-exhausted')
    if (clientResult.kind === 'quota-exhausted') expect(clientResult.scope).toBe('client')
    expect(quotaCountOf(clientLimited, 'client', 'client-a', DAY)).toBe(1)
    expect(checkCount(clientLimited, checkFingerprint(NAMESPACE, 'client-capped.example'))).toBe(0)

    const globalStore = new ValSqliteCheckStore(globalLimited)
    await globalStore.initialize()
    expect(await globalStore.claimQuota('global', 'all', DAY, 1)).toBe(true)
    const globalResult = await globalStore.admit({
      ...admission(candidate('global-capped', 'global-capped.example')),
      globalQuota: { scope: 'global', subject: 'all', day: DAY, max: 1 },
    })
    expect(globalResult.kind).toBe('quota-exhausted')
    if (globalResult.kind === 'quota-exhausted') expect(globalResult.scope).toBe('global')
    expect(quotaCountOf(globalLimited, 'client', 'client-a', DAY)).toBe(0)
    expect(quotaCountOf(globalLimited, 'global', 'all', DAY)).toBe(1)
    expect(checkCount(globalLimited, checkFingerprint(NAMESPACE, 'global-capped.example'))).toBe(0)
  } finally {
    clientLimited.close()
    globalLimited.close()
  }
})

function quotaCountOf(sqlite: NodeSqliteClient, scope: string, subject: string, day: string): number {
  const row = sqlite.database.prepare(
    'SELECT count FROM canonry_quota WHERE scope = ? AND subject = ? AND day = ?',
  ).get(scope, subject, day) as { count?: number } | undefined
  return row?.count ?? 0
}

function checkCount(sqlite: NodeSqliteClient, fingerprint: string): number {
  const row = sqlite.database.prepare('SELECT COUNT(*) AS count FROM canonry_checks WHERE fingerprint = ?').get(
    fingerprint,
  ) as {
    count?: number
  }
  return row.count ?? 0
}
