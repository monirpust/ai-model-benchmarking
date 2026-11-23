'use strict';
// Small, dependency-free helpers shared across the framework.
const crypto = require('crypto');

/** Stable JSON stringify (sorted keys) so hashes don't depend on key order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function sha256(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : stableStringify(data)).digest('hex');
}

function shortHash(data, n = 12) {
  return sha256(data).slice(0, n);
}

/** Mulberry32 seeded PRNG: deterministic, fast, good enough for sampling. */
function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : parseInt(shortHash(String(seed), 8), 16) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Replace {{path.to.value}} placeholders. Missing values become empty strings. */
function renderTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = getPath(vars, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
  });
}

function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Pull the first JSON object/array out of an LLM response (handles ```json fences and chatter). */
function extractJson(text) {
  if (text == null) return { ok: false, error: 'empty response' };
  if (typeof text === 'object') return { ok: true, value: text };
  const s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(s);
  for (const c of candidates) {
    try { return { ok: true, value: JSON.parse(c) }; } catch (_) { /* try next */ }
    const start = c.search(/[[{]/);
    if (start >= 0) {
      const open = c[start];
      const close = open === '{' ? '}' : ']';
      let depth = 0; let inStr = false; let esc = false;
      for (let i = start; i < c.length; i++) {
        const ch = c[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) { try { return { ok: true, value: JSON.parse(c.slice(start, i + 1)) }; } catch (_) { break; } } }
      }
    }
  }
  return { ok: false, error: 'no parseable JSON found' };
}

/** Run async tasks with a concurrency limit, preserving result order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

function nowIso() { return new Date().toISOString(); }

module.exports = { stableStringify, sha256, shortHash, rng, shuffle, renderTemplate, getPath, extractJson, pool, nowIso };
