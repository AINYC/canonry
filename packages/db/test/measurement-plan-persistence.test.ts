import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { expect, onTestFinished, test } from 'vitest'
import { MIGRATION_VERSIONS, createClient, migrate } from '../src/index.js'
import * as schema from '../src/schema.js'

const TARGET_MODEL_MIGRATION_VERSION = 117
const NOW = '2026-07-30T00:00:00.000Z'

function createTempDb(prefix: string, through = Number.POSITIVE_INFINITY) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= through))
  return db
}

function seedProject(db: ReturnType<typeof createTempDb>, id: string) {
  db.$client.prepare(`
    INSERT INTO projects
      (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (?, ?, 'Example', 'example.com', 'US', 'en', ?, ?)
  `).run(id, id, NOW, NOW)
}

function seedLegacyHistory(db: ReturnType<typeof createTempDb>, projectId = 'project-a') {
  seedProject(db, projectId)
  db.$client.prepare(`
    INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
    VALUES ('legacy-run', ?, 'answer-visibility', 'completed', 'manual', ?)
  `).run(projectId, NOW)
  db.$client.prepare(`
    INSERT INTO query_snapshots
      (id, run_id, query_text, provider, citation_state, answer_text, created_at)
    VALUES ('legacy-snapshot', 'legacy-run', 'best apartments', 'openai', 'cited', 'Stored answer', ?)
  `).run(NOW)
}

function seedPlanVersion(db: ReturnType<typeof createTempDb>, projectId: string, id = 'version-1') {
  db.$client.prepare(`
    INSERT INTO measurement_plan_versions
      (id, project_id, revision, canonical_json, checksum, created_at)
    VALUES (?, ?, 1, '{"schemaVersion":1}', 'checksum-v1', ?)
  `).run(id, projectId, NOW)
}

function columns(db: ReturnType<typeof createTempDb>, table: string) {
  return db.$client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
}

function foreignKeys(db: ReturnType<typeof createTempDb>, table: string) {
  return db.$client.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    from: string
    table: string
    to: string
    on_delete: string
  }>
}

