// agy-context analyzer — zero-dependency log analysis for Antigravity conversations.
//
// Source of truth: ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
// Each PLANNER_RESPONSE step carries the provider-reported `input_tokens` (uncached),
// `cache_read_tokens` and `output_tokens` of one model request. The context size of
// that request is input + cache_read. Older logs have no token fields; for those only
// the char-based composition estimate is available.
//
// Read-only: this module never writes anything except its own cache file.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SCHEMA = 8;
const MAX_SERIES = 400;
const MAX_TURNS = 200;
const MAX_FILES = 120;
const MAX_OPS = 30;
const MAX_CMDS = 300;
const MAX_INJECT_EVENTS = 300;

export const COMP_KEYS = [
  'user', 'system', 'reasoning', 'answer', 'toolCalls',
  'commands', 'files', 'edits', 'search', 'mcp', 'other',
];
const zeroComp = () => Object.fromEntries(COMP_KEYS.map((k) => [k, 0]));

const RESULT_CAT = {
  RUN_COMMAND: 'commands',
  VIEW_FILE: 'files', LIST_DIRECTORY: 'files',
  CODE_ACTION: 'edits',
  GREP_SEARCH: 'search', SEARCH_WEB: 'search', READ_URL_CONTENT: 'search',
  MCP_TOOL: 'mcp',
};
// Used for generic result steps (the log gives them no specific type): results arrive in the
// same order as the tool calls of the preceding model step, so the call name tells the category.
const TOOL_CAT = {
  run_command: 'commands', manage_task: 'commands', command_status: 'commands', schedule: 'commands',
  view_file: 'files', read_file: 'files', list_dir: 'files',
  grep_search: 'search', find_by_name: 'search', search_web: 'search', read_url_content: 'search',
  replace_file_content: 'edits', multi_replace_file_content: 'edits', write_to_file: 'edits',
  write_file: 'edits', edit_file: 'edits',
  call_mcp_tool: 'mcp', list_resources: 'mcp', read_resource: 'mcp',
};
const SYSTEM_TYPES = new Set([
  'SYSTEM_MESSAGE', 'EPHEMERAL_MESSAGE', 'CHECKPOINT', 'CONVERSATION_HISTORY', 'ERROR_MESSAGE',
]);
const READ_TOOLS = new Set(['view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name']);
const WRITE_TOOLS = new Set([
  'replace_file_content', 'multi_replace_file_content', 'write_to_file', 'write_file', 'edit_file',
]);
const PATH_KEYS = ['AbsolutePath', 'Path', 'TargetFile', 'SearchPath', 'SearchDirectory', 'DirectoryPath'];
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const SHELL_SKIP = new Set([
  'cd', 'export', 'set', 'source', 'unset', 'true', 'false', ':', 'then', 'do', 'fi', 'done', 'else', 'elif',
  'if', 'for', 'while', 'until', 'case', 'esac', 'in', 'function', 'select', 'return', 'exit', 'break', 'continue',
]);

export function brainDir() {
  return process.env.AGY_CONTEXT_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
}
export function dataDir() {
  return process.env.AGY_CONTEXT_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context');
}
const logFile = (id) => path.join(brainDir(), id, '.system_generated', 'logs', 'transcript_full.jsonl');

/** Rough token estimate: ASCII ≈ 3.6 chars/token, everything else (CJK etc.) ≈ 1.4 chars/token. */
export function estimateTokens(s) {
  if (!s) return 0;
  if (typeof s !== 'string') s = JSON.stringify(s);
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 3.6 + other / 1.4);
}

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Tool-call args arrive double-encoded (each value is a JSON string); decode when possible. */
function unq(v) {
  if (typeof v === 'string' && v.length > 1 && (v[0] === '"' || v[0] === '[' || v[0] === '{')) {
    try { return JSON.parse(v); } catch { /* keep raw */ }
  }
  return v;
}
const lineCount = (x) => (typeof x === 'string' && x ? x.split('\n').length : 0);

function userText(content) {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content || '');
  return (m ? m[1] : content || '').replace(/\s+/g, ' ').trim();
}

