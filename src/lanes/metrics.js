'use strict';
// Lane 4a: automatic metrics, computed by program on 100% of records.
// Each metric yields { value, score } where score is normalised to [0,1]
// on a FIXED scale (never relative to other candidates).
const { cohenKappa } = require('../util/stats');

/** Collect values at a path; "questions[].text" maps over arrays. */
function getAll(obj, path) {
  if (!path) return [obj];
  let cur = [obj];
  for (const part of String(path).split('.')) {
    const isArr = part.endsWith('[]');
    const key = isArr ? part.slice(0, -2) : part;
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      const v = key ? c[key] : c;
      if (isArr) { if (Array.isArray(v)) next.push(...v); } else if (v !== undefined) next.push(v);
    }
    cur = next;
  }
  return cur;
}

const toks = (s) => String(s || '').toLowerCase().match(/[a-z0-9ঀ-৿]{3,}/g) || [];
const strs = (vals) => vals.flatMap((v) => (typeof v === 'string' ? [v] : (v && typeof v === 'object' ? Object.values(v).filter((x) => typeof x === 'string') : [])));

function jaccard(a, b) {
  const A = new Set(toks(a)); const B = new Set(toks(b));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function scaleScore(value, m) {
  if (!Number.isFinite(value)) return null;
  if (!m.scale) return null;
  const [lo, hi] = m.scale;
  const s = clamp01((value - lo) / (hi - lo || 1));
  return m.direction === 'lower' ? 1 - s : s;
}

/** Compute one item-level metric for one record. Returns { value, score } or null when not applicable. */
function itemMetric(m, record, item) {
  if (m.type === 'schema_valid') return { value: record.ok ? 1 : 0, score: record.ok ? 1 : 0 };
  if (!record.ok) return { value: null, score: 0 }; // failures score 0, never dropped
  const out = record.output;
  const vals = getAll(out, m.path);
  switch (m.type) {
    case 'count': {
      const n = Array.isArray(vals[0]) ? vals[0].length : vals.length;
      const ok = n >= (m.min ?? 0) && n <= (m.max ?? Infinity);
      return { value: n, score: ok ? 1 : 0 };
    }
    case 'field_match': {
      const ref = getAll(item.reference, m.reference)[0];
      if (ref === undefined) return null;
      const norm = (x) => (m.case_sensitive ? String(x) : String(x).toLowerCase().trim());
      if (!vals.length) return { value: 0, score: 0 };
      const refSet = Array.isArray(ref) ? new Set(ref.map(norm)) : null;
      const hits = vals.filter((v) => (refSet ? refSet.has(norm(v)) : norm(v) === norm(ref))).length;
      const v = hits / vals.length;
      return { value: v, score: v };
    }
    case 'numeric_error': {
      const ref = Number(getAll(item.reference, m.reference)[0]);
      const got = Number(vals[0]);
      if (!Number.isFinite(ref)) return null;
      if (!Number.isFinite(got)) return { value: null, score: 0 };
      const err = Math.abs(got - ref);
      return { value: err, score: scaleScore(err, { scale: m.scale || [0, Math.max(1, Math.abs(ref))], direction: 'lower' }) };
    }
    case 'within_tolerance': {
      const ref = Number(getAll(item.reference, m.reference)[0]);
      const got = Number(vals[0]);
      if (!Number.isFinite(ref)) return null;
      const ok = Number.isFinite(got) && Math.abs(got - ref) <= (m.tolerance ?? 0);
      return { value: ok ? 1 : 0, score: ok ? 1 : 0 };
    }
    case 'grounding': {
      const against = (m.against || Object.keys(item.input)).map((f) => item.input[f]).join(' ');
      const src = new Set(toks(against));
      const outT = toks(strs(vals).join(' '));
      const v = outT.length ? outT.filter((t) => src.has(t)).length / outT.length : 0;
      return { value: v, score: clamp01(m.scale ? scaleScore(v, m) : v) };
    }
    case 'distinct_ratio': {
      const list = strs(vals);
      if (list.length < 2) return { value: 1, score: 1 };
      let dup = 0;
      for (let i = 1; i < list.length; i++) if (list.slice(0, i).some((p) => jaccard(p, list[i]) >= (m.threshold ?? 0.8))) dup++;
      const v = 1 - dup / list.length;
      return { value: v, score: v };
    }
    case 'length': {
      const list = strs(vals);
      const words = list.length ? list.reduce((a, s) => a + s.split(/\s+/).filter(Boolean).length, 0) / list.length : 0;
      if (m.range) return { value: words, score: words >= m.range[0] && words <= m.range[1] ? 1 : 0 };
      return { value: words, score: scaleScore(words, m) };
    }
    case 'regex': {
      const list = strs(vals);
      const re = new RegExp(m.pattern, m.flags || 'i');
      const v = list.length ? list.filter((s) => re.test(s)).length / list.length : 0;
      return { value: v, score: v };
    }
    case 'enum_coverage': {
      const present = new Set(vals.map(String));
      const expected = m.expected || [];
      const v = expected.length ? expected.filter((e) => present.has(String(e))).length / expected.length : 0;
      return { value: v, score: v };
    }
    default: return null; // candidate-level metrics (qwk) handled separately
  }
}

/** Candidate-level metric: quadratic weighted kappa between output and reference across items. */
function candidateMetric(m, records, itemsById) {
  if (m.type !== 'qwk') return null;
  const a = []; const b = [];
  for (const r of records) {
    const ref = Number(getAll(itemsById[r.itemId].reference, m.reference)[0]);
    if (!Number.isFinite(ref)) continue;
    const got = r.ok ? Number(getAll(r.output, m.path)[0]) : NaN;
    a.push(Number.isFinite(got) ? Math.round(got) : (m.scale ? m.scale[0] : 0)); // failures count as the minimum score
    b.push(Math.round(ref));
  }
  const k = cohenKappa(a, b, { min: m.scale?.[0], max: m.scale?.[1], weights: 'quadratic' });
  return { value: k, score: Number.isFinite(k) ? clamp01(k) : 0 };
}

const OBJECTIVE = new Set(['schema_valid', 'count', 'field_match', 'numeric_error', 'within_tolerance', 'qwk']);
const isObjective = (m) => (m.objective !== undefined ? m.objective : OBJECTIVE.has(m.type));
const isCandidateLevel = (m) => m.type === 'qwk';

function computeMetrics(cfg, records, itemsById) {
  const rows = {};
  for (const r of records) {
    rows[r.recordId] = {};
    for (const m of cfg.metrics) {
      if (isCandidateLevel(m)) continue;
      const res = itemMetric(m, r, itemsById[r.itemId]);
      if (res) rows[r.recordId][m.id] = res;
    }
  }
  return rows;
}

module.exports = { computeMetrics, itemMetric, candidateMetric, getAll, isObjective, isCandidateLevel, jaccard };
