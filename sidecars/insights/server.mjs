// Context Insights sidecar: serves the dashboard and analytics over local conversation logs.
// Every endpoint is POST so the sidecar token is enforced by sidecar_sdk. Conversation text and
// attachment previews are only served for explicit drill-downs to this local, token-protected UI.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sdk;
try {
  sdk = await import('sidecar_sdk');
} catch {
  sdk = await import(new URL(`file://${path.join(os.homedir(), '.gemini/antigravity/lib/node_modules/sidecar_sdk/index.mjs')}`).href);
}
const { SidecarApp } = sdk;
const A = await import('../../lib/analyzer.mjs');
const { getSettings, setSettings } = await import('../../lib/settings.mjs');
const { askPrompt, btwQuestion } = await import('../../lib/report.mjs');
const pluginMeta = JSON.parse(readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8'));

const app = new SidecarApp();
app.page('/', () => readFileSync(new URL('./index.html', import.meta.url), 'utf8'));

async function resolve(id) {
  const all = await A.loadAll();
  const s = id ? await A.getConversation(String(id)) : A.pickCurrent(all);
  return { all, s };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.api('/api/settings', async () => getSettings());
app.api('/api/settings/save', async (d) => setSettings(d || {}));
app.api('/api/plugin-info', async () => ({
  name: pluginMeta.name,
  displayName: pluginMeta.displayName,
  version: pluginMeta.version,
  description: pluginMeta.description,
  homepage: pluginMeta.homepage,
  repository: pluginMeta.repository,
}));

app.api('/api/overview', async (d) => {
  const settings = await getSettings();
  const days = d.days !== undefined ? Number(d.days) : settings.days;
  const day = DATE_RE.test(d.day || '') ? d.day : '';
  const from = DATE_RE.test(d.from || '') ? d.from : '';
  const to = DATE_RE.test(d.to || '') ? d.to : '';
  const archived = ['active', 'all', 'archived'].includes(d.archived) ? d.archived : settings.archivedMode;
  return A.overview(await A.loadAll(), { days, day, from, to, archived, settings });
});

app.api('/api/conversation', async (d) => {
  const { all, s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  return A.detail(s, await getSettings(), all);
});

app.api('/api/fleet', async (d) => {
  const { all, s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  return A.fleet(all, s.id, await getSettings());
});

app.api('/api/browse', async (d) => {
  const { s } = await resolve(d.id);
  const k = Number(d.k) || 0; // 0 = live (what the next request will carry)
  if (!s) return { error: 'not-found' };
  return A.browseRequest(s.id, k);
});

app.api('/api/commands', async (d) => {
  const { s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  return { id: s.id, cmdList: await A.allCommands(s.id) };
});

app.api('/api/dna', async (d) => {
  const { s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  return { id: s.id, requests: await A.dnaSeries(s.id) };
});

app.api('/api/step', async (d) => {
  const { s } = await resolve(d.id);
  const step = Number(d.step);
  if (!s || !Number.isInteger(step)) return { error: 'not-found' };
  return (await A.getStep(s.id, step)) || { error: 'not-found' };
});

app.api('/api/media', async (d) => {
  const { s } = await resolve(d.id);
  if (!s || !d.uri) return { error: 'not-found' };
  const m = await A.resolveMedia(s.id, String(d.uri));
  return m || { error: 'not-found' };
});

// Self-contained prompt for the isolated "side question" conversation + the text for a native /btw.
app.api('/api/ask-prompt', async (d) => {
  const { all, s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  const det = A.detail(s, await getSettings(), all);
  return { id: s.id, prompt: askPrompt(det, d.lang), btw: btwQuestion(det, d.lang) };
});

await app.run();
