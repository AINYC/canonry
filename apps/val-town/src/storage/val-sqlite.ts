import type {
  CheckAdmission,
  CheckAdmissionInput,
  CheckRecord,
  CheckResult,
  CheckStatus,
  CheckStore,
} from '../runtime/types.ts'

type SqlArg = string | number | null

export interface ValSqliteStatement {
  sql: string
  args?: SqlArg[] | Record<string, SqlArg>
}

export interface ValSqliteResult {
  rows: unknown[]
}

/** Minimal structural type of Val Town's initialized @libsql/client instance. */
export interface ValSqliteClient {
  execute(statement: string | ValSqliteStatement): Promise<ValSqliteResult>
  /**
   * Val Town documents `batch` as the multi-statement primitive. `write` mode
   * applies every statement as one SQLite transaction.
   */
  batch(statements: ValSqliteStatement[], mode: 'write'): Promise<ValSqliteResult[]>
}

const ADMISSION_PENDING = '__canonry_admission_pending__'
const ADMISSION_CLIENT_CLAIMED = '__canonry_admission_client_claimed__'
const ADMISSION_GRANTED = '__canonry_admission_granted__'

const ADDITIVE_COLUMNS = [
  'ALTER TABLE canonry_checks ADD COLUMN user_queries TEXT',
]

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS canonry_checks (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    domain TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    user_queries TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS canonry_checks_reuse ON canonry_checks (fingerprint, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS canonry_checks_lease ON canonry_checks (status, lease_until)',
  // A second active record would be paid duplicate work even if a caller
  // bypassed the admission batch. Terminal/cached history stays unconstrained.
  "CREATE UNIQUE INDEX IF NOT EXISTS canonry_checks_one_active ON canonry_checks (fingerprint) WHERE status IN ('queued', 'running')",
  `CREATE TABLE IF NOT EXISTS canonry_quota (
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (scope, subject, day)
  )`,
  `CREATE TABLE IF NOT EXISTS canonry_leases (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
]

/** Val-scoped SQLite adapter. SQL remains behind the store port for local/test parity. */
export class ValSqliteCheckStore implements CheckStore {
  constructor(private readonly sqlite: ValSqliteClient) {}

  async initialize(): Promise<void> {
    for (const statement of SCHEMA) await this.sqlite.execute(statement)
    // A table created before `user_queries` existed will not gain it from
    // CREATE TABLE IF NOT EXISTS. ALTER is the only way to reach it, and it
    // throws once the column is present, which is the steady state.
    for (const statement of ADDITIVE_COLUMNS) {
      try {
        await this.sqlite.execute(statement)
      } catch {
        // Already applied.
      }
    }
  }

  /** Atomically reuse, reclaim, spend quota, and create in Val's documented write batch. */
  async admit(input: CheckAdmissionInput): Promise<CheckAdmission> {
    const results = await this.sqlite.batch(this.admissionBatch(input), 'write')
    const reclaimed = results[0]?.rows[0] ? rowToCheck(results[0].rows[0]) : null
    const candidateCreated = results[1]?.rows.length === 1
    const clientQuotaClaimed = results[2]?.rows.length === 1
    const globalQuotaClaimed = results[4]?.rows.length === 1
    const reusable = results[10]?.rows[0] ? rowToCheck(results[10].rows[0]) : null

    if (reclaimed && reusable) return { kind: 'reclaimed', record: reusable }
    if (!candidateCreated && reusable) return { kind: 'reused', record: reusable }
    if (candidateCreated && !clientQuotaClaimed) return { kind: 'quota-exhausted', scope: 'client' }
    if (candidateCreated && !globalQuotaClaimed) return { kind: 'quota-exhausted', scope: 'global' }
    if (candidateCreated && reusable) return { kind: 'created', record: reusable }

    throw new Error('Atomic admission completed without a reusable or created check.')
  }

  findReusable(fingerprint: string, now: string): Promise<CheckRecord | null> {
    return this.findReusableWith(fingerprint, now)
  }

  async create(record: CheckRecord): Promise<void> {
    await this.createWith(record)
  }

  async get(id: string): Promise<CheckRecord | null> {
    const result = await this.sqlite.execute({ sql: 'SELECT * FROM canonry_checks WHERE id = ? LIMIT 1', args: [id] })
    return result.rows[0] ? rowToCheck(result.rows[0]) : null
  }

  async update(
    id: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>>,
  ): Promise<CheckRecord | null> {
    const fields: string[] = []
    const args: SqlArg[] = []
    if (patch.status !== undefined) {
      fields.push('status = ?')
      args.push(patch.status)
    }
    if (patch.updatedAt !== undefined) {
      fields.push('updated_at = ?')
      args.push(patch.updatedAt)
    }
    if (patch.expiresAt !== undefined) {
      fields.push('expires_at = ?')
      args.push(patch.expiresAt)
    }
    if (patch.result !== undefined) {
      fields.push('result_json = ?')
      args.push(patch.result ? JSON.stringify(patch.result) : null)
    }
    if (patch.errorCode !== undefined) {
      fields.push('error_code = ?')
      args.push(patch.errorCode)
    }
    if (patch.errorMessage !== undefined) {
      fields.push('error_message = ?')
      args.push(patch.errorMessage)
    }
    if (fields.length === 0) return this.get(id)
    args.push(id)
    await this.sqlite.execute({ sql: `UPDATE canonry_checks SET ${fields.join(', ')} WHERE id = ?`, args })
    return this.get(id)
  }

  async claimJob(id: string, owner: string, now: string, leaseUntil: string): Promise<CheckRecord | null> {
    const result = await this.sqlite.execute({
      sql: `UPDATE canonry_checks
        SET status = 'running', updated_at = ?, lease_owner = ?, lease_until = ?
        WHERE id = ? AND (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?)))
        RETURNING *`,
      args: [now, owner, leaseUntil, id, now],
    })
    return result.rows[0] ? rowToCheck(result.rows[0]) : null
  }

  async finalizeJob(
    id: string,
    owner: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>>,
  ): Promise<CheckRecord | null> {
    const fields: string[] = ['lease_owner = NULL', 'lease_until = NULL']
    const args: SqlArg[] = []
    if (patch.status !== undefined) {
      fields.push('status = ?')
      args.push(patch.status)
    }
    if (patch.updatedAt !== undefined) {
      fields.push('updated_at = ?')
      args.push(patch.updatedAt)
    }
    if (patch.expiresAt !== undefined) {
      fields.push('expires_at = ?')
      args.push(patch.expiresAt)
    }
    if (patch.result !== undefined) {
      fields.push('result_json = ?')
      args.push(patch.result ? JSON.stringify(patch.result) : null)
    }
    if (patch.errorCode !== undefined) {
      fields.push('error_code = ?')
      args.push(patch.errorCode)
    }
    if (patch.errorMessage !== undefined) {
      fields.push('error_message = ?')
      args.push(patch.errorMessage)
    }
    args.push(id, owner)
    const result = await this.sqlite.execute({
      sql: `UPDATE canonry_checks SET ${fields.join(', ')} WHERE id = ? AND lease_owner = ? RETURNING *`,
      args,
    })
    return result.rows[0] ? rowToCheck(result.rows[0]) : null
  }

  async requeueJob(id: string, owner: string, now: string): Promise<CheckRecord | null> {
    const result = await this.sqlite.execute({
      sql: `UPDATE canonry_checks
        SET status = 'queued', updated_at = ?, lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND lease_owner = ?
        RETURNING *`,
      args: [now, id, owner],
    })
    return result.rows[0] ? rowToCheck(result.rows[0]) : null
  }

  async claimGlobalLease(name: string, holder: string, now: string, leaseUntil: string): Promise<boolean> {
    const result = await this.sqlite.execute({
      sql: `INSERT INTO canonry_leases (name, holder, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
          WHERE canonry_leases.holder = excluded.holder OR canonry_leases.expires_at <= ?
        RETURNING name`,
      args: [name, holder, leaseUntil, now],
    })
    return result.rows.length > 0
  }

  async releaseGlobalLease(name: string, holder: string): Promise<void> {
    await this.sqlite.execute({ sql: 'DELETE FROM canonry_leases WHERE name = ? AND holder = ?', args: [name, holder] })
  }

  claimQuota(scope: string, subject: string, day: string, max: number): Promise<boolean> {
    return this.claimQuotaWith(scope, subject, day, max)
  }

  private admissionBatch(input: CheckAdmissionInput): ValSqliteStatement[] {
    const candidate = input.candidate
    const activeCheckWhere = `(status = 'queued'
      OR (status = 'running' AND lease_until IS NOT NULL AND lease_until > ?)
      OR (status IN ('complete', 'partial') AND expires_at > ?))`

    return [
      // Reclaim only when an active or cached check would not already be
      // reused. This is the same precedence as findReusable() before the
      // transaction was introduced.
      {
        sql: `UPDATE canonry_checks
          SET status = 'queued', updated_at = ?, lease_owner = NULL, lease_until = NULL
          WHERE id = (
            SELECT id FROM canonry_checks
            WHERE fingerprint = ?
              AND status = 'running'
              AND (lease_until IS NULL OR lease_until <= ?)
            ORDER BY created_at DESC LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM canonry_checks
            WHERE fingerprint = ? AND ${activeCheckWhere}
          )
          RETURNING *`,
        args: [input.now, candidate.fingerprint, input.now, candidate.fingerprint, input.now, input.now],
      },
      // A pending row is a durable admission slot. The partial unique index
      // above prevents a second active record even if this batch is ever
      // called through a different Val isolate.
      {
        sql: `INSERT INTO canonry_checks
          (id, fingerprint, domain, status, created_at, updated_at, expires_at, result_json, error_code, error_message, lease_owner, lease_until, user_queries)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM canonry_checks
            WHERE fingerprint = ? AND ${activeCheckWhere}
          )
          RETURNING id`,
        args: [
          candidate.id,
          candidate.fingerprint,
          candidate.domain,
          candidate.status,
          candidate.createdAt,
          candidate.updatedAt,
          candidate.expiresAt,
          candidate.result ? JSON.stringify(candidate.result) : null,
          ADMISSION_PENDING,
          candidate.errorMessage,
          candidate.leaseOwner,
          candidate.leaseUntil,
          JSON.stringify(candidate.userQueries ?? []),
          candidate.fingerprint,
          input.now,
          input.now,
        ],
      },
      {
        sql: `INSERT INTO canonry_quota (scope, subject, day, count)
          SELECT ?, ?, ?, 1
          WHERE ? > 0 AND EXISTS (
            SELECT 1 FROM canonry_checks WHERE id = ? AND error_code = ?
          )
          ON CONFLICT(scope, subject, day) DO UPDATE SET count = count + 1
            WHERE canonry_quota.count < ?
          RETURNING count`,
        args: [
          input.clientQuota.scope,
          input.clientQuota.subject,
          input.clientQuota.day,
          input.clientQuota.max,
          candidate.id,
          ADMISSION_PENDING,
          input.clientQuota.max,
        ],
      },
      // SQLite changes() refers to the immediately preceding batch statement.
      // It lets the next durable state transition distinguish a quota cap from
      // an admitted claim without exposing an intermediate row outside this
      // atomic write batch.
      {
        sql: `UPDATE canonry_checks
          SET error_code = ?
          WHERE id = ? AND error_code = ? AND changes() = 1`,
        args: [ADMISSION_CLIENT_CLAIMED, candidate.id, ADMISSION_PENDING],
      },
      {
        sql: `INSERT INTO canonry_quota (scope, subject, day, count)
          SELECT ?, ?, ?, 1
          WHERE ? > 0 AND EXISTS (
            SELECT 1 FROM canonry_checks WHERE id = ? AND error_code = ?
          )
          ON CONFLICT(scope, subject, day) DO UPDATE SET count = count + 1
            WHERE canonry_quota.count < ?
          RETURNING count`,
        args: [
          input.globalQuota.scope,
          input.globalQuota.subject,
          input.globalQuota.day,
          input.globalQuota.max,
          candidate.id,
          ADMISSION_CLIENT_CLAIMED,
          input.globalQuota.max,
        ],
      },
      {
        sql: `UPDATE canonry_checks
          SET error_code = ?
          WHERE id = ? AND error_code = ? AND changes() = 1`,
        args: [ADMISSION_GRANTED, candidate.id, ADMISSION_CLIENT_CLAIMED],
      },
      // A global-cap rejection gives the client quota slot back before the
      // batch commits. A client-cap rejection never reaches this state.
      {
        sql: `UPDATE canonry_quota
          SET count = count - 1
          WHERE scope = ? AND subject = ? AND day = ? AND count > 0
            AND EXISTS (
              SELECT 1 FROM canonry_checks WHERE id = ? AND error_code = ?
            )`,
        args: [
          input.clientQuota.scope,
          input.clientQuota.subject,
          input.clientQuota.day,
          candidate.id,
          ADMISSION_CLIENT_CLAIMED,
        ],
      },
      {
        sql: 'DELETE FROM canonry_quota WHERE scope = ? AND subject = ? AND day = ? AND count <= 0',
        args: [input.clientQuota.scope, input.clientQuota.subject, input.clientQuota.day],
      },
      {
        sql: `DELETE FROM canonry_checks
          WHERE id = ? AND error_code IN (?, ?)
          RETURNING id`,
        args: [candidate.id, ADMISSION_PENDING, ADMISSION_CLIENT_CLAIMED],
      },
      {
        sql: 'UPDATE canonry_checks SET error_code = NULL WHERE id = ? AND error_code = ?',
        args: [candidate.id, ADMISSION_GRANTED],
      },
      {
        sql: `SELECT * FROM canonry_checks
          WHERE fingerprint = ? AND ${activeCheckWhere}
          ORDER BY created_at DESC LIMIT 1`,
        args: [candidate.fingerprint, input.now, input.now],
      },
    ]
  }

  private async findReusableWith(fingerprint: string, now: string): Promise<CheckRecord | null> {
    const result = await this.sqlite.execute({
      sql: `SELECT * FROM canonry_checks
        WHERE fingerprint = ?
          AND (
            status = 'queued'
            OR (status = 'running' AND lease_until IS NOT NULL AND lease_until > ?)
            OR (status IN ('complete', 'partial') AND expires_at > ?)
          )
        ORDER BY created_at DESC LIMIT 1`,
      args: [fingerprint, now, now],
    })
    const row = result.rows[0]
    return row ? rowToCheck(row) : null
  }

  private async createWith(record: CheckRecord): Promise<void> {
    await this.sqlite.execute({
      sql: `INSERT INTO canonry_checks
        (id, fingerprint, domain, status, created_at, updated_at, expires_at, result_json, error_code, error_message, lease_owner, lease_until, user_queries)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.fingerprint,
        record.domain,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.expiresAt,
        record.result ? JSON.stringify(record.result) : null,
        record.errorCode,
        record.errorMessage,
        record.leaseOwner,
        record.leaseUntil,
        JSON.stringify(record.userQueries ?? []),
      ],
    })
  }
  private async claimQuotaWith(scope: string, subject: string, day: string, max: number): Promise<boolean> {
    // The WHERE condition is evaluated within this one UPSERT, so concurrent
    // requests cannot both spend the final remaining slot.
    const result = await this.sqlite.execute({
      sql: `INSERT INTO canonry_quota (scope, subject, day, count)
        SELECT ?, ?, ?, 1 WHERE ? > 0
        ON CONFLICT(scope, subject, day) DO UPDATE SET count = count + 1
          WHERE canonry_quota.count < ?
        RETURNING count`,
      args: [scope, subject, day, max, max],
    })
    return result.rows.length > 0
  }
}

function rowToCheck(row: unknown): CheckRecord {
  const value = row as Record<string, unknown>
  const resultJson = readString(value, 'result_json')
  return {
    id: readString(value, 'id') ?? '',
    fingerprint: readString(value, 'fingerprint') ?? '',
    domain: readString(value, 'domain') ?? '',
    status: (readString(value, 'status') ?? 'failed') as CheckStatus,
    createdAt: readString(value, 'created_at') ?? '',
    updatedAt: readString(value, 'updated_at') ?? '',
    expiresAt: readString(value, 'expires_at'),
    result: resultJson ? JSON.parse(resultJson) as CheckResult : null,
    errorCode: readString(value, 'error_code'),
    errorMessage: readString(value, 'error_message'),
    leaseOwner: readString(value, 'lease_owner'),
    leaseUntil: readString(value, 'lease_until'),
    userQueries: readQueries(value),
  }
}

/** Rows written before the column existed read as an empty list, not a crash. */
function readQueries(value: Record<string, unknown>): string[] {
  const raw = value.user_queries
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const current = value[key]
  return typeof current === 'string' ? current : current == null ? null : String(current)
}
