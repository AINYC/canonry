/**
 * `CheckStore` implementations.
 *
 * `ValSqliteCheckStore` takes a `ValSqliteClient` interface, so the host — not
 * the kit — imports whatever SQLite binding it actually has.
 */
export * from './storage/memory.js'
export * from './storage/val-sqlite.js'
