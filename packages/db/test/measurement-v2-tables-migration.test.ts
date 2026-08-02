import { expect, onTestFinished, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  createClient,
  measurementDiscoveryConfigs,
  measurementOperationReceipts,
  measurementPlanDrafts,
  measurementPlanVersions,
  measurementQuerySetItems,
  measurementQuerySets,
  measurementQueryTemplates,
  migrate,
  MIGRATION_VERSIONS,
} from '../src/index.js'
import type { DatabaseClient } from '../src/index.js'

const NOW = '2026-08-01T00:00:00.000Z'
/** The last version before the Advanced Measurement v2 work. */
const BASELINE = 121

function freshDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

function seedProject(db: DatabaseClient, id = 'prj_1', name = 'northstar') {
  db.run(sql`
    INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (${id}, ${name}, 'Northstar', 'northstar.example', 'US', 'en', ${NOW}, ${NOW})
  `)
}

/** A v1 revision as it was written before this migration existed: no v2 columns at all. */
function seedLegacyPlanVersion(db: DatabaseClient, id = 'mpv_1', revision = 1) {
  db.run(sql`
    INSERT INTO measurement_plan_versions (id, project_id, revision, canonical_json, checksum, created_at)
    VALUES (${id}, 'prj_1', ${revision}, '{"schemaVersion":1}', ${'a'.repeat(64)}, ${NOW})
  `)
}

interface ColumnInfo { name: string; notnull: number; pk: number }

function columnInfo(db: DatabaseClient, table: string): ColumnInfo[] {
  return db.all(sql.raw(`PRAGMA table_info('${table}')`)) as ColumnInfo[]
}

function indexList(db: DatabaseClient, table: string): Array<{ name: string; unique: number }> {
  return db.all(sql.raw(`PRAGMA index_list('${table}')`)) as Array<{ name: string; unique: number }>
}

const NEW_TABLES: SQLiteTable[] = [
  measurementPlanDrafts,
  measurementQuerySets,
  measurementQuerySetItems,
  measurementQueryTemplates,
  measurementDiscoveryConfigs,
  measurementOperationReceipts,
]

test('every v122+ migration applies on a database at v121 and is a no-op on re-run', () => {
  const db = freshDb('canonry-measurement-v2-upgrade-')
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= BASELINE))
  seedProject(db)
  seedLegacyPlanVersion(db)

  migrate(db)
  // A second boot must not re-run anything or fail on an already-created table.
  migrate(db)

  const applied = db.all(sql.raw('SELECT version FROM _migrations ORDER BY version')) as Array<{ version: number }>
  expect(applied.map(row => row.version)).toEqual(MIGRATION_VERSIONS.map(version => version.version))
  for (const table of NEW_TABLES) {
    expect(columnInfo(db, getTableName(table)).length, `${getTableName(table)} was not created`).toBeGreaterThan(0)
  }
})

test('the upgrade backfills schema_version = 1 on every historic revision', () => {
  const db = freshDb('canonry-measurement-v2-backfill-')
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= BASELINE))
  seedProject(db)
  seedLegacyPlanVersion(db)

  migrate(db)

  const row = db.select().from(measurementPlanVersions).get()
  expect(row).toMatchObject({
    schemaVersion: 1,
    compiledChecksum: null,
    publishedBy: null,
    sourceDraftId: null,
  })
})

test('compiled_checksum is a separate nullable column and never overwrites checksum', () => {
  const db = freshDb('canonry-measurement-v2-checksums-')
  migrate(db)
  seedProject(db)

  // Historic v1: document checksum only. Backfilling a compiled checksum here
  // would invent a value that was never computed for it.
  db.insert(measurementPlanVersions).values({
    id: 'mpv_1',
    projectId: 'prj_1',
    revision: 1,
    canonicalJson: '{"schemaVersion":1}',
    checksum: 'a'.repeat(64),
    schemaVersion: 1,
    compiledChecksum: null,
    createdAt: NOW,
  }).run()
  // v2: both, and they are different values over different content.
  db.insert(measurementPlanVersions).values({
    id: 'mpv_2',
    projectId: 'prj_1',
    revision: 2,
    canonicalJson: '{"schemaVersion":2}',
    checksum: 'b'.repeat(64),
    schemaVersion: 2,
    compiledChecksum: 'c'.repeat(64),
    publishedBy: 'usr_1',
    sourceDraftId: 'mpd_1',
    createdAt: NOW,
  }).run()

  const rows = db.select().from(measurementPlanVersions).orderBy(measurementPlanVersions.revision).all()
  expect(rows.map(row => [row.schemaVersion, row.checksum, row.compiledChecksum])).toEqual([
    [1, 'a'.repeat(64), null],
    [2, 'b'.repeat(64), 'c'.repeat(64)],
  ])
})