function shellPrograms(cmd) {
  // Drop heredoc bodies and quoted strings first so embedded scripts don't look like commands.
  const lines = String(cmd).split('\n');
  const kept = [];
  let marker = null;
  for (const line of lines) {
    if (marker !== null) { if (line.trim() === marker) marker = null; continue; }
    kept.push(line);
    const h = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(line);
    if (h) marker = h[1];
  }
  const text = kept.join('\n')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const out = new Set();
  for (const seg of text.split(/&&|\|\||;|\||\n/)) {
    const words = seg.trim().split(/\s+/);
    let w = words.shift();
    while (w && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === 'sudo' || w === 'time' || w === 'env' || w === 'nohup')) w = words.shift();
    if (!w) continue;
    w = w.replace(/^[(`{!]+/, '');
    w = path.basename(w);
    if (!w || w[0] === '-' || SHELL_SKIP.has(w) || /[^\w.+@-]/.test(w)) continue;
    out.add(w);
  }
  return out;
}

const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const vecOf = (c) => COMP_KEYS.map((k) => Math.round(c[k] || 0));

function downsample(series, max) {
  if (series.length <= max) return series;
  const out = [];
  const size = series.length / max;
  for (let b = 0; b < max; b++) {
    const lo = Math.floor(b * size);
    const hi = Math.min(series.length, Math.floor((b + 1) * size));
    let best = series[lo];
    for (let i = lo; i < hi; i++) if (series[i][2] > best[2]) best = series[i];
    out.push(best);
  }
  return out;
}

function guessProject(files) {
  const home = os.homedir();
  const counts = {};
  for (const [p, f] of Object.entries(files)) {
    if (!p.startsWith(home + '/')) continue;
    const top = p.slice(home.length + 1).split('/')[0];
    if (!top || top.startsWith('.')) continue;
    inc(counts, top, f.r + f.w + f.s);
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : '';
}

const tsOf = (re, text) => { const m = re.exec(text); return m ? Date.parse(m[1]) || 0 : 0; };
const CREATED = /Created At:\s*(\S+)/;
const COMPLETED = /Completed At:\s*(\S+)/;

function sourceOf(j) {
  const c = j.content || '';
  const m = /sender=(\S+)/.exec(c);
  if (m) return m[1].replace(/^.*\//, '').slice(0, 40);
  const t = /\[(Message|Notice)\]/.exec(c);
  return t ? t[1].toLowerCase() : (j.type || '').toLowerCase();
}

function toolBrief(c) {
  const a = c.args || {};
  const s = unq(a.toolSummary) || unq(a.toolAction);
  if (s) return String(s).slice(0, 90);
  for (const k of ['CommandLine', 'Query', 'Pattern', 'url', 'Url', ...PATH_KEYS]) {
    const v = unq(a[k]);
    if (typeof v === 'string' && v) return v.replace(/\s+/g, ' ').slice(0, 90);
  }
  return '';
}

/** Parse one transcript into a compact summary. */
export async function analyzeFile(file, id) {
  const st = await fsp.stat(file);
  const s = {
    id, size: st.size, mtime: st.mtimeMs, title: '', first: 0, last: 0,
    steps: 0, turns: 0, requests: 0, errors: 0, badLines: 0, hasTokens: false,
    tokens: { input: 0, cache: 0, output: 0 }, peak: 0, lastCtx: 0, startCtx: 0, baseline: null,
    comp: zeroComp(), compNow: zeroComp(),
    tools: {}, cmds: {}, skills: {}, files: {}, daily: {},
    checkpoints: [], series: [], turnList: [], project: '',
    events: [], cmdList: [], timing: { model: 0, tool: 0 }, children: [],
  };
  let turn = null;
  let cur = zeroComp();          // composition since the last checkpoint
  let pending = [];              // tool calls of the last model step, in result order
  let pendingCk = null;
  let reqTs = 0;
  let batch = null;
  const flushBatch = () => {
    if (batch) s.timing.tool += Math.min(Math.max(batch.max - batch.min, 0), 3600e3);
    batch = null;
  };
  const addComp = (key, n) => { s.comp[key] += n; cur[key] += n; };
  const dayOf = (ts) => (s.daily[dayKey(ts)] ||= { r: 0, i: 0, c: 0, o: 0, t: 0 });
  const fileRec = (p) => (s.files[p] ||= { r: 0, w: 0, s: 0, img: 0, add: 0, del: 0, hits: 0, ops: [] });
  const addOp = (f, op) => { if (f.ops.length < MAX_OPS) f.ops.push(op); };

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { s.badLines++; continue; }
    s.steps++;
    const ts = Date.parse(j.created_at) || 0;
    if (ts) {
      if (!s.first || ts < s.first) s.first = ts;
      if (ts > s.last) s.last = ts;
    }
    const type = j.type;

    if (type === 'USER_INPUT') {
      flushBatch();
      const text = userText(j.content);
      addComp('user', estimateTokens(j.content));
      s.turns++;
      if (!s.title) s.title = text.slice(0, 120);
      turn = { n: s.turns, ts, text: text.slice(0, 90), req: 0, peak: 0, start: 0, fresh: 0, out: 0, tools: 0 };
      s.turnList.push(turn);
      s.events.push({ k: s.requests, step: j.step_index, ts, kind: 'user', label: text.slice(0, 80), tok: estimateTokens(j.content) });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      flushBatch();
      reqTs = ts;
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      pending = calls.slice();
      const hasTok = j.input_tokens != null || j.cache_read_tokens != null;
      if (hasTok && pendingCk && s.baseline != null) {
        const ctxNext = (j.input_tokens || 0) + (j.cache_read_tokens || 0);
        const carried = Math.max(0, ctxNext - s.baseline - COMP_KEYS.reduce((a, key) => a + cur[key], 0));
        cur.system += carried; s.comp.system += carried;
      }
      // the request carries the content accumulated *before* this response
      const snapshot = vecOf(cur);
      addComp('reasoning', estimateTokens(j.thinking));
      addComp('answer', estimateTokens(j.content));
      if (calls.length) addComp('toolCalls', estimateTokens(JSON.stringify(calls)));
      for (const c of calls) {
        const name = c.name || 'unknown';
        inc(s.tools, name);
        if (turn) turn.tools++;
        const args = c.args || {};
        if (ts) dayOf(ts).t++;
        if (name === 'run_command') {
          for (const p of shellPrograms(unq(args.CommandLine))) inc(s.cmds, p);
        }
        const kind = READ_TOOLS.has(name) ? 'r' : WRITE_TOOLS.has(name) ? 'w' : null;
        if (kind) {
          for (const key of PATH_KEYS) {
            const raw = unq(args[key]);
            if (typeof raw !== 'string' || !raw) continue;
            const p = raw.replace(/^file:\/\//, '');
            if (name === 'grep_search' || name === 'find_by_name') break; // counted from results
            const f = fileRec(p);
            if (kind === 'w') {
              let add = 0; let del = 0;
              if (name === 'write_file') add = lineCount(unq(args.Content));
              else if (name === 'write_to_file') add = lineCount(unq(args.CodeContent));
              else if (name === 'edit_file') { add = lineCount(unq(args.Replacement)); del = lineCount(unq(args.Target)); }
              else if (name === 'replace_file_content') { add = lineCount(unq(args.ReplacementContent)); del = lineCount(unq(args.TargetContent)); }
              else if (name === 'multi_replace_file_content') {
                const chunks = unq(args.ReplacementChunks);
                if (Array.isArray(chunks)) for (const ch of chunks) { add += lineCount(ch.ReplacementContent); del += lineCount(ch.TargetContent); }
              }
              f.w++; f.add += add; f.del += del;
              addOp(f, [s.requests + 1, j.step_index, 'w', add, del]);
            } else if (IMG_RE.test(p)) {
              f.img++; addOp(f, [s.requests + 1, j.step_index, 'i', 0, 0]);
            } else {
              f.r++; addOp(f, [s.requests + 1, j.step_index, 'r', 0, 0]);
            }
            if (/(^|\/)SKILL\.md$/.test(p) && kind === 'r') {
              const sk = path.basename(path.dirname(p));
              inc(s.skills, sk);
              s.events.push({ k: s.requests + 1, step: j.step_index, ts, kind: 'skill', label: sk, tok: 0 });
            }
            break;
          }
        }
      }
      if (j.input_tokens != null || j.cache_read_tokens != null) {
        const inp = j.input_tokens || 0;
        const cr = j.cache_read_tokens || 0;
        const out = j.output_tokens || 0;
        const ctx = inp + cr;
        s.hasTokens = true;
        s.requests++;
        if (s.requests === 1) { s.startCtx = ctx; s.baseline = Math.max(0, ctx - snapshot.reduce((a, b) => a + b, 0)); }
        s.tokens.input += inp; s.tokens.cache += cr; s.tokens.output += out;
        if (ctx > s.peak) s.peak = ctx;
        if (pendingCk) { pendingCk.tok = ctx - s.lastCtx; pendingCk = null; }
        s.lastCtx = ctx;
        s.series.push([
          s.requests, ts, ctx, inp, out, turn ? turn.n : 0, snapshot,
          calls.map((c) => c.name).join(','),
          (j.content || '').replace(/\s+/g, ' ').slice(0, 100),
        ]);
        if (ts) { const d = dayOf(ts); d.r++; d.i += inp; d.c += cr; d.o += out; }
        if (turn) {
          if (!turn.req) turn.start = ctx;
          turn.req++; turn.fresh += inp; turn.out += out;
          if (ctx > turn.peak) turn.peak = ctx;
        }
      }
      continue;
    }

    const content = j.content || '';
    const est = estimateTokens(content);

    if (SYSTEM_TYPES.has(type) || j.source === 'SYSTEM' || j.source === 'SYSTEM_SDK') {
      if (type === 'CHECKPOINT') {
        // The log stores the whole truncated history here, so its size says nothing about what
        // stays in the window; the carried summary is sized from the next real request instead.
        cur = zeroComp();
        const ev = { k: s.requests, step: j.step_index, ts, kind: 'compact', label: `checkpoint #${s.checkpoints.length + 1}`, tok: 0 };
        s.checkpoints.push({ k: s.requests, t: ts, step: j.step_index });
        s.events.push(ev);
        pendingCk = ev;
        continue;
      }
      addComp('system', est);
      if (!s.title && !s.turns) { // subagents start with the delegated task as a system message
        const m = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content);
        const t = (m ? m[1] : '').replace(/<[^>]+>/g, ' ').replace(/\*\*Task\*\*:?|Task:|\*\*/g, ' ').replace(/\s+/g, ' ').trim();
        if (t) s.title = t.slice(0, 120);
      }
      if (type === 'ERROR_MESSAGE') {
        s.errors++;
        s.events.push({ k: s.requests, step: j.step_index, ts, kind: 'error', label: (j.error || content).replace(/\s+/g, ' ').slice(0, 100), tok: est });
      } else {
        s.events.push({ k: s.requests, step: j.step_index, ts, kind: 'inject', label: `${(type || '').toLowerCase().replace('_message', '')}: ${sourceOf(j)}`, tok: est });
      }
      continue;
    }

    // ---- tool result
    const call = pending.shift();
    const cat = RESULT_CAT[type] || TOOL_CAT[call && call.name] || 'other';
    addComp(cat, est);

    const head = content.slice(0, 200);
    const c0 = tsOf(CREATED, head);
    const c1 = tsOf(COMPLETED, head) || c0;
    if (c0 && !(call && call.name === 'ask_question')) {
      if (!batch) {
        batch = { min: c0, max: c1 };
        if (reqTs) s.timing.model += Math.min(Math.max(c0 - reqTs, 0), 180e3);
      } else { batch.min = Math.min(batch.min, c0); batch.max = Math.max(batch.max, c1); }
    }

    if (call && call.name === 'run_command' && (type === 'RUN_COMMAND' || type === 'GENERIC')) {
      const cmd = String(unq((call.args || {}).CommandLine) || '');
      let stt = 'ok';
      if (/running as a background task/i.test(head + content.slice(200, 500))) stt = 'bg';
      else if (/exit(?:ed)?\s*(?:with)?\s*code\s*([1-9]\d*)/i.test(content.slice(0, 600)) || /Encountered error/.test(head + content.slice(200, 300))) stt = 'fail';
      s.cmdList.push({
        step: j.step_index, k: s.requests, ts: c0 || ts, dur: c0 ? Math.max(c1 - c0, 0) : 0, st: stt,
        prog: [...shellPrograms(cmd)].slice(0, 3).join(' '), cmd: cmd.replace(/\s+/g, ' ').slice(0, 220),
      });
      if (s.cmdList.length > MAX_CMDS * 2) s.cmdList.splice(0, MAX_CMDS);
    }
    if (type === 'GREP_SEARCH' || (call && call.name === 'grep_search')) {
      const hits = {};
      let n = 0;
      for (const m of content.matchAll(/"File":"((?:[^"\\]|\\.)*)"/g)) {
        if (n++ > 3000) break;
        inc(hits, m[1].replace(/\\\//g, '/'));
      }
      for (const [p, h] of Object.entries(hits).slice(0, 100)) {
        const f = fileRec(p);
        f.s++; f.hits += h; addOp(f, [s.requests, j.step_index, 's', h, 0]);
      }
    }
    if (/Created the following subagent/.test(head + content.slice(200, 400))) {
      for (const m of content.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/g)) s.children.push(m[1]);
    }
  }
  flushBatch();

  s.series = downsample(s.series, MAX_SERIES);
  if (s.turnList.length > MAX_TURNS) s.turnList = s.turnList.slice(-MAX_TURNS);
  if (s.cmdList.length > MAX_CMDS) s.cmdList = s.cmdList.slice(-MAX_CMDS);
  const inject = s.events.filter((e) => e.kind === 'inject');
  if (inject.length > MAX_INJECT_EVENTS) {
    const drop = new Set(inject.slice(0, inject.length - MAX_INJECT_EVENTS));
    s.events = s.events.filter((e) => !drop.has(e));
  }
  const topFiles = Object.entries(s.files)
    .sort((a, b) => (b[1].r + b[1].w + b[1].s + b[1].img) - (a[1].r + a[1].w + a[1].s + a[1].img)).slice(0, 400);
  s.project = guessProject(Object.fromEntries(topFiles));
  s.files = Object.fromEntries(topFiles.slice(0, MAX_FILES));
  s.compNow = cur;
  s.children = [...new Set(s.children)];
  if (!s.title) s.title = id.slice(0, 8);
  return s;
}

