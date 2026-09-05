import fs from 'node:fs'
import path from 'node:path'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentOptions, AgentTool } from '@mariozechner/pi-agent-core'
import { registerBuiltInApiProviders, streamSimple, type Model } from '@mariozechner/pi-ai'
import type { DatabaseClient } from '@ainyc/canonry-db'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import { streamEngineRouteText } from '../engine-route-text-execution.js'
import { resolveEngineConnectionTextApiKey } from '../engine-routes.js'
import {
  agentProviderApiKeyEnvVar,
  agentProvidersByPriority,
  configuredTextRoute,
  defaultModelForAeroProvider,
  detectAeroProvider,
  resolveApiKeyFor,
  resolveAeroProviderModel,
  validateAgentProviderRegistry,
  type AeroProviderId,
  type ConfiguredTextRoute,
  type SupportedAgentProvider,
} from './providers.js'
import { resolveAeroSkillDir } from './skill-paths.js'
import { buildSkillDocTools } from './skill-tools.js'
import {
  AeroToolProfiles,
  AeroToolScopes,
  buildAeroStateTools,
  type AeroToolProfile,
  type AeroToolScope,
} from './tools.js'
import {
  AERO_PROMPT_FAMILY,
  AERO_PROMPT_VERSION,
  AeroLlmUsageFeatures,
  recordLlmUsageEvent,
} from './llm-usage.js'
import { splitAeroAnthropicSystemCachePayload } from './prompt-cache.js'
import { createAeroToolUsageHooks } from './tool-usage.js'

export type { SupportedAgentProvider } from './providers.js'
export type { AeroProviderId } from './providers.js'
export { AgentProviders, listAgentProviders, coerceAeroProvider, coerceAgentProvider } from './providers.js'

let builtinsRegistered = false
function ensureBuiltinsRegistered(): void {
  if (!builtinsRegistered) {
    registerBuiltInApiProviders()
    validateAgentProviderRegistry()
    builtinsRegistered = true
  }
}

export interface AeroSessionOptions {
  projectName: string
  client: ApiClient
  config: CanonryConfig
  /** Explicit native or configured `route:*` provider. Default: auto-detect. */
  provider?: AeroProviderId
  /** Explicit model id within the chosen provider. Default: provider's default. */
  modelId?: string
  /** Override system prompt (skips aero skill file load). Useful for tests. */
  systemPromptOverride?: string
  /** Override streamFn — used by tests via pi-ai's faux provider. */
  streamFn?: AgentOptions['streamFn']
  /** Override tool set. Default: `buildAllTools({ client, projectName })` — reads + writes. */
  tools?: AgentTool[]
  /**
   * Tool surface scope. 'all' exposes reads + writes (default). 'read-only'
   * exposes only the read tools — used by the dashboard bar where we don't
   * yet have a confirmation UX for destructive/additive actions.
   */
  toolScope?: AeroToolScope
  /** Optional profile that narrows the tool surface for specific operator workflows. */
  toolProfile?: AeroToolProfile
  /** Seed initial transcript. Used by the registry when rehydrating a persisted session. */
  initialMessages?: import('@mariozechner/pi-agent-core').AgentMessage[]
  /** Optional telemetry context. When present, assistant turn usage is appended to llm_usage_events. */
  db?: DatabaseClient
  projectId?: string
  agentSessionId?: string
  /** Internal frozen route generation used by SessionRegistry. */
  routeSnapshot?: ConfiguredTextRoute
}

export { resolveAeroSkillDir } from './skill-paths.js'

/**
 * Compose the system prompt from soul.md (identity/voice) + SKILL.md (task
 * rules). Soul is optional — SKILL.md alone is a valid prompt — but when
 * present it's prepended so identity frames the task instructions.
 */
export function loadAeroSystemPrompt(pkgDir?: string): string {
  const skillDir = resolveAeroSkillDir(pkgDir)
  const skillBody = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
  const soulPath = path.join(skillDir, 'soul.md')
  const base = fs.existsSync(soulPath)
    ? `${fs.readFileSync(soulPath, 'utf-8').trimEnd()}\n\n---\n\n${skillBody}`
    : skillBody
  return appendSystemPromptExtras(base)
}

