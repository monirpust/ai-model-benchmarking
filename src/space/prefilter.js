'use strict';
// Layer 2: LLM-based pre-filtering of the configuration space.
// An agent reads the task description + factor list and prunes millions of
// combinations down to a small relevant candidate set BEFORE any test runs.
// Every decision is returned with a rationale so the pruning is auditable.
const { describeSpace, restrictDims, sampleCandidates, candidateId, levelId, formatBig, violates } = require('./space');
const { generate, providerStatus, parseModelId } = require('../providers');
const { extractJson } = require('../util/core');

const SYSTEM = `You are the pre-filter agent of an AI benchmarking framework. Your job is to prune a large
configuration space of factor combinations down to a small, relevant subset BEFORE any expensive tests run.
Keep levels that are plausible for the task, the input modalities and the stated decision; drop levels that
are irrelevant, incompatible (e.g. a model that cannot read the required input type), redundant, or dominated.
Always keep at least one level per factor. Return JSON only.`;

function buildPrompt(cfg, dims, size, target) {
  const inputTypes = [...new Set((cfg.inputs.fields || []).map((f) => f.type))];
  const factorText = dims.map((d) => {
    const lv = d.levels.map((l) => {
      if (l && typeof l === 'object') {
        const extra = Object.entries(l).filter(([k]) => k !== 'id').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(', ');
        return `  - ${levelId(l)}${extra ? ` (${extra})` : ''}`;
      }
      return `  - ${levelId(l)}`;
    }).join('\n');
    return `* ${d.name} (${d.count} levels)${d.description ? `: ${d.description}` : ''}\n${lv}`;
  }).join('\n');
  return `TASK DESCRIPTION:\n${cfg.task.description}\n\nDECISION THE BENCHMARK INFORMS:\n${cfg.benchmark.decision}\n\n` +
    `INPUT MODALITIES REQUIRED: ${inputTypes.join(', ')}\nOUTPUT: structured JSON matching a fixed schema\n` +
    `FULL SPACE SIZE: ${formatBig(size)} combinations\nTARGET NUMBER OF CANDIDATES: ${target}\n\nFACTORS AND LEVELS:\n${factorText}\n\n` +
    (cfg.space.prefilter.guidance ? `ADDITIONAL GUIDANCE FROM THE RESEARCHER:\n${cfg.space.prefilter.guidance}\n\n` : '') +
    `Return JSON exactly in this shape:\n{\n  "keep": { "<factor>": ["<level id>", ...], ... },\n  "constraints": [ { "if": {"<factor>": "<level id or prefix*>"}, "then_not": {"<factor>": "<level id or prefix*>"} } ],\n  "rationale": { "<factor>": "<one or two sentences explaining what was kept and why>" },\n  "summary": "<one paragraph>"\n}`;
}

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []);

/** Offline heuristic planner used with the mock provider (and as a fallback if the LLM reply is unusable). */
function heuristicPlan(cfg, dims, target) {
  const taskWords = words(`${cfg.task.description} ${cfg.benchmark.decision} ${cfg.space.prefilter.guidance || ''}`);
  const inputTypes = new Set((cfg.inputs.fields || []).filter((f) => !f.optional).map((f) => f.type));
  const status = providerStatus();
  const scored = {};
  const rationale = {};
  for (const d of dims) {
    scored[d.name] = d.levels.map((l) => {
      const obj = l && typeof l === 'object' ? l : { id: l };
      let score = 0; const notes = [];
      const text = `${obj.id} ${obj.description || ''} ${(obj.tags || []).join(' ')}`;
      for (const w of words(text)) if (taskWords.has(w)) score += 1;
      if (d.name === 'model') {
        const supports = obj.supports || ['text'];
        const missing = [...inputTypes].filter((t) => !supports.includes(t));
        if (missing.length) { score -= 100; notes.push(`cannot read ${missing.join('/')}`); }
        if (cfg.space.prefilter.require_available_providers && !status[parseModelId(obj.id).provider]) { score -= 50; notes.push('provider key not configured'); }
        if (obj.tier === 'frontier') score += 2;
        if (obj.tier === 'small') score += 0.5; // keep a cheap baseline in contention
      }
      if (obj.recommended) score += 3;
      if (obj.discouraged) score -= 3;
      return { level: l, id: levelId(l), score, notes };
    }).sort((a, b) => b.score - a.score);
  }
  // Drop incompatible levels, then shrink the factor with the most levels until the product is near the target.
  const keepCount = {};
  for (const d of dims) {
    const ok = scored[d.name].filter((s) => s.score > -50);
    keepCount[d.name] = Math.max(1, ok.length);
  }
  const product = () => Object.values(keepCount).reduce((a, b) => a * b, 1);
  const goal = Math.max(target, 1) * 3;
  const minModels = Math.min(keepCount.model || 1, Math.max(3, Math.ceil(target / 4)));
  while (product() > goal) {
    const candidates = Object.entries(keepCount).filter(([n, c]) => c > (n === 'model' ? minModels : 1));
    if (!candidates.length) break;
    candidates.sort((a, b) => (b[1] - a[1]) || (a[0] === 'model' ? 1 : -1));
    keepCount[candidates[0][0]] -= 1;
  }
  const keep = {};
  for (const d of dims) {
    const kept = scored[d.name].slice(0, keepCount[d.name]);
    const dropped = scored[d.name].slice(keepCount[d.name]);
    keep[d.name] = kept.map((s) => s.id);
    const incompatible = dropped.filter((s) => s.notes.length).map((s) => `${s.id} (${s.notes.join(', ')})`);
    rationale[d.name] = `Kept ${kept.length} of ${d.count}: ${keep[d.name].join(', ')}.` +
      (incompatible.length ? ` Excluded as incompatible: ${incompatible.join('; ')}.` : '') +
      (dropped.length - incompatible.length > 0 ? ` ${dropped.length - incompatible.length} lower-relevance levels dropped to meet the target size.` : '');
  }
  return { keep, constraints: [], rationale, summary: 'Heuristic plan: keyword relevance to the task description, modality compatibility, and greedy reduction of the largest factors until the space is near the target size.' };
}

