'use strict';
// Layer 2: the configuration space = Cartesian product of factor levels.
// The space is NEVER enumerated in full: candidates are addressed by a
// mixed-radix index, so spaces of millions or billions stay tractable.
const { levelsOf } = require('../config/loader');
const { rng, shortHash } = require('../util/core');

function levelId(level) {
  if (level && typeof level === 'object') return String(level.id ?? JSON.stringify(level));
  return String(level);
}

function describeSpace(factors) {
  const dims = Object.entries(factors).map(([name, spec]) => {
    const levels = levelsOf(spec);
    return { name, description: (spec && spec.description) || '', levels, count: levels.length };
  });
  const size = dims.reduce((acc, d) => acc * BigInt(d.count), 1n);
  return { dims, size };
}

/** Decode a mixed-radix index into one level per factor. */
function candidateAt(dims, index) {
  let rem = BigInt(index);
  const picked = new Array(dims.length);
  for (let i = dims.length - 1; i >= 0; i--) {
    const k = BigInt(dims[i].count);
    picked[i] = dims[i].levels[Number(rem % k)];
    rem /= k;
  }
  return Object.fromEntries(dims.map((d, i) => [d.name, picked[i]]));
}

function candidateKey(choice) {
  return Object.keys(choice).sort().map((k) => `${k}=${levelId(choice[k])}`).join('|');
}

function candidateId(choice) {
  return 'c_' + shortHash(candidateKey(choice), 10);
}

/**
 * Constraint rules exclude combinations, e.g.
 *   { if: { model: "anthropic:*" }, then_not: { input_mode: "audio" } }
 * Glob '*' suffix matching is supported on level ids.
 */
function matches(level, pattern) {
  const id = levelId(level);
  const pats = Array.isArray(pattern) ? pattern : [pattern];
  return pats.some((p) => (String(p).endsWith('*') ? id.startsWith(String(p).slice(0, -1)) : id === String(p)));
}

function violates(choice, constraints = []) {
  return constraints.some((c) => {
    const ifOk = Object.entries(c.if || {}).every(([f, p]) => matches(choice[f], p));
    if (!ifOk) return false;
    return Object.entries(c.then_not || {}).some(([f, p]) => matches(choice[f], p));
  });
}

/** Seeded uniform sample of up to n distinct valid candidates without enumerating the space. */
function sampleCandidates(dims, n, { seed = 42, constraints = [], maxTries = 50000 } = {}) {
  const size = dims.reduce((acc, d) => acc * BigInt(d.count), 1n);
  const out = new Map();
  if (size <= BigInt(maxTries)) {
    // small enough to scan: shuffle indices deterministically
    const total = Number(size);
    const rand = rng(seed);
    const idx = Array.from({ length: total }, (_, i) => i);
    for (let i = total - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (const i of idx) {
      const c = candidateAt(dims, i);
      if (!violates(c, constraints)) out.set(candidateKey(c), c);
      if (out.size >= n) break;
    }
    return [...out.values()];
  }
  const rand = rng(seed);
  let tries = 0;
  while (out.size < n && tries < maxTries) {
    tries++;
    const choice = {};
    for (const d of dims) choice[d.name] = d.levels[Math.floor(rand() * d.count)];
    if (!violates(choice, constraints)) out.set(candidateKey(choice), choice);
  }
  return [...out.values()];
}

/** Restrict each factor to a subset of level ids (used by the pre-filter). */
function restrictDims(dims, keep) {
  return dims.map((d) => {
    const ids = keep[d.name];
    if (!ids || !ids.length) return d;
    const levels = d.levels.filter((l) => ids.map(String).includes(levelId(l)));
    return { ...d, levels: levels.length ? levels : d.levels, count: (levels.length ? levels : d.levels).length };
  });
}

function formatBig(n) {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = { describeSpace, candidateAt, candidateKey, candidateId, sampleCandidates, restrictDims, violates, levelId, formatBig };
