'use strict';
// Lane 4c: two-tier human evaluation.
//   Junior judges: rate a stratified random sample + every item the LLM judge flagged,
//                  independently and blind; N raters per item.
//   Senior judges: adjudicate every item where juniors disagree (or all items, if configured).
// The final (gold) score per item/criterion = senior score if present, else the
// juniors' shared score when they agree.
const { rng, shuffle } = require('../util/core');

/** Build the human sample. Only repeat 0 of valid records is sampled. Stores inclusion probabilities. */
function buildSample(cfg, records, flags) {
  const h = cfg.human.junior;
  const pool = records.filter((r) => r.ok && r.repeat === 0);
  const strataKeys = cfg.inputs.strata || [];
  const keyOf = (r) => strataKeys.map((s) => `${s}=${r.strata?.[s] ?? ''}`).join('|') || 'all';
  const groups = new Map();
  for (const r of pool) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const rand = rng(`human-sample-${cfg.run.seed}`);
  const sample = new Map();
  for (const [k, list] of groups) {
    const n = Math.min(list.length, Math.max(h.min_per_stratum ?? 1, Math.round(list.length * h.sample_fraction)));
    for (const r of shuffle(list, rand).slice(0, n)) sample.set(r.recordId, { recordId: r.recordId, stratum: k, inRandom: true, inclusionProb: n / list.length, flagged: false });
  }
  if (h.include_flagged) {
    const byId = Object.fromEntries(pool.map((r) => [r.recordId, r]));
    for (const f of flags) {
      if (!byId[f.recordId]) continue;
      const cur = sample.get(f.recordId);
      if (cur) cur.flagged = true;
      else sample.set(f.recordId, { recordId: f.recordId, stratum: keyOf(byId[f.recordId]), inRandom: false, inclusionProb: 1, flagged: true, flagReasons: f.reasons });
    }
  }
  return [...sample.values()];
}

function ratingsByRecord(ratings) {
  const map = {};
  for (const r of ratings) {
    if (!map[r.recordId]) map[r.recordId] = { junior: [], senior: [] };
    const list = map[r.recordId][r.role === 'senior' ? 'senior' : 'junior'];
    const i = list.findIndex((x) => x.rater === r.rater);
    if (i >= 0) list[i] = r; else list.push(r); // a rater's latest rating wins
  }
  return map;
}

function disagreement(juniors, criteria, threshold) {
  if (juniors.length < 2) return { disagree: false, criteria: [] };
  const bad = criteria.filter((c) => {
    const vals = juniors.map((j) => j.scores?.[c.id]).filter(Number.isFinite);
    return vals.length >= 2 && Math.max(...vals) - Math.min(...vals) >= threshold;
  }).map((c) => c.id);
  return { disagree: bad.length > 0, criteria: bad };
}

/** Status of every sampled item: junior progress, disagreement, senior need, final scores. */
function humanStatus(cfg, sample, ratings) {
  const criteria = cfg.rubric.criteria || [];
  const by = ratingsByRecord(ratings);
  const need = cfg.human.junior.raters_per_item;
  const mode = cfg.human.senior.adjudicate;
  const thr = cfg.human.senior.disagreement_threshold ?? 1;
  return sample.map((s) => {
    const r = by[s.recordId] || { junior: [], senior: [] };
    const juniorDone = r.junior.length >= need;
    const dis = disagreement(r.junior, criteria, thr);
    const needsSenior = juniorDone && (mode === 'all' || dis.disagree);
    const senior = r.senior[r.senior.length - 1];
    let final = null;
    if (senior) final = senior.scores;
    else if (juniorDone && !needsSenior) {
      final = {};
      for (const c of criteria) {
        const vals = r.junior.map((j) => j.scores?.[c.id]).filter(Number.isFinite);
        if (vals.length) final[c.id] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      }
    }
    return { ...s, juniorRatings: r.junior, seniorRating: senior || null, juniorDone, disagreement: dis, needsSenior, seniorDone: Boolean(senior), final, complete: Boolean(final) };
  });
}

/** Next blinded item for a rater, or null. Juniors never see others' scores; seniors see juniors' scores. */
function nextTask(cfg, { role, rater, sample, ratings, records, itemsById }) {
  const status = humanStatus(cfg, sample, ratings);
  const recById = Object.fromEntries(records.map((r) => [r.recordId, r]));
  const order = shuffle(status, rng(`order-${rater}`));
  const pick = order.find((s) => (role === 'senior'
    ? s.needsSenior && !s.seniorDone
    : !s.juniorDone && !s.juniorRatings.some((j) => j.rater === rater)));
  const remaining = order.filter((s) => (role === 'senior' ? s.needsSenior && !s.seniorDone : !s.juniorDone && !s.juniorRatings.some((j) => j.rater === rater))).length;
  if (!pick) return { task: null, remaining: 0 };
  const rec = recById[pick.recordId];
  const item = itemsById[rec.itemId];
  return {
    remaining,
    task: {
      recordId: rec.recordId,
      blind: rec.blind,
      input: item.input,
      media: item.media.map((m) => ({ field: m.field, type: m.type, mime: m.mime, dataUrl: `data:${m.mime};base64,${m.base64}` })),
      reference: cfg.human.show_reference ? item.reference : undefined,
      output: rec.output,
      rubric: cfg.rubric.criteria,
      juniorScores: role === 'senior' ? pick.juniorRatings.map((j) => ({ rater: j.rater, scores: j.scores, comment: j.comment })) : undefined,
      disagreementOn: role === 'senior' ? pick.disagreement.criteria : undefined,
    },
  };
}

function validateRating(cfg, body) {
  const errs = [];
  if (!['junior', 'senior'].includes(body.role)) errs.push('role must be junior or senior');
  if (!body.rater || !/^[\w .@-]{1,60}$/.test(body.rater)) errs.push('rater name required (letters, digits, space, . @ - _)');
  if (!body.recordId) errs.push('recordId required');
  for (const c of cfg.rubric.criteria || []) {
    const v = Number(body.scores?.[c.id]);
    if (!Number.isInteger(v) || v < c.scale[0] || v > c.scale[1]) errs.push(`score for ${c.id} must be an integer ${c.scale[0]}-${c.scale[1]}`);
  }
  return errs;
}

module.exports = { buildSample, humanStatus, nextTask, validateRating, ratingsByRecord, disagreement };
