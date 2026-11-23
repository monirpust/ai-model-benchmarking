'use strict';
// Layer 6: defensible ranking. Failures count 0; fixed-scale normalisation;
// config weights only; cluster-bootstrap CIs; paired tests with Holm
// correction; ties when gaps are below the minimum meaningful gap; weight
// sensitivity check; cost and latency.
const { mean, std, quantile, holm: holmFn } = require('../util/stats');
const { rng } = require('../util/core');
const { candidateMetric, isCandidateLevel } = require('../lanes/metrics');

/** Which components (metrics/criteria) enter the ranking, with renormalised weights. */
function components(cfg, calibration) {
  const comps = [];
  for (const m of cfg.metrics) {
    const st = calibration.metricStatus[m.id];
    if (st && !st.included) continue;
    if (!isCandidateLevel(m) && !m.scale && !['schema_valid', 'count', 'field_match', 'within_tolerance', 'grounding', 'distinct_ratio', 'regex', 'enum_coverage', 'numeric_error', 'length'].includes(m.type)) continue;
    comps.push({ id: m.id, kind: 'metric', def: m });
  }
  for (const c of cfg.rubric.criteria || []) comps.push({ id: c.id, kind: 'criterion', def: c, source: calibration.scoreSource[c.id]?.source || 'judge' });
  const given = cfg.aggregation.weights || {};
  const hasWeights = Object.keys(given).length > 0;
  for (const c of comps) c.weight = hasWeights ? Number(given[c.id] || 0) : 1;
  const sum = comps.reduce((a, c) => a + c.weight, 0) || 1;
  for (const c of comps) c.weight /= sum;
  return comps.filter((c) => c.weight > 0);
}

/**
 * Per-candidate, per-item component scores (averaged over repeats).
 * Returns Map<candidateId, Map<itemId, { source, comp: {id: score} }>>
 */