test('a revert republishes older content: the compiled-checksum index is not unique', () => {
  const db = freshDb('canonry-measurement-v2-revert-')
  migrate(db)
  seedProject(db)

  const compiledChecksum = 'd'.repeat(64)
  for (const revision of [1, 2, 3]) {
    db.insert(measurementPlanVersions).values({
      id: `mpv_${revision}`,
      projectId: 'prj_1',
      revision,
      canonicalJson: '{"schemaVersion":2}',
      checksum: String(revision).repeat(64),
      schemaVersion: 2,
      // Revision 3 restores revision 1's content, which must be publishable.
      compiledChecksum: revision === 2 ? 'e'.repeat(64) : compiledChecksum,
      createdAt: NOW,
    }).run()
  }

  expect(db.select().from(measurementPlanVersions).all()).toHaveLength(3)
  const index = indexList(db, 'measurement_plan_versions')
    .find(entry => entry.name === 'idx_measurement_plan_versions_compiled_checksum')
  expect(index).toBeDefined()
  expect(index!.unique).toBe(0)
})

test('drizzle and the migration DDL agree on every new table, column and nullability', () => {
  const db = freshDb('canonry-measurement-v2-parity-')
  migrate(db)

  const mismatches: string[] = []
  for (const table of [...NEW_TABLES, measurementPlanVersions]) {
    const tableName = getTableName(table)
    const declared = columnInfo(db, tableName)
    const byName = new Map(declared.map(column => [column.name, column]))

    for (const column of Object.values(getTableColumns(table))) {
      const actual = byName.get(column.name)
      if (!actual) {
        mismatches.push(`${tableName}.${column.name} is declared in drizzle but missing from the DDL`)
        continue
      }
      // SQLite reports a TEXT PRIMARY KEY as nullable, but it is not.
      const ddlNotNull = actual.notnull === 1 || actual.pk > 0
      if (ddlNotNull !== column.notNull) {
        mismatches.push(
          `${tableName}.${column.name} nullability differs: drizzle notNull=${column.notNull}, DDL notNull=${ddlNotNull}`,
        )
      }
      byName.delete(column.name)
    }
    for (const name of byName.keys()) {
      mismatches.push(`${tableName}.${name} exists in the DDL but is not declared in drizzle`)
    }
  }

  expect(mismatches, mismatches.join('\n')).toEqual([])
})

test('a project gets at most one server-side draft', () => {
  const db = freshDb('canonry-measurement-v2-draft-')
  migrate(db)
  seedProject(db)

  const draft = {
    projectId: 'prj_1',
    schemaVersion: 2,
    baseActiveVersionId: null,
    baseActiveRevision: null,
    authoringJson: '{}',
    etagVersion: 1,
    createdBy: 'usr_1',
    updatedBy: 'usr_1',
    createdAt: NOW,
    updatedAt: NOW,
  }
  db.insert(measurementPlanDrafts).values({ id: 'mpd_1', ...draft }).run()
  expect(() => db.insert(measurementPlanDrafts).values({ id: 'mpd_2', ...draft }).run()).toThrow(/UNIQUE/i)

  db.run(sql`DELETE FROM projects WHERE id = 'prj_1'`)
  expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(0)
})

test('operation receipts are keyed by project, operation and idempotency key, and are swept by expiry', () => {
  const db = freshDb('canonry-measurement-v2-receipts-')
  migrate(db)
  seedProject(db)

  const receipt = {
    projectId: 'prj_1',
    operation: 'measurement-draft.publish',
    idempotencyKey: 'key-1',
    requestChecksum: 'a'.repeat(64),
    responseJson: '{"published":true}',
    statusCode: 201,
    createdAt: NOW,
    expiresAt: '2026-08-02T00:00:00.000Z',
  }
  db.insert(measurementOperationReceipts).values(receipt).run()
  expect(() => db.insert(measurementOperationReceipts).values(receipt).run()).toThrow(/UNIQUE|PRIMARY/i)

  // Nothing deletes these rows on write, so the sweep needs the expiry index.
  expect(indexList(db, 'measurement_operation_receipts').map(entry => entry.name))
    .toContain('idx_measurement_operation_receipts_expires')
})

test('deleting a query set leaves its project queries alone', () => {
  const db = freshDb('canonry-measurement-v2-query-sets-')
  migrate(db)
  seedProject(db)
  db.run(sql`INSERT INTO queries (id, project_id, query, created_at) VALUES ('q_1', 'prj_1', 'best apartments', ${NOW})`)

  db.insert(measurementQuerySets).values({
    id: 'qs_1',
    projectId: 'prj_1',
    name: 'Non-brand',
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(measurementQuerySetItems).values({
    id: 'qsi_1',
    querySetId: 'qs_1',
    queryId: 'q_1',
    position: 0,
    createdAt: NOW,
  }).run()

  db.delete(measurementQuerySets).where(sql`id = 'qs_1'`).run()

  expect(db.select().from(measurementQuerySetItems).all()).toHaveLength(0)
  const queries = db.all(sql.raw("SELECT id FROM queries")) as Array<{ id: string }>
  expect(queries.map(row => row.id)).toEqual(['q_1'])
})