/**
 * Generic system-prompt APPEND seam (OSS-D). Appends `AERO_SYSTEM_PROMPT_APPEND`
 * (inline) and/or the contents of `AERO_SYSTEM_PROMPT_FILE` (a file path) AFTER
 * the base soul+SKILL prompt, separated by a divider. Empty by default, so a
 * default install is byte-identical. Generic: carries no product vocabulary.
 *
 * Lives inside `loadAeroSystemPrompt` so it covers BOTH the one-shot
 * `createAeroSession` default path AND the registry (which builds on
 * `loadAeroSystemPrompt`, then layers the dynamic `<memory>` block AFTER, so the
 * appended rules frame the task and sit before per-session memory). A
 * `systemPromptOverride` (tests / explicit full control) deliberately bypasses
 * this. A missing or unreadable file is skipped, never breaking the agent. The
 * FILE variant exists so a multi-KB prompt is mounted as a file rather than
 * crammed into a single `-e` env arg. Exported for tests.
 */
export function appendSystemPromptExtras(
  base: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inline = env.AERO_SYSTEM_PROMPT_APPEND?.trim()
  let fileBody = ''
  const filePath = env.AERO_SYSTEM_PROMPT_FILE?.trim()
  if (filePath) {
    try {
      fileBody = fs.readFileSync(filePath, 'utf-8').trim()
    } catch {
      fileBody = ''
    }
  }
  const extras = [inline, fileBody].filter((s): s is string => !!s && s.length > 0)
  if (extras.length === 0) return base
  return `${base.trimEnd()}\n\n---\n\n${extras.join('\n\n')}`
}

function missingProviderMessage(): string {
  const configHints = agentProvidersByPriority().join(', ')
  const envHints = agentProvidersByPriority().map(agentProviderApiKeyEnvVar).join(' / ')
  return (
    `No agent LLM provider configured. Add an API key for one of: ${configHints} in ` +
    `~/.canonry/config.yaml, export ${envHints}, or configure a text route under engineRoutes.`
  )
}

/** Pick the first configured agent provider — canonry config first, then pi-ai env-var fallback. */
export function detectAgentProvider(config: CanonryConfig): SupportedAgentProvider | undefined {
  for (const provider of agentProvidersByPriority()) {
    if (resolveApiKeyFor(provider, config)) return provider
  }
  return undefined
}

export function resolveAeroModel(
  provider: AeroProviderId,
  config: CanonryConfig,
  modelId?: string,
  routeSnapshot?: ConfiguredTextRoute,
): Model<never> {
  ensureBuiltinsRegistered()
  return resolveAeroProviderModel(provider, config, modelId, routeSnapshot)
}

/** Resolver used by pi's `getApiKey` callback — `resolveApiKeyFor` handles canonry config and env-var fallback. */
export function buildApiKeyResolver(
  config: CanonryConfig,
): (piAiProvider: string) => string | undefined {
  return (piAiProvider: string) => resolveApiKeyFor(piAiProvider, config)
}

/** Freeze a configured route's credential generation for the whole turn. */
function buildRouteApiKeyResolver(
  route: ConfiguredTextRoute,
): NonNullable<AgentOptions['getApiKey']> {
  const apiKey = resolveEngineConnectionTextApiKey(route.connection)
  if (!apiKey) {
    throw new Error(
      `Configured text route '${route.route.id}' requires an API key for its ${route.connection.preset} connection.`,
    )
  }
  return (piAiProvider: string) => piAiProvider === route.route.id ? apiKey : undefined
}

function buildAeroProviderSessionId(opts: AeroSessionOptions): string {
  return `canonry:aero:${opts.agentSessionId ?? opts.projectId ?? opts.projectName}`
}

/**
 * The stream function a provider must run under. A route streams INSIDE its
 * connection's execution gate and holds the slot until the terminal event; a
 * native provider must not be wrapped at all.
 *
 * Exported because the provider can change AFTER construction (alignModel) and
 * the gate has to move with it. `Agent.streamFn` is fixed when the Agent is
 * built, so swapping only the model left a session switched TO a route
 * streaming completely outside its quota, and one switched to a native provider
 * still serialized behind the gateway's concurrency limit.
 */
export function aeroStreamFnFor(
  config: CanonryConfig,
  provider: AeroProviderId,
  base?: AgentOptions['streamFn'],
  db?: DatabaseClient,
  routeSnapshot?: ConfiguredTextRoute,
): NonNullable<AgentOptions['streamFn']> {
  const streamFn = base ?? streamSimple
  if (!provider.startsWith('route:')) return streamFn
  const route = routeSnapshot?.route.id === provider
    ? routeSnapshot
    : configuredTextRoute(config, provider)
  if (!route) return streamFn
  return (model, context, options) => streamEngineRouteText(
    route.connection,
    () => streamFn(model, context, options),
    { db, model, signal: options?.signal },
  )
}

