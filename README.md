# Canonry <img src="https://raw.githubusercontent.com/Canonry/canonry/main/apps/web/public/favicon-32.png" alt="Canonry canary icon" width="24" />

[![npm version](https://img.shields.io/npm/v/@canonry/canonry)](https://www.npmjs.com/package/@canonry/canonry) [![Node.js >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)](https://nodejs.org)

**Give your agent the evidence, tools, and skills to run AEO.**

Canonry is an **agent-first, open-source AEO operating platform.**

**Connect your agent:** [Agent Plugin](docs/plugins.md) · [MCP](docs/mcp.md) · CLI · REST API

- **Track AI visibility:** Brand mentions and citations across answer engines.
- **Compare competitors:** Citation gaps and the domains and pages getting cited.
- **Measure complex portfolios:** Properties and market groups, with questions, engines, models, and locations tailored per property.
- **Investigate site activity:** Search analytics, server-side crawler visits, AI page fetches, referrals, and technical audits.
- **Act on the evidence:** Plan content, update WordPress pages, deploy structured data, submit sitemaps, and prepare paused ChatGPT Ads campaigns for approval.

**Self-hosted, with your own provider keys.** Use the dashboard to review the same evidence and recommendations as your agent.

`npm install -g @canonry/canonry`

![Canonry architecture: your agent connects through MCP, CLI, or REST API to measurement, project evidence, and execution tools. Agent Plugin skills guide the work. Webhooks return events.](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/measure-act.svg)

**Give your agent a job:**

> Find a question where competitors get cited and we don't. Compare their cited pages with our relevant page, using our search data, server-side traffic, and site audit. Propose a content update for review. After I approve it, publish through WordPress, submit the sitemap, and rerun the checks.

Your agent coordinates the steps using Canonry's tools and returns the results for review.

### Compare competitors and measure complex portfolios

- **Competitor comparisons:** Compare brand mentions and citations across tracked questions and answer engines. Find questions where competitors are cited and your site is absent.
- **Who gets cited:** [Rank cited domains](skills/canonry/references/canonry-cli.md#cited-source-rankings-cnry-sources) and inspect exact URLs, including your pages, competitors, aggregators, and publishers.
- **Advanced Measurement:** Build [versioned measurement plans](docs/mcp.md#tool-surface) for portfolios of locations, products, or site sections. Assign questions, engines, models, and locations per property, separate branded and non-brand coverage, and organize overlapping market groups with their own competitors. Compare results across properties, groups, answer engines, and locations, then drill down to exact answers and cited sources.

### Built-in integrations and workflows

- **Answer engines:** Canonry measures Gemini, ChatGPT, Claude, Perplexity, and OpenAI-compatible local models.
- **Agent workflows:** Use the [MCP adapter](docs/mcp.md), [Agent Plugin](docs/plugins.md), [external webhooks](skills/canonry/references/canonry-cli.md#agent), or built-in [Aero](skills/aero/SKILL.md).
- **Search and analytics:** Connect [Google Search Console](docs/google-search-console-setup.md), [Google Analytics 4](docs/google-analytics-setup.md), and [Bing Webmaster Tools](docs/bing-webmaster-setup.md).
- **Server traffic:** Inspect recorded crawler visits, AI page fetches, and referral arrivals from [Cloudflare, Cloud Run, Vercel, and WordPress](skills/canonry/references/server-side-traffic.md).
- **Backlinks:** Query [Common Crawl hyperlink releases](skills/canonry/references/canonry-cli.md#backlinks-common-crawl) locally with DuckDB, and sync new releases on a schedule.
- **Paid media:** Connect [OpenAI Ads Manager](docs/mcp.md#tool-surface) for account, conversion, campaign, and performance workflows.
- **Conversion measurement:** Audit [Google Ads and Google Tag Manager](docs/google-marketing.md) with read-only snapshots and declared conversion contracts.
- **Local presence:** Connect [Google Business Profile](skills/canonry/references/google-business-profile.md) for search terms, performance, lodging data, and booking actions.
- **Publishing and indexing:** Publish through [WordPress](docs/wordpress-setup.md), generate JSON-LD, and [submit sitemaps or URLs for indexing](skills/canonry/references/indexing.md).
- **Client reporting:** Automate [scheduled checks and data syncs](skills/canonry/references/canonry-cli.md#scheduling--notifications), send webhook alerts, and generate [client-ready HTML reports](skills/canonry/references/canonry-cli.md#reports).

The dashboard, CLI, and agent tools share the same project API.

<a id="or-use-any-shell-capable-coding-agent"></a>

## Start with your agent

Connect the [Agent Plugin](docs/plugins.md) or [MCP adapter](docs/mcp.md) to your agent. For any shell-capable agent, copy the setup request below.

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

## Get a Page Health baseline

![Canonry Site Map graph](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/dashboard.png)

*Map crawlable pages and the internal links connecting them.*

1. Install Canonry.

   ```bash
   npm install -g @canonry/canonry
   ```

2. Create the local configuration, SQLite database, and full-instance API key.

   ```bash
   cnry bootstrap
   ```

   Canonry stores `config.yaml` and `data.db` in `~/.canonry` by default. Set
   `CANONRY_CONFIG_DIR` before `bootstrap`, `serve`, and later CLI commands to
   keep an install in another private directory; use the same value every time.

3. Start Canonry.

   ```bash
   cnry serve
   ```

4. Open [http://127.0.0.1:4100/setup](http://127.0.0.1:4100/setup). If prompted, create a dashboard password.

5. Enter your domain and approve the public-site crawl. This crawl creates a persisted Page Health baseline. AI Visibility is optional.

6. To use the terminal instead, keep `cnry serve` running. Open a second terminal and run:

   ```bash
   cnry project create my-site --domain example.com --country US --language en
   cnry technical-aeo run my-site --max-pages 100 --wait --format json
   ```

7. Read the run ID and status from the output. If the status is `completed` or `partial`, read evidence from that run:

   ```bash
   cnry technical-aeo score my-site --run-id <run-id> --format json
   cnry technical-aeo pages my-site --run-id <run-id> --sort score-asc --limit 10 --format jsonl
   ```

   `--wait` polls for up to 15 minutes. If the scan remains active, use the progress command below. If it fails or is cancelled, inspect it with `cnry run show <run-id> --format json`.

## Add AI Visibility when you need it

![Canonry AI Visibility mention share trend across answer engines](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/ai-visibility-trend.png)

*Track your share of answer-engine brand mentions over time.*

![Canonry AI Visibility citation map across queries and answer engines](https://raw.githubusercontent.com/Canonry/canonry/main/docs/images/ai-visibility-diagnostics.png)

*Map citation and answer-mention coverage across every tracked query and engine.*

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
| **Dashboard** | Review recommendations, inspect evidence, and observe the same project record used by agents. |

## Deployment and trust boundary

Canonry is self-hosted and single-tenant. Run one instance for one operator or team, and isolate unrelated teams on separate instances.

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
| **Integrations** | [GSC](docs/google-search-console-setup.md) · [GA4](docs/google-analytics-setup.md) · [Google Ads + GTM](docs/google-marketing.md) · [Bing](docs/bing-webmaster-setup.md) · [Google Business Profile](skills/canonry/references/google-business-profile.md) · [WordPress](docs/wordpress-setup.md) · [Server-side traffic (Cloudflare direct push or Queue pull, Cloud Run, Vercel, WordPress)](skills/canonry/references/server-side-traffic.md) |
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
