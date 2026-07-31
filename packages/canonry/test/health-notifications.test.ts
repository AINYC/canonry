import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, doctorHealthState, notifications, projects } from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'

// Canonry alarmed when the measurement reported bad news and never when the
// measurement itself was broken. Every notifiable event described a finding
// (citation.lost, run.failed, insight.*), so a Vercel source that silently
// discarded traffic for 24h kept emitting `run.completed` — a success signal —
// the whole time, and a provider that quietly stopped retrieving looked
// identical to a brand that genuinely was not mentioned.
//
// These tests pin the health channel that closes that gap, and specifically pin
// that it stays quiet when nothing changed: an operator who gets the same
// warning every day stops reading the channel, which recreates the original
// failure with extra steps.

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-health-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'healthproj', displayName: 'Health', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  db.insert(notifications).values({
    id: crypto.randomUUID(), projectId, channel: 'webhook',
    config: { url: 'https://hooks.example/health', events: ['health.degraded', 'health.recovered'] },
    enabled: true, createdAt: now, updatedAt: now,
  } as never).run()
  return { db, projectId, notifier: new Notifier(db, 'https://canonry.test') }
}

const check = (id: string, status: string, code: string, summary = 'x') => ({ id, status, code, summary })
const at = (iso: string) => ({ checkedAt: iso })

test('a first pass that is already degraded notifies once', async () => {
  const { notifier, projectId, db } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1]) })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding', 'discarding now')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  expect(sent).toHaveLength(1)
  const payload = sent[0] as { event: string; health: { status: string; previousStatus: null; code: string } }
  expect(payload.event).toBe('health.degraded')
  expect(payload.health.status).toBe('fail')
  expect(payload.health.previousStatus).toBeNull()
  expect(payload.health.code).toBe('traffic.sync-lag.discarding')
  // The payload deliberately carries no `run` — this is not a finding.
  expect(payload).not.toHaveProperty('run')

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
})

test('a repeat of the same problem stays silent so the channel keeps meaning something', async () => {
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1]) })

  const checks = [check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind')]
  const first = await notifier.onHealthChecked(projectId, { checks, ...at('2026-07-31T05:00:00.000Z') })
  const second = await notifier.onHealthChecked(projectId, { checks, ...at('2026-08-01T05:00:00.000Z') })
  const third = await notifier.onHealthChecked(projectId, { checks, ...at('2026-08-02T05:00:00.000Z') })

  expect(first).toBe('health.degraded')
  expect(second).toBeNull()
  expect(third).toBeNull()
  expect(sent).toHaveLength(1)
})

test('a different cause at the same severity does notify, because it is different news', async () => {
  const { notifier, projectId } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  const first = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  const second = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.connected', 'warn', 'traffic.source.partially-errored')],
    ...at('2026-08-01T05:00:00.000Z'),
  })

  expect(first).toBe('health.degraded')
  expect(second).toBe('health.degraded')
})

test('recovery closes the loop', async () => {
  const { notifier, projectId } = harness()
  const sent: { event: string; health: { previousStatus: string | null } }[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => {
    sent.push(args[1] as never)
  })

  await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  const recovered = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'ok', 'traffic.sync-lag.current')],
    ...at('2026-08-01T05:00:00.000Z'),
  })

  expect(recovered).toBe('health.recovered')
  expect(sent.at(-1)!.event).toBe('health.recovered')
  expect(sent.at(-1)!.health.previousStatus).toBe('fail')
})

test('a healthy first pass says nothing, so enabling this does not announce working projects', async () => {
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a) })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'ok', 'traffic.sync-lag.current')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBeNull()
  expect(sent).toHaveLength(0)
})

test('a skipped check does not mask a failing one', async () => {
  const { notifier, projectId, db } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  await notifier.onHealthChecked(projectId, {
    checks: [
      check('traffic.source.sync-lag', 'skipped', 'traffic.sync-lag.no-source'),
      check('traffic.source.credentials', 'fail', 'traffic.credentials.failed'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
  expect(stored.code).toBe('traffic.credentials.failed')
})

test('a pass where every check skipped is unknown, never healthy', async () => {
  // The whole point of this channel is that a green signal must mean something
  // was measured. If every check skips there is no signal at all, and calling
  // that `ok` reproduces green-while-blind — an instrument reporting health
  // having measured nothing. It must warn, and it must say why.
  const { notifier, projectId, db } = harness()
  const sent: { event: string; health: { code: string } }[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => {
    sent.push(a[1] as never)
  })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [
      check('traffic.source.sync-lag', 'skipped', 'traffic.sync-lag.no-source'),
      check('traffic.source.credentials', 'skipped', 'traffic.credentials.no-source'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('warn')
  expect(stored.code).toBe('health.no-signal')
  expect(stored.summary).toMatch(/unknown, not confirmed/)
  expect(sent.at(-1)!.health.code).toBe('health.no-signal')
})

test('worst status wins when several checks are unhappy', async () => {
  const { notifier, projectId, db } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  await notifier.onHealthChecked(projectId, {
    checks: [
      check('a.warn', 'warn', 'a.warn.code'),
      check('b.fail', 'fail', 'b.fail.code'),
      check('c.ok', 'ok', 'c.ok.code'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
  expect(stored.code).toBe('b.fail.code')
})

test('a subscriber that did not opt into health events is not sent one', async () => {
  const { db, notifier, projectId } = harness()
  db.update(notifications)
    .set({ config: { url: 'https://hooks.example/runs', events: ['run.completed', 'run.failed'] } } as never)
    .where(eq(notifications.projectId, projectId)).run()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a) })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  // The transition still happened and is still recorded; only delivery is filtered.
  expect(event).toBe('health.degraded')
  expect(sent).toHaveLength(0)
})
