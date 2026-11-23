'use strict';
// Layer 1: reference inputs. Loads items, resolves typed media fields
// (image/audio) to base64, checks strata balance, splits dev/test BY SOURCE,
// and hashes the frozen dataset.
const fs = require('fs');
const path = require('path');
const { sha256, rng, shuffle } = require('../util/core');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

function readItems(cfg) {
  if (Array.isArray(cfg.inputs.items)) return cfg.inputs.items;
  const file = path.resolve(cfg._baseDir || process.cwd(), cfg.inputs.dataset);
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${path.basename(file)} line ${i + 1}: ${e.message}`); }
  });
}

/** Resolve a media field value: data URL, { path }, or a relative path string. */
function resolveMedia(value, type, baseDir) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && value.startsWith('data:')) {
    const m = value.match(/^data:([^;]+);base64,(.*)$/);
    return m ? { type, mime: m[1], base64: m[2], ref: '(inline)' } : null;
  }
  const rel = typeof value === 'object' ? value.path : value;
  const abs = path.resolve(baseDir, rel);
  const ext = path.extname(abs).toLowerCase();
  const buf = fs.readFileSync(abs);
  return { type, mime: (typeof value === 'object' && value.mime) || MIME[ext] || (type === 'image' ? 'image/png' : 'audio/wav'), base64: buf.toString('base64'), ref: rel, bytes: buf.length };
}

function loadDataset(cfg) {
  const fields = cfg.inputs.fields;
  const baseDir = cfg._baseDir || process.cwd();
  const raw = readItems(cfg);
  const errors = [];
  const items = raw.map((r, i) => {
    const id = r.id ?? `item_${i + 1}`;
    const input = {}; const media = [];
    for (const f of fields) {
      const v = r.input ? r.input[f.name] : r[f.name];
      if ((v === undefined || v === null || v === '') && !f.optional) errors.push(`item ${id}: missing required field "${f.name}"`);
      if (f.type === 'text') input[f.name] = v ?? '';
      else if (v) {
        try { const m = resolveMedia(v, f.type, baseDir); if (m) { media.push({ ...m, field: f.name }); input[f.name] = `[${f.type}: ${m.ref}]`; } } catch (e) { errors.push(`item ${id}: cannot read ${f.type} "${f.name}": ${e.message}`); }
      }
    }
    return { id: String(id), source: String(r.source ?? id), strata: r.strata || {}, input, media, reference: r.reference || {}, meta: r.meta || {} };
  });
  if (errors.length) throw new Error(`Dataset errors:\n- ${errors.slice(0, 20).join('\n- ')}`);
  const ids = new Set();
  for (const it of items) { if (ids.has(it.id)) throw new Error(`Duplicate item id "${it.id}"`); ids.add(it.id); }

  // split by source: all items from a source go to the same split (prevents leakage)
  const split = cfg.inputs.split;
  const sources = shuffle([...new Set(items.map((it) => it.source))].sort(), rng(split.seed));
  const nTest = Math.max(1, Math.round(sources.length * split.test_fraction));
  const testSources = new Set(sources.slice(0, nTest));
  const test = items.filter((it) => testSources.has(it.source));
  const dev = items.filter((it) => !testSources.has(it.source));

  const strataFields = cfg.inputs.strata || [];
  const balance = {};
  for (const s of strataFields) {
    balance[s] = {};
    for (const it of test) { const k = String(it.strata[s] ?? '(none)'); balance[s][k] = (balance[s][k] || 0) + 1; }
  }
  const warnings = [];
  const minPer = cfg.inputs.min_per_stratum || 2;
  for (const [s, counts] of Object.entries(balance)) for (const [k, n] of Object.entries(counts)) if (n < minPer) warnings.push(`stratum ${s}=${k} has only ${n} test item(s) (< ${minPer})`);

  const hash = sha256(items.map((it) => ({ id: it.id, input: it.input, media: it.media.map((m) => sha256(m.base64)), reference: it.reference, strata: it.strata, source: it.source })));
  let test2 = test;
  if (cfg.run.max_items) test2 = test.slice(0, cfg.run.max_items);
  return { items, dev, test: test2, hash, balance, warnings, sources: { total: sources.length, test: nTest } };
}

module.exports = { loadDataset, resolveMedia };
