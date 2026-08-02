import { describe, it, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { createClient } from '../src/client.js'
import { migrate, MIGRATION_VERSIONS } from '../src/migrate.js'

// The measurement-plan migration rebuilds `runs` to add a foreign key, then
// verifies it did no damage. That verification used an unscoped
// `PRAGMA foreign_key_check`, which walks EVERY table: one pre-existing orphan
// anywhere in the database aborted the migration, and since the migration is
// re-attempted on every boot, the install could never start again.
//
// Such orphans are ordinary here. Migrations run with foreign keys disabled, and
// v98 exists specifically to relink FK-orphaned query_snapshots rows.

function requiredColumns(db: ReturnType<typeof createClient>, table: string): string[] {
  const cols = db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{
    name: string
    notnull: number
    dflt_value: unknown
  }>
  return cols.filter(column => column.notnull && column.dflt_value === null).map(column => column.name)
}

describe('measurement-plan foreign-key verification', () => {
  it('upgrades a database that already contains an unrelated orphan', () => {
    const file = '/tmp/canonry-fk-scope-orphan.db'
    rmSync(file, { force: true })
    const db = createClient(file)

    // Stop one version short of the rebuild.
    migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 117))

    // An orphaned snapshot: its run is long gone. Nothing to do with the
    // measurement-plan foreign key being added.
    db.run(sql.raw('PRAGMA foreign_keys=OFF'))
    const columns = requiredColumns(db, 'query_snapshots')
    const values = columns.map(name => (name === 'run_id' ? "'run-since-deleted'" : "'x'"))
    db.run(sql.raw(`INSERT INTO query_snapshots (${columns.join(', ')}) VALUES (${values.join(', ')})`))

    expect(() => migrate(db)).not.toThrow()

    const applied = db.all(sql`SELECT version FROM _migrations ORDER BY version`) as Array<{ version: number }>
    expect(applied.at(-1)!.version).toBeGreaterThanOrEqual(118)
  })

  it('still refuses when the rebuild itself orphans a run', () => {
    const file = '/tmp/canonry-fk-scope-runs.db'
    rmSync(file, { force: true })
    const db = createClient(file)
    migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 117))

    // A run pointing at a project that does not exist is damage in the very
    // table the rebuild touches, which is what the check is for.
    db.run(sql.raw('PRAGMA foreign_keys=OFF'))
    const columns = requiredColumns(db, 'runs')
    const values = columns.map(name => (name === 'project_id' ? "'project-missing'" : "'x'"))
    db.run(sql.raw(`INSERT INTO runs (${columns.join(', ')}) VALUES (${values.join(', ')})`))

    expect(() => migrate(db)).toThrow(/foreign-key violations/)
  })
})
