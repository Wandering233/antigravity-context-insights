// Reference per-1M-token USD pricing and context windows for common Antigravity models.
// Used only when custom rates in Settings are all 0 and auto-pricing is enabled.
// Prices are approximate reference values and may differ from live provider billing.

const TABLE = [
  // [regex, input, cacheRead, output, contextWindow, label]
  [/claude.*opus.*4|opus\s*4/i,        15.0,  1.50,  75.0,  200000, 'Claude Opus'],
  [/claude.*sonnet|sonnet/i,            3.0,  0.30,  15.0,  200000, 'Claude Sonnet'],
  [/claude.*haiku|haiku/i,              0.8,  0.08,   4.0,  200000, 'Claude Haiku'],
  [/gemini.*pro/i,                      1.25, 0.31,  10.0, 1000000, 'Gemini Pro'],
  [/gemini.*flash.*lite/i,              0.075,0.018,  0.3, 1000000, 'Gemini Flash-Lite'],
  [/gemini.*flash/i,                    0.15, 0.0375, 0.6, 1000000, 'Gemini Flash'],
  [/gemini.*(?:hydrogen|ultra|4)/i,     1.25, 0.31,  10.0, 1000000, 'Gemini'],
  [/deepseek/i,                         0.27, 0.07,   1.1,  128000, 'DeepSeek'],
  [/gpt-5|o3|o4/i,                      2.0,  0.50,   8.0,  400000, 'OpenAI'],
];

export const CNY_PER_USD = 1 / 0.15; // matches dsh-context: 1 CNY = 0.15 USD

export function lookupModel(modelName) {
  if (!modelName) return null;
  for (const [re, input, cache, output, window, family] of TABLE) {
    if (re.test(modelName)) return { input, cache, output, window, family, inferred: true };
  }
  return null;
}

export function resolvePricing(modelName, settings) {
  const r = settings?.rates || {};
  if (r.input > 0 || r.cache > 0 || r.output > 0) {
    return { input: r.input, cache: r.cache, output: r.output, window: settings.contextWindow, source: 'custom' };
  }
  if (settings?.autoPrice === false) return null;
  const hit = lookupModel(modelName);
  if (!hit) return null;
  return { input: hit.input, cache: hit.cache, output: hit.output, window: hit.window, family: hit.family, source: 'reference' };
}

export function costWithPricing(tokens, pricing) {
  if (!pricing || !tokens) return 0;
  return ((tokens.input || 0) * (pricing.input || 0)
    + (tokens.cache || 0) * (pricing.cache || 0)
    + (tokens.output || 0) * (pricing.output || 0)) / 1e6;
}
