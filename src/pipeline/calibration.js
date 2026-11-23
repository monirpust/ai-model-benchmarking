'use strict';
// Layer 5: validate every lane against senior-adjudicated human scores and
// build the score-source map (which lane each criterion's score comes from).
// Agreement is computed on the RANDOM part of the human sample only, so the
// extra flagged (harder) items do not bias the statistics.
const { cohenKappa, spearman, mean } = require('../util/stats');
const { isObjective, getAll } = require('../lanes/metrics');

function calibrate(cfg, { records, metrics, judgements, humanStatus }) {
  const criteria = cfg.rubric.criteria || [];
  const C = cfg.calibration;
  const thrHuman = cfg.human.agreement_threshold;
  const random = humanStatus.filter((s) => s.inRandom);
  const complete = random.filter((s) => s.complete);
  const out = { nRandom: random.length, nComplete: complete.length, humanHuman: {}, judgeHuman: {}, metricHuman: {}, bias: {}, scoreSource: {}, metricStatus: {}, loopBacks: [], warnings: [] };
  const enough = complete.length >= C.min_items;
  if (!enough) out.warnings.push(`Only ${complete.length} completed human items in the random sample (need ${C.min_items}); lanes are PROVISIONAL and uncalibrated.`);

  for (const c of criteria) {
    // human-human: first two junior raters on each random item
    const a = []; const b = [];
    for (const s of random) {
      const v = s.juniorRatings.map((j) => j.scores?.[c.id]).filter(Number.isFinite);
      if (v.length >= 2) { a.push(v[0]); b.push(v[1]); }
    }
    const hh = cohenKappa(a, b, { min: c.scale[0], max: c.scale[1], weights: 'quadratic' });
    out.humanHuman[c.id] = { kappa: hh, n: a.length, reliable: Number.isFinite(hh) && hh >= thrHuman };

    // judge-human against gold
    const j = []; const g = [];
    for (const s of complete) {
      const js = judgements[s.recordId]?.scores?.[c.id]?.score;
      if (Number.isFinite(js) && Number.isFinite(s.final?.[c.id])) { j.push(Math.round(js)); g.push(s.final[c.id]); }
    }
    const jh = cohenKappa(j, g, { min: c.scale[0], max: c.scale[1], weights: 'quadratic' });
    out.judgeHuman[c.id] = { kappa: jh, n: j.length, ok: Number.isFinite(jh) && jh >= C.judge_human_threshold };

    let source; let reason;
    if (!enough) { source = 'judge'; reason = 'provisional: not enough human data yet'; }
    else if (!out.humanHuman[c.id].reliable) {
      source = 'judge'; reason = `humans disagree (kappa ${fmt(hh)} < ${thrHuman}); rubric needs revision`;
      out.loopBacks.push({ connector: 'A', criterion: c.id, action: 'Back to Layer 0: rewrite unclear anchors for this criterion, then re-rate.' });
    } else if (out.judgeHuman[c.id].ok) { source = 'judge'; reason = `judge agrees with humans (kappa ${fmt(jh)})`; }
    else {
      source = 'human'; reason = `judge disagrees with humans (kappa ${fmt(jh)} < ${C.judge_human_threshold}); ranking uses human scores on the sample`;
      out.loopBacks.push({ connector: 'B', criterion: c.id, action: 'Back to Layer 4b: revise the judge prompt/anchors or change judge model, then re-run the judge.' });
    }
    out.scoreSource[c.id] = { source, reason, provisional: !enough };
  }

  // metric-human: does each metric track the mean normalised human score?
  const goldMean = (s) => mean(criteria.filter((c) => Number.isFinite(s.final?.[c.id])).map((c) => (s.final[c.id] - c.scale[0]) / (c.scale[1] - c.scale[0])));
  for (const m of cfg.metrics) {
    if (m.type === 'qwk') { out.metricStatus[m.id] = { included: true, reason: 'objective agreement with reference key' }; continue; }
    const x = []; const y = [];
    for (const s of complete) { const v = metrics[s.recordId]?.[m.id]?.score; const gm = goldMean(s); if (Number.isFinite(v) && Number.isFinite(gm)) { x.push(v); y.push(gm); } }
    const rho = spearman(x, y);
    out.metricHuman[m.id] = { spearman: rho, n: x.length };
    if (isObjective(m)) out.metricStatus[m.id] = { included: true, reason: 'objective check against a key or schema; correlation reported for information' };
    else if (!enough) out.metricStatus[m.id] = { included: true, provisional: true, reason: 'provisional: not enough human data to validate' };
    else if (Number.isFinite(rho) && rho >= C.metric_human_threshold) out.metricStatus[m.id] = { included: true, reason: `tracks humans (rho ${fmt(rho)})` };
    else out.metricStatus[m.id] = { included: false, demoted: true, reason: `does not track humans (rho ${fmt(rho)} < ${C.metric_human_threshold}); kept as diagnostic only` };
  }

  // bias analysis for the judge: length bias and subgroup bias
  const lenOf = (r) => JSON.stringify(r.output || '').length;
  const recById = Object.fromEntries(records.map((r) => [r.recordId, r]));
  const judged = records.filter((r) => r.ok && judgements[r.recordId]);
  const jMean = (r) => mean(criteria.map((c) => judgements[r.recordId].scores[c.id]?.score).filter(Number.isFinite));
  out.bias.lengthJudge = spearman(judged.map(lenOf), judged.map(jMean));
  out.bias.lengthHuman = spearman(complete.map((s) => lenOf(recById[s.recordId])), complete.map(goldMean));
  if (Number.isFinite(out.bias.lengthJudge) && Number.isFinite(out.bias.lengthHuman) && out.bias.lengthJudge - out.bias.lengthHuman > 0.2) {
    out.warnings.push(`Possible length bias: judge score correlates with output length (rho ${fmt(out.bias.lengthJudge)}) more than human score does (rho ${fmt(out.bias.lengthHuman)}).`);
  }
  const strataKeys = cfg.inputs.strata || [];
  out.bias.subgroup = {};
  for (const sk of strataKeys) {
    const groups = {};
    for (const s of complete) {
      const r = recById[s.recordId]; const k = String(r.strata?.[sk] ?? '');
      const diffs = criteria.map((c) => (judgements[s.recordId]?.scores?.[c.id]?.score ?? NaN) - (s.final?.[c.id] ?? NaN)).filter(Number.isFinite);
      if (!groups[k]) groups[k] = []; groups[k].push(...diffs);
    }
    out.bias.subgroup[sk] = Object.fromEntries(Object.entries(groups).map(([k, d]) => [k, { meanJudgeMinusHuman: mean(d), n: d.length }]));
  }
  return out;
}

function fmt(x) { return Number.isFinite(x) ? x.toFixed(2) : 'n/a'; }

module.exports = { calibrate, getAll };
