# agy-context — Context Insights for Antigravity

Inspired by [`dsh-context`](https://www.npmjs.com/package/dsh-context) for DeepSeek Harness. Shows **what your agent is carrying, how it got there, and what it costs** — from local conversation logs (read-only, no network).

## Feature map (vs. dsh-context)

| dsh-context | agy-context |
| --- | --- |
| Context Insights page (KPIs, 7-day chart, heatmap, skills / tools / commands, session cards with filter, search, group by workspace) | **Insights** tab: same, plus click a tool / program / skill / heatmap day to filter conversations, search, group by project, sort, cost estimate |
| Context Stats / Token Stats / Timing Stats | KPI cards: turns, steps, tool calls, requests, fresh / cache / output tokens, cache hit rate, active time (model vs. tools), truncations, estimated cost |
| Current Context (stack vs. model window) | **Current context** gauge vs. a configurable window, calibrated to the real request size (system prompt + tools + rules shown separately) |
| Context Trend (per-request stacked bars, Step/Turn, Total/Delta, overview, ✂ markers, hover, pin, step brief) | Same: stacked bars per request, Step/Turn, Total/Delta, fit-to-width, ✂ checkpoint markers, hover details, click to pin, and the pinned request's actual prompt / cache / output, user message, what was added, response |
| Context Browser (what any request is made of, expandable items) | **Browser**: items a request carried since the last checkpoint, grouped by category, each expandable to its raw text |
| Context Events (inject / compact / prune / switch / mode) | **Events**: compact (with tokens reclaimed), inject (system messages, reminders), skill loads, errors, user messages; filter chips; click → browse that request |
| File Activity (read / written / searched / images, +/- lines, ops log) | **Files**: same filters + path search, +/- lines per file, search hits, per-file operation log with raw step text |
| Command Executions | **Commands**: status (ok / fail / background), duration, program distribution, search, slowest |
| Fleet tab (agent network) | **Fleet**: parent / subagent conversations as a tree with context, composition, status, time, cost; open context or chat |
| Preferences + system prompt prefix/suffix | **Settings**: defaults, context window, cost rates, trend defaults, and **custom instructions** saved as this plugin's always-on rule |
| `/context` command | `context` skill (`/context`) + CLI `session`, `overview`, `list`, `fleet`, `browse` |

Not applicable to Antigravity: pruning events, model-switch / mode events (not recorded in logs), Skill Injections category (skill loads are shown as events/stats), PTC `run_code`.

### Ask an agent

- **Side question** — starts a *separate* read-only conversation seeded with the report, so the main conversation stays untouched.
- **Copy /btw** — copies a ready-made `/btw …` line; paste it in the composer to use Antigravity's native `/btw` (isolated side question). The sidecar SDK has no API to trigger the native `/btw` directly, hence the copy button.

## Data

`~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript_full.jsonl`

- Token numbers (`input`, `cache_read`, `output`) are provider-reported per model request; context size = input + cache read.
- Composition and per-category numbers are estimates (≈3.6 chars/token ASCII, ≈1.4 CJK), calibrated to the real request size in the gauge and trend. Tool results are attributed to the tool that produced them.
- Timing is derived from step timestamps (model time per request is capped at 3 min, so approval waits don't dominate).
- Older logs without token fields still get composition, events, files and commands.
- Summaries are cached in `~/.gemini/antigravity/plugin_data/agy-context/cache.json` (safe to delete); settings in `settings.json` next to it.

## Install

### Global

```bash
git clone https://github.com/Wandering233/antigravity-context-insights.git ~/.gemini/config/plugins/agy-context
```

Restart Antigravity, then open **Context Insights** from the side-pane list, or run `/context`.

### Workspace Sandbox (Testing)

To test inside a specific repository without modifying global configurations:

```bash
mkdir -p .agents/plugins
git clone https://github.com/Wandering233/antigravity-context-insights.git .agents/plugins/agy-context
```

## Layout

```
plugin.json
lib/analyzer.mjs      # streaming log analyzer, drill-down, fleet, cache (zero dependencies)
lib/report.mjs        # markdown reports + side-question prompt
lib/settings.mjs      # preferences + custom-instructions rule
lib/cli.mjs           # CLI used by the skill
skills/context/       # /context skill
sidecars/insights/    # side-pane dashboard (sidecar_sdk, POST-only token-protected API)
rules/AGENTS.md       # created only when custom instructions are set
```

## Privacy

The sidecar binds to loopback via `sidecar_sdk` and every endpoint requires the sidecar token. Nothing is written outside the plugin's cache/settings files (and `rules/AGENTS.md` when you set custom instructions). Raw conversation text is only sent to the local UI when you expand an item in Browser / Files / Commands. "Side question" sends the generated report (titles, counts, sizes, file paths — not message text) to a new agent conversation.

## License

MIT

