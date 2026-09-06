import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from '@mariozechner/pi-ai'
import type { EngineConnectionConfig } from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { configureSharedProviderExecutionGate, getSharedProviderExecutionGate } from './provider-execution-gate.js'
import { getCurrentUsageDay, releaseDailyQueryQuota, reserveDailyQueryQuota } from './usage-quota.js'

type TextRouteConnection = Pick<EngineConnectionConfig, 'id' | 'quota'>
type TextExecutionOptions = { db?: DatabaseClient; model?: Model<Api>; signal?: AbortSignal }
const dailyReservation = new AsyncLocalStorage<{ db: DatabaseClient; scope: string; period: string; consumed: boolean }>()
const standaloneDailyUsage = new Map<string, { period: string; count: number }>()
const configuredDailyLimits = new Map<string, number>()

/** Settings own live budgets; captured adapters must not restore an old policy. */
export function configureEngineRouteTextExecution(connection: TextRouteConnection): void {
  const scope = engineRouteConnectionScope(connection)
  configuredDailyLimits.set(scope, connection.quota.maxRequestsPerDay)
  configureSharedProviderExecutionGate(scope, connection.quota.maxConcurrency, connection.quota.maxRequestsPerMinute)
}

/** Research reserves its whole batch up front. Each dispatch may spend one token. */
export function withEngineRouteDailyReservation<T>(
  reservation: { db: DatabaseClient; scope: string; period: string },
  task: () => Promise<T>,
): Promise<T> {
  return dailyReservation.run({ ...reservation, consumed: false }, task)
}

function reserveTextRequest(connection: TextRouteConnection, db?: DatabaseClient): void {
  const scope = engineRouteConnectionScope(connection)
  const period = getCurrentUsageDay()
  const prepaid = dailyReservation.getStore()
  if (prepaid && !prepaid.consumed && prepaid.scope === scope && (!db || db === prepaid.db)) {
    prepaid.consumed = true
    if (prepaid.period === period) return
    // A queued dispatch crossing midnight belongs to the new day's budget.
    releaseDailyQueryQuota(prepaid.db, { ...prepaid, count: 1 })
  }
  const usageDb = db ?? (prepaid?.scope === scope ? prepaid.db : undefined)
  const limit = configuredDailyLimits.get(scope) ?? connection.quota.maxRequestsPerDay
  if (usageDb) {
    if (reserveDailyQueryQuota(usageDb, { scope, period, count: 1, limit }).reserved) return
  } else {
    // Standalone adapters have no persistence host; server consumers always pass db.
    const previous = standaloneDailyUsage.get(scope)
    const count = previous?.period === period ? previous.count : 0
    if (count < limit) {
      standaloneDailyUsage.set(scope, { period, count: count + 1 })
      return
    }
  }
  throw new Error(`Daily quota exceeded for ${connection.id}; limit is ${limit}.`)
}

/** The credential boundary, not the individual configured route, owns the budget. */
export function engineRouteConnectionScope(connection: TextRouteConnection): string {
  return `connection:${connection.id}`
}

export function getEngineRouteTextExecutionGate(connection: TextRouteConnection) {
  return getSharedProviderExecutionGate(
    engineRouteConnectionScope(connection),
    connection.quota.maxConcurrency,
    connection.quota.maxRequestsPerMinute,
  )
}

/**
 * One execution boundary for every generic OpenAI-compatible text call.
 * Native providers deliberately never pass through this route-only helper.
 */
export function runEngineRouteText<T>(
  connection: TextRouteConnection,
  task: () => Promise<T>,
  options: TextExecutionOptions = {},
): Promise<T> {
  return getEngineRouteTextExecutionGate(connection).run(async () => {
    reserveTextRequest(connection, options.db)
    return task()
  }, options.signal)
}

/**
 * `streamSimple` returns before its upstream stream completes, so `run()` by
 * itself would release the connection slot too early. Proxy every event and
 * hold the shared gate through the source stream's terminal result instead.
 */
export function streamEngineRouteText(
  connection: TextRouteConnection,
  source: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  options: TextExecutionOptions = {},
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream()
  void runEngineRouteText(connection, async () => {
    const input = await source()
    for await (const event of input) output.push(event)
    output.end(await input.result())
  }, options).catch((error: unknown) => {
    const stopReason = options.signal?.aborted ? 'aborted' : 'error'
    const message: AssistantMessage = {
      role: 'assistant', content: [],
      api: options.model?.api ?? 'openai-completions',
      provider: options.model?.provider ?? connection.id,
      model: options.model?.id ?? '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    }
    output.push({ type: 'error', reason: stopReason, error: message })
    output.end(message)
  })
  return output
}
