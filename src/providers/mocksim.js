'use strict';
// Deterministic simulation used by the offline mock provider and by the
// --simulate-humans demo. NOTHING here is used when real providers are chosen.
// Each mock candidate has a latent "skill" derived from its factor levels; the
// generated outputs degrade with lower skill in ways the metrics and the
// heuristic judge can detect (ungrounded text, wrong labels, numeric error,
// malformed JSON). This lets the full pipeline be demonstrated and tested.
const { rng, shortHash, getPath } = require('../util/core');
const { levelId } = require('../space/space');

const GENERIC = [
  'Explain the main idea of this topic.',
  'Describe the importance of the concept.',
  'What is discussed in this section?',
  'Discuss the key points in detail.',
];

function hashUnit(s) { return parseInt(shortHash(String(s), 8), 16) / 0xffffffff; }

/** Latent skill in [0.2, 0.97] from the candidate's levels. Mock model names can encode skill: mock:strong / mock:medium / mock:weak. */
function skillOf(choice) {
  const model = levelId(choice.model);
  let s = /strong/.test(model) ? 0.82 : /medium/.test(model) ? 0.66 : /weak/.test(model) ? 0.45 : 0.5 + 0.35 * hashUnit(model);
  for (const [f, lv] of Object.entries(choice)) {
    if (f === 'model') continue;
    const id = levelId(lv).toLowerCase();
    if (/few_shot|cot|rubric|structured|anchored/.test(id)) s += 0.05;
    if (/zero_shot|bare|minimal/.test(id)) s -= 0.03;
    if (f === 'temperature') s -= Math.max(0, Number(id) - 0.3) * 0.12;
    s += (hashUnit(`${f}=${id}`) - 0.5) * 0.04; // small idiosyncratic effect per level
  }
  return Math.max(0.2, Math.min(0.97, s));
}

function sentencesOf(item) {
  const text = Object.values(item.input || {}).filter((v) => typeof v === 'string' && !v.startsWith('data:')).join(' ');
  return text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.split(' ').length >= 5);
}

function toQuestion(sentence, rand) {
  const s = sentence.replace(/[.!?]+$/, '');
  const stems = ['Explain why', 'How does', 'What is meant by the statement that', 'Analyse how', 'Compare and justify whether'];
  const stem = stems[Math.floor(rand() * stems.length)];
  return `${stem} ${s.charAt(0).toLowerCase()}${s.slice(1)}?`;
}

function fillSchema(schema, ctx, propName = '', depth = 0) {
  const { item, skill, rand } = ctx;
  if (!schema || depth > 6) return null;
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const ref = item.reference || {};
  if (schema.enum) {
    const correct = getPath(ref, propName) ?? ref[propName];
    if (correct !== undefined && schema.enum.includes(correct) && rand() < skill) return correct;
    return schema.enum[Math.floor(rand() * schema.enum.length)];
  }
  if (t === 'object') {
    const out = {};
    const props = schema.properties || {};
    for (const k of Object.keys(props)) {
      if ((schema.required || []).includes(k) || rand() < 0.7) out[k] = fillSchema(props[k], ctx, k, depth + 1);
    }
    if (rand() < (1 - skill) * 0.25 && schema.required && schema.required.length) delete out[schema.required[0]]; // occasional missing field
    return out;
  }
  if (t === 'array') {
    const lo = schema.minItems ?? 1; const hi = schema.maxItems ?? Math.max(lo, 4);
    let n = lo + Math.floor(rand() * (hi - lo + 1));
    if (rand() < (1 - skill) * 0.2) n = hi + 1; // occasionally over-produce
    return Array.from({ length: n }, () => fillSchema(schema.items, ctx, propName, depth + 1));
  }
  if (t === 'number' || t === 'integer') {
    const min = schema.minimum ?? 0; const max = schema.maximum ?? 10;
    const target = Number(getPath(ref, propName) ?? ref[propName]);
    let v = Number.isFinite(target) ? target + (rand() * 2 - 1) * (1 - skill) * (max - min) * 0.6 : min + rand() * (max - min);
    v = Math.max(min, Math.min(max, v));
    return t === 'integer' ? Math.round(v) : Math.round(v * 10) / 10;
  }
  if (t === 'boolean') return rand() < 0.5;
  // strings
  const sents = sentencesOf(item);
  const grounded = sents.length && rand() < skill;
  const base = grounded ? sents[Math.floor(rand() * sents.length)] : GENERIC[Math.floor(rand() * GENERIC.length)];
  if (/question|stem|prompt/i.test(propName)) return grounded ? toQuestion(base, rand) : base;
  if (/feedback|explanation|rationale|comment/i.test(propName)) {
    return grounded
      ? `Your answer addresses the point that ${base.replace(/[.!?]+$/, '').toLowerCase()}. To improve, give a concrete example and justify each step.`
      : 'Good attempt. Try to add more detail.';
  }
  if (/answer|solution/i.test(propName)) return base;
  return base;
}

