import type { CheckAdmission, CheckAdmissionInput, CheckRecord, CheckStore } from '../runtime/types.ts'

const ADMISSION_LEASE_PREFIX = 'public-check-admission:'
const ADMISSION_LEASE_MS = 10_000
const ADMISSION_RETRIES = 8
const ADMISSION_RETRY_DELAY_MS = 8

/** Deterministic store for local development and tests. Production uses Val SQLite. */
export class MemoryCheckStore implements CheckStore {
  readonly checks = new Map<string, CheckRecord>()
  readonly quota = new Map<string, number>()

  initialize(): Promise<void> {
    return Promise.resolve()
  }

  async admit(input: CheckAdmissionInput): Promise<CheckAdmission> {
    const leaseName = `${ADMISSION_LEASE_PREFIX}${input.candidate.fingerprint}`
    const leaseUntil = new Date(new Date(input.now).getTime() + ADMISSION_LEASE_MS).toISOString()

    for (let attempt = 0; attempt < ADMISSION_RETRIES; attempt++) {
      const holder = crypto.randomUUID()
      if (!await this.claimGlobalLease(leaseName, holder, input.now, leaseUntil)) {
        if (attempt + 1 < ADMISSION_RETRIES) await delay(ADMISSION_RETRY_DELAY_MS)
        continue
      }

      try {
        const reusable = await this.findReusable(input.candidate.fingerprint, input.now)
        if (reusable) return { kind: 'reused', record: reusable }

        const stale = this.findStaleRunning(input.candidate.fingerprint, input.now)
        if (stale) {
          const current = this.checks.get(stale.id)
          if (current?.status === 'running' && (!current.leaseUntil || current.leaseUntil <= input.now)) {
            const reclaimed: CheckRecord = {
              ...current,
              status: 'queued',
              updatedAt: input.now,
              leaseOwner: null,
              leaseUntil: null,
            }
            this.checks.set(reclaimed.id, reclaimed)
            return { kind: 'reclaimed', record: clone(reclaimed) }
          }
          const retried = await this.findReusable(input.candidate.fingerprint, input.now)
          if (retried) return { kind: 'reused', record: retried }
        }

        if (
          !await this.claimQuota(
            input.clientQuota.scope,
            input.clientQuota.subject,
            input.clientQuota.day,
            input.clientQuota.max,
          )
        ) {
          return { kind: 'quota-exhausted', scope: 'client' }
        }
        if (
          !await this.claimQuota(
            input.globalQuota.scope,
            input.globalQuota.subject,
            input.globalQuota.day,
            input.globalQuota.max,
          )
        ) {
          this.releaseQuota(input.clientQuota.scope, input.clientQuota.subject, input.clientQuota.day)
          return { kind: 'quota-exhausted', scope: 'global' }
        }

        try {
          await this.create(input.candidate)
          return { kind: 'created', record: clone(input.candidate) }
        } catch (error) {
          this.releaseQuota(input.clientQuota.scope, input.clientQuota.subject, input.clientQuota.day)
          this.releaseQuota(input.globalQuota.scope, input.globalQuota.subject, input.globalQuota.day)
          throw error
        }
      } finally {
        await this.releaseGlobalLease(leaseName, holder)
      }
    }

    return { kind: 'busy' }
  }

  findReusable(fingerprint: string, now: string): Promise<CheckRecord | null> {
    const candidates = [...this.checks.values()]
      .filter((check) => check.fingerprint === fingerprint)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const check of candidates) {
      if (check.status === 'queued') return Promise.resolve(clone(check))
      if (check.status === 'running' && check.leaseUntil && check.leaseUntil > now) return Promise.resolve(clone(check))
      if ((check.status === 'complete' || check.status === 'partial') && check.expiresAt && check.expiresAt > now) {
        return Promise.resolve(clone(check))
      }
    }
    return Promise.resolve(null)
  }

  create(record: CheckRecord): Promise<void> {
    this.checks.set(record.id, clone(record))
    return Promise.resolve()
  }

  get(id: string): Promise<CheckRecord | null> {
    const record = this.checks.get(id)
    return Promise.resolve(record ? clone(record) : null)
  }

  update(
    id: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>>,
  ): Promise<CheckRecord | null> {
    const current = this.checks.get(id)
    if (!current) return Promise.resolve(null)
    const next = { ...current, ...clone(patch) }
    this.checks.set(id, next)
    return Promise.resolve(clone(next))
  }

  claimJob(id: string, owner: string, now: string, leaseUntil: string): Promise<CheckRecord | null> {
    const current = this.checks.get(id)
    if (!current) return Promise.resolve(null)
    const canClaim = current.status === 'queued' ||
      (current.status === 'running' && (!current.leaseUntil || current.leaseUntil <= now))
    if (!canClaim) return Promise.resolve(null)
    const next: CheckRecord = { ...current, status: 'running', updatedAt: now, leaseOwner: owner, leaseUntil }
    this.checks.set(id, next)
    return Promise.resolve(clone(next))
  }

  finalizeJob(
    id: string,
    owner: string,
    patch: Partial<Pick<CheckRecord, 'status' | 'updatedAt' | 'expiresAt' | 'result' | 'errorCode' | 'errorMessage'>>,
  ): Promise<CheckRecord | null> {
    const current = this.checks.get(id)
    if (!current || current.leaseOwner !== owner) return Promise.resolve(null)
    const next: CheckRecord = { ...current, ...clone(patch), leaseOwner: null, leaseUntil: null }
    this.checks.set(id, next)
    return Promise.resolve(clone(next))
  }

  requeueJob(id: string, owner: string, now: string): Promise<CheckRecord | null> {
    const current = this.checks.get(id)
    if (!current || current.leaseOwner !== owner) return Promise.resolve(null)
    const next: CheckRecord = { ...current, status: 'queued', updatedAt: now, leaseOwner: null, leaseUntil: null }
    this.checks.set(id, next)
    return Promise.resolve(clone(next))
  }

  claimGlobalLease(name: string, holder: string, now: string, leaseUntil: string): Promise<boolean> {
    const current = this.globalLeases.get(name)
    if (current && current.holder !== holder && current.leaseUntil > now) return Promise.resolve(false)
    this.globalLeases.set(name, { holder, leaseUntil })
    return Promise.resolve(true)
  }

  releaseGlobalLease(name: string, holder: string): Promise<void> {
    if (this.globalLeases.get(name)?.holder === holder) this.globalLeases.delete(name)
    return Promise.resolve()
  }

  claimQuota(scope: string, subject: string, day: string, max: number): Promise<boolean> {
    const key = `${scope}:${subject}:${day}`
    const value = this.quota.get(key) ?? 0
    if (value >= max) return Promise.resolve(false)
    this.quota.set(key, value + 1)
    return Promise.resolve(true)
  }

  private findStaleRunning(fingerprint: string, now: string): CheckRecord | null {
    const candidate = [...this.checks.values()]
      .filter((check) =>
        check.fingerprint === fingerprint && check.status === 'running' &&
        (!check.leaseUntil || check.leaseUntil <= now)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return candidate ? clone(candidate) : null
  }

  private releaseQuota(scope: string, subject: string, day: string): void {
    const key = `${scope}:${subject}:${day}`
    const value = this.quota.get(key) ?? 0
    if (value <= 1) this.quota.delete(key)
    else this.quota.set(key, value - 1)
  }

  private readonly globalLeases = new Map<string, { holder: string; leaseUntil: string }>()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
