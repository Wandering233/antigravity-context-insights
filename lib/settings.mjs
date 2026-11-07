// agy-context settings: user preferences + always-on custom instructions.
//
// Preferences live in <plugin_data>/agy-context/settings.json.
// "Custom instructions" are written to this plugin's own rules/AGENTS.md, which Antigravity loads
// as an always-on rule while the plugin is enabled (the counterpart of dsh-context's system
// prompt prefix/suffix). The file is only ever written from the text the user typed in the
// settings page and is removed again when the text is cleared.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './analyzer.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE_FILE = path.join(pluginRoot, 'rules', 'AGENTS.md');
const settingsFile = () => path.join(dataDir(), 'settings.json');

export const DEFAULTS = {
  days: 30,                 // default time range of the Insights page (0 = all)
  contextWindow: 1000000,   // tokens, used for the "Current context" gauge
  rates: { input: 0, cache: 0, output: 0 }, // USD per 1M tokens; 0 = cost hidden
  trendMode: 'total',       // total | delta
  trendGran: 'step',        // step | turn
  trendOverview: false,     // compress the whole session into the panel width
  sort: 'recent',           // recent | peak | tok
  groupByProject: false,
  customInstructions: '',
};

const num = (v, d, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };

function sanitize(p) {
  const out = { ...DEFAULTS, ...p };
  out.days = [0, 7, 30, 90].includes(Number(out.days)) ? Number(out.days) : DEFAULTS.days;
  out.contextWindow = Math.round(num(out.contextWindow, DEFAULTS.contextWindow, 1000));
  out.rates = {
    input: num(out.rates?.input, 0), cache: num(out.rates?.cache, 0), output: num(out.rates?.output, 0),
  };
  out.trendMode = out.trendMode === 'delta' ? 'delta' : 'total';
  out.trendGran = out.trendGran === 'turn' ? 'turn' : 'step';
  out.trendOverview = !!out.trendOverview;
  out.sort = ['recent', 'peak', 'tok'].includes(out.sort) ? out.sort : 'recent';
  out.groupByProject = !!out.groupByProject;
  out.customInstructions = String(out.customInstructions || '').slice(0, 20000);
  return out;
}

export async function getSettings() {
  try { return sanitize(JSON.parse(await fsp.readFile(settingsFile(), 'utf8'))); } catch { return sanitize({}); }
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = sanitize({ ...cur, ...patch, rates: { ...cur.rates, ...(patch.rates || {}) } });
  await fsp.mkdir(dataDir(), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(next, null, 2));
  if (next.customInstructions !== cur.customInstructions) await syncRule(next.customInstructions);
  return next;
}

async function syncRule(text) {
  const t = text.trim();
  if (!t) {
    await fsp.rm(RULE_FILE, { force: true });
    await fsp.rmdir(path.dirname(RULE_FILE)).catch(() => {}); // only succeeds when empty
    return;
  }
  await fsp.mkdir(path.dirname(RULE_FILE), { recursive: true });
  await fsp.writeFile(RULE_FILE, `${t}\n`);
}
