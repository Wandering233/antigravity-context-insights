#!/usr/bin/env node
// agy-context CLI — context insight reports for Antigravity conversations.
//
//   node cli.mjs session <conversation-id|prefix|latest> [--json]
//   node cli.mjs overview [--days N] [--json]
//   node cli.mjs list [--limit N] [--json]
//   node cli.mjs fleet <conversation-id|prefix|latest> [--json]
//   node cli.mjs browse <conversation-id|prefix> <request#|0> [--json]

import { browseRequest, detail, fleet, getConversation, loadAll, overview, pickCurrent } from './analyzer.mjs';
import { fleetReport, k, overviewReport, sessionReport, table, when } from './report.mjs';
import { getSettings } from './settings.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'help';
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--json'));
const json = flag('json');

function help() {
  return `agy-context — context insight for Antigravity conversations

  session <id|prefix|latest> [--json]   composition, context trend, events, heavy turns, commands, files
  overview [--days N] [--json]          usage across conversations (default 30 days, 0 = all)
  list [--limit N] [--json]             recent conversations
  fleet <id|prefix|latest> [--json]     parent / subagent conversations of an agent family
  browse <id|prefix> <request#|0>       what a model request carried (0 = live / next request)`;
}

async function pick(all, want) {
  return want === 'latest' ? pickCurrent(all) : getConversation(want);
}

async function main() {
  const settings = await getSettings();
  if (cmd === 'session') {
    const all = await loadAll();
    const want = positional[0] || 'latest';
    const s = await pick(all, want);
    if (!s) { console.error(`No conversation matches "${want}".`); process.exit(1); }
    const d = detail(s, settings, all);
    console.log(json ? JSON.stringify(d, null, 2) : sessionReport(d));
  } else if (cmd === 'overview') {
    const o = overview(await loadAll(), { days: Number(opt('days', 30)), settings });
    console.log(json ? JSON.stringify(o, null, 2) : overviewReport(o));
  } else if (cmd === 'list') {
    const o = overview(await loadAll(), { days: 0, archived: 'all', settings });
    const list = o.conversations.slice(0, Number(opt('limit', 15)));
    console.log(json ? JSON.stringify(list, null, 2) : table(['ID', 'Last active', 'Title', 'Turns', 'Peak ctx'],
      list.map((c) => [c.id, when(c.last), (c.title || '').slice(0, 60), c.turns, c.hasTokens ? k(c.peak) : '-'])));
  } else if (cmd === 'fleet') {
    const all = await loadAll();
    const s = await pick(all, positional[0] || 'latest');
    if (!s) { console.error('No such conversation.'); process.exit(1); }
    const f = fleet(all, s.id, settings);
    console.log(json ? JSON.stringify(f, null, 2) : fleetReport(f));
  } else if (cmd === 'browse') {
    const s = await getConversation(positional[0] || '');
    const n = Number(positional[1]);
    if (!s || Number.isNaN(n)) { console.error('usage: browse <conversation-id> <request#|0=live>'); process.exit(1); }
    const { items } = await browseRequest(s.id, n);
    if (json) { console.log(JSON.stringify(items, null, 2)); return; }
    const total = items.reduce((a, b) => a + b.tok, 0);
    console.log(`${n ? `Request #${n}` : 'Live (next request)'} of ${s.id.slice(0, 8)} carried ${items.length} items ≈ ${k(total)} tokens since the last checkpoint\n`);
    console.log(table(['Step', 'Category', '≈ Tokens', 'Item'],
      [...items].sort((a, b) => b.tok - a.tok).slice(0, 25).map((i) => [i.step, i.cat, k(i.tok), i.title])));
  } else {
    console.log(help());
  }
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
