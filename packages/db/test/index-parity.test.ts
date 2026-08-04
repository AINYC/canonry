import { test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { createClient, migrate } from '../src/index.js'
import * as schema from '../src/schema.js'

test('every schema.ts index exists in the migrated database', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-idx-parity-'))
  const dbPath = path.join(tmpDir, 'parity.db')

  try {
    const drizzleDb = createClient(dbPath)
    migrate(drizzleDb)

    const raw = new Database(dbPath, { readonly: true })

    const schemaTables: SQLiteTable[] = []
    for (const value of Object.values(schema)) {
      if (is(value, SQLiteTable)) {
        schemaTables.push(value)
      }
    }

    expect(schemaTables.length).toBeGreaterThan(0)

    const missingIndexes: string[] = []

    for (const table of schemaTables) {
      const config = getTableConfig(table)
      const tableName = config.name

      // Get indexes of this table from sqlite_master
      const dbIndexes = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
        .all(tableName) as Array<{ name: string, sql: string | null }>

      const dbIndexNames = new Set(dbIndexes.map((i) => i.name.toLowerCase()))

      for (const idx of config.indexes) {
        const name = idx.name || (idx as Record<string, unknown>).config ? ((idx as Record<string, unknown>).config as Record<string, string>).name : undefined;
        if (!name) {
          console.log('Index without name found:', idx);
          continue;
        }
        const idxName = name.toLowerCase()
        if (!dbIndexNames.has(idxName)) {
          // Check if there is an index with matching column signature, or just by name.
          // Since migrations typically use CREATE INDEX IF NOT EXISTS idx_..., they should match exactly by name.
          missingIndexes.push(`Table: ${tableName}, Index: ${name}`)
        }
      }
    }

    raw.close()

    expect(missingIndexes, `Indexes declared in schema.ts but not created by MIGRATIONS:\n  ${missingIndexes.join('\n  ')}`).toEqual([])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