/** Candidate output: returns { text, quality } where quality is the latent [0,1] value used only by simulated humans. */
function mockCandidateOutput({ item, cfg, choice, repeat, attempt = 0 }) {
  const skill = skillOf(choice);
  const rand = rng(`${item.id}|${JSON.stringify(choice)}|${repeat}|${attempt}`);
  const quality = Math.max(0, Math.min(1, skill + (rand() - 0.5) * 0.25));
  if (rand() < (1 - skill) * 0.12) return { text: 'Sure! Here are the results: {broken json', quality: 0 };
  const value = fillSchema(cfg.output.schema, { item, skill: quality, rand });
  return { text: JSON.stringify(value), quality };
}

const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];

/** Heuristic judge: groundedness + specificity + structure, mapped onto each criterion's scale with noise. */
function mockJudge({ criteria, item, output, seed }) {
  const rand = rng(seed);
  const inText = new Set(tokens(Object.values(item.input || {}).filter((v) => typeof v === 'string').join(' ')));
  const outStr = JSON.stringify(output || {});
  const outToks = tokens(outStr);
  const overlap = outToks.length ? outToks.filter((t) => inText.has(t)).length / outToks.length : 0;
  const leaves = [];
  (function walk(v) { if (typeof v === 'string') leaves.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(output);
  const generic = new Set(GENERIC.concat(['Good attempt. Try to add more detail.']));
  const textLeaves = leaves.filter((s) => s.split(' ').length > 3);
  const specificity = textLeaves.length ? 1 - textLeaves.filter((s) => generic.has(s)).length / textLeaves.length : 0.5;
  const base = Math.max(0, Math.min(1, 0.3 * Math.min(1, overlap * 1.6) + 0.7 * specificity));
  const scores = {};
  for (const c of criteria) {
    const [lo, hi] = c.scale;
    const noisy = base + (rand() - 0.5) * 0.3 + (hashUnit(c.id) - 0.5) * 0.1;
    const score = Math.max(lo, Math.min(hi, Math.round(lo + noisy * (hi - lo))));
    scores[c.id] = { score, reason: `Heuristic mock judgement: groundedness ${overlap.toFixed(2)}, specificity ${specificity.toFixed(2)}.`, evidence: (textLeaves[0] || outStr).slice(0, 80) };
  }
  // Simulate an occasional judge mistake (quoting text that is not in the output) so the
  // validate-and-flag path of lane 4b is exercised in demos.
  if (rand() < 0.06 && criteria.length) scores[criteria[0].id].evidence = 'the answer mentions a detail that is not actually present';
  return { scores };
}

/** Simulated human rating around the latent quality. Senior judges are less noisy than juniors. */
function simulatedHumanScore({ quality, scale, role, raterId, key }) {
  const rand = rng(`${raterId}|${key}`);
  const sd = role === 'senior' ? 0.3 : 0.5;
  const gauss = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
  const [lo, hi] = scale;
  return Math.max(lo, Math.min(hi, Math.round(lo + quality * (hi - lo) + gauss * sd)));
}

module.exports = { skillOf, mockCandidateOutput, mockJudge, simulatedHumanScore, fillSchema };
