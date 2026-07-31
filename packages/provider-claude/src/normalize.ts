import Anthropic from "@anthropic-ai/sdk";
import type { WebSearchTool20250305 } from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  AI_ENGINE_SELF_DOMAINS,
  hostMatchesAnyDomain,
  hostOf,
  normalizeServedModel,
  registrableDomain,
} from "@ainyc/canonry-contracts";
import { withRetry } from "./utils.js";
import type {
  ClaudeConfig,
  ClaudeHealthcheckResult,
  ClaudeNormalizedResult,
  ClaudeRawResult,
  ClaudeTrackedQueryInput,
  GroundingSource,
} from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const VALIDATION_PATTERN = /^claude-/;

/**
 * Claude decides for itself whether a query warrants a search, and answers
 * stable-knowledge questions from training data instead. That judgement tightened
 * between Sonnet 4.6 and Sonnet 5: over a 60-day window Sonnet 4.6 searched on all
 * 136 tracked answers, while Sonnet 5 searched on only 84 of 119. Every one of the
 * 35 unsearched answers recorded zero cited domains and zero mentions, so they
 * entered visibility rates as genuine absences rather than as answers the brand
 * never had a chance to appear in.
 *
 * Anthropic documents the system prompt, not `tool_choice`, as the lever for
 * widening the search trigger; `max_uses` only caps searches and cannot raise the
 * floor. Forcing via `tool_choice` does work on this server tool but prefills the
 * assistant turn, which suppresses the preamble text we parse as the answer and
 * measurably narrows retrieval (1 search / 3 cited URLs versus 2 / 7-9 here).
 *
 * The wording below names no brand, domain, competitor, or ranking, so it steers
 * retrieval only and leaves the substance of the answer to the model.
 *
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
const RETRIEVAL_SYSTEM_PROMPT =
  "You are answering as a consumer-facing assistant with web access. " +
  "Always search the web before answering so your response reflects current, " +
  "real-world sources. Do not answer from prior knowledge alone.";

/**
 * Resolve the effective model name, validating that it is a recognised Claude
 * model identifier (must start with "claude-"). If an invalid name is stored
 * the default is used and a warning is logged.
 */
function resolveModel(config: ClaudeConfig): string {
  const m = config.model;
  if (!m) return DEFAULT_MODEL;
  if (VALIDATION_PATTERN.test(m)) return m;
  console.warn(
    `[provider-claude] Invalid model name "${m}" — this provider uses the Anthropic API ` +
      `which only accepts "claude-*" model names. ` +
      `Falling back to ${DEFAULT_MODEL}.`,
  );
  return DEFAULT_MODEL;
}

export function validateConfig(config: ClaudeConfig): ClaudeHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: "claude", message: "missing api key" };
  }
  const model = resolveModel(config);
  const warning =
    config.model && !VALIDATION_PATTERN.test(config.model)
      ? ` (invalid model "${config.model}" replaced with default)`
      : "";
  return {
    ok: true,
    provider: "claude",
    message: `config valid${warning}`,
    model,
  };
}

export async function healthcheck(
  config: ClaudeConfig,
): Promise<ClaudeHealthcheckResult> {
  const validation = validateConfig(config);
  if (!validation.ok) return validation;

  try {
    const model = resolveModel(config);
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: 'Say "ok"' }],
      }),
    );
    const text = extractTextFromResponse(response);
    return {
      ok: text.length > 0,
      provider: "claude",
      message:
        text.length > 0
          ? "claude api key verified"
          : "empty response from claude",
      model,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      provider: "claude",
      message: err instanceof Error ? err.message : String(err),
      model: resolveModel(config),
    };
  }
}

