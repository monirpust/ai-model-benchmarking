'use strict';
// Pluggable LLM providers. Every provider implements one call:
//   generate({ model, system, prompt, media, temperature, maxTokens, json, mock })
//     -> { text, usage: { input, output }, latencyMs }
// Model ids are written "provider:model", e.g. "openai:gpt-4o-mini",
// "anthropic:claude-sonnet-4-5", "gemini:gemini-2.5-flash", "compat:llama3.1", "mock:strong".
// `media` is [{ type: 'image'|'audio', mime, base64 }].
// `mock` is an optional function used ONLY by the offline mock provider to fabricate
// a deterministic, schema-shaped response so the whole pipeline runs without API keys.

const DEFAULT_TIMEOUT_MS = Number(process.env.GENBENCH_TIMEOUT_MS || 120000);

function parseModelId(id) {
  const s = String(id);
  const i = s.indexOf(':');
  if (i < 0) return { provider: 'mock', model: s };
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

async function httpJson(url, { headers = {}, body, retries = 3 }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
      if (res.status !== 429 && res.status < 500) throw lastErr; // do not retry client errors
    } catch (e) {
      lastErr = e;
      if (e.message && /^HTTP 4(?!29)/.test(e.message)) throw e;
    } finally { clearTimeout(timer); }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastErr;
}

function requireKey(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Add it to your environment or .env file, or use a mock:* model.`);
  return v;
}

const audioFormat = (mime) => (/mp3|mpeg/.test(mime) ? 'mp3' : 'wav');

// ---------- OpenAI and OpenAI-compatible (Ollama, vLLM, LM Studio, Together, Groq...) ----------
function openaiLike({ baseUrl, apiKey, compat }) {
  return async (req) => {
    const content = [{ type: 'text', text: req.prompt }];
    for (const m of req.media || []) {
      if (m.type === 'image') content.push({ type: 'image_url', image_url: { url: `data:${m.mime};base64,${m.base64}` } });
      else if (m.type === 'audio') content.push({ type: 'input_audio', input_audio: { data: m.base64, format: audioFormat(m.mime) } });
    }
    const messages = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: (req.media || []).length ? content : req.prompt });
    const body = { model: req.model, messages, temperature: req.temperature ?? 0 };
    if (req.maxTokens) body[compat ? 'max_tokens' : 'max_completion_tokens'] = req.maxTokens;
    if (req.json) body.response_format = { type: 'json_object' };
    if (req.seed !== undefined && !compat) body.seed = req.seed;
    const t0 = Date.now();
    const data = await httpJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body });
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
      latencyMs: Date.now() - t0,
    };
  };
}

// ---------- Anthropic ----------
async function anthropic(req) {
  const key = requireKey('ANTHROPIC_API_KEY');
  const content = [];
  for (const m of req.media || []) {
    if (m.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: m.mime, data: m.base64 } });
    else if (m.type === 'audio') throw new Error('Anthropic models do not accept audio input; transcribe first or exclude this combination with a space constraint.');
  }
  content.push({ type: 'text', text: req.json ? `${req.prompt}\n\nRespond with JSON only.` : req.prompt });
  const body = { model: req.model, max_tokens: req.maxTokens || 2048, temperature: req.temperature ?? 0, messages: [{ role: 'user', content }] };
  if (req.system) body.system = req.system;
  const t0 = Date.now();
  const data = await httpJson(process.env.ANTHROPIC_BASE_URL ? `${process.env.ANTHROPIC_BASE_URL}/v1/messages` : 'https://api.anthropic.com/v1/messages', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body,
  });
  return {
    text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
    usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    latencyMs: Date.now() - t0,
  };
}

// ---------- Google Gemini ----------
async function gemini(req) {
  const key = requireKey('GEMINI_API_KEY');
  const parts = [{ text: req.prompt }];
  for (const m of req.media || []) parts.push({ inline_data: { mime_type: m.mime, data: m.base64 } });
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: req.temperature ?? 0, ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}), ...(req.json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
  const data = await httpJson(url, { headers: { 'x-goog-api-key': key }, body });
  return {
    text: (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''),
    usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 },
    latencyMs: Date.now() - t0,
  };
}

// ---------- Offline mock ----------
async function mock(req) {
  const value = typeof req.mock === 'function' ? req.mock(req) : { note: 'mock provider: no mock responder supplied' };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text, usage: { input: Math.ceil(String(req.prompt).length / 4), output: Math.ceil(text.length / 4) }, latencyMs: 5 + (text.length % 40) };
}

const registry = {
  openai: (req) => openaiLike({ baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: requireKey('OPENAI_API_KEY') })(req),
  compat: (req) => openaiLike({ baseUrl: process.env.OPENAI_COMPAT_BASE_URL || 'http://localhost:11434/v1', apiKey: process.env.OPENAI_COMPAT_API_KEY, compat: true })(req),
  anthropic,
  gemini,
  mock,
};

/** Register a custom provider at runtime: registerProvider('myco', async (req) => ({ text, usage, latencyMs })). */
function registerProvider(name, fn) { registry[name] = fn; }

async function generate(modelId, req) {
  const { provider, model } = parseModelId(modelId);
  const fn = registry[provider];
  if (!fn) throw new Error(`Unknown provider "${provider}" in model id "${modelId}". Known: ${Object.keys(registry).join(', ')}`);
  return fn({ ...req, model });
}

/** Cost in USD from a pricing table { "provider:model": { input, output } } given per 1M tokens. */
function costOf(modelId, usage, pricing = {}) {
  const p = pricing[modelId];
  if (!p || !usage) return 0;
  return ((usage.input || 0) * (p.input || 0) + (usage.output || 0) * (p.output || 0)) / 1e6;
}

function providerStatus() {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    compat: Boolean(process.env.OPENAI_COMPAT_BASE_URL),
    mock: true,
  };
}

module.exports = { generate, parseModelId, registerProvider, costOf, providerStatus };
