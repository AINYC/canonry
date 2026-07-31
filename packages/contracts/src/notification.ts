import { z } from 'zod'

export const notificationEventSchema = z.enum([
  'citation.lost',
  'citation.gained',
  'run.completed',
  'run.failed',
  'insight.critical',
  'insight.high',
  /**
   * Instrument health, as opposed to findings. Every other event above reports
   * what the measurement SAW; these two report whether the measurement is
   * trustworthy at all. They exist because a degraded pipeline keeps emitting
   * `run.completed` — a success signal — while producing wrong numbers.
   *
   * Edge-triggered: emitted when the worst check status changes, never on every
   * scheduled pass, so a persistent warning does not train the operator to
   * ignore the channel.
   */
  'health.degraded',
  'health.recovered',
])
export type NotificationEvent = z.infer<typeof notificationEventSchema>

/**
 * Where a notification is delivered.
 *
 * - `webhook`  POST the canonry payload verbatim, HMAC-signed. For your own
 *              receiver, which can verify the signature and read the fields.
 * - `discord`  POST a Discord embed to a Discord webhook URL. Discord rejects
 *              arbitrary JSON with a 400, so the payload is reshaped at send
 *              time. Delivery is a plain HTTP POST: no agent, no model, no
 *              per-message cost.
 */
export const notificationChannelSchema = z.enum(['webhook', 'discord'])
export type NotificationChannel = z.infer<typeof notificationChannelSchema>
export const NotificationChannels = notificationChannelSchema.enum

export const notificationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  channel: notificationChannelSchema,
  url: z.string().url(),
  urlDisplay: z.string(),
  urlHost: z.string(),
  events: z.array(notificationEventSchema),
  enabled: z.boolean().default(true),
  /** Opaque tag identifying the creator (e.g. `"agent"` for Aero webhooks). */
  source: z.string().optional(),
  webhookSecret: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type NotificationDto = z.infer<typeof notificationDtoSchema>

export const notificationCreateRequestSchema = z.object({
  channel: notificationChannelSchema.default('webhook'),
  url: z.string().url(),
  events: z.array(notificationEventSchema).min(1),
  source: z.string().optional(),
})

export type NotificationCreateRequest = z.infer<typeof notificationCreateRequestSchema>

export interface InsightWebhookPayload {
  source: 'canonry'
  event: 'insight.critical' | 'insight.high'
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  insights: Array<{
    id: string
    type: string
    severity: string
    title: string
    query: string
    provider: string
  }>
  dashboardUrl: string
}

/**
 * Health events carry no `run`: they report on the measurement apparatus, not
 * on a sweep. Deliberately a separate payload rather than a run payload with a
 * null run, because a subscriber that keys off `run.id` should fail loudly on
 * a health event instead of silently treating it as a finding about the site.
 */
export interface HealthWebhookPayload {
  source: 'canonry'
  event: 'health.degraded' | 'health.recovered'
  project: { name: string; canonicalDomain: string }
  health: {
    /** Worst check status observed on this pass. */
    status: 'ok' | 'warn' | 'fail'
    /** Stable code of the worst check, e.g. "traffic.sync-lag.discarding". */
    code: string
    summary: string
    remediation: string | null
    checkedAt: string
    /** What the status was before this pass, so the transition is explicit. */
    previousStatus: 'ok' | 'warn' | 'fail' | null
    /** Every non-ok check on this pass, worst first. */
    failing: Array<{ id: string; status: string; code: string; summary: string }>
  }
  dashboardUrl: string
}

export interface WebhookPayload {
  source: 'canonry'
  event: NotificationEvent
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  transitions: Array<{
    query: string
    from: string
    to: string
    provider: string
    /**
     * Location label this transition was observed at. Optional for backward
     * compatibility with subscribers built before multi-location fan-out was
     * supported; the field is populated for all transitions produced by
     * canonry post-#480 when the underlying snapshot carries a location.
     */
    location?: string | null
  }>
  dashboardUrl: string
}
