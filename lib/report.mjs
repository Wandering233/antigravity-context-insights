// Markdown reports shared by the CLI and the dashboard's "ask agent" prompt.

import { COMP_KEYS } from './analyzer.mjs';

export const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
export const pct = (x) => `${(x * 100).toFixed(1)}%`;
export const when = (t) => (t ? new Date(t).toLocaleString('sv-SE').slice(0, 16) : '-');
export const dur = (ms) => (ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)}h` : ms >= 60e3 ? `${(ms / 60e3).toFixed(1)}m` : `${(ms / 1e3).toFixed(1)}s`);
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
export const LABEL = {
  user: 'User messages', system: 'System / checkpoints', reasoning: 'Reasoning', answer: 'Answers',
  toolCalls: 'Tool calls (args)', commands: 'Command output', files: 'File reads / listings',
  edits: 'Edit results', search: 'Search & web', mcp: 'MCP tools', other: 'Other tool results', skills: 'Skill injections',
};

export function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}
export function compTable(comp) {
  const total = COMP_KEYS.reduce((a, key) => a + (comp[key] || 0), 0) || 1;
  return table(['Category', '≈ Tokens', 'Share'],
    COMP_KEYS.filter((key) => comp[key]).sort((a, b) => comp[b] - comp[a])
      .map((key) => [LABEL[key], k(comp[key]), pct(comp[key] / total)]));
}
export function spark(vals) {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(...vals, 1);
  return vals.map((v) => bars[Math.min(7, Math.floor((v / max) * 7.999))]).join('');
}

export function sessionReport(d) {
  const L = [];
  L.push(`# Context report — ${d.title || d.id}`);
  L.push(`\`${d.id}\` · ${when(d.first)} → ${when(d.last)}${d.project ? ` · project: ${d.project}` : ''}${d.model ? ` · model: ${d.model}` : ''}\n`);
  L.push(`- Turns: **${d.turns}** · steps: ${d.steps} · tool calls: ${d.toolCalls} · errors: ${d.errors} · checkpoints (context truncations): **${d.checkpoints}**`);
  if (d.hasTokens) {
    L.push(`- Model requests: **${d.requests}** · current context: **${k(d.lastCtx)}** tokens · peak: **${k(d.peak)}** · first request: ${k(d.startCtx)} (system prompt + tools + rules + first message)`);
    L.push(`- Fresh input ${k(d.tokens.input)} · cache read ${k(d.tokens.cache)} · output ${k(d.tokens.output)} · cache hit rate **${pct(d.cacheHit)}**${d.cost ? ` · est. cost **$${d.cost.toFixed(2)}**` : ''}`);
    const tail = d.series.slice(-40).map((p) => p[2]);
    L.push(`- Context trend (last ${tail.length} requests): \`${spark(tail)}\``);
    const active = d.timing.model + d.timing.tool;
    if (active) L.push(`- Active time ${dur(active + (d.timing.overhead || 0))}: model ${dur(d.timing.model)} (${d.timing.tps ? `${d.timing.tps} tok/s` : ''}) · tools ${dur(d.timing.tool)} · overhead ${dur(d.timing.overhead || 0)}`.replace(' ()', ''));
  } else {
    L.push('- No provider token data in this (older) log — only the estimated composition below is available.');
  }
  L.push('\n## Composition of conversation content (estimated tokens)\n');
  L.push(compTable(d.comp));
  const nowTotal = COMP_KEYS.reduce((a, key) => a + (d.compNow[key] || 0), 0);
  if (d.checkpoints && nowTotal) {
    L.push(`\n### Since the last checkpoint (what is actually in the window now, ≈ ${k(nowTotal)})\n`);
    L.push(compTable(d.compNow));
  }
  if (d.turnList.length && d.hasTokens) {
    const heavy = [...d.turnList].filter((t) => t.req).sort((a, b) => (b.peak - b.start) - (a.peak - a.start)).slice(0, 8);
    L.push('\n## Turns that grew the context most\n');
    L.push(table(['#', 'Request', 'Context start → peak', 'Growth', 'Requests', 'Tools'],
      heavy.map((t) => [t.n, t.text, `${k(t.start)} → ${k(t.peak)}`, `+${k(t.peak - t.start)}`, t.req, t.tools])));
  }
  const events = d.events.filter((e) => e.kind === 'compact' || e.kind === 'error' || e.kind === 'model').slice(-8);
  if (events.length) {
    L.push('\n## Context events\n');
    L.push(table(['When', 'Kind', 'Detail', 'Δ tokens'],
      events.map((e) => [when(e.ts), e.kind, e.label, e.tok ? (e.kind === 'compact' ? `${e.tok > 0 ? '+' : ''}${k(e.tok)}` : `≈${k(e.tok)}`) : ''])));
  }
  const bigCmds = [...d.cmdList].filter((c) => c.dur > 0).sort((a, b) => b.dur - a.dur).slice(0, 5);
  const failed = d.cmdList.filter((c) => c.st === 'fail').length;
  if (d.cmdList.length) {
    L.push(`\n## Commands — ${d.cmdList.length} runs, ${failed} failed\n`);
    L.push(table(['Slowest', 'Duration', 'Status'], bigCmds.map((c) => [c.cmd.slice(0, 80), dur(c.dur), c.st])));
  }
  const section = (title, rows, head) => { if (rows.length) L.push(`\n## ${title}\n\n${table(head, rows)}`); };
  section('Tools', d.tools.slice(0, 10).map((x) => [x.name, x.count, `≈${k(x.tok || 0)}`]), ['Tool', 'Calls', 'Volume']);
  section('Programs', d.cmds.slice(0, 10).map((x) => [x.name, x.count]), ['Program', 'Runs']);
  section('Skills loaded', d.skills.map((x) => [x.name, x.count, x.source || '-']), ['Skill', 'Loads', 'Source']);
  section('File activity', d.files.slice(0, 10).map((x) => [x.name, x.r, x.w, x.s, `+${x.add}/−${x.del}`]), ['File', 'Reads', 'Writes', 'Searches', 'Lines']);
  if (d.childIds.length) L.push(`\nSubagent conversations: ${d.childIds.map((x) => x.slice(0, 8)).join(', ')}`);
  return L.join('\n');
}

