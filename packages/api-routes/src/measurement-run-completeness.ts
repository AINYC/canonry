/**
 * Did a run actually produce the measurements it promised?
 *
 * A run pinned to a plan carries a manifest of expected provider slots. Rows
 * missing from that manifest are not a smaller measurement, they are an
 * unfinished one: a rate taken over what did land would be a rate over a
 * partial denominator, and an insight derived from it states a conclusion
 * about questions nobody answered.
 *
 * A run with no manifest is reported complete. Planless runs measure the live
 * query set and have no promise to fall short of, so nothing about their
 * existing behaviour changes.
 */

import { eq } from 'drizzle-orm'
import { parseMeasurementRunManifestV1 } from '@ainyc/canonry-contracts'
import { querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'

export interface MeasurementRunCompleteness {
  /** Whether this run measured a published plan at all. */
  planned: boolean
  executed: number
  expected: number
  complete: boolean
}

export function measurementRunCompleteness(db: DatabaseClient, runId: string): MeasurementRunCompleteness {
  const run = db.select({ manifest: runs.measurementManifest }).from(runs).where(eq(runs.id, runId)).get()
  if (!run?.manifest) return { planned: false, executed: 0, expected: 0, complete: true }

  let expected: number
  try {
    expected = parseMeasurementRunManifestV1(run.manifest).expectedSlots.length
  } catch {
    // An unreadable manifest is not a licence to treat the run as whole.
    return { planned: true, executed: 0, expected: 0, complete: false }
  }

  const executed = db.select({ id: querySnapshots.id }).from(querySnapshots)
    .where(eq(querySnapshots.runId, runId)).all().length

  return { planned: true, executed, expected, complete: executed >= expected }
}
