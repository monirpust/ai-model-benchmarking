'use strict';
// Layer 0: load, default, validate and hash a benchmark configuration file.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { sha256 } = require('../util/core');

const INPUT_TYPES = ['text', 'image', 'audio'];
const METRIC_TYPES = ['schema_valid', 'count', 'field_match', 'numeric_error', 'within_tolerance', 'grounding', 'distinct_ratio', 'length', 'regex', 'enum_coverage', 'qwk'];

const DEFAULTS = {
  run: { repeats: 1, seed: 42, max_concurrency: 4, retry_invalid: 1, max_items: null },
  split: { by: 'source', test_fraction: 1.0, seed: 42 },
  prefilter: { enabled: true, target_size: 10, provider: 'mock', model: 'mock-planner' },
  judge: { enabled: true, provider: 'mock', model: 'mock-judge', recheck_fraction: 0.2, consistency_tolerance: 1, swap_order: false },
  human: {
    junior: { raters_per_item: 2, sample_fraction: 0.2, include_flagged: true, min_per_stratum: 1 },
    senior: { adjudicate: 'disagreements', disagreement_threshold: 1 },
    agreement_threshold: 0.6,
  },
  calibration: { judge_human_threshold: 0.6, metric_human_threshold: 0.5, min_items: 8 },
  aggregation: { min_meaningful_gap: 0.05, bootstrap_iterations: 1000, cluster_by: 'source', weight_perturbation: 0.1, alpha: 0.05 },
};

function deepMerge(base, over) {
  if (over === undefined) return structuredClone(base);
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...structuredClone(base) };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function parseConfigText(text, filename = 'config.yaml') {
  return filename.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
}

/** Load a config from disk; relative paths inside it resolve against its folder. */
function loadConfigFile(file) {
  const abs = path.resolve(file);
  const raw = parseConfigText(fs.readFileSync(abs, 'utf8'), abs);
  return normalizeConfig(raw, path.dirname(abs));
}

function normalizeConfig(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object') throw new Error('Config must be an object');
  const cfg = structuredClone(raw);
  cfg.run = deepMerge(DEFAULTS.run, cfg.run);
  cfg.inputs = cfg.inputs || {};
  cfg.inputs.split = deepMerge(DEFAULTS.split, cfg.inputs.split);
  cfg.space = cfg.space || { factors: {} };
  cfg.space.prefilter = deepMerge(DEFAULTS.prefilter, cfg.space.prefilter);
  cfg.judge = deepMerge(DEFAULTS.judge, cfg.judge);
  cfg.human = deepMerge(DEFAULTS.human, cfg.human);
  cfg.calibration = deepMerge(DEFAULTS.calibration, cfg.calibration);
  cfg.aggregation = deepMerge(DEFAULTS.aggregation, cfg.aggregation);
  cfg.metrics = cfg.metrics || [];
  cfg.rubric = cfg.rubric || { criteria: [] };
  cfg.prompts = cfg.prompts || {};
  cfg._baseDir = baseDir;
  return cfg;
}

/** Returns { ok, errors[], warnings[] }. Errors block a run; warnings do not. */
function validateConfig(cfg) {
  const errors = []; const warnings = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(cfg.benchmark && cfg.benchmark.id, 'benchmark.id is required');
  need(cfg.benchmark && cfg.benchmark.decision, 'benchmark.decision is required (Layer 0: which decision does this benchmark inform?)');
  need(cfg.task && cfg.task.description, 'task.description is required (used by the pre-filter agent and the judge)');

  const fields = cfg.inputs.fields || [];
  need(fields.length > 0, 'inputs.fields must declare at least one input field');
  for (const f of fields) {
    need(f.name, 'every input field needs a name');
    need(INPUT_TYPES.includes(f.type), `input field "${f.name}" has invalid type "${f.type}" (allowed: ${INPUT_TYPES.join(', ')})`);
  }
  need(cfg.inputs.dataset || Array.isArray(cfg.inputs.items), 'inputs.dataset (path) or inputs.items (inline array) is required');

  need(cfg.output && cfg.output.schema, 'output.schema (JSON schema of the fixed output structure) is required');

  const factors = cfg.space.factors || {};
  need(Object.keys(factors).length > 0, 'space.factors must declare at least one factor');
  need(Array.isArray(levelsOf(factors.model)) && levelsOf(factors.model).length > 0, 'space.factors.model is required (list of provider:model ids)');
  for (const [name, spec] of Object.entries(factors)) {
    const lv = levelsOf(spec);
    need(Array.isArray(lv) && lv.length > 0, `factor "${name}" needs a non-empty list of levels`);
  }
  for (const p of levelsOf(factors.prompt) || []) {
    const id = typeof p === 'object' ? p.id : p;
    need(cfg.prompts[id], `prompt level "${id}" has no template under prompts.${id}`);
  }
  if (!factors.prompt) need(cfg.prompts.default, 'without a prompt factor, prompts.default is required');

  for (const m of cfg.metrics) {
    need(m.id, 'every metric needs an id');
    need(METRIC_TYPES.includes(m.type), `metric "${m.id}" has unknown type "${m.type}" (allowed: ${METRIC_TYPES.join(', ')})`);
    if (m.type === 'length' && !m.scale && !m.range) {
      warnings.push(`metric "${m.id}" (length) has neither scale nor range; it will be reported but not enter the ranking`);
    }
    if (m.type === 'numeric_error' && !m.scale) warnings.push(`metric "${m.id}" has no scale; the reference value is used as the error ceiling`);
  }

  const crit = cfg.rubric.criteria || [];
  for (const c of crit) {
    need(c.id && c.description, 'every rubric criterion needs id and description');
    need(Array.isArray(c.scale) && c.scale.length === 2, `criterion "${c.id}" needs scale: [min, max]`);
    if (!c.anchors || Object.keys(c.anchors).length < 2) warnings.push(`criterion "${c.id}" has fewer than 2 anchors; raters and judges will disagree more`);
  }

  const weights = cfg.aggregation.weights || {};
  const ids = new Set([...cfg.metrics.map((m) => m.id), ...crit.map((c) => c.id)]);
  for (const k of Object.keys(weights)) need(ids.has(k), `aggregation.weights.${k} does not match any metric or criterion id`);
  const wsum = Object.values(weights).reduce((a, b) => a + Number(b), 0);
  if (Object.keys(weights).length && Math.abs(wsum - 1) > 1e-6) warnings.push(`aggregation weights sum to ${wsum.toFixed(3)}; they will be renormalised to 1`);
  if (!Object.keys(weights).length) warnings.push('no aggregation.weights given; all scored metrics and criteria will be weighted equally');

  return { ok: errors.length === 0, errors, warnings };
}

/** A factor may be given as an array of levels or as { levels: [...], description }. */
function levelsOf(spec) {
  if (Array.isArray(spec)) return spec;
  if (spec && Array.isArray(spec.levels)) return spec.levels;
  return undefined;
}

/** Hash excludes private keys (e.g. _baseDir) so the spec hash is location-independent. */
function configHash(cfg) {
  const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k.startsWith('_') ? undefined : v)));
  return sha256(clean);
}

module.exports = { loadConfigFile, normalizeConfig, validateConfig, parseConfigText, configHash, levelsOf, DEFAULTS, INPUT_TYPES, METRIC_TYPES };
