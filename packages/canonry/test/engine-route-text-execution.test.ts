import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createClient, migrate, usageCounters } from '@ainyc/canonry-db'
import { normalizeEngineConnection } from '@ainyc/canonry-contracts'
import { configureEngineRouteTextExecution, getEngineRouteTextExecutionGate, runEngineRouteText, streamEngineRouteText, withEngineRouteDailyReservation } from '../src/engine-route-text-execution.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { getCurrentUsageDay, reserveDailyQueryQuota } from '../src/usage-quota.js'

function setup(limit = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-text-daily-'))
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  const dbPath = path.join(directory, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const connection = normalizeEngineConnection({
    id: `daily-${path.basename(directory)}`, label: 'Test gateway', preset: 'litellm',
    quota: { maxConcurrency: 2, maxRequestsPerMinute: 100, maxRequestsPerDay: limit },
  })
  return { db, dbPath, connection, scope: `connection:${connection.id}` }
}

test('daily text capacity is shared atomically and survives fresh workers', async () => {
  const { db, dbPath, connection } = setup()
  const task = vi.fn(async () => 'done')
  const outcomes = await Promise.allSettled([
    runEngineRouteText(connection, task, { db }),
    runEngineRouteText(connection, task, { db }),
  ])
  expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(task).toHaveBeenCalledTimes(1)
  resetSharedProviderExecutionGates()
  const reopened = createClient(dbPath)
  await expect(runEngineRouteText(connection, task, { db: reopened })).rejects.toThrow('Daily quota exceeded')
  expect(reopened.select().from(usageCounters).get()?.count).toBe(1)
})

test('a research reservation pays for exactly one adapter dispatch, never twice', async () => {
  const { db, connection, scope } = setup()
  const period = getCurrentUsageDay()
  expect(reserveDailyQueryQuota(db, { scope, period, count: 1, limit: 1 }).reserved).toBe(true)
  await withEngineRouteDailyReservation({ db, scope, period }, async () => {
    await expect(runEngineRouteText(connection, async () => 'prepaid', { db })).resolves.toBe('prepaid')
    await expect(runEngineRouteText(connection, async () => 'extra', { db })).rejects.toThrow('Daily quota exceeded')
  })
  expect(db.select().from(usageCounters).get()?.count).toBe(1)
})

test('captured adapters use the current daily cap after settings are lowered or raised', async () => {
  const { db, connection } = setup(2)
  configureEngineRouteTextExecution(connection)
  await runEngineRouteText(connection, async () => 'first', { db })
  configureEngineRouteTextExecution({ ...connection, quota: { ...connection.quota, maxRequestsPerDay: 1 } })
  await expect(runEngineRouteText(connection, async () => 'stale cap', { db })).rejects.toThrow('Daily quota exceeded')
  configureEngineRouteTextExecution({ ...connection, quota: { ...connection.quota, maxRequestsPerDay: 3 } })
  await expect(runEngineRouteText(connection, async () => 'second', { db })).resolves.toBe('second')
  await expect(runEngineRouteText(connection, async () => 'third', { db })).resolves.toBe('third')
  await expect(runEngineRouteText(connection, async () => 'fourth', { db })).rejects.toThrow('Daily quota exceeded')
})

test('quota rejection returns a terminal stream error without dispatching upstream', async () => {
  const { db, connection } = setup()
  await runEngineRouteText(connection, async () => 'done', { db })
  const source = vi.fn(() => { throw new Error('must not dispatch') })
  const stream = streamEngineRouteText(connection, source, { db })
  const events = []
  for await (const event of stream) events.push(event)
  expect(events).toMatchObject([{ type: 'error', error: { stopReason: 'error', errorMessage: expect.stringContaining('Daily quota exceeded') } }])
  await expect(stream.result()).resolves.toMatchObject({ stopReason: 'error' })
  expect(source).not.toHaveBeenCalled()
})

test('a dispatch crossing midnight transfers its prepaid request to the current day', async () => {
  const { db, connection, scope } = setup()
  const oldPeriod = '2000-01-01'
  reserveDailyQueryQuota(db, { scope, period: oldPeriod, count: 1, limit: 1 })
  await withEngineRouteDailyReservation({ db, scope, period: oldPeriod }, () => runEngineRouteText(connection, async () => 'done', { db }))
  expect(db.select().from(usageCounters).all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ period: oldPeriod, count: 0 }),
    expect.objectContaining({ period: getCurrentUsageDay(), count: 1 }),
  ]))
})

test('a dispatched provider failure still consumes capacity but releases its gate', async () => {
  const { db, connection } = setup(2)
  await expect(runEngineRouteText(connection, async () => { throw new Error('upstream failure') }, { db })).rejects.toThrow('upstream failure')
  await expect(runEngineRouteText(connection, async () => 'next', { db })).resolves.toBe('next')
  await expect(runEngineRouteText(connection, async () => 'extra', { db })).rejects.toThrow('Daily quota exceeded')
})

test('canceling a queued stream terminates immediately without spending daily quota', async () => {
  const { db, connection } = setup()
  connection.quota.maxConcurrency = 1
  let release!: () => void
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const blocker = getEngineRouteTextExecutionGate(connection).run(async () => {
    started()
    await new Promise<void>(resolve => { release = resolve })
  })
  await active
  const controller = new AbortController()
  const source = vi.fn(() => { throw new Error('must not dispatch') })
  const stream = streamEngineRouteText(connection, source, { db, signal: controller.signal })
  controller.abort()
  await expect(stream.result()).resolves.toMatchObject({ stopReason: 'aborted' })
  expect(db.select().from(usageCounters).all()).toEqual([])
  expect(source).not.toHaveBeenCalled()
  release()
  await blocker
  await expect(runEngineRouteText(connection, async () => 'still available', { db })).resolves.toBe('still available')
})
