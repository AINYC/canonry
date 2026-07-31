import crypto from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs } from '@ainyc/canonry-db'
import { ensureCurrentQueryBasketRevision } from './query-basket.js'

export interface QueueRunParams {
  projectId: string
  kind?: string
  trigger?: string
  createdAt?: string
  location?: string | null
  /** Array of tracked query strings to scope the sweep to. Null = full sweep. */
  queries?: string[] | null
}

export type QueueRunResult =
  | { conflict: true; activeRunId: string }
  | { conflict: false; runId: string }

export function queueRunIfProjectIdle(db: DatabaseClient, params: QueueRunParams): QueueRunResult {
  const createdAt = params.createdAt ?? new Date().toISOString()
  const kind = params.kind ?? 'answer-visibility'
  const trigger = params.trigger ?? 'manual'
  const runId = crypto.randomUUID()

  return db.transaction((tx) => {
    const activeRun = tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, params.projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .get()

    if (activeRun) {
      return { conflict: true, activeRunId: activeRun.id } as const
    }

    // Stamp the query set this run is about to measure, so analytics can compare
    // like-for-like later without inferring membership from row timestamps.
    //
    // Only a FULL sweep is stamped. A scoped run (`queries` non-null) deliberately
    // measures a subset, and labelling it with the full basket would let a
    // 3-query spot check land in a bucket as though all 16 had been measured —
    // the same denominator error the basket exists to prevent, arriving by a
    // different route. Scoped runs keep a null revision and analytics treats them
    // as unversioned.
    const basket = params.queries == null
      ? ensureCurrentQueryBasketRevision(tx as unknown as DatabaseClient, params.projectId, createdAt)
      : null

    tx.insert(runs).values({
      id: runId,
      projectId: params.projectId,
      kind,
      status: 'queued',
      trigger,
      location: params.location ?? null,
      queries: params.queries ?? null,
      queryBasketRevision: basket?.revision ?? null,
      createdAt,
    }).run()

    return { conflict: false, runId } as const
  })
}