function itemScores(cfg, comps, { records, metrics, judgements, humanStatus }) {
  const gold = Object.fromEntries(humanStatus.filter((s) => s.complete).map((s) => [s.recordId, s.final]));
  const byCand = new Map();
  const groups = new Map();
  for (const r of records) {
    const k = `${r.candidateId}|${r.itemId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, recs] of groups) {
    const [cand, itemId] = k.split('|');
    const comp = {};
    for (const c of comps) {
      if (c.kind === 'metric') {
        if (isCandidateLevel(c.def)) continue;
        const vals = recs.map((r) => metrics[r.recordId]?.[c.id]?.score).filter((v) => v !== undefined && v !== null);
        if (vals.length) comp[c.id] = mean(vals.map((v) => (Number.isFinite(v) ? v : 0)));
      } else {
        const [lo, hi] = c.def.scale;
        const norm = (v) => (v - lo) / (hi - lo);
        if (c.source === 'human') {
          const r0 = recs.find((r) => r.repeat === 0);
          if (r0 && gold[r0.recordId] && Number.isFinite(gold[r0.recordId][c.id])) comp[c.id] = norm(gold[r0.recordId][c.id]);
        } else {
          comp[c.id] = mean(recs.map((r) => (r.ok && Number.isFinite(judgements[r.recordId]?.scores?.[c.id]?.score) ? norm(judgements[r.recordId].scores[c.id].score) : 0)));
        }
      }
    }
    if (!byCand.has(cand)) byCand.set(cand, new Map());
    byCand.get(cand).set(itemId, { source: recs[0].source, strata: recs[0].strata, comp });
  }
  return byCand;
}

/** Overall score for a set of items (with repetition allowed, for bootstrap) for one candidate. */
function overallFor(comps, itemsMap, itemIds, candRecords, itemsById, weights) {
  const parts = {};
  for (const c of comps) {
    if (c.kind === 'metric' && isCandidateLevel(c.def)) {
      const recs = itemIds.flatMap((id) => candRecords.filter((r) => r.itemId === id));
      parts[c.id] = candidateMetric(c.def, recs, itemsById)?.score ?? 0;
      continue;
    }
    const vals = itemIds.map((id) => itemsMap.get(id)?.comp[c.id]).filter(Number.isFinite);
    parts[c.id] = vals.length ? mean(vals) : NaN;
  }
  let total = 0; let wsum = 0;
  for (const c of comps) { const w = weights ? weights[c.id] : c.weight; if (Number.isFinite(parts[c.id])) { total += w * parts[c.id]; wsum += w; } }
  return { overall: wsum ? total / wsum : 0, parts };
}

function aggregate(cfg, data) {
  const { records, candidates, items, calibration } = data;
  const A = cfg.aggregation;
  const comps = components(cfg, calibration);
  const scores = itemScores(cfg, comps, data);
  const itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
  const clusterKey = A.cluster_by === 'item' ? (it) => it.id : (it) => it.source;
  const clusters = new Map();
  for (const it of items) { const k = clusterKey(it); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(it.id); }
  const clusterIds = [...clusters.keys()];
  const B = A.bootstrap_iterations;
  const rand = rng(`boot-${cfg.run.seed}`);
  const resamples = Array.from({ length: B }, () => Array.from({ length: clusterIds.length }, () => clusterIds[Math.floor(rand() * clusterIds.length)]));
  const allIds = items.map((i) => i.id);

  const rows = candidates.map((cand) => {
    const map = scores.get(cand.id) || new Map();
    const candRecords = records.filter((r) => r.candidateId === cand.id);
    const point = overallFor(comps, map, allIds, candRecords, itemsById);
    const boots = resamples.map((rs) => overallFor(comps, map, rs.flatMap((k) => clusters.get(k)), candRecords, itemsById).overall).sort((a, b) => a - b);
    // run-to-run variability: overall per repeat
    const perRepeat = [];
    for (let r = 0; r < cfg.run.repeats; r++) {
      const sub = candRecords.filter((x) => x.repeat === r);
      if (!sub.length) continue;
      const subScores = itemScores(cfg, comps, { ...data, records: sub }).get(cand.id) || new Map();
      perRepeat.push(overallFor(comps, subScores, allIds, sub, itemsById).overall);
    }
    const failures = candRecords.filter((r) => !r.ok).length;
    const cost = candRecords.reduce((a, r) => a + (r.provenance.costUsd || 0), 0);
    const lat = mean(candRecords.map((r) => r.provenance.latencyMs));
    const strata = {};
    for (const sk of cfg.inputs.strata || []) {
      strata[sk] = {};
      const vals = [...new Set(items.map((i) => String(i.strata[sk] ?? '')))];
      for (const v of vals) {
        const ids = items.filter((i) => String(i.strata[sk] ?? '') === v).map((i) => i.id);
        strata[sk][v] = overallFor(comps, map, ids, candRecords, itemsById).overall;
      }
    }
    return {
      candidateId: cand.id, blind: data.codes[cand.id], choice: cand.choice,
      overall: point.overall, ci: [quantile(boots, A.alpha / 2), quantile(boots, 1 - A.alpha / 2)],
      components: point.parts, runStd: perRepeat.length > 1 ? std(perRepeat) : 0,
      failureRate: candRecords.length ? failures / candRecords.length : 0, failures, n: candRecords.length,
      costUsd: cost, costPerItem: items.length ? cost / items.length : 0, meanLatencyMs: lat,
      qualityPerDollar: cost > 0 ? point.overall / cost : null,
      strata, _boots: boots,
    };
  }).sort((a, b) => b.overall - a.overall);

  // paired cluster bootstrap of the leader vs every other candidate, on the SAME resamples
  const leader = rows[0];
  const leaderMap = scores.get(leader?.candidateId) || new Map();
  const leaderRecs = records.filter((r) => r.candidateId === leader?.candidateId);
  const leaderPer = resamples.map((rs) => overallFor(comps, leaderMap, rs.flatMap((k) => clusters.get(k)), leaderRecs, itemsById).overall);
  const tests = rows.slice(1).map((r) => {
    const map = scores.get(r.candidateId) || new Map();
    const recs = records.filter((x) => x.candidateId === r.candidateId);
    const other = resamples.map((rs) => overallFor(comps, map, rs.flatMap((k) => clusters.get(k)), recs, itemsById).overall);
    const d = leaderPer.map((x, i) => x - other[i]).sort((a, b) => a - b);
    const below = d.filter((x) => x <= 0).length / d.length;
    return { candidateId: r.candidateId, diff: leader.overall - r.overall, ci: [quantile(d, A.alpha / 2), quantile(d, 1 - A.alpha / 2)], p: Math.min(1, 2 * Math.min(below, 1 - below)) };
  });
  const adj = holmFn(tests.map((t) => t.p));
  tests.forEach((t, i) => {
    t.pHolm = adj[i];
    t.tiedWithLeader = Math.abs(t.diff) < A.min_meaningful_gap || t.pHolm >= A.alpha;
  });

  // rank groups: candidates tied with the leader share rank 1; others ranked sequentially by gap
  let rank = 1;
  rows.forEach((r, i) => {
    if (i === 0) { r.rank = 1; r.tiedWithLeader = true; return; }
    const t = tests.find((x) => x.candidateId === r.candidateId);
    r.tiedWithLeader = t.tiedWithLeader;
    if (t.tiedWithLeader) { r.rank = 1; return; }
    const prev = rows[i - 1];
    rank = (!prev.tiedWithLeader && (prev.overall - r.overall) < A.min_meaningful_gap) ? prev.rank : i + 1;
    r.rank = rank;
  });

  // weight sensitivity: perturb each weight +/- delta, renormalise, check the leader
  const flips = [];
  const delta = A.weight_perturbation;
  for (const c of comps) {
    for (const sign of [-1, 1]) {
      const w = Object.fromEntries(comps.map((x) => [x.id, x.weight]));
      w[c.id] = Math.max(0, w[c.id] + sign * delta);
      const s = Object.values(w).reduce((a, b) => a + b, 0) || 1;
      for (const k of Object.keys(w)) w[k] /= s;
      const ranked = rows.map((r) => {
        const map = scores.get(r.candidateId) || new Map();
        const recs = records.filter((x) => x.candidateId === r.candidateId);
        return { id: r.candidateId, v: overallFor(comps, map, allIds, recs, itemsById, w).overall };
      }).sort((a, b) => b.v - a.v);
      if (ranked[0] && leader && ranked[0].id !== leader.candidateId) flips.push({ component: c.id, change: sign > 0 ? `+${delta}` : `-${delta}`, newLeader: ranked[0].id });
    }
  }
  const tiedCount = rows.filter((r) => r.tiedWithLeader).length;
  const verdict = !leader ? 'No candidates.' : tiedCount > 1
    ? `No single winner: ${tiedCount} candidates are statistically tied with the leader (gap < ${A.min_meaningful_gap} or not significant after Holm correction).`
    : flips.length ? `Leader ${leader.blind} is ahead but the ranking is weight-sensitive (${flips.length} perturbation(s) change the leader); report with caution.`
      : `Leader ${leader.blind} is ahead of every other candidate by at least the minimum meaningful gap, significant after Holm correction, and stable under weight perturbation.`;
  rows.forEach((r) => { delete r._boots; });
  return { components: comps.map((c) => ({ id: c.id, kind: c.kind, weight: c.weight, source: c.source || 'program' })), leaderboard: rows, tests, sensitivity: { delta, flips, stable: flips.length === 0 }, verdict };
}

module.exports = { aggregate, components };
