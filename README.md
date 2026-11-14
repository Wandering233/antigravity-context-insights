# agy-context — Context Insights for Antigravity

Inspired by [`dsh-context`](https://www.npmjs.com/package/dsh-context) (v0.84.0) for DeepSeek Harness. Shows **what your agent is carrying, how it got there, and what it costs** — entirely from local Antigravity conversation logs and metadata (read-only, no network).

## Feature map (vs. dsh-context)

| dsh-context | agy-context |
| --- | --- |
| Context Insights page (KPIs, custom dates, archived filter, 7-day chart, heatmap with Tokens/Sessions, skills with source/path, tools, commands, paginated session cards with search/group/sort) | **Insights** tab: same — plus reads Antigravity's `conversation_summaries.db` for real titles, workspace paths, running state and archived status |
| Context Stats / Token Stats / Timing Stats | **KPIs + Token Stats + Timing Stats**: turns, steps, model badge, user/answer/skill/event/I-O jump chips, fresh/cache/output tokens, cache hit rate, **TPS (`tok/s`)**, proportional timeline strip (`0..Q3..Total`), own + subagent cost |
| Current Context (stack vs. model window + compaction reserve) | **Current context** gauge calibrated to the real request size against the model's window, with auto-compaction trigger line inferred from checkpoints |
| Context Trend (Step/Turn, Total/Delta, Adaptive, Duration curve with right-side quartile ticks, Overview stacked bands, DNA mode, hover & pinned Step Brief) | Same: **Step / Turn**, **Total / Delta**, **Adaptive** viewport rescaling, **Duration** curve (turns sum step durations, right-side quartile axis), **Overview** continuous stacked bands with category highlight, **DNA** item-fingerprint bars, and live **Step brief** (`User / In / Response`) |
| Context Browser (Treemap, DNA, diff badges, Delta-only filter, searchable step picker, provider tags, Raw/Markdown/JSON tree/Find/Copy, image attachments) | **Browser**: **Treemap**, **DNA** reverse read-order view, **vs prev step / turn** diffs, **Added only**, searchable step picker (`Live` or `T·S`), tool provider tags (`builtin` / `mcp:<server>` / `skill:<name>`), **Raw / Markdown / JSON tree + Find + Copy**, and **image attachment thumbnails** |
| Context Events (inject / compact / switch / mode) | **Events**: compact (with net Δ), inject, skill loads, **model switches** (`A → B`), slash mode commands, errors, user messages |
| File Activity (Read / Written / Searched / Images, 5 sorts, +/- lines, read line ranges, ops log) | **Files**: same filters, **5 sorts** (`Count / Lines / Latest / Path / Name`), file-type glyphs, `+add / −del` lines, read line ranges, search hits, path copy, expandable ops log |
| Command Executions (rail + notable + programs + status + rich viewer) | **Commands**: summary KPIs, **Notable** quick-jumps (`Slowest / Most failing / Most repeated / Background`), searchable programs list, status/heredoc/exit-code/truncated/stderr badges, Raw/MD/Find + Reveal in Browser |
| Fleet tab (Agent network, Cross-agent timeline, Collaborating tasks, Event inspector) | **Fleet**: parent + subagent tree (via logs & `conversation_summaries.db`), **Swimlane timeline** (`Earliest / Latest`, hide quiet lanes), **Collaborating tasks**, and **Event inspector** |
| Preferences + system prompt prefix/suffix | **Settings**: language (`Auto / EN / ZH`), tabs visibility, USD / CNY (`1 CNY = 0.15 USD`), auto reference pricing + custom rates, defaults for trend/browser/tools/files, and **System Prompt Prefix & Suffix** synced to `rules/AGENTS.md` |
| `/context` command | `context` skill (`/context`) + CLI `session`, `overview`, `list`, `fleet`, `browse` |

Not applicable to Antigravity: pruning events (Antigravity truncates via checkpoints rather than pruning tool outputs), PTC `run_code`, DeepSeek account balance widget.

### Ask an agent

- **Side question** — starts a *separate* read-only conversation seeded with the report, leaving the main conversation untouched.
- **Copy /btw** — copies a ready-made `/btw …` prompt to paste in the composer for Antigravity's native `/btw`.

## Data & Privacy

- Reads `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript_full.jsonl` and `~/.gemini/antigravity/conversation_summaries.db` (read-only).
- Summaries are cached in `~/.gemini/antigravity/plugin_data/agy-context/cache.json`; settings in `settings.json`.
- Built-in reference model pricing (`lib/pricing.mjs`) is approximate; override in **Settings** for exact billing rates.
- The sidecar binds to loopback via `sidecar_sdk`, every API route is POST with token validation, and conversation text / local images are only returned to the local UI on explicit drill-down.

## Install

```bash
git clone <this repo> ~/.gemini/config/plugins/agy-context
```

Restart Antigravity, then open **Context Insights** from the side-pane list, or run `/context`.