// ---------------------------------------------------------------- on-demand drill-down

function itemTitle(prefix, text) {
  return `${prefix}${text ? ` ${text}` : ''}`.replace(/\s+/g, ' ').slice(0, 140);
}

/** What did request #k carry? Items since the last checkpoint, up to (not including) request k's response. */
export async function browseRequest(id, k) {
  const file = logFile(id);
  let items = [];
  let pending = [];
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const type = j.type;
    if (type === 'PLANNER_RESPONSE') {
      const hasTokens = j.input_tokens != null || j.cache_read_tokens != null;
      if (hasTokens && n + 1 === k) break;
      if (hasTokens) n++;
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      pending = calls.slice();
      if (j.thinking) items.push({ step: j.step_index, cat: 'reasoning', title: itemTitle('reasoning', j.thinking.slice(0, 80)), tok: estimateTokens(j.thinking) });
      if (j.content) items.push({ step: j.step_index, cat: 'answer', title: itemTitle('answer', j.content.slice(0, 80)), tok: estimateTokens(j.content) });
      for (const c of calls) items.push({ step: j.step_index, cat: 'toolCalls', title: itemTitle(c.name, toolBrief(c)), tok: estimateTokens(JSON.stringify(c)) });
      continue;
    }
    const content = j.content || '';
    if (type === 'USER_INPUT') {
      items.push({ step: j.step_index, cat: 'user', title: itemTitle('user', userText(content).slice(0, 100)), tok: estimateTokens(content) });
    } else if (type === 'CHECKPOINT') {
      items = [{ step: j.step_index, cat: 'system', title: 'checkpoint (summary of earlier turns)', tok: estimateTokens(content) }];
    } else if (SYSTEM_TYPES.has(type) || j.source === 'SYSTEM' || j.source === 'SYSTEM_SDK') {
      items.push({ step: j.step_index, cat: 'system', title: itemTitle((type || '').toLowerCase(), sourceOf(j)), tok: estimateTokens(content) });
    } else {
      const call = pending.shift();
      const cat = RESULT_CAT[type] || TOOL_CAT[call && call.name] || 'other';
      items.push({ step: j.step_index, cat, title: itemTitle(call ? `${call.name} →` : `${type} →`, call ? toolBrief(call) : ''), tok: estimateTokens(content) });
    }
    if (items.length > 4000) items.splice(0, items.length - 3000);
  }
  return items;
}

