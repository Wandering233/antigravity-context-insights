// Context Insights sidecar: serves the dashboard and analytics over local conversation logs.
// Every endpoint is POST so the sidecar token is enforced by sidecar_sdk. Conversation text is
// only served for explicit drill-downs (/api/browse, /api/step) to this local, token-protected UI.

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

const app = new SidecarApp();
app.page('/', () => readFileSync(new URL('./index.html', import.meta.url), 'utf8'));

async function resolve(id) {
  const all = await A.loadAll();
  const s = id ? await A.getConversation(String(id)) : A.pickCurrent(all);
  return { all, s };
}

app.api('/api/settings', async () => getSettings());
app.api('/api/settings/save', async (d) => setSettings(d || {}));

app.api('/api/overview', async (d) => {
  const { rates, days } = await getSettings();
  return A.overview(await A.loadAll(), { days: Number(d.days ?? days), rates });
});

app.api('/api/conversation', async (d) => {
  const { s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  return A.detail(s, (await getSettings()).rates);
});

app.api('/api/fleet', async (d) => {
  const { all, s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  return A.fleet(all, s.id, (await getSettings()).rates);
});

app.api('/api/browse', async (d) => {
  const { s } = await resolve(d.id);
  const k = Number(d.k);
  if (!s || !k) return { error: 'not-found' };
  return { items: await A.browseRequest(s.id, k) };
});

app.api('/api/step', async (d) => {
  const { s } = await resolve(d.id);
  const step = Number(d.step);
  if (!s || !Number.isInteger(step)) return { error: 'not-found' };
  return (await A.getStep(s.id, step)) || { error: 'not-found' };
});

// Self-contained prompt for the isolated "side question" conversation + the text for a native /btw.
app.api('/api/ask-prompt', async (d) => {
  const { s } = await resolve(d.id);
  if (!s) return { error: 'not-found' };
  const det = A.detail(s, (await getSettings()).rates);
  return { id: s.id, prompt: askPrompt(det, d.lang), btw: btwQuestion(det, d.lang) };
});

await app.run();