export interface AeroSessionRuntime {
  model: Model<never>
  streamFn?: AgentOptions['streamFn']
  getApiKey: NonNullable<AgentOptions['getApiKey']>
  route?: ConfiguredTextRoute
}

/**
 * Resolve model, transport gate, and credential from one route snapshot. The
 * caller can install the returned values synchronously, so no turn can pair a
 * replacement credential with the prior endpoint/model generation.
 */
export function resolveAeroSessionRuntime(
  config: CanonryConfig,
  provider: AeroProviderId,
  modelId?: string,
  opts?: {
    streamFn?: AgentOptions['streamFn']
    db?: DatabaseClient
    routeSnapshot?: ConfiguredTextRoute
  },
): AeroSessionRuntime {
  if (!provider.startsWith('route:')) {
    return {
      model: resolveAeroModel(provider, config, modelId),
      // Preserve construction semantics: undefined lets Agent use pi-ai's
      // default stream function for native providers.
      streamFn: opts?.streamFn,
      getApiKey: buildApiKeyResolver(config),
    }
  }

  const route = opts?.routeSnapshot?.route.id === provider
    ? opts.routeSnapshot
    : configuredTextRoute(config, provider)
  if (!route) {
    throw new Error(`Configured text route '${provider}' is not available on this Canonry instance.`)
  }
  return {
    model: resolveAeroModel(provider, config, modelId, route),
    streamFn: aeroStreamFnFor(config, provider, opts?.streamFn, opts?.db, route),
    getApiKey: buildRouteApiKeyResolver(route),
    route,
  }
}

export function createAeroSession(opts: AeroSessionOptions): Agent {
  const systemPrompt = opts.systemPromptOverride ?? loadAeroSystemPrompt()

  const provider = opts.provider ?? detectAeroProvider(opts.config)
  if (!provider) throw new Error(missingProviderMessage())

  const runtime = resolveAeroSessionRuntime(opts.config, provider, opts.modelId, {
    streamFn: opts.streamFn,
    db: opts.db,
    routeSnapshot: opts.routeSnapshot,
  })

  const toolScope = opts.toolScope ?? AeroToolScopes.all
  const toolProfile = opts.toolProfile ?? AeroToolProfiles.default
  const toolCtx = {
    client: opts.client,
    projectName: opts.projectName,
  }
  // Skill-doc tools ride in both scopes — they're pure reads of bundled
  // assets, no project state involved.
  const stateTools = buildAeroStateTools(toolCtx, { scope: toolScope, profile: toolProfile })
  const defaultTools = [...stateTools, ...buildSkillDocTools()]
  const tools = opts.tools ?? defaultTools
  const toolUsageHooks = opts.db
    ? createAeroToolUsageHooks({
        db: opts.db,
        projectId: opts.projectId,
        agentSessionId: opts.agentSessionId,
        metadata: { projectName: opts.projectName },
      })
    : {}

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: runtime.model,
      tools,
      ...(opts.initialMessages ? { messages: opts.initialMessages } : {}),
    },
    streamFn: runtime.streamFn,
    sessionId: buildAeroProviderSessionId(opts),
    onPayload: splitAeroAnthropicSystemCachePayload,
    ...toolUsageHooks,
    getApiKey: runtime.getApiKey,
  })

  const telemetryDb = opts.db
  if (telemetryDb) {
    agent.subscribe((event) => {
      if (event.type !== 'turn_end') return
      if (event.message.role !== 'assistant') return
      recordLlmUsageEvent({
        db: telemetryDb,
        projectId: opts.projectId,
        agentSessionId: opts.agentSessionId,
        feature: AeroLlmUsageFeatures.turn,
        promptFamily: AERO_PROMPT_FAMILY,
        promptVersion: AERO_PROMPT_VERSION,
        message: event.message,
        metadata: { projectName: opts.projectName, toolCount: agent.state.tools.length },
      })
    })
  }

  return agent
}

/** Exposed so the registry can persist the chosen provider/model without re-running detection. */
export function resolveSessionProviderAndModel(
  config: CanonryConfig,
  opts?: { provider?: AeroProviderId; modelId?: string },
): { provider: AeroProviderId; modelId: string } {
  const provider = opts?.provider ?? detectAeroProvider(config)
  if (!provider) throw new Error(missingProviderMessage())
  const modelId = opts?.modelId ?? defaultModelForAeroProvider(provider, config)
  return { provider, modelId }
}
