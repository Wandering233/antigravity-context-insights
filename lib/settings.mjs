// agy-context settings: user preferences + always-on system prompt prefix/suffix rules.
//
// Preferences live in <plugin_data>/agy-context/settings.json.
// Prefix & suffix are written to this plugin's own rules/AGENTS.md, which Antigravity loads
// as an always-on rule while the plugin is enabled (the counterpart of dsh-context's system
// prompt prefix/suffix). The file is only ever written from user-provided text and is removed
// again when both fields are cleared.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './analyzer.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE_FILE = path.join(pluginRoot, 'rules', 'AGENTS.md');
const settingsFile = () => path.join(dataDir(), 'settings.json');

export const DEFAULTS = {
  days: 30,                 // default time range of the Insights page (1 = today, 0 = all)
  contextWindow: 1000000,   // fallback tokens for the "Current context" gauge
  autoPrice: true,          // use built-in reference pricing when custom rates are 0
  currency: 'USD',          // USD | CNY
  rates: { input: 0, cache: 0, output: 0 }, // custom USD per 1M tokens (overrides autoPrice when > 0)
  trendMode: 'total',       // total | delta
  trendGran: 'step',        // step | turn
  trendOverview: false,     // compress the whole session into the panel width
  trendCurves: false,       // overlay per-request model / tool duration curves
  trendAutoThreshold: 100,  // auto switch the trend to "fit to width" above this many bars (0 = never)
  compareBaseline: 'step',  // step | turn — baseline of the Browser diff badges
  toolSort: 'count',        // count | size | name
  fileSort: 'lines',        // count | lines | latest | path | name
  sort: 'recent',           // recent | peak | ctx | tok
  groupByProject: false,
  archivedMode: 'active',   // active | all | archived
  lang: 'auto',             // auto | zh | en
  showInsights: true,
  showFleet: true,
  promptPrefix: '',
  promptSuffix: '',
};

const num = (v, d, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };

function sanitize(p) {
  const raw = { ...p };
  // migrate legacy single customInstructions field into promptSuffix if present
  if (raw.customInstructions && !raw.promptSuffix && !raw.promptPrefix) {
    raw.promptSuffix = raw.customInstructions;
  }
  delete raw.customInstructions;
  const out = { ...DEFAULTS, ...raw };
  out.days = [0, 1, 7, 30, 90].includes(Number(out.days)) ? Number(out.days) : DEFAULTS.days;
  out.contextWindow = Math.round(num(out.contextWindow, DEFAULTS.contextWindow, 1000));
  out.autoPrice = out.autoPrice !== false;
  out.currency = out.currency === 'CNY' ? 'CNY' : 'USD';
  out.rates = {
    input: num(out.rates?.input, 0), cache: num(out.rates?.cache, 0), output: num(out.rates?.output, 0),
  };
  out.trendMode = out.trendMode === 'delta' ? 'delta' : 'total';
  out.trendGran = out.trendGran === 'turn' ? 'turn' : 'step';
  out.trendOverview = !!out.trendOverview;
  out.trendCurves = !!out.trendCurves;
  out.trendAutoThreshold = [0, 100, 200, 300].includes(Number(out.trendAutoThreshold))
    ? Number(out.trendAutoThreshold)
    : Math.round(num(out.trendAutoThreshold, DEFAULTS.trendAutoThreshold));
  out.compareBaseline = out.compareBaseline === 'turn' ? 'turn' : 'step';
  out.toolSort = ['count', 'size', 'name'].includes(out.toolSort) ? out.toolSort : 'count';
  // accept legacy 'activity' alias
  const fs = out.fileSort === 'activity' ? 'count' : out.fileSort;
  out.fileSort = ['count', 'lines', 'latest', 'path', 'name'].includes(fs) ? fs : 'lines';
  out.sort = ['recent', 'peak', 'ctx', 'tok'].includes(out.sort) ? out.sort : 'recent';
  out.groupByProject = !!out.groupByProject;
  out.archivedMode = ['active', 'all', 'archived'].includes(out.archivedMode) ? out.archivedMode : 'active';
  out.lang = ['zh', 'en'].includes(out.lang) ? out.lang : 'auto';
  out.showInsights = out.showInsights !== false;
  out.showFleet = out.showFleet !== false;
  out.promptPrefix = String(out.promptPrefix || '').slice(0, 12000);
  out.promptSuffix = String(out.promptSuffix || '').slice(0, 12000);
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
  if (next.promptPrefix !== cur.promptPrefix || next.promptSuffix !== cur.promptSuffix) {
    await syncRule(next.promptPrefix, next.promptSuffix);
  }
  return next;
}

async function syncRule(prefix, suffix) {
  const p = prefix.trim();
  const s = suffix.trim();
  if (!p && !s) {
    await fsp.rm(RULE_FILE, { force: true });
    await fsp.rmdir(path.dirname(RULE_FILE)).catch(() => {}); // only succeeds when empty
    return;
  }
  const blocks = [];
  if (p) blocks.push(p);
  if (s) blocks.push(s);
  await fsp.mkdir(path.dirname(RULE_FILE), { recursive: true });
  await fsp.writeFile(RULE_FILE, `${blocks.join('\n\n')}\n`);
}
