'use strict';
// Statistics used by calibration (Layer 5) and aggregation (Layer 6).
const { rng } = require('./core');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

const std = (xs) => Math.sqrt(variance(xs));

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Cohen's kappa for two raters on ordinal categories.
 * weights: 'none' | 'linear' | 'quadratic'. Ratings must be integers in [min, max].
 */
function cohenKappa(a, b, { min, max, weights = 'quadratic' } = {}) {
  const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return NaN;
  const lo = min ?? Math.min(...pairs.flat());
  const hi = max ?? Math.max(...pairs.flat());
  const k = hi - lo + 1;
  if (k < 2) return 1;
  const O = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const [x, y] of pairs) O[Math.round(x) - lo][Math.round(y) - lo] += 1;
  const n = pairs.length;
  const rowT = O.map((r) => r.reduce((s, v) => s + v, 0));
  const colT = O[0].map((_, j) => O.reduce((s, r) => s + r[j], 0));
  const w = (i, j) => {
    if (weights === 'none') return i === j ? 0 : 1;
    const d = Math.abs(i - j) / (k - 1);
    return weights === 'linear' ? d : d * d;
  };
  let num = 0; let den = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      num += w(i, j) * O[i][j] / n;
      den += w(i, j) * (rowT[i] * colT[j]) / (n * n);
    }
  }
  if (den === 0) return 1; // both raters constant and identical
  return 1 - num / den;
}

function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) r[idx[t][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

function spearman(x, y) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 3) return NaN;
  return pearson(rank(pairs.map((p) => p[0])), rank(pairs.map((p) => p[1])));
}

/**
 * Cluster bootstrap: resample whole clusters (e.g. sources/courses) with replacement.
 * clusters: Map<clusterId, number[]> of per-item scores for one candidate.
 */
function clusterBootstrapCI(clusters, { iterations = 1000, alpha = 0.05, seed = 1 } = {}) {
  const keys = [...clusters.keys()];
  const all = keys.flatMap((k) => clusters.get(k));
  const point = mean(all);
  if (keys.length < 2) return { mean: point, lo: point, hi: point, n: all.length };
  const rand = rng(seed);
  const stats = [];
  for (let b = 0; b < iterations; b++) {
    const sample = [];
    for (let i = 0; i < keys.length; i++) sample.push(...clusters.get(keys[Math.floor(rand() * keys.length)]));
    stats.push(mean(sample));
  }
  stats.sort((p, q) => p - q);
  return { mean: point, lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2), n: all.length };
}

/** Paired cluster bootstrap of the difference between two candidates (a - b). */
function pairedClusterBootstrapDiff(clustersA, clustersB, { iterations = 1000, alpha = 0.05, seed = 7 } = {}) {
  const keys = [...clustersA.keys()].filter((k) => clustersB.has(k));
  const diffOf = (ks) => mean(ks.flatMap((k) => clustersA.get(k))) - mean(ks.flatMap((k) => clustersB.get(k)));
  const point = diffOf(keys);
  if (keys.length < 2) return { diff: point, lo: point, hi: point, p: 1 };
  const rand = rng(seed);
  const stats = [];
  for (let b = 0; b < iterations; b++) {
    const ks = [];
    for (let i = 0; i < keys.length; i++) ks.push(keys[Math.floor(rand() * keys.length)]);
    stats.push(diffOf(ks));
  }
  stats.sort((p, q) => p - q);
  const below = stats.filter((s) => s <= 0).length / stats.length;
  const p = Math.min(1, 2 * Math.min(below, 1 - below));
  return { diff: point, lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2), p };
}

/** Holm-Bonferroni correction: returns adjusted p-values in input order. */
function holm(pvalues) {
  const order = pvalues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvalues.length;
  const adj = new Array(m);
  let running = 0;
  order.forEach(([p, i], r) => { running = Math.max(running, Math.min(1, (m - r) * p)); adj[i] = running; });
  return adj;
}

module.exports = { mean, variance, std, quantile, cohenKappa, spearman, pearson, rank, clusterBootstrapCI, pairedClusterBootstrapDiff, holm };
