import type {
  HealthWebhookPayload,
  InsightWebhookPayload,
  WebhookPayload,
} from '@ainyc/canonry-contracts'

/**
 * Reshape a canonry notification into a Discord embed.
 *
 * A Discord webhook IS a webhook, so it needs no channel type of its own — the
 * URL identifies it unambiguously and the only difference is the body Discord
 * will accept. Discord rejects arbitrary JSON with a 400, so the payload is
 * reshaped at send time; everything else (SSRF guard, retries, delivery log) is
 * the ordinary webhook path.
 *
 * The health events get the most structure because they are the ones read
 * under pressure: an operator seeing this at 3am needs the project, what broke,
 * and the next command, without opening a dashboard.
 */

/**
 * A Discord webhook endpoint, by host. Matching the host (not a substring)
 * keeps `discord.com.evil.test` from being handed an embed, and keeps a
 * first-party receiver that merely mentions discord in its path on the normal
 * signed path.
 */
export function isDiscordWebhookUrl(rawUrl: string): boolean {
  let url: URL
  try { url = new URL(rawUrl) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  const discordHost = host === 'discord.com' || host === 'discordapp.com'
    || host.endsWith('.discord.com') || host.endsWith('.discordapp.com')
  return discordHost && url.pathname.startsWith('/api/webhooks/')
}

/** Discord rejects embeds whose description exceeds 4096 characters. */
const MAX_DESCRIPTION = 3800
/** Red for a failure, amber for a warning, green for a recovery. */
const COLOR_FAIL = 0xd9_36_3b
const COLOR_WARN = 0xd9_8b_1e
const COLOR_OK = 0x2e_9e_4f

interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

export interface DiscordWebhookBody {
  username: string
  embeds: Array<{
    title: string
    description?: string
    color: number
    fields?: DiscordEmbedField[]
    url?: string
    timestamp?: string
    footer?: { text: string }
  }>
}

function clamp(value: string, max = MAX_DESCRIPTION): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function isHealth(
  payload: WebhookPayload | InsightWebhookPayload | HealthWebhookPayload,
): payload is HealthWebhookPayload {
  return payload.event === 'health.degraded' || payload.event === 'health.recovered'
}

function healthEmbed(payload: HealthWebhookPayload): DiscordWebhookBody {
  const { health, project } = payload
  const recovered = payload.event === 'health.recovered'
  const color = recovered ? COLOR_OK : health.status === 'fail' ? COLOR_FAIL : COLOR_WARN

  const fields: DiscordEmbedField[] = [
    { name: 'Status', value: recovered ? 'recovered' : health.status, inline: true },
    { name: 'Check', value: health.code, inline: true },
  ]
  if (health.previousStatus) {
    fields.push({ name: 'Was', value: health.previousStatus, inline: true })
  }
  if (health.remediation) {
    fields.push({ name: 'What to do', value: clamp(health.remediation, 1000) })
  }
  // Everything else that is unhappy, so a single headline never hides the rest.
  const others = health.failing.filter(check => check.code !== health.code)
  if (others.length > 0) {
    fields.push({
      name: `Also failing (${others.length})`,
      value: clamp(others.map(c => `• \`${c.status}\` ${c.code}`).join('\n'), 1000),
    })
  }

  return {
    username: 'Canonry',
    embeds: [{
      title: recovered
        ? `✅ ${project.name} recovered`
        : `${health.status === 'fail' ? '🔴' : '🟠'} ${project.name} — measurement degraded`,
      description: clamp(health.summary),
      color,
      fields,
      url: payload.dashboardUrl,
      timestamp: health.checkedAt,
      footer: { text: project.canonicalDomain },
    }],
  }
}

function runEmbed(payload: WebhookPayload | InsightWebhookPayload): DiscordWebhookBody {
  const failed = payload.event === 'run.failed'
  const transitions = 'transitions' in payload ? payload.transitions : []
  const insights = 'insights' in payload ? payload.insights : []

  const fields: DiscordEmbedField[] = [
    { name: 'Event', value: payload.event, inline: true },
    { name: 'Run', value: payload.run.status, inline: true },
  ]
  if (transitions.length > 0) {
    fields.push({
      name: `Changes (${transitions.length})`,
      value: clamp(
        transitions.slice(0, 10)
          .map(t => `• ${t.provider}: \`${t.from}\` → \`${t.to}\` — ${t.query}`)
          .join('\n'),
        1000,
      ),
    })
  }
  if (insights.length > 0) {
    fields.push({
      name: `Insights (${insights.length})`,
      value: clamp(insights.slice(0, 10).map(i => `• [${i.severity}] ${i.title}`).join('\n'), 1000),
    })
  }

  return {
    username: 'Canonry',
    embeds: [{
      title: `${failed ? '🔴' : '📊'} ${payload.project.name}`,
      color: failed ? COLOR_FAIL : COLOR_OK,
      fields,
      url: payload.dashboardUrl,
      ...(payload.run.finishedAt ? { timestamp: payload.run.finishedAt } : {}),
      footer: { text: payload.project.canonicalDomain },
    }],
  }
}

export function toDiscordWebhookBody(
  payload: WebhookPayload | InsightWebhookPayload | HealthWebhookPayload,
): DiscordWebhookBody {
  return isHealth(payload) ? healthEmbed(payload) : runEmbed(payload)
}
