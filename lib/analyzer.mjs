// agy-context analyzer — read-only log + SQLite summary analysis for Antigravity conversations.
//
// Sources of truth:
// - ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
// - ~/.gemini/antigravity/conversation_summaries.db (optional, read-only metadata: title, workspace, parent, status, archived)
//
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
import { costWithPricing, resolvePricing } from './pricing.mjs';

const SCHEMA = 13;
const MAX_SERIES = 400;
const MAX_TURNS = 200;
const MAX_FILES = 150;
const MAX_OPS = 30;
const MAX_CMDS = 300;
const MAX_INJECT_EVENTS = 300;
const MAX_COMMS = 300;

export const COMP_KEYS = [
  'user', 'system', 'reasoning', 'answer', 'toolCalls',
  'commands', 'files', 'edits', 'search', 'mcp', 'other', 'skills',
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

export function agyDir() {
  return process.env.AGY_CONTEXT_AGY_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
}
export function brainDir() {
  return process.env.AGY_CONTEXT_BRAIN_DIR || path.join(agyDir(), 'brain');
}
export function dataDir() {
  return process.env.AGY_CONTEXT_DATA_DIR || path.join(agyDir(), 'plugin_data', 'agy-context');
}
const summaryDbPath = () => process.env.AGY_CONTEXT_SUMMARY_DB || path.join(agyDir(), 'conversation_summaries.db');
const logFile = (id) => path.join(brainDir(), id, '.system_generated', 'logs', 'transcript_full.jsonl');

/** Read pixel dimensions from PNG / JPEG / GIF / WebP headers (0,0 if unknown). */
function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG SOF0..SOF3
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

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

function parseModelSwitches(content) {
  const out = [];
  const blockRe = /<USER_SETTINGS_CHANGE>\s*([\s\S]*?)\s*<\/USER_SETTINGS_CHANGE>/g;
  for (const bm of String(content || '').matchAll(blockRe)) {
    const m = /The user changed setting `Model Selection` from (.+?) to (.+?)(?:\.\s*(?:No need|If reporting)|\.?\s*$)/m.exec(bm[1]);
    if (m) out.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return out;
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

function skillSource(p) {
  if (p.includes('/.gemini/antigravity/builtin/')) return 'bundled';
  if (p.includes('/.gemini/config/plugins/')) return 'plugin';
  if (p.includes('/.gemini/config/skills/') || p.includes('/.agents/skills/')) return 'user';
  return 'project';
}

function parseCmdEntry(step, k, ts, dur, cmd, content, head) {
  let st = 'ok';
  if (/running as a background task/i.test(head + content.slice(200, 500))) st = 'bg';
  else if (/exit(?:ed)?\s*(?:with)?\s*code\s*([1-9]\d*)/i.test(content.slice(0, 600)) || /Encountered error/.test(head + content.slice(200, 300))) st = 'fail';
  const codeM = /exit(?:ed)?\s*(?:with)?\s*code\s*(\d+)/i.exec(content.slice(0, 600));
  return {
    step, k, ts, dur, st,
    code: codeM ? Number(codeM[1]) : (st === 'ok' ? 0 : null),
    inferredCode: !codeM && st === 'ok',
    lines: lineCount(content), chars: content.length,
    heredoc: /<<-?\s*['"]?[A-Za-z_][\w]*/.test(cmd),
    truncated: /output was truncated|more characters/i.test(content.slice(0, 400) + content.slice(-300)),
    stderr: /stderr|traceback|command failed/i.test(content.slice(0, 800)),
    prog: [...shellPrograms(cmd)].slice(0, 3).join(' '),
    cmd: cmd.replace(/\s+/g, ' ').slice(0, 220),
  };
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

function callPath(c) {
  const a = (c && c.args) || {};
  for (const key of PATH_KEYS) {
    const v = unq(a[key]);
    if (typeof v === 'string' && v) return v.replace(/^file:\/\//, '');
  }
  return '';
}
const isSkillRead = (c) => !!c && (c.name === 'view_file' || c.name === 'read_file') && /(^|\/)SKILL\.md$/.test(callPath(c));
const isErrorHead = (h) => /^\s*(Created At:[^\n]*\n)?(Completed At:[^\n]*\n)?\s*(Encountered error|Error invalid tool call|Error:)/.test(h) || /exit(?:ed)?\s*(?:with)?\s*code\s*[1-9]\d*/i.test(h);

function toolProvider(c) {
  if (!c) return '';
  if (c.name === 'call_mcp_tool') {
    const sv = unq((c.args || {}).ServerName);
    return sv ? `mcp:${sv}` : 'mcp';
  }
  if (isSkillRead(c)) return `skill:${path.basename(path.dirname(callPath(c)))}`;
  return 'builtin';
}

function toolBrief(c) {
  const a = c.args || {};
  if (c.name === 'call_mcp_tool') {
    const sv = unq(a.ServerName); const tn = unq(a.ToolName);
    if (sv || tn) return `mcp:${sv || '?'}/${tn || '?'}`;
  }
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
    id, size: st.size, mtime: st.mtimeMs, title: '', lastUser: '', first: 0, last: 0,
    steps: 0, turns: 0, requests: 0, errors: 0, badLines: 0, hasTokens: false,
    tokens: { input: 0, cache: 0, output: 0 }, peak: 0, lastCtx: 0, startCtx: 0, baseline: null,
    model: '', startModel: '',
    comp: zeroComp(), compNow: zeroComp(),
    tools: {}, toolTokens: {}, cmds: {}, cmdProgRuns: {}, cmdTotal: 0, skills: {}, skillMeta: {}, files: {}, daily: {},
    checkpoints: [], series: [], turnList: [], project: '',
    events: [], cmdList: [], timing: { model: 0, tool: 0, toolSum: 0, overhead: 0, modelCalls: 0, toolRuns: 0 },
    children: [], seen: { tool: {}, cmd: {}, skill: {} }, comms: [],
  };
  let turn = null;
  let cur = zeroComp();
  let pending = [];
  let pendingCk = null;
  let reqTs = 0;
  let batch = null;
  let curTs = 0;
  let curPoint = null;
  let lastBatchEnd = 0;
  let delegations = [];
  const dayOf = (ts) => (s.daily[dayKey(ts)] ||= { r: 0, i: 0, c: 0, o: 0, t: 0, mm: 0, tm: 0, tl: {}, cm: {}, sk: {}, cp: {} });
  const flushBatch = () => {
    if (batch) {
      const ms = Math.min(Math.max(batch.max - batch.min, 0), 3600e3);
      s.timing.tool += ms;
      s.timing.toolRuns++;
      if (batch.min) dayOf(batch.min).tm += ms;
      if (curPoint) curPoint[10] = ms;
      lastBatchEnd = batch.max;
    }
    batch = null;
  };
  const addComp = (key, n) => { s.comp[key] += n; cur[key] += n; if (curTs) inc(dayOf(curTs).cp, key, n); };
  const fileRec = (p) => (s.files[p] ||= { r: 0, w: 0, s: 0, img: 0, add: 0, del: 0, hits: 0, last: 0, ops: [] });
  const addOp = (f, op) => {
    if (curTs && curTs > (f.last || 0)) f.last = curTs;
    if (f.ops.length < MAX_OPS) f.ops.push(op);
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { s.badLines++; continue; }
    s.steps++;
    const ts = Date.parse(j.created_at) || 0;
    curTs = ts;
    if (ts) {
      if (!s.first || ts < s.first) s.first = ts;
      if (ts > s.last) s.last = ts;
    }
    const type = j.type;

    if (Array.isArray(j.media)) {
      for (const m of j.media) {
        if (m && typeof m.uri === 'string' && m.uri) {
          const f = fileRec(m.uri.replace(/^file:\/\//, ''));
          f.img++;
          addOp(f, [s.requests + (type === 'PLANNER_RESPONSE' ? 1 : 0), j.step_index, 'i', 0, 0]);
        }
      }
    }

    if (type === 'USER_INPUT') {
      flushBatch();
      for (const sw of parseModelSwitches(j.content)) {
        if (!s.startModel && sw.to) s.startModel = sw.to;
        if (sw.to) s.model = sw.to;
        if (sw.from && sw.to && sw.from !== 'None' && sw.from !== sw.to) {
          s.events.push({ k: s.requests, step: j.step_index, ts, turn: s.turns + 1, kind: 'model', label: `${sw.from} → ${sw.to}`, tok: 0 });
        }
      }
      const text = userText(j.content);
      addComp('user', estimateTokens(j.content));
      s.turns++;
      if (!s.title) s.title = text.slice(0, 120);
      if (text) s.lastUser = text.slice(0, 120);
      turn = { n: s.turns, ts, text: text.slice(0, 90), req: 0, peak: 0, start: 0, fresh: 0, out: 0, tools: 0 };
      s.turnList.push(turn);
      s.events.push({ k: s.requests, step: j.step_index, ts, turn: s.turns, kind: 'user', label: text.slice(0, 80), tok: estimateTokens(j.content) });
      const modeM = /^\/(plan|goal|teamwork|boost|grill-me)\b/.exec(text);
      if (modeM) s.events.push({ k: s.requests, step: j.step_index, ts, turn: s.turns, kind: 'mode', label: modeM[0], tok: 0 });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      flushBatch();
      if (lastBatchEnd && ts > lastBatchEnd) s.timing.overhead += Math.min(ts - lastBatchEnd, 30e3);
      lastBatchEnd = 0;
      reqTs = ts;
      curPoint = null;
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      pending = calls.slice();
      const hasTok = j.input_tokens != null || j.cache_read_tokens != null;
      if (hasTok && pendingCk && s.baseline != null) {
        const ctxNext = (j.input_tokens || 0) + (j.cache_read_tokens || 0);
        const carried = Math.max(0, ctxNext - s.baseline - COMP_KEYS.reduce((a, key) => a + cur[key], 0));
        cur.system += carried; s.comp.system += carried;
      }
      const snapshot = vecOf(cur);
      addComp('reasoning', estimateTokens(j.thinking));
      addComp('answer', estimateTokens(j.content));
      if (calls.length) addComp('toolCalls', estimateTokens(JSON.stringify(calls)));
      for (const c of calls) {
        const name = c.name || 'unknown';
        inc(s.tools, name);
        inc(s.toolTokens, name, estimateTokens(JSON.stringify(c)));
        if (turn) turn.tools++;
        const args = c.args || {};
        if (ts) { const dd = dayOf(ts); dd.t++; inc(dd.tl, name); s.seen.tool[name] = ts; }
        if (name === 'run_command') {
          const progs = shellPrograms(unq(args.CommandLine));
          for (const p of progs) {
            inc(s.cmds, p);
            inc(s.cmdProgRuns, p);
            if (ts) { inc(dayOf(ts).cm, p); s.seen.cmd[p] = ts; }
          }
        }
        if (name === 'invoke_subagent') {
          let list = unq(args.Subagents);
          if (!Array.isArray(list) && args.Prompt) list = [{ Role: unq(args.Role), TypeName: unq(args.TypeName), Prompt: unq(args.Prompt) }];
          for (const d of Array.isArray(list) ? list : []) {
            const ev = { ts, step: j.step_index, kind: 'delegate', peer: '', role: String(d.Role || d.TypeName || '').slice(0, 80), text: String(d.Prompt || '').slice(0, 600) };
            s.comms.push(ev); delegations.push(ev);
          }
        } else if (name === 'send_message') {
          s.comms.push({ ts, step: j.step_index, kind: 'out', peer: String(unq(args.Recipient) || '').slice(0, 60), text: String(unq(args.Message) || '').slice(0, 600) });
        }
        const kind = READ_TOOLS.has(name) ? 'r' : WRITE_TOOLS.has(name) ? 'w' : null;
        if (kind) {
          for (const key of PATH_KEYS) {
            const raw = unq(args[key]);
            if (typeof raw !== 'string' || !raw) continue;
            const p = raw.replace(/^file:\/\//, '');
            if (name === 'grep_search' || name === 'find_by_name') break;
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
              const sl = Number(unq(args.StartLine)) || 0;
              const el = Number(unq(args.EndLine)) || 0;
              f.r++; addOp(f, [s.requests + 1, j.step_index, 'r', sl, el]);
            }
            if (/(^|\/)SKILL\.md$/.test(p) && kind === 'r') {
              const sk = path.basename(path.dirname(p));
              inc(s.skills, sk);
              s.skillMeta[sk] = { path: p, source: skillSource(p) };
              if (ts) { inc(dayOf(ts).sk, sk); s.seen.skill[sk] = ts; }
              s.events.push({ k: s.requests + 1, step: j.step_index, ts, turn: s.turns, kind: 'skill', label: sk, tok: 0 });
            }
            break;
          }
        }
      }
      if (hasTok) {
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
        curPoint = [
          s.requests, ts, ctx, inp, out, turn ? turn.n : 0, snapshot,
          calls.map((c) => c.name).join(','),
          (j.content || '').replace(/\s+/g, ' ').slice(0, 100), 0, 0,
        ];
        s.series.push(curPoint);
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
        cur = zeroComp();
        const ev = { k: s.requests, step: j.step_index, ts, turn: s.turns, kind: 'compact', label: `checkpoint #${s.checkpoints.length + 1}`, tok: 0 };
        s.checkpoints.push({ k: s.requests, t: ts, step: j.step_index });
        s.events.push(ev);
        pendingCk = ev;
        continue;
      }
      addComp('system', est);
      if (type === 'SYSTEM_MESSAGE') {
        const m = /sender=([0-9a-f-]{36})(?![\w/-])/.exec(content);
        if (m && m[1] !== id) {
          const body = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content);
          s.comms.push({ ts, step: j.step_index, kind: 'in', peer: m[1], text: (body ? body[1] : content).trim().slice(0, 600) });
        }
      }
      if (!s.title && !s.turns) {
        const m = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content);
        const t = (m ? m[1] : '').replace(/<[^>]+>/g, ' ').replace(/\*\*Task\*\*:?|Task:|\*\*/g, ' ').replace(/\s+/g, ' ').trim();
        if (t) s.title = t.slice(0, 120);
      }
      if (type === 'ERROR_MESSAGE') {
        s.errors++;
        s.events.push({ k: s.requests, step: j.step_index, ts, turn: s.turns, kind: 'error', label: (j.error || content).replace(/\s+/g, ' ').slice(0, 100), tok: est });
      } else {
        s.events.push({ k: s.requests, step: j.step_index, ts, turn: s.turns, kind: 'inject', label: `${(type || '').toLowerCase().replace('_message', '')}: ${sourceOf(j)}`, tok: est });
      }
      continue;
    }

    // ---- tool result
    const call = pending.shift();
    const cat = isSkillRead(call) ? 'skills' : (RESULT_CAT[type] || TOOL_CAT[call && call.name] || 'other');
    addComp(cat, est);
    if (call) inc(s.toolTokens, call.name || 'unknown', est);

    const head = content.slice(0, 200);
    const c0 = tsOf(CREATED, head);
    const c1 = tsOf(COMPLETED, head) || c0;
    if (c0 && !(call && call.name === 'ask_question')) {
      s.timing.toolSum += Math.min(Math.max(c1 - c0, 0), 3600e3);
      if (!batch) {
        batch = { min: c0, max: c1 };
        if (reqTs) {
          const ms = Math.min(Math.max(c0 - reqTs, 0), 180e3);
          s.timing.model += ms;
          s.timing.modelCalls++;
          dayOf(reqTs).mm += ms;
          if (curPoint) curPoint[9] = ms;
        }
      } else { batch.min = Math.min(batch.min, c0); batch.max = Math.max(batch.max, c1); }
    }

    if (call && call.name === 'run_command' && (type === 'RUN_COMMAND' || type === 'GENERIC')) {
      s.cmdTotal++;
      const cmd = String(unq((call.args || {}).CommandLine) || '');
      let stt = 'ok';
      if (/running as a background task/i.test(head + content.slice(200, 500))) stt = 'bg';
      else if (/exit(?:ed)?\s*(?:with)?\s*code\s*([1-9]\d*)/i.test(content.slice(0, 600)) || /Encountered error/.test(head + content.slice(200, 300))) stt = 'fail';
      s.cmdList.push(parseCmdEntry(j.step_index, s.requests, c0 || ts, c0 ? Math.max(c1 - c0, 0) : 0, cmd, content, head));
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
      const ids = [...content.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]);
      ids.forEach((cid, i) => { s.children.push(cid); const d = delegations[i]; if (d) d.peer = cid; });
      delegations = delegations.slice(ids.length);
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
  if (s.comms.length > MAX_COMMS) s.comms = s.comms.slice(-MAX_COMMS);
  s.children = [...new Set(s.children)];
  if (!s.title) s.title = id.slice(0, 8);
  return s;
}

// ---------------------------------------------------------------- on-demand drill-down

function itemTitle(prefix, text) {
  return `${prefix}${text ? ` ${text}` : ''}`.replace(/\s+/g, ' ').slice(0, 140);
}

/**
 * What did request #k carry? Items since the last checkpoint, up to (not including) request k's response.
 * k = 0 means "live": everything up to the end of the log (what the next request will carry).
 * Also returns per-category snapshots at the previous request / before the current turn for diff badges.
 */
export async function browseRequest(id, k) {
  const file = logFile(id);
  let items = [];
  let pending = [];
  let n = 0;
  let turn = 0;
  let seq = 0;
  let prevStep = null;
  let prevStepSeq = 0;
  let turnStart = {};
  let turnSeq = 0;
  let lastTurnSnap = {};
  let lastTurnSeq = 0;
  let reqMeta = null;
  const push = (it) => { it.seq = ++seq; items.push(it); };
  const snap = () => {
    const o = {};
    for (const it of items) { const e = (o[it.cat] ||= { n: 0, t: 0 }); e.n++; e.t += it.tok; }
    return o;
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const type = j.type;
    if (type === 'PLANNER_RESPONSE') {
      const hasTokens = j.input_tokens != null || j.cache_read_tokens != null;
      if (hasTokens && k && n + 1 === k) {
        turnStart = lastTurnSnap; turnSeq = lastTurnSeq;
        const inp = j.input_tokens || 0; const cr = j.cache_read_tokens || 0;
        reqMeta = { k, turn, ts: Date.parse(j.created_at) || 0, prompt: inp + cr, fresh: inp, cache: cr, output: j.output_tokens || 0 };
        break;
      }
      if (hasTokens && k && n + 1 === k - 1) { prevStep = snap(); prevStepSeq = seq; }
      if (hasTokens) n++;
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      pending = calls.slice();
      if (j.thinking) push({ step: j.step_index, turn, cat: 'reasoning', kind: 'think', title: itemTitle('reasoning', j.thinking.slice(0, 80)), tok: estimateTokens(j.thinking) });
      if (j.content) push({ step: j.step_index, turn, cat: 'answer', kind: 'answer', title: itemTitle('answer', j.content.slice(0, 80)), tok: estimateTokens(j.content) });
      for (const c of calls) {
        push({ step: j.step_index, turn, cat: 'toolCalls', kind: 'tool', provider: toolProvider(c), call: c.name, title: itemTitle(c.name, toolBrief(c)), tok: estimateTokens(JSON.stringify(c)) });
      }
      continue;
    }
    const content = j.content || '';
    const media = Array.isArray(j.media) && j.media.length ? j.media.map((m) => ({ mime: m.mime_type || '', uri: m.uri || '' })) : null;
    if (type === 'USER_INPUT') {
      lastTurnSnap = snap(); lastTurnSeq = seq;
      turn++;
      const mTok = media ? media.length * 512 : 0;
      const it = { step: j.step_index, turn, cat: 'user', title: itemTitle('user', userText(content).slice(0, 100)), tok: estimateTokens(content) + mTok };
      if (media) it.media = media;
      push(it);
    } else if (type === 'CHECKPOINT') {
      prevStepSeq = seq; lastTurnSeq = seq;
      items = []; push({ step: j.step_index, turn, cat: 'system', title: 'checkpoint (summary of earlier turns)', tok: estimateTokens(content) });
    } else if (SYSTEM_TYPES.has(type) || j.source === 'SYSTEM' || j.source === 'SYSTEM_SDK') {
      push({ step: j.step_index, turn, cat: 'system', title: itemTitle((type || '').toLowerCase(), sourceOf(j)), tok: estimateTokens(content) });
    } else {
      const call = pending.shift();
      const cat = isSkillRead(call) ? 'skills' : (RESULT_CAT[type] || TOOL_CAT[call && call.name] || 'other');
      const head = content.slice(0, 400);
      const cp = call ? callPath(call) : '';
      const imgMedia = !media && cp && IMG_RE.test(cp) ? [{ mime: `image/${path.extname(cp).slice(1).toLowerCase()}`, uri: cp }] : media;
      const it = {
        step: j.step_index, turn, cat, title: itemTitle(call ? `${call.name} →` : `${type} →`, call ? toolBrief(call) : ''),
        tok: estimateTokens(content) + (imgMedia && estimateTokens(content) < 120 ? imgMedia.length * 512 : 0),
        ok: !isErrorHead(head), lines: content ? content.split('\n').length : 0,
      };
      if (call) { it.call = call.name; it.provider = toolProvider(call); it.args = JSON.stringify(call.args || {}, null, 1).slice(0, 1500); }
      if (imgMedia) it.media = imgMedia;
      push(it);
    }
    if (items.length > 4000) items.splice(0, items.length - 3000);
  }
  items.forEach((it, idx) => { it.pos = idx + 1; });
  return { items, prev: { step: prevStep || {}, turn: turnStart, stepSeq: prevStepSeq, turnSeq }, reqMeta };
}

/** Per-request item strips for Trend DNA mode (computed on demand, never stored in cache). */
export async function dnaSeries(id) {
  const file = logFile(id);
  let items = [];
  let pending = [];
  let n = 0;
  let turn = 0;
  const reqs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const type = j.type;
    if (type === 'PLANNER_RESPONSE') {
      const hasTok = j.input_tokens != null || j.cache_read_tokens != null;
      if (hasTok) {
        n++;
        // keep a compact DNA strip (<= 40 bands per bar) so the SVG stays light even on huge sessions
        let compact = items;
        if (items.length > 40) {
          const minTok = [...items].map((x) => x[2]).sort((a, b) => b - a)[34] || 0;
          compact = items.filter((x, i) => x[2] >= minTok || i >= items.length - 8).slice(-40);
        }
        reqs.push({ k: n, turn, ctx: (j.input_tokens || 0) + (j.cache_read_tokens || 0), items: compact.map((x) => [...x]) });
      }
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      pending = calls.slice();
      if (j.thinking) items.push([j.step_index, 'reasoning', estimateTokens(j.thinking), 'reasoning']);
      if (j.content) items.push([j.step_index, 'answer', estimateTokens(j.content), 'answer']);
      for (const c of calls) items.push([j.step_index, 'toolCalls', estimateTokens(JSON.stringify(c)), c.name]);
      continue;
    }
    const content = j.content || '';
    if (type === 'USER_INPUT') {
      turn++;
      items.push([j.step_index, 'user', estimateTokens(content), userText(content).slice(0, 48)]);
    } else if (type === 'CHECKPOINT') {
      items = [[j.step_index, 'system', estimateTokens(content), 'checkpoint']];
    } else if (SYSTEM_TYPES.has(type) || j.source === 'SYSTEM' || j.source === 'SYSTEM_SDK') {
      items.push([j.step_index, 'system', estimateTokens(content), sourceOf(j)]);
    } else {
      const call = pending.shift();
      const cat = isSkillRead(call) ? 'skills' : (RESULT_CAT[type] || TOOL_CAT[call && call.name] || 'other');
      items.push([j.step_index, cat, estimateTokens(content), call ? `${call.name} ${toolBrief(call).slice(0, 36)}` : type]);
    }
    if (items.length > 2000) items.splice(0, items.length - 1500);
  }
  if (reqs.length > 240) {
    const step = reqs.length / 240;
    const out = [];
    for (let i = 0; i < 240; i++) out.push(reqs[Math.min(reqs.length - 1, Math.floor(i * step))]);
    return out;
  }
  return reqs;
}

/** Load EVERY run_command entry from a conversation log (used when cmdTotal > 300). */
export async function allCommands(id) {
  const file = logFile(id);
  const out = [];
  let pending = [];
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const type = j.type;
    if (type === 'PLANNER_RESPONSE') {
      if (j.input_tokens != null || j.cache_read_tokens != null) n++;
      pending = Array.isArray(j.tool_calls) ? j.tool_calls.slice() : [];
      continue;
    }
    if (type === 'USER_INPUT' || SYSTEM_TYPES.has(type) || j.source === 'SYSTEM' || j.source === 'SYSTEM_SDK') continue;
    const call = pending.shift();
    if (call && call.name === 'run_command' && (type === 'RUN_COMMAND' || type === 'GENERIC')) {
      const content = j.content || '';
      const head = content.slice(0, 200);
      const ts = Date.parse(j.created_at) || 0;
      const c0 = tsOf(CREATED, head);
      const c1 = tsOf(COMPLETED, head) || c0;
      const cmd = String(unq((call.args || {}).CommandLine) || '');
      out.push(parseCmdEntry(j.step_index, n, c0 || ts, c0 ? Math.max(c1 - c0, 0) : 0, cmd, content, head));
    }
  }
  return out;
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
        media: Array.isArray(j.media) ? j.media : [],
        inputTokens: j.input_tokens, cacheTokens: j.cache_read_tokens, outputTokens: j.output_tokens,
      };
    }
  }
  return null;
}

/** Resolve whether a local image URI belongs to a conversation (for safe /api/media preview). */
export async function resolveMedia(id, uri) {
  const clean = String(uri || '').replace(/^file:\/\//, '');
  if (!clean || !IMG_RE.test(clean)) return null;
  const resolved = path.resolve(clean);
  const convBrain = path.resolve(path.join(brainDir(), id));
  let allowed = resolved.startsWith(convBrain + path.sep);
  if (!allowed) {
    // also allow if the exact file path was referenced in this conversation's transcript
    const file = logFile(id);
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.includes(resolved) || line.includes(clean)) { allowed = true; break; }
    }
    rl.close();
  }
  if (!allowed) return null;
  try {
    const st = await fsp.stat(resolved);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return null;
    const buf = await fsp.readFile(resolved);
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const dims = imageDimensions(buf);
    const estTokens = dims
      ? Math.min(1600, Math.max(258, Math.ceil((dims.width * dims.height) / 750)))
      : 512;
    return {
      mime, size: st.size, width: dims?.width || 0, height: dims?.height || 0,
      estTokens, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(resolved),
    };
  } catch { return null; }
}