test.each([110, 114, 115])('populated v%i upgrades through the Target model without rewriting history', legacyVersion => {
  const db = createTempDb(`canonry-target-model-v${legacyVersion}-`, legacyVersion)
  seedLegacyHistory(db)
  if (legacyVersion >= 115) {
    db.$client.prepare(`UPDATE runs SET query_basket_revision = 7 WHERE id = 'legacy-run'`).run()
  }

  migrate(db)

  expect(MIGRATION_VERSIONS.some(migration => migration.version === TARGET_MODEL_MIGRATION_VERSION)).toBe(true)
  expect(columns(db, 'measurement_segments').map(column => column.name)).toEqual([
    'id', 'project_id', 'stable_key', 'kind', 'retired_at', 'created_at',
  ])
  expect(columns(db, 'runs').map(column => column.name)).toEqual(expect.arrayContaining([
    'measurement_plan_version_id', 'measurement_manifest',
  ]))
  expect(columns(db, 'query_snapshots').map(column => column.name)).toEqual(expect.arrayContaining([
    'measurement_execution_id', 'requested_context', 'supported_context',
  ]))
  expect(db.$client.prepare(`
    SELECT query_basket_revision, measurement_plan_version_id, measurement_manifest
    FROM runs WHERE id = 'legacy-run'
  `).get()).toEqual({
    query_basket_revision: legacyVersion >= 115 ? 7 : null,
    measurement_plan_version_id: null,
    measurement_manifest: null,
  })
  expect(db.$client.prepare(`
    SELECT measurement_execution_id, requested_context, supported_context
    FROM query_snapshots WHERE id = 'legacy-snapshot'
  `).get()).toEqual({ measurement_execution_id: null, requested_context: null, supported_context: null })
  expect(db.$client.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
  migrate(db)
  expect(db.$client.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})

test('Target and group identities share a project-local stable-key namespace', () => {
  const db = createTempDb('canonry-target-segments-')
  seedProject(db, 'project-a')
  seedProject(db, 'project-b')

  db.$client.prepare(`
    INSERT INTO measurement_segments (id, project_id, stable_key, kind, retired_at, created_at)
    VALUES ('target-a', 'project-a', 'm-line', 'target', NULL, ?)
  `).run(NOW)
  db.$client.prepare(`
    INSERT INTO measurement_segments (id, project_id, stable_key, kind, retired_at, created_at)
    VALUES ('group-b', 'project-b', 'm-line', 'group', NULL, ?)
  `).run(NOW)

  expect(() => db.$client.prepare(`
    INSERT INTO measurement_segments (id, project_id, stable_key, kind, retired_at, created_at)
    VALUES ('duplicate', 'project-a', 'm-line', 'group', NULL, ?)
  `).run(NOW)).toThrow(/UNIQUE/i)
  expect(() => db.$client.prepare(`
    INSERT INTO measurement_segments (id, project_id, stable_key, kind, retired_at, created_at)
    VALUES ('bad-kind', 'project-a', 'bad', 'cohort', NULL, ?)
  `).run(NOW)).toThrow(/CHECK/i)
})

test('runs pin an immutable plan version from the same project', () => {
  const db = createTempDb('canonry-target-run-pin-')
  seedProject(db, 'project-a')
  seedProject(db, 'project-b')
  seedPlanVersion(db, 'project-a')

  db.$client.prepare(`
    INSERT INTO runs
      (id, project_id, kind, status, trigger, measurement_plan_version_id, measurement_manifest, created_at)
    VALUES ('pinned', 'project-a', 'answer-visibility', 'queued', 'manual', 'version-1', '{"schemaVersion":2}', ?)
  `).run(NOW)
  expect(() => db.$client.prepare(`
    INSERT INTO runs
      (id, project_id, kind, status, trigger, measurement_plan_version_id, created_at)
    VALUES ('cross-project', 'project-b', 'answer-visibility', 'queued', 'manual', 'version-1', ?)
  `).run(NOW)).toThrow(/FOREIGN KEY/i)
  expect(() => db.$client.prepare(`DELETE FROM measurement_plan_versions WHERE id = 'version-1'`).run())
    .toThrow(/FOREIGN KEY/i)
})

test('project deletion cascades through pinned plans and their historical runs', () => {
  const db = createTempDb('canonry-target-project-delete-')
  seedProject(db, 'project-a')
  seedPlanVersion(db, 'project-a')
  db.$client.prepare(`
    INSERT INTO measurement_plans (project_id, active_version_id, created_at, updated_at)
    VALUES ('project-a', 'version-1', ?, ?)
  `).run(NOW, NOW)
  db.$client.prepare(`
    INSERT INTO runs
      (id, project_id, kind, status, trigger, measurement_plan_version_id, created_at)
    VALUES ('pinned', 'project-a', 'answer-visibility', 'completed', 'manual', 'version-1', ?)
  `).run(NOW)

  db.$client.prepare(`DELETE FROM projects WHERE id = 'project-a'`).run()
  expect(db.$client.prepare(`SELECT * FROM measurement_plans`).all()).toEqual([])
  expect(db.$client.prepare(`SELECT * FROM measurement_plan_versions`).all()).toEqual([])
  expect(db.$client.prepare(`SELECT * FROM runs`).all()).toEqual([])
  expect(db.$client.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})

test('execution context is nullable for legacy rows and unique per run, execution and provider', () => {
  const db = createTempDb('canonry-target-snapshots-')
  seedLegacyHistory(db)

  db.$client.prepare(`
    INSERT INTO query_snapshots
      (id, run_id, query_text, provider, citation_state, measurement_execution_id,
       requested_context, supported_context, created_at)
    VALUES
      ('target-snapshot', 'legacy-run', 'best apartments', 'gemini', 'cited', 'execution-1',
       '{"label":"Dallas","city":"Dallas","region":"TX","country":"US"}',
       '{"status":"applied"}', ?)
  `).run(NOW)
  expect(() => db.$client.prepare(`
    INSERT INTO query_snapshots
      (id, run_id, query_text, provider, citation_state, measurement_execution_id, created_at)
    VALUES ('duplicate-slot', 'legacy-run', 'best apartments', 'gemini', 'not-cited', 'execution-1', ?)
  `).run(NOW)).toThrow(/UNIQUE/i)

  expect(db.$client.prepare(`
    SELECT requested_context, supported_context FROM query_snapshots WHERE id = 'target-snapshot'
  `).get()).toEqual({
    requested_context: '{"label":"Dallas","city":"Dallas","region":"TX","country":"US"}',
    supported_context: '{"status":"applied"}',
  })
})

test('schema mirrors the Target plan persistence boundary', () => {
  const expectedTables = [
    ['measurementPlanVersions', 'measurement_plan_versions', ['id', 'project_id', 'revision', 'canonical_json', 'checksum', 'created_at']],
    ['measurementSegments', 'measurement_segments', ['id', 'project_id', 'stable_key', 'kind', 'retired_at', 'created_at']],
    ['measurementPlans', 'measurement_plans', ['project_id', 'active_version_id', 'created_at', 'updated_at']],
  ] as const

  for (const [exportName, tableName, expectedColumns] of expectedTables) {
    const exported = (schema as Record<string, unknown>)[exportName]
    expect(exported, `schema.ts must export ${exportName}`).toSatisfy(value => is(value, SQLiteTable))
    const table = exported as SQLiteTable
    expect(getTableName(table)).toBe(tableName)
    expect(Object.values(getTableColumns(table)).map(column => column.name)).toEqual(expectedColumns)
  }
  expect((schema as Record<string, unknown>).measurementPlanVersionSegments).toBeUndefined()

  const runColumns = getTableColumns(schema.runs)
  expect(runColumns.measurementPlanVersionId.name).toBe('measurement_plan_version_id')
  expect(runColumns.measurementManifest.name).toBe('measurement_manifest')
  const snapshotColumns = getTableColumns(schema.querySnapshots)
  expect(snapshotColumns.measurementExecutionId.name).toBe('measurement_execution_id')
  expect(snapshotColumns.requestedContext.name).toBe('requested_context')
  expect(snapshotColumns.supportedContext.name).toBe('supported_context')

  const db = createTempDb('canonry-target-schema-fks-')
  expect(foreignKeys(db, 'runs')).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: 'measurement_plan_version_id', table: 'measurement_plan_versions', to: 'id' }),
  ]))
})
