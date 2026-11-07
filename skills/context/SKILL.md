---
name: context
description: Context insight for Antigravity conversations. Use when the user asks about context usage, context size, token usage, cache hit rate, what is filling or bloating the context window, why a conversation is slow or expensive, how to slim the context, subagent/fleet usage, or runs /context. Reports composition, per-turn growth, context events (checkpoints), commands, file activity and subagent families for the current or any past conversation, and usage across all conversations.
---

# Context Insights

Read-only analysis of local conversation logs
(`~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript_full.jsonl`).
Provider-reported `input_tokens`, `cache_read_tokens` and `output_tokens` are on
each model step; **context size of a request = fresh input + cache read**.
Composition shares are *estimates* (char-based); token/cache numbers are exact.

## Run the report

The CLI lives at `../../lib/cli.mjs` relative to this `SKILL.md`
(i.e. `<plugin dir>/lib/cli.mjs`). Resolve the absolute path from this file's
location, then:

```bash
# current conversation (use your own conversation ID from the session context)
node <plugin>/lib/cli.mjs session <conversation-id>

# most recent conversation / a past one by ID prefix
node <plugin>/lib/cli.mjs session latest
node <plugin>/lib/cli.mjs session 01e05345

# what exactly did model request #N carry? (items since the last checkpoint, largest first)
node <plugin>/lib/cli.mjs browse <conversation-id> <N>

# agent family: parent + subagent conversations with context/peak/status
node <plugin>/lib/cli.mjs fleet <conversation-id>

# all conversations
node <plugin>/lib/cli.mjs overview --days 7      # 0 = all time
node <plugin>/lib/cli.mjs list --limit 15

# machine-readable (series, events, files with +/- lines, commands, ...)
node <plugin>/lib/cli.mjs session <id> --json
```

The first run parses every log (a few seconds for hundreds of MB); results are
cached in `~/.gemini/antigravity/plugin_data/agy-context/cache.json`, so later
runs are instant.

## How to answer

1. Run `session <current-id>` for "this conversation" questions, `overview` for
   usage-style questions, `fleet` when subagents are involved.
2. Summarize in the user's language; don't paste the whole report. Lead with the
   numbers that matter: current context vs. peak, cache hit rate, number of
   checkpoints (and how much each reclaimed), and the 2–3 largest composition
   categories (prefer "since the last checkpoint" when checkpoints exist).
3. Name the **turns that grew the context most** and what they did; use
   `browse <id> <request#>` on the peak request to name the biggest single items.
4. Give concrete, evidence-based advice, e.g.:
   - large *command output* → pipe through `head`/`grep`/`tail`, redirect to a file;
   - large *file reads* → read line ranges or grep first, avoid re-reading;
   - big *tool-call args* (whole-file writes) → prefer targeted edits;
   - many *checkpoints* / context near the window → start a fresh conversation with
     a short summary, or delegate research to a subagent;
   - low *cache hit* → a changing prefix (rules/skills edits) between turns.
5. Point to the dashboard for visual exploration:
   `[Context Insights](sidecar://agy-context/insights/)` (only if the plugin's
   sidecar is running — see the `ui-plugin-navigation` skill). It has Insights,
   Context (trend, browser, events, files, commands), Fleet and Settings tabs,
   plus **Side question** (isolated analysis conversation) and **Copy /btw**.

## Notes

- Older logs (before token fields were recorded) only have the estimated
  composition; say so rather than inventing token numbers.
- Subagent conversations are separate entries (their own ID).
- Never modify the logs; this skill is strictly read-only.