export function overviewReport(o) {
  const t = o.totals;
  const L = [`# Antigravity usage overview — ${o.days ? `last ${o.days} days` : 'all time'}\n`];
  L.push(`- Conversations: **${t.convs}** (${t.totalConvs} total, ${t.archivedConvs} archived) · turns: ${t.turns} · model requests: ${t.requests} · tool calls: ${t.toolCalls}`);
  L.push(`- Fresh input ${k(t.input)} · cache read ${k(t.cache)} · output ${k(t.output)} · cache hit rate **${pct(o.cacheHit)}**${o.cost ? ` · est. cost **$${o.cost.toFixed(2)}** (${t.priced}/${t.convs} priced)` : ''}`);
  const active = o.timing.model + o.timing.tool;
  if (active) L.push(`- Active time ${dur(active)} (model ${pct(o.timing.model / active)}, tools ${pct(o.timing.tool / active)})`);
  L.push('\n## Last 7 days\n');
  L.push(table(['Day', 'Requests', 'Fresh in', 'Cache read', 'Output', 'Tool calls'],
    o.last7.map((d) => [d.day, d.r, k(d.i), k(d.c), k(d.o), d.t])));
  L.push('\n## Where the content comes from (estimated)\n');
  L.push(compTable(o.comp));
  const rows = (a) => a.map((x) => [x.name, x.count, x.sessions || '-']);
  if (o.tools.length) L.push(`\n## Top tools\n\n${table(['Tool', 'Calls', 'Sessions'], rows(o.tools.slice(0, 10)))}`);
  if (o.cmds.length) L.push(`\n## Top commands\n\n${table(['Program', 'Runs', 'Sessions'], rows(o.cmds.slice(0, 10)))}`);
  if (o.skills.length) L.push(`\n## Skills loaded\n\n${table(['Skill', 'Loads', 'Sessions'], rows(o.skills))}`);
  L.push('\n## Heaviest conversations (peak context)\n');
  L.push(table(['Conversation', 'Model', 'Last active', 'Turns', 'Requests', 'Peak ctx', 'Cache hit'],
    [...o.conversations].sort((a, b) => b.peak - a.peak).slice(0, 8).map((c) => [
      `${(c.title || c.id).slice(0, 44)} (${c.id.slice(0, 8)})`, c.model || '-', when(c.last), c.turns, c.requests, k(c.peak),
      c.hasTokens ? pct(c.tokens.cache / ((c.tokens.cache + c.tokens.input) || 1)) : '-',
    ])));
  return L.join('\n');
}

export function fleetReport(f) {
  return `# Agent family (${f.nodes.length} conversations)\n\n${table(['Agent', 'Role', 'Context now', 'Peak', 'Requests', 'Status'],
    f.nodes.map((n) => [`${'  '.repeat(n.depth)}${(n.title || n.id).slice(0, 50)} (${n.id.slice(0, 8)})`,
      n.depth === 0 ? 'main' : (n.agentName || 'subagent'), k(n.lastCtx), k(n.peak), n.requests, n.running ? 'running' : 'idle']))}`;
}

/** Prompt for the isolated side conversation started by "Ask agent" (read-only, self-contained). */
export function askPrompt(d, lang = 'en') {
  const zh = /^zh/i.test(lang);
  return [
    zh
      ? '这是一个旁路提问(类似 /btw):请只读分析,不要修改任何文件、不要启动子 Agent、不要安排后台任务。下面是我另一个对话的上下文洞察报告(已由 agy-context 生成),无需再运行任何命令。'
      : 'This is a read-only side question (like /btw): do not edit files, spawn subagents or schedule background tasks. Below is the context-insight report of another conversation, generated by agy-context; you do not need to run any command.',
    zh
      ? '请用中文简洁回答:1) 上下文主要由什么占据、当前相对峰值与窗口的状况;2) 哪几轮增长最多、原因;3) 3-5 条具体、有证据的精简建议。'
      : 'Answer concisely: 1) what dominates the context and where it stands vs. its peak; 2) which turns grew it most and why; 3) 3–5 concrete, evidence-based slimming tips.',
    '', sessionReport(d),
  ].join('\n');
}

/** One-line text the user can paste after the native `/btw` command in the composer. */
export function btwQuestion(d, lang = 'en') {
  const zh = /^zh/i.test(lang);
  const id = d.id;
  return zh
    ? `请使用 context 技能分析对话 ${id}:上下文主要由什么占据、哪几轮增长最多,并给出精简建议。只读,不要修改文件。`
    : `Use the context skill to analyze conversation ${id}: what dominates its context, which turns grew it most, and how to slim it. Read-only, do not edit files.`;
}