// ---------------------------------------------------------------- SQLite metadata enrichment + cache

let sqliteMod = null;
async function loadSummaryMeta() {
  const dbPath = summaryDbPath();
  const out = new Map();
  if (!fs.existsSync(dbPath)) return out;
  try {
    if (!sqliteMod) {
      // Suppress Node's one-time SQLite ExperimentalWarning so CLI output stays clean.
      const prev = process.listeners('warning');
      const hush = (w) => { if (w?.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return; for (const fn of prev) fn(w); };
      process.removeAllListeners('warning');
      process.on('warning', hush);
      sqliteMod = await import('node:sqlite');
    }
    const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const archived = new Set();
      try {
        for (const r of db.prepare('SELECT DISTINCT conversation_id FROM conversations_fts WHERE archived = 1').all()) {
          archived.add(r.conversation_id);
        }
      } catch { /* FTS table optional */ }
      const rows = db.prepare(
        'SELECT conversation_id, title, preview, workspace_uris, status, agent_name, parent_conversation_id, group_id FROM conversation_summaries',
      ).all();
      for (const r of rows) {
        let workspace = '';
        try {
          const arr = JSON.parse(r.workspace_uris || '[]');
          if (Array.isArray(arr) && arr[0]) workspace = String(arr[0]).replace(/^file:\/\//, '');
        } catch { /* ignore */ }
        out.set(r.conversation_id, {
          title: r.title || r.preview || '',
          workspace,
          project: workspace ? path.basename(workspace) : '',
          running: r.status === 'CASCADE_RUN_STATUS_RUNNING',
          agentName: r.agent_name || '',
          parentId: r.parent_conversation_id || '',
          groupId: r.group_id || '',
          archived: archived.has(r.conversation_id),
        });
      }
    } finally { db.close(); }
  } catch { /* fallback cleanly to JSONL-only metadata */ }
  return out;
}

const memo = new Map(); // id -> parsed summary
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

/** Load (incrementally) every conversation summary, enriched with live DB metadata. */
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

      const metaMap = await loadSummaryMeta();
      const items = [...memo.values()];
      const byId = new Map(items.map((s) => [s.id, s]));
      // Merge DB metadata + parent-child links dynamically on a fresh shallow wrapper so memo stays pure.
      const dbChildren = new Map();
      for (const [cid, m] of metaMap) {
        if (m.parentId && byId.has(m.parentId) && byId.has(cid)) {
          let arr = dbChildren.get(m.parentId);
          if (!arr) { arr = []; dbChildren.set(m.parentId, arr); }
          arr.push(cid);
        }
      }
      return items.map((s) => {
        const m = metaMap.get(s.id);
        const extra = dbChildren.get(s.id);
        if (!m && !extra) return s;
        const children = extra ? [...new Set([...s.children, ...extra])] : s.children;
        return {
          ...s,
          title: (m?.title && (!s.title || s.title === s.id.slice(0, 8) || m.title.length < 100)) ? m.title : (s.title || m?.title || s.id.slice(0, 8)),
          workspace: m?.workspace || '',
          project: m?.project || s.project,
          agentName: m?.agentName || '',
          parentId: m?.parentId || '',
          groupId: m?.groupId || '',
          dbRunning: !!m?.running,
          archived: !!m?.archived,
          children,
        };
      });
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

function teamTotals(byId, rootId, settings) {
  const seen = new Set();
  const stack = [rootId];
  let tokens = 0; let cost = 0; let count = 0;
  while (stack.length) {
    const cid = stack.pop();
    if (seen.has(cid)) continue;
    seen.add(cid);
    const s = byId.get(cid);
    if (!s) continue;
    count++;
    tokens += s.tokens.input + s.tokens.cache + s.tokens.output;
    cost += costWithPricing(s.tokens, resolvePricing(s.model, settings));
    for (const ch of s.children || []) stack.push(ch);
  }
  return { tokens, cost, count };
}

export function brief(s, settingsOrRates, byId) {
  const settings = settingsOrRates && 'rates' in settingsOrRates ? settingsOrRates : { rates: settingsOrRates || {}, autoPrice: false };
  const pricing = resolvePricing(s.model, settings);
  const toolCalls = Object.values(s.tools).reduce((a, b) => a + b, 0);
  const cost = costWithPricing(s.tokens, pricing);
  const subCost = byId && s.children?.length
    ? Math.max(0, teamTotals(byId, s.id, settings).cost - cost)
    : 0;
  const team = byId && s.children?.length ? teamTotals(byId, s.id, settings) : null;
  return {
    id: s.id, title: s.title, lastUser: s.lastUser || '', project: s.project, workspace: s.workspace || '',
    first: s.first, last: s.last,
    steps: s.steps, turns: s.turns, requests: s.requests, errors: s.errors,
    hasTokens: s.hasTokens, tokens: s.tokens, peak: s.peak, lastCtx: s.lastCtx,
    model: s.model || s.startModel || '', agentName: s.agentName || '', archived: !!s.archived,
    running: !!(s.dbRunning || (Date.now() - s.last < RUN_MS)),
    comp: s.comp, toolCalls, checkpoints: s.checkpoints.length,
    cost, subCost, teamTokens: team ? team.tokens : 0, teamCost: team ? team.cost : 0,
    pricing: pricing ? { input: pricing.input, cache: pricing.cache, output: pricing.output, window: pricing.window, source: pricing.source } : null,
    toolNames: Object.keys(s.tools), cmdNames: Object.keys(s.cmds), skillNames: Object.keys(s.skills),
    activeDays: Object.keys(s.daily), children: s.children.length,
  };
}

export function overview(list, { days = 30, day = '', from = '', to = '', archived = 'active', now = Date.now(), rates, settings } = {}) {
  const cfg = settings || { rates: rates || {}, autoPrice: false };
  const byId = new Map(list.map((s) => [s.id, s]));
  const cutoff = days > 0 ? dayKey(now - (days - 1) * 864e5) : '';
  const inRange = (d) => {
    if (day) return d === day;
    if (from || to) return (!from || d >= from) && (!to || d <= to);
    return !cutoff || d >= cutoff;
  };
  const visibleArchived = (s) => archived === 'all' || (archived === 'archived' ? !!s.archived : !s.archived);

  const convs = [];
  const totals = { convs: 0, archivedConvs: 0, totalConvs: list.length, requests: 0, input: 0, cache: 0, output: 0, toolCalls: 0, turns: 0, priced: 0 };
  const tools = {}; const cmds = {}; const skills = {}; const files = {}; const comp = {};
  const toolSess = {}; const cmdSess = {}; const skillSess = {}; const skillMeta = {};
  const lastUsed = { tool: {}, cmd: {}, skill: {} };
  const dailyAll = {};
  let model = 0; let toolMs = 0; let totalCost = 0;

  for (const s of list) {
    if (s.archived) totals.archivedConvs++;
    const p = resolvePricing(s.model, cfg);
    if (visibleArchived(s)) {
      for (const [d, v] of Object.entries(s.daily)) {
        const t = (dailyAll[d] ||= { r: 0, i: 0, c: 0, o: 0, t: 0, s: 0, cost: 0 });
        t.r += v.r; t.i += v.i; t.c += v.c; t.o += v.o; t.t += v.t; t.s++;
        if (p) t.cost += costWithPricing({ input: v.i, cache: v.c, output: v.o }, p);
      }
    }
    if (!visibleArchived(s)) continue;
    let any = false;
    const sTools = new Set(); const sCmds = new Set(); const sSkills = new Set();
    for (const [d, v] of Object.entries(s.daily)) {
      if (!inRange(d)) continue;
      any = true;
      totals.requests += v.r; totals.input += v.i; totals.cache += v.c; totals.output += v.o; totals.toolCalls += v.t;
      if (p) totalCost += costWithPricing({ input: v.i, cache: v.c, output: v.o }, p);
      model += v.mm || 0; toolMs += v.tm || 0;
      sumInto(tools, v.tl || {}); sumInto(cmds, v.cm || {}); sumInto(skills, v.sk || {}); sumInto(comp, v.cp || {});
      for (const k of Object.keys(v.tl || {})) sTools.add(k);
      for (const k of Object.keys(v.cm || {})) sCmds.add(k);
      for (const k of Object.keys(v.sk || {})) sSkills.add(k);
    }
    if (!any && !day && !from && !to && (!cutoff || (s.last && dayKey(s.last) >= cutoff))) any = true;
    if (!any) continue;
    convs.push(s);
    totals.convs++; totals.turns += s.turns;
    if (p) totals.priced++;
    for (const k of sTools) inc(toolSess, k);
    for (const k of sCmds) inc(cmdSess, k);
    for (const k of sSkills) inc(skillSess, k);
    for (const [k, m] of Object.entries(s.skillMeta || {})) if (!skillMeta[k]) skillMeta[k] = m;
    for (const kind of ['tool', 'cmd', 'skill']) {
      for (const [name, ts] of Object.entries(s.seen[kind])) if (ts > (lastUsed[kind][name] || 0)) lastUsed[kind][name] = ts;
    }
    for (const [fp, f] of Object.entries(s.files)) inc(files, fp, f.r + f.w + f.s + f.img);
  }
  const dayList = (n) => Array.from({ length: n }, (_, k) => {
    const d = dayKey(now - (n - 1 - k) * 864e5);
    return { day: d, ...(dailyAll[d] || { r: 0, i: 0, c: 0, o: 0, t: 0, s: 0, cost: 0 }) };
  });
  const topL = (o, sess, n, kind) => top(o, n).map((x) => ({
    ...x, sessions: sess[x.name] || 0, last: lastUsed[kind][x.name] || 0,
    ...(kind === 'skill' && skillMeta[x.name] ? skillMeta[x.name] : {}),
  }));
  return {
    days, day, from, to, archived, totals, cost: totalCost,
    timing: { model, tool: toolMs },
    cacheHit: totals.cache + totals.input ? totals.cache / (totals.cache + totals.input) : 0,
    last7: dayList(7), heat: dayList(56),
    tools: topL(tools, toolSess, 60, 'tool'),
    cmds: topL(cmds, cmdSess, 60, 'cmd'),
    skills: topL(skills, skillSess, 60, 'skill'),
    files: top(files, 12),
    comp,
    conversations: convs.sort((a, b) => b.last - a.last).map((s) => brief(s, cfg, byId)),
  };
}

export function pickCurrent(list) {
  return [...list].sort((a, b) => b.last - a.last)[0] || null;
}

export function detail(s, settingsOrRates, list) {
  const byId = list ? new Map(list.map((x) => [x.id, x])) : null;
  const filesList = Object.entries(s.files)
    .map(([name, f]) => ({ name, ...f }))
    .sort((a, b) => (b.r + b.w + b.s + b.img) - (a.r + a.w + a.s + a.img));
  const tps = s.timing.model > 0 ? Math.round((s.tokens.output / s.timing.model) * 1000) : 0;
  return {
    ...brief(s, settingsOrRates, byId),
    cacheHit: s.tokens.cache + s.tokens.input ? s.tokens.cache / (s.tokens.cache + s.tokens.input) : 0,
    startCtx: s.startCtx, baseline: s.baseline ?? 0, compNow: s.compNow,
    timing: { ...s.timing, tps }, comms: s.comms,
    series: s.series, checkpointList: s.checkpoints, turnList: s.turnList, events: s.events,
    tools: top(s.tools, 30).map((x) => ({ ...x, tok: s.toolTokens?.[x.name] || 0 })),
    cmds: top(s.cmds, 40).map((x) => ({ ...x, runs: s.cmdProgRuns?.[x.name] || 0 })),
    cmdTotal: s.cmdTotal || s.cmdList.length,
    skills: top(s.skills, 20).map((x) => ({ ...x, ...(s.skillMeta?.[x.name] || {}) })),
    files: filesList, cmdList: s.cmdList, daily: s.daily, childIds: s.children,
  };
}

/** Agent family of a conversation: parent, itself, and all (transitive) subagent conversations. */
export function fleet(list, id, settingsOrRates) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const parentOf = new Map();
  for (const s of list) {
    if (s.parentId && byId.has(s.parentId)) parentOf.set(s.id, s.parentId);
    for (const c of s.children) if (!parentOf.has(c)) parentOf.set(c, s.id);
  }
  let root = id;
  const guard = new Set();
  while (parentOf.has(root) && !guard.has(root)) { guard.add(root); root = parentOf.get(root); }
  const nodes = [];
  const walk = (cid, depth, parent, teammate = false) => {
    const s = byId.get(cid);
    if (!s || nodes.some((n) => n.id === cid)) return;
    nodes.push({
      ...brief(s, settingsOrRates, byId), depth, parent, teammate, isCurrent: cid === id,
      activeMs: s.timing.model + s.timing.tool,
      comms: s.comms,
    });
    for (const c of s.children) walk(c, depth + 1, cid);
  };
  walk(root, 0, null);
  const gid = byId.get(root)?.groupId;
  if (gid) {
    for (const s of list) {
      if (s.groupId === gid && !nodes.some((n) => n.id === s.id)) walk(s.id, 1, root, true);
    }
  }
  return { current: id, root, nodes };
}