/** Diversity-preserving final selection: round-robin across kept models so every model is tested. */
function selectFinal(dims, target, constraints, seed) {
  const modelDim = dims.find((d) => d.name === 'model');
  if (!modelDim || modelDim.count <= 1) return sampleCandidates(dims, target, { seed, constraints });
  const perModel = Math.max(1, Math.ceil(target / modelDim.count));
  const out = [];
  modelDim.levels.forEach((m, i) => {
    const sub = dims.map((d) => (d.name === 'model' ? { ...d, levels: [m], count: 1 } : d));
    out.push(...sampleCandidates(sub, perModel, { seed: seed + i, constraints }));
  });
  // trim evenly to target while keeping model coverage
  const byModel = new Map();
  for (const c of out) { const k = levelId(c.model); if (!byModel.has(k)) byModel.set(k, []); byModel.get(k).push(c); }
  const final = [];
  for (let round = 0; final.length < target; round++) {
    let added = false;
    for (const list of byModel.values()) { if (list[round] && final.length < target) { final.push(list[round]); added = true; } }
    if (!added) break;
  }
  return final;
}

async function prefilter(cfg, { target, onLog = () => {} } = {}) {
  const { dims, size } = describeSpace(cfg.space.factors);
  const pf = cfg.space.prefilter;
  const goal = target || pf.target_size || 10;
  const userConstraints = cfg.space.constraints || [];
  const result = { originalSize: size.toString(), target: goal, agent: pf.provider === 'mock' ? 'mock:heuristic-planner' : `${pf.provider}:${pf.model}`, steps: [] };
  onLog(`Space has ${formatBig(size)} combinations across ${dims.length} factors; target ${goal}.`);

  let plan; let raw = null;
  if (!pf.enabled || size <= BigInt(goal)) {
    plan = { keep: {}, constraints: [], rationale: {}, summary: pf.enabled ? 'Space already at or below target; no pruning needed.' : 'Pre-filter disabled; seeded uniform sample used.' };
  } else {
    const modelId = pf.provider === 'mock' ? 'mock:planner' : `${pf.provider}:${pf.model}`;
    try {
      const reply = await generate(modelId, {
        system: SYSTEM, prompt: buildPrompt(cfg, dims, size, goal), temperature: 0, maxTokens: 2000, json: true,
        mock: () => heuristicPlan(cfg, dims, goal),
      });
      raw = reply.text;
      const parsed = extractJson(reply.text);
      if (!parsed.ok || !parsed.value.keep) throw new Error(`planner reply unusable: ${parsed.error || 'missing keep'}`);
      plan = parsed.value;
    } catch (e) {
      onLog(`Pre-filter agent failed (${e.message}); falling back to heuristic planner.`);
      plan = heuristicPlan(cfg, dims, goal);
      result.agent += ' (fallback: heuristic)';
    }
  }
  const restricted = restrictDims(dims, plan.keep || {});
  const restrictedSize = restricted.reduce((a, d) => a * BigInt(d.count), 1n);
  const constraints = [...userConstraints, ...(plan.constraints || [])];
  const finals = selectFinal(restricted, goal, constraints, cfg.run.seed || 42).filter((c) => !violates(c, constraints));
  result.prunedSize = restrictedSize.toString();
  result.keep = Object.fromEntries(restricted.map((d) => [d.name, d.levels.map(levelId)]));
  result.constraints = constraints;
  result.rationale = plan.rationale || {};
  result.summary = plan.summary || '';
  result.raw = raw;
  result.candidates = finals.map((choice) => ({ id: candidateId(choice), choice }));
  result.reduction = `${formatBig(size)} → ${formatBig(restrictedSize)} → ${result.candidates.length}`;
  onLog(`Pruned ${result.reduction}.`);
  return result;
}

module.exports = { prefilter, heuristicPlan, buildPrompt, selectFinal };