/** Full text of one step (truncated for the UI). */
export async function getStep(id, step) {
  const file = logFile(id);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const cut = (x, n = 30000) => (typeof x === 'string' && x.length > n ? `${x.slice(0, n)}\n… [${x.length - n} more characters]` : x);
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.step_index === step) {
      rl.close();
      return {
        step, type: j.type, source: j.source, ts: j.created_at,
        content: cut(j.content), thinking: cut(j.thinking),
        tool_calls: j.tool_calls ? cut(JSON.stringify(j.tool_calls, null, 2)) : '',
        inputTokens: j.input_tokens, cacheTokens: j.cache_read_tokens, outputTokens: j.output_tokens,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- loading + cache

const memo = new Map(); // id -> summary
let cacheLoaded = false;
let inflight = null;
const cachePath = () => path.join(dataDir(), 'cache.json');

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(await fsp.readFile(cachePath(), 'utf8'));
    if (raw.schema === SCHEMA) for (const s of raw.items) memo.set(s.id, s);
  } catch { /* no cache yet */ }
}
async function saveCache() {
  try {
    const p = cachePath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ schema: SCHEMA, items: [...memo.values()] }));
    await fsp.rename(tmp, p);
  } catch { /* cache is best-effort */ }
}

/** Load (incrementally) every conversation summary. */
export function loadAll() {
  if (!inflight) {
    inflight = (async () => {
      await loadCache();
      const root = brainDir();
      let ids = [];
      try { ids = await fsp.readdir(root); } catch { return []; }
      let dirty = false;
      const seen = new Set();
      for (const id of ids) {
        const file = logFile(id);
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        seen.add(id);
        const old = memo.get(id);
        if (old && old.size === st.size && old.mtime === st.mtimeMs) continue;
        try { memo.set(id, await analyzeFile(file, id)); dirty = true; } catch { /* unreadable, skip */ }
      }
      for (const id of [...memo.keys()]) if (!seen.has(id)) { memo.delete(id); dirty = true; }
      if (dirty) await saveCache();
      return [...memo.values()];
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

export async function getConversation(idOrPrefix) {
  const all = await loadAll();
  return all.find((s) => s.id === idOrPrefix) || all.find((s) => s.id.startsWith(idOrPrefix)) || null;
}

// ---------------------------------------------------------------- aggregation

const sumInto = (dst, src) => { for (const [k, v] of Object.entries(src)) dst[k] = (dst[k] || 0) + v; };
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
const RUN_MS = 3 * 60e3;

export function costOf(tokens, rates) {
  if (!rates) return 0;
  return ((tokens.input || 0) * (rates.input || 0) + (tokens.cache || 0) * (rates.cache || 0) + (tokens.output || 0) * (rates.output || 0)) / 1e6;
}

export function brief(s, rates) {
  const toolCalls = Object.values(s.tools).reduce((a, b) => a + b, 0);
  return {
    id: s.id, title: s.title, project: s.project, first: s.first, last: s.last,
    steps: s.steps, turns: s.turns, requests: s.requests, errors: s.errors,
    hasTokens: s.hasTokens, tokens: s.tokens, peak: s.peak, lastCtx: s.lastCtx,
    comp: s.comp, toolCalls, checkpoints: s.checkpoints.length,
    cost: costOf(s.tokens, rates),
    toolNames: Object.keys(s.tools), cmdNames: Object.keys(s.cmds), skillNames: Object.keys(s.skills),
    activeDays: Object.keys(s.daily), children: s.children.length,
  };
}

export function overview(list, { days = 30, now = Date.now(), rates } = {}) {
  const cutoff = days > 0 ? dayKey(now - (days - 1) * 864e5) : '';
  const inRange = [];
  const totals = { convs: 0, requests: 0, input: 0, cache: 0, output: 0, toolCalls: 0, turns: 0 };
  const tools = {}; const cmds = {}; const skills = {}; const files = {}; const comp = {};
  const dailyAll = {};
  let model = 0; let toolMs = 0;
  for (const s of list) {
    for (const [d, v] of Object.entries(s.daily)) {
      const t = (dailyAll[d] ||= { r: 0, i: 0, c: 0, o: 0, t: 0 });
      t.r += v.r; t.i += v.i; t.c += v.c; t.o += v.o; t.t += v.t;
    }
    const lastDay = s.last ? dayKey(s.last) : '';
    let any = !cutoff || lastDay >= cutoff;
    let r = 0; let i = 0; let c = 0; let o = 0;
    for (const [d, v] of Object.entries(s.daily)) {
      if (!cutoff || d >= cutoff) { r += v.r; i += v.i; c += v.c; o += v.o; any = true; }
    }
    if (!any) continue;
    inRange.push(s);
    totals.convs++; totals.requests += r; totals.input += i; totals.cache += c; totals.output += o;
    totals.turns += s.turns;
    totals.toolCalls += Object.values(s.tools).reduce((a, b) => a + b, 0);
    model += s.timing.model; toolMs += s.timing.tool;
    sumInto(tools, s.tools); sumInto(cmds, s.cmds); sumInto(skills, s.skills); sumInto(comp, s.comp);
    for (const [p, f] of Object.entries(s.files)) inc(files, p, f.r + f.w + f.s + f.img);
  }
  const dayList = (n) => Array.from({ length: n }, (_, k) => {
    const d = dayKey(now - (n - 1 - k) * 864e5);
    return { day: d, ...(dailyAll[d] || { r: 0, i: 0, c: 0, o: 0, t: 0 }) };
  });
  return {
    days, totals, cost: costOf(totals, rates),
    timing: { model, tool: toolMs },
    cacheHit: totals.cache + totals.input ? totals.cache / (totals.cache + totals.input) : 0,
    last7: dayList(7), heat: dayList(56),
    tools: top(tools, 15), cmds: top(cmds, 15), skills: top(skills, 12), files: top(files, 12),
    comp,
    conversations: inRange.sort((a, b) => b.last - a.last).map((s) => brief(s, rates)),
  };
}

export function pickCurrent(list) {
  return [...list].sort((a, b) => b.last - a.last)[0] || null;
}

export function detail(s, rates) {
  const filesList = Object.entries(s.files)
    .map(([name, f]) => ({ name, ...f }))
    .sort((a, b) => (b.r + b.w + b.s + b.img) - (a.r + a.w + a.s + a.img));
  return {
    ...brief(s, rates),
    cacheHit: s.tokens.cache + s.tokens.input ? s.tokens.cache / (s.tokens.cache + s.tokens.input) : 0,
    startCtx: s.startCtx, baseline: s.baseline ?? 0, compNow: s.compNow, timing: s.timing,
    series: s.series, checkpointList: s.checkpoints, turnList: s.turnList, events: s.events,
    tools: top(s.tools, 20), cmds: top(s.cmds, 30), skills: top(s.skills, 20),
    files: filesList, cmdList: s.cmdList, daily: s.daily, childIds: s.children,
  };
}

/** Agent family of a conversation: parent, itself, and all (transitive) subagent conversations. */
export function fleet(list, id, rates) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const parentOf = new Map();
  for (const s of list) for (const c of s.children) if (!parentOf.has(c)) parentOf.set(c, s.id);
  let root = id;
  const guard = new Set();
  while (parentOf.has(root) && !guard.has(root)) { guard.add(root); root = parentOf.get(root); }
  const nodes = [];
  const walk = (cid, depth, parent) => {
    const s = byId.get(cid);
    if (!s || nodes.some((n) => n.id === cid)) return;
    nodes.push({
      ...brief(s, rates), depth, parent, isCurrent: cid === id,
      running: Date.now() - s.last < RUN_MS,
      activeMs: s.timing.model + s.timing.tool,
    });
    for (const c of s.children) walk(c, depth + 1, cid);
  };
  walk(root, 0, null);
  return { current: id, root, nodes };
}