export async function executeTrackedQuery(
  input: ClaudeTrackedQueryInput,
): Promise<ClaudeRawResult> {
  const model = resolveModel(input.config);
  const client = new Anthropic({ apiKey: input.config.apiKey });

  const webSearchTool: Record<string, unknown> = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 5,
  };
  if (input.location) {
    webSearchTool.user_location = {
      type: "approximate",
      city: input.location.city,
      region: input.location.region,
      country: input.location.country,
      ...(input.location.timezone ? { timezone: input.location.timezone } : {}),
    };
  }

  try {
    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 4096,
        system: RETRIEVAL_SYSTEM_PROMPT,
        tools: [webSearchTool as unknown as WebSearchTool20250305],
        messages: [{ role: "user", content: input.query }],
      }),
    );

    const rawResponse = responseToRecord(response);
    const parsed = reparseStoredResult(rawResponse);
    if (parsed.providerError) {
      throw new Error(parsed.providerError);
    }

    return {
      provider: "claude",
      rawResponse,
      model,
      servedModel: extractServedModel(rawResponse),
      groundingSources: parsed.groundingSources,
      searchQueries: parsed.searchQueries,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[provider-claude] ${msg}`);
  }
}

export function normalizeResult(raw: ClaudeRawResult): ClaudeNormalizedResult {
  const parsed = reparseStoredResult(raw.rawResponse);
  const useParsed = hasParsedResponseContent(raw.rawResponse);
  const groundingSources = useParsed
    ? parsed.groundingSources
    : raw.groundingSources;
  const searchQueries = useParsed ? parsed.searchQueries : raw.searchQueries;
  const citedDomains = extractCitedDomainsFromSources(groundingSources);

  return {
    provider: "claude",
    answerText: parsed.answerText,
    citedDomains,
    groundingSources,
    searchQueries,
  };
}

function hasParsedResponseContent(
  rawResponse: Record<string, unknown>,
): boolean {
  return Array.isArray(rawResponse.content) && rawResponse.content.length > 0;
}

/**
 * Read the model Claude reported serving off a stored raw response. A response that
 * omits `model` yields undefined rather than the configured model.
 */
export function extractServedModel(
  rawResponse: Record<string, unknown>,
): string | undefined {
  return normalizeServedModel(rawResponse.model);
}

export function reparseStoredResult(
  rawResponse: Record<string, unknown>,
): ClaudeNormalizedResult & { providerError?: string } {
  const groundingSources = extractGroundingSourcesFromRaw(rawResponse);
  const searchQueries = extractSearchQueriesFromRaw(rawResponse);

  const providerErrors = extractWebSearchToolErrors(rawResponse);

  return {
    provider: "claude",
    answerText: extractAnswerTextFromRaw(rawResponse),
    citedDomains: extractCitedDomainsFromSources(groundingSources),
    groundingSources,
    searchQueries,
    ...(providerErrors.length > 0
      ? { providerError: `web_search tool error: ${providerErrors.join(", ")}` }
      : {}),
  };
}

// --- Internal helpers ---

function extractTextFromResponse(response: Anthropic.Message): string {
  try {
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  } catch {
    return "";
  }
}

function extractGroundingSourcesFromRaw(
  rawResponse: Record<string, unknown>,
): GroundingSource[] {
  const sources: GroundingSource[] = [];
  const seen = new Set<string>();
  try {
    // Anthropic distinguishes retrieved `web_search_result` entries from final citations on
    // `text.citations` entries with `type: "web_search_result_location"`, so we only count
    // the latter as citation evidence.
    // Docs: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
    // SDK: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
    const content = rawResponse.content as
      | Array<{
          type?: string;
          citations?: Array<{
            type?: string;
            url?: string;
            title?: string | null;
          }> | null;
        }>
      | undefined;
    if (!content) return [];

    for (const block of content) {
      if (block.type === "text" && Array.isArray(block.citations)) {
        for (const citation of block.citations) {
          if (
            citation.type === "web_search_result_location" &&
            typeof citation.url === "string" &&
            !seen.has(citation.url)
          ) {
            seen.add(citation.url);
            sources.push({
              uri: citation.url,
              title: citation.title ?? "",
            });
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return sources;
}

function extractSearchQueriesFromRaw(
  rawResponse: Record<string, unknown>,
): string[] {
  const queries = new Set<string>();
  try {
    // Anthropic's web-search response examples show the executed search on the preceding
    // `server_tool_use.input.query` block, so we recover telemetry from that block instead
    // of from `web_search_tool_result`.
    // Docs: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
    const content = rawResponse.content as
      | Array<{
          type?: string;
          name?: string;
          input?: {
            query?: unknown;
            queries?: unknown;
          };
        }>
      | undefined;
    if (!content) return [];

    for (const block of content) {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        if (
          typeof block.input?.query === "string" &&
          block.input.query.length > 0
        ) {
          queries.add(block.input.query);
        }
        if (Array.isArray(block.input?.queries)) {
          for (const query of block.input.queries) {
            if (typeof query === "string" && query.length > 0) {
              queries.add(query);
            }
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return [...queries];
}

function extractAnswerTextFromRaw(
  rawResponse: Record<string, unknown>,
): string {
  try {
    const content = rawResponse.content as
      | Array<{
          type: string;
          text?: string;
        }>
      | undefined;

    if (!content) return "";

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
    }
    return parts.join("");
  } catch {
    return "";
  }
}

function extractWebSearchToolErrors(
  rawResponse: Record<string, unknown>,
): string[] {
  const errors = new Set<string>();
  try {
    // Anthropic documents that web-search failures can still arrive in a successful message
    // response as `web_search_tool_result` blocks whose `content` is a
    // `web_search_tool_result_error`.
    // Docs: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
    // SDK: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
    const content = rawResponse.content as
      | Array<{
          type?: string;
          content?: unknown;
        }>
      | undefined;
    if (!content) return [];

    for (const block of content) {
      if (block.type !== "web_search_tool_result") continue;
      if (
        block.content === null ||
        typeof block.content !== "object" ||
        Array.isArray(block.content)
      )
        continue;
      const errorCode = (block.content as { error_code?: unknown }).error_code;
      if (typeof errorCode === "string" && errorCode.length > 0) {
        errors.add(errorCode);
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return [...errors];
}

function extractCitedDomainsFromSources(
  groundingSources: GroundingSource[],
): string[] {
  const domains = new Set<string>();

  for (const source of groundingSources) {
    const domain = extractDomainFromUri(source.uri);
    if (domain) domains.add(domain);
  }

  return [...domains];
}

function extractDomainFromUri(uri: string): string | null {
  const hostname = hostOf(uri);
  if (
    !hostname ||
    !registrableDomain(hostname) ||
    hostMatchesAnyDomain(hostname, AI_ENGINE_SELF_DOMAINS.chatgpt)
  ) {
    return null;
  }
  return hostname;
}

export async function generateText(
  prompt: string,
  config: ClaudeConfig,
): Promise<string> {
  const model = resolveModel(config);
  const client = new Anthropic({ apiKey: config.apiKey });
  const response = await withRetry(() =>
    client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  );
  return extractTextFromResponse(response);
}

function responseToRecord(
  response: Anthropic.Message,
): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  } catch {
    return { error: "failed to serialize response" };
  }
}
