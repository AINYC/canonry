# Canonry <img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@canonry/canonry)](https://www.npmjs.com/package/@canonry/canonry) [![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)](https://nodejs.org)

Your entire AEO/GEO/AI Visibility, technical SEO + web analytics stack. **Agent-first. Self-hosted. Local.**

Canonry gives operators and agents one technical record for AI visibility, site health, search, traffic, local presence, and backlinks.

**Measure → diagnose → approve action → measure change**

| Phase | What Canonry does |
|---|---|
| **Measure** | Track mentions and citations across Gemini, ChatGPT, Claude, Perplexity, and local models. Join them with GSC, GA4, Bing, traffic, Business Profile, and backlink data. |
| **Diagnose** | Crawl the site, score Page Health, inspect evidence, compare competitors, and explain regressions. |
| **Act** | Generate content, create WordPress and JSON-LD changes, submit URLs for indexing, and manage ChatGPT ads through approval workflows. |
| **Operate** | Create automation workflows, schedule checks, sync data, manage projects as YAML, send webhooks, and generate client-ready reports. |

### Built-in integrations and workflows

- **Answer engines:** Canonry measures Gemini, ChatGPT, Claude, Perplexity, and OpenAI-compatible local models.
- **Search and analytics:** Connect [Google Search Console](docs/google-search-console-setup.md), [Google Analytics 4](docs/google-analytics-setup.md), and [Bing Webmaster Tools](docs/bing-webmaster-setup.md).
- **Local presence:** Connect [Google Business Profile](skills/canonry/references/google-business-profile.md) for search terms, performance, lodging data, and booking actions.
- **Server traffic:** Capture events from [Cloudflare, Cloud Run, Vercel, and WordPress](skills/canonry/references/server-side-traffic.md).
- **Publishing and indexing:** Publish through [WordPress](docs/wordpress-setup.md), generate JSON-LD, and [submit sitemaps or URLs for indexing](skills/canonry/references/indexing.md).
- **Backlinks:** Query [Common Crawl hyperlink releases](skills/canonry/references/canonry-cli.md#backlinks-common-crawl) locally with DuckDB, and sync new releases on a schedule.
- **Paid media:** Connect [OpenAI Ads Manager](docs/mcp.md#tool-surface) for account, conversion, campaign, and performance workflows.
- **Operations:** Apply project configuration from YAML with [`cnry apply`](skills/canonry/references/canonry-cli.md#config-as-code). Use [schedules and alerts](skills/canonry/references/canonry-cli.md#scheduling--notifications) and generate [client-ready HTML reports](skills/canonry/references/canonry-cli.md#reports).
- **Agents:** Use the [MCP adapter](docs/mcp.md), [Agent Plugin](docs/plugins.md), [external webhooks](skills/canonry/references/canonry-cli.md#agent), or built-in [Aero](skills/aero/SKILL.md).

The dashboard, CLI, and agent tools share the same project API.

![Canonry Site Map graph](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/dashboard.png)

## Get a Page Health baseline

You need Node.js `>=22.14` and `<26`, plus a public, crawlable site. Site Health does not need an answer-provider key.

```bash
npm install -g @canonry/canonry
cnry bootstrap
cnry serve
```

`cnry bootstrap` creates the local configuration, SQLite database, and full-instance API key. Keep its output private. Provider credentials are optional. Bootstrap imports supported variables already in your environment.

Open [http://127.0.0.1:4100/setup](http://127.0.0.1:4100/setup). By default, the first open asks you to create a dashboard password. Enter your domain and approve the public-site crawl to build a persisted Page Health baseline. AI Visibility is optional.

To use the terminal instead of the setup page, keep `cnry serve` running and open a second terminal:

```bash
cnry project create my-site --domain example.com --country US --language en
cnry technical-aeo run my-site --max-pages 100 --wait --format json
```

The run command returns a run ID and status. If the status is `completed` or `partial`, read evidence from that run:

```bash
cnry technical-aeo score my-site --run-id <run-id> --format json
cnry technical-aeo pages my-site --run-id <run-id> --sort score-asc --limit 10 --format jsonl
```

`--wait` polls for up to 15 minutes. If the scan remains active, use the progress command below. If it fails or is cancelled, inspect it with `cnry run show <run-id> --format json`.

The CLI installs as both `cnry` and `canonry`. The commands are interchangeable. The compatibility package `@ainyc/canonry` remains available. Use `@canonry/canonry` for new installations.

## Or use any shell-capable coding agent

If your client supports the [Agent Plugin](docs/plugins.md) or [MCP adapter](docs/mcp.md), use that integration. Otherwise, paste this request into any shell-capable agent.

<details>
<summary>Copy the Site Health-first setup request</summary>

<br />

```text
Help me set up Canonry for my public site.

Use the official Canonry docs:
- Agent quickstart: https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent
- CLI reference: https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md
- Plugin setup: https://github.com/Canonry/canonry/blob/main/docs/plugins.md
- MCP setup: https://github.com/Canonry/canonry/blob/main/docs/mcp.md

If a Canonry installation or connected plugin/MCP is available, use it. Do not create a duplicate. Choose the connected tools or the shell path, not both. The `cnry` and `canonry` commands are interchangeable.

1. Ask for my public domain, country, and language. Do not create or scan anything yet.
2. If connected tools are available, use them for the remaining steps. For the shell path, make sure that `cnry` is on PATH. Then run `cnry --version`. If Canonry is missing, propose `npm install -g @canonry/canonry` and wait for approval. If configuration is missing, tell me to run `cnry bootstrap` in my private terminal and wait. Never ask me to paste passwords, API keys, OAuth credentials, or command output.
3. Make sure that the API or connected tool is reachable. If the shell API is unavailable, propose `cnry start`. Wait for approval. List the projects with the connected project tool or `cnry project list --format json`. Reuse a project with the same domain. Make sure that the proposed name is not assigned to a different domain. If no match exists, show the exact create operation and wait for approval.
4. Propose a bounded Site Health scan. Include `--max-pages` and the state of dead-link checking. Show the connected operation or exact `cnry technical-aeo run ... --wait --format json` command. Wait for separate approval before scanning.
5. If the run status is `completed` or `partial`, read its score and worst pages with run-pinned connected tools. For the shell path, use `cnry technical-aeo score <project> --run-id <run-id> --format json` and `cnry technical-aeo pages <project> --run-id <run-id> --sort score-asc --limit 10 --format jsonl`. If the run failed or was cancelled, inspect the run error and stop. Summarize completed evidence and propose AI Visibility setup.
6. Ask before you add queries, connect providers, start a provider-backed or quota-consuming run, edit files, or publish.
```

</details>

## Add AI Visibility when you need it

Add provider keys in **Settings**. Settings changes apply immediately. To import environment variables, stop Canonry and set the variables. Then run `cnry bootstrap` and restart Canonry.

| Provider | Key source | Environment variable |
|---|---|---|
| Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` |
| OpenAI | [OpenAI Platform](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| Claude | [Anthropic Console](https://console.anthropic.com/settings/keys) | `ANTHROPIC_API_KEY` |
| Perplexity | [Perplexity settings](https://www.perplexity.ai/settings/api) | `PERPLEXITY_API_KEY` |
| Local model | Any OpenAI-compatible endpoint | `LOCAL_BASE_URL` |

Then add the queries that matter and run a measured sweep:

```bash
cnry query add my-site "your first query" "your second query"
cnry run my-site --wait
cnry visibility-stats my-site --by-provider
```

## Technical surface

| Surface | Use it for |
|---|---|
| **CLI and REST API** | Script project measurements, diagnoses, actions, reports, and schedules. OpenAPI is available at `GET /api/v1/openapi.json`. |
| **MCP and Agent Plugin** | Give Codex, Claude, Cursor, or a custom agent a typed, task-shaped tool surface. |
| **Aero** | When enabled and configured, use the built-in analyst that reviews evidence and wakes after completed runs. |
| **Dashboard** | Approve work, inspect evidence, and observe the same project record used by agents. |
| **Config as code** | Declare many projects in YAML and apply them with `cnry apply`. |

## Deployment and trust boundary

Canonry is self-hosted and single-tenant. Run one instance for one operator or team, and isolate unrelated teams on separate instances.

- `cnry serve` runs locally or on your server with SQLite.
- Provider credentials remain on the Canonry instance.
- API keys support project scope and read-only access. A write-scoped project key can change instance settings.
- These key controls do not replace instance isolation.
- The dashboard is a companion to the CLI, API, MCP, and agent surfaces.

See the [deployment guide](docs/deployment.md) for reverse proxies, daemon mode, Docker, systemd, and Tailscale.

## If you get stuck

| Problem | Fix |
|---|---|
| Site scan is still running | Read exact counters with `cnry technical-aeo progress <project> --run-id <id> --format json`. |
| Site scan failed | Read the error with `cnry run show <run-id> --format json`. Read the last phase and counters with the progress command above. |
| No visibility results | Inspect existing work with `cnry runs <project> --format json`, then `cnry run show <run-id> --format json`. This does not start another paid run. |
| Need more query candidates | Run `cnry discover run <project> --icp "..."`. This does not change the basket. Preview a completed session with `cnry discover promote preview <project> <session-id>`. Promote only after approval. |
| Need one-off research | Run `cnry research run <project> "query one" "query two" --wait`. Research does not change the tracked basket. |
| `npm install` fails on `node-gyp` | Install build tools for `better-sqlite3` ([guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)). |

## Documentation

| | |
|---|---|
| **Architecture & data model** | [docs/architecture.md](docs/architecture.md) · [docs/data-model.md](docs/data-model.md) |
| **Aero — built-in agent** | [skills/aero/SKILL.md](skills/aero/SKILL.md) |
| **Agent Plugin — portable core + Codex / Claude adapters** | [docs/plugins.md](docs/plugins.md) |
| **MCP — Claude Desktop / Cursor / Codex** | [docs/mcp.md](docs/mcp.md) |
| **Integrations** | [GSC](docs/google-search-console-setup.md) · [GA4](docs/google-analytics-setup.md) · [Bing](docs/bing-webmaster-setup.md) · [Google Business Profile](skills/canonry/references/google-business-profile.md) · [WordPress](docs/wordpress-setup.md) · [Server-side traffic (Cloudflare direct push or Queue pull, Cloud Run, Vercel, WordPress)](skills/canonry/references/server-side-traffic.md) |
| **Deployment** — reverse proxies, Docker, systemd, Tailscale | [docs/deployment.md](docs/deployment.md) |
| **API** | `GET /api/v1/openapi.json` |
| **Standalone skills bundle** for Claude Code / Codex | `cnry skills install` ([details](skills/canonry/SKILL.md)) |
| **All docs** | [docs/README.md](docs/README.md) |

## Contributing

```bash
git clone https://github.com/Canonry/canonry.git && cd canonry
pnpm install && pnpm run typecheck && pnpm run test && pnpm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[FSL-1.1-ALv2](./LICENSE). Free to use, modify, and self-host. Each version converts to Apache 2.0 after two years.
