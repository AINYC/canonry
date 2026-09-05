import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  configureSharedProviderExecutionGate,
  getSharedProviderExecutionGate,
  resetSharedProviderExecutionGates,
} from '../src/provider-execution-gate.js'

beforeEach(() => {
  resetSharedProviderExecutionGates()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('tightening concurrency preserves active slots and waits for the new cap', async () => {
  const key = 'connection:quota-edit'
  const gate = configureSharedProviderExecutionGate(key, 2, 100)
  let active = 0
  let started = 0
  let notifyTwoStarted!: () => void
  const twoStarted = new Promise<void>(resolve => { notifyTwoStarted = resolve })
  const releases: Array<() => void> = []
  const blockingTask = () => gate.run(async () => {
    active++
    started++
    if (started === 2) notifyTwoStarted()
    await new Promise<void>(resolve => releases.push(resolve))
    active--
  })

  const first = blockingTask()
  const second = blockingTask()
  await twoStarted
  let thirdStarted = false
  const third = gate.run(async () => { thirdStarted = true })

  const updated = configureSharedProviderExecutionGate(key, 1, 100)
  expect(updated).toBe(gate)
  releases.shift()!()
  await Promise.resolve()
  expect(active).toBe(1)
  expect(thirdStarted).toBe(false)

  releases.shift()!()
  await Promise.all([first, second, third])
  expect(thirdStarted).toBe(true)
})

test('raising concurrency wakes work already queued on the shared gate', async () => {
  const key = 'connection:quota-raise'
  const gate = configureSharedProviderExecutionGate(key, 1, 100)
  let releaseFirst!: () => void
  let notifyFirstStarted!: () => void
  const firstStarted = new Promise<void>(resolve => { notifyFirstStarted = resolve })
  const first = gate.run(async () => {
    notifyFirstStarted()
    await new Promise<void>(resolve => { releaseFirst = resolve })
  })
  await firstStarted

  let notifySecondStarted!: () => void
  const secondStarted = new Promise<void>(resolve => { notifySecondStarted = resolve })
  const second = gate.run(async () => { notifySecondStarted() })
  configureSharedProviderExecutionGate(key, 2, 100)
  await secondStarted

  releaseFirst()
  await Promise.all([first, second])
})

test('tightening requests per minute retains the existing rolling window', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-04T12:00:00.000Z'))
  const key = 'connection:quota-rpm'
  const gate = configureSharedProviderExecutionGate(key, 2, 2)
  await gate.run(async () => undefined)
  await gate.run(async () => undefined)

  configureSharedProviderExecutionGate(key, 2, 1)
  let dispatched = false
  const next = getSharedProviderExecutionGate(key, 99, 99).run(async () => { dispatched = true })
  await Promise.resolve()
  expect(dispatched).toBe(false)

  await vi.advanceTimersByTimeAsync(60_051)
  await next
  expect(dispatched).toBe(true)
})

test('case-sensitive connection IDs have independent budgets; native provider aliases do not', () => {
  const upper = configureSharedProviderExecutionGate('connection:Gateway', 1, 1)
  const lower = configureSharedProviderExecutionGate('connection:gateway', 10, 100)
  expect(upper).not.toBe(lower)
  expect(getSharedProviderExecutionGate('connection:Gateway', 99, 99)).toBe(upper)
  expect(getSharedProviderExecutionGate(' OpenAI ', 1, 1)).toBe(getSharedProviderExecutionGate('openai', 1, 1))
})

test('canceling a concurrency waiter removes it without releasing another task\'s slot', async () => {
  const gate = configureSharedProviderExecutionGate('connection:abort-concurrency', 1, 100)
  let release!: () => void
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const first = gate.run(async () => {
    started()
    await new Promise<void>(resolve => { release = resolve })
  })
  await active
  const controller = new AbortController()
  const canceledTask = vi.fn(async () => undefined)
  const canceled = gate.run(canceledTask, controller.signal)
  controller.abort(new Error('canceled'))
  await expect(canceled).rejects.toThrow('canceled')
  const nextTask = vi.fn(async () => undefined)
  const next = gate.run(nextTask)
  await Promise.resolve()
  expect(nextTask).not.toHaveBeenCalled()
  release()
  await Promise.all([first, next])
  expect(canceledTask).not.toHaveBeenCalled()
  expect(nextTask).toHaveBeenCalledOnce()
})

test('canceling rate waiters is prompt and neither consumes a request nor bypasses the queue', async () => {
  vi.useFakeTimers()
  const gate = configureSharedProviderExecutionGate('connection:abort-rate', 3, 1)
  await gate.run(async () => undefined)
  const firstController = new AbortController()
  const queuedController = new AbortController()
  const canceledTask = vi.fn(async () => undefined)
  const first = gate.run(canceledTask, firstController.signal)
  const queued = gate.run(canceledTask, queuedController.signal)
  await vi.advanceTimersByTimeAsync(0)
  // The second waiter sits behind the first rate-limit sleep, not on a timer.
  queuedController.abort(new Error('queued canceled'))
  await expect(queued).rejects.toThrow('queued canceled')
  firstController.abort(new Error('sleep canceled'))
  await expect(first).rejects.toThrow('sleep canceled')
  const nextTask = vi.fn(async () => undefined)
  const next = gate.run(nextTask)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(nextTask).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(51)
  await next
  expect(nextTask).toHaveBeenCalledOnce()
  expect(canceledTask).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('canceling an already dispatched request holds its slot until upstream settles', async () => {
  const gate = configureSharedProviderExecutionGate('connection:abort-active', 1, 100)
  const controller = new AbortController()
  let release!: () => void
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const first = gate.run(async () => {
    started()
    await new Promise<void>(resolve => { release = resolve })
  }, controller.signal)
  await active
  controller.abort()
  const nextTask = vi.fn(async () => undefined)
  const next = gate.run(nextTask)
  await Promise.resolve()
  expect(nextTask).not.toHaveBeenCalled()
  release()
  await Promise.all([first, next])
  expect(nextTask).toHaveBeenCalledOnce()
})
