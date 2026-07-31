import { test, expect } from 'vitest'
import { isDiscordWebhookUrl, toDiscordWebhookBody } from '../src/discord-payload.js'
import type { HealthWebhookPayload, WebhookPayload } from '@ainyc/canonry-contracts'

// Discord rejects arbitrary JSON with a 400, so a notification aimed at Discord
// cannot be the same bytes we send a first-party receiver. These pin the
// envelope Discord actually accepts, and that the fields an operator reads
// under pressure survive the reshape.

const health = (over: Partial<HealthWebhookPayload['health']> = {}): HealthWebhookPayload => ({
  source: 'canonry',
  event: 'health.degraded',
  project: { name: 'gjelina-hotel', canonicalDomain: 'gjelinahotel.com' },
  health: {
    status: 'fail',
    code: 'traffic.sync-lag.discarding',
    summary: '1 traffic source is discarding traffic instead of ingesting it.',
    remediation: 'Run `cnry traffic backfill ... --days N --wait`.',
    checkedAt: '2026-07-31T18:00:00.000Z',
    previousStatus: 'warn',
    failing: [
      { id: 'traffic.source.sync-lag', status: 'fail', code: 'traffic.sync-lag.discarding', summary: 'x' },
      { id: 'content.winnability', status: 'warn', code: 'content.winnability.low-coverage', summary: 'y' },
    ],
    ...over,
  },
  dashboardUrl: 'https://canonry.test/projects/gjelina-hotel',
})

test('a degraded health event becomes a Discord embed carrying the whole story', () => {
  const body = toDiscordWebhookBody(health())
  const embed = body.embeds[0]!

  expect(body.embeds).toHaveLength(1)
  expect(embed.title).toContain('gjelina-hotel')
  expect(embed.description).toContain('discarding traffic')
  expect(embed.url).toBe('https://canonry.test/projects/gjelina-hotel')

  const names = embed.fields!.map(f => f.name)
  expect(names).toContain('Status')
  expect(names).toContain('Check')
  // The remediation is the whole point of waking someone up.
  expect(names).toContain('What to do')
  expect(embed.fields!.find(f => f.name === 'What to do')!.value).toContain('backfill')

  // The headline is one check; the others must still be visible, or the
  // alphabetical-headline problem just moves into Discord.
  const also = embed.fields!.find(f => f.name.startsWith('Also failing'))!
  expect(also.value).toContain('content.winnability.low-coverage')
  expect(also.value).not.toContain('traffic.sync-lag.discarding')
})

test('a recovery reads as a recovery, not another alarm', () => {
  const payload = { ...health(), event: 'health.recovered' as const }
  const embed = toDiscordWebhookBody(payload).embeds[0]!
  expect(embed.title).toContain('recovered')
  expect(embed.color).toBe(0x2e_9e_4f)
})

test('severity drives colour so the channel is scannable', () => {
  expect(toDiscordWebhookBody(health({ status: 'fail' })).embeds[0]!.color).toBe(0xd9_36_3b)
  expect(toDiscordWebhookBody(health({ status: 'warn' })).embeds[0]!.color).toBe(0xd9_8b_1e)
})

test('an over-long summary is clamped, because Discord 400s past its limit', () => {
  const embed = toDiscordWebhookBody(health({ summary: 'x'.repeat(9000) })).embeds[0]!
  expect(embed.description!.length).toBeLessThanOrEqual(3800)
  expect(embed.description!.endsWith('…')).toBe(true)
})

test('run events also reshape rather than being posted raw', () => {
  const payload: WebhookPayload = {
    source: 'canonry',
    event: 'run.failed',
    project: { name: 'azcoatings', canonicalDomain: 'azcoatingsllc.com' },
    run: { id: 'run_1', status: 'failed', finishedAt: '2026-07-31T18:00:00.000Z' },
    transitions: [{ query: 'roof coating', from: 'cited', to: 'not-cited', provider: 'openai' }],
    dashboardUrl: 'https://canonry.test/projects/azcoatings',
  }
  const embed = toDiscordWebhookBody(payload).embeds[0]!
  expect(embed.title).toContain('azcoatings')
  expect(embed.fields!.some(f => f.name.startsWith('Changes'))).toBe(true)
})

test('a Discord webhook is recognised by its URL, and lookalikes are not', () => {
  expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123/abc')).toBe(true)
  expect(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/123/abc')).toBe(true)
  expect(isDiscordWebhookUrl('https://ptb.discord.com/api/webhooks/123/abc')).toBe(true)

  // A lookalike host must never be handed an embed.
  expect(isDiscordWebhookUrl('https://discord.com.evil.test/api/webhooks/1/a')).toBe(false)
  // A first-party receiver that merely mentions discord stays on the signed path.
  expect(isDiscordWebhookUrl('https://hooks.example.com/relay/discord')).toBe(false)
  expect(isDiscordWebhookUrl('http://discord.com/api/webhooks/123/abc')).toBe(false)
  expect(isDiscordWebhookUrl('https://discord.com/api/other/123')).toBe(false)
  expect(isDiscordWebhookUrl('not a url')).toBe(false)
})
