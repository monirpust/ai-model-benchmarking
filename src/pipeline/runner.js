'use strict';
// Orchestrates Layers 0-7 for one run and persists every artefact.
const path = require('path');
const store = require('../store/runstore');
const { normalizeConfig, validateConfig, configHash, loadConfigFile } = require('../config/loader');
const { loadDataset } = require('../data/dataset');
const { prefilter } = require('../space/prefilter');
const { describeSpace, formatBig } = require('../space/space');
const { runGeneration } = require('./generate');
const { computeMetrics } = require('../lanes/metrics');
const { runJudge, independenceWarnings } = require('../lanes/judge');
const { buildSample, humanStatus } = require('../lanes/human');
const { calibrate } = require('./calibration');
const { aggregate } = require('./aggregation');
const { simulatedHumanScore } = require('../providers/mocksim');
const { nowIso, shortHash } = require('../util/core');

const active = new Map(); // runId -> { stop: boolean }

function stripPrivate(cfg) { return JSON.parse(JSON.stringify(cfg, (k, v) => (k.startsWith('_') ? undefined : v))); }

function makeRunId(benchId) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${String(benchId).replace(/[^\w-]/g, '')}-${stamp}-${shortHash(Math.random(), 4)}`;
}

function setStatus(runId, patch) {
  const cur = store.read(runId, 'status.json', {});
  const next = { ...cur, ...patch, updatedAt: nowIso() };
  if (patch.logLine) { next.log = [...(cur.log || []), `${nowIso().slice(11, 19)} ${patch.logLine}`].slice(-200); delete next.logLine; }
  store.write(runId, 'status.json', next);
  return next;
}

/** Prepare a config from a path or an object (+ baseDir for relative dataset/media paths). */
function prepareConfig({ configPath, config, baseDir }) {
  const cfg = configPath ? loadConfigFile(configPath) : normalizeConfig(config, baseDir || process.cwd());
  const v = validateConfig(cfg);
  if (!v.ok) { const e = new Error(`Invalid config:\n- ${v.errors.join('\n- ')}`); e.validation = v; throw e; }
  cfg._hash = configHash(cfg);
  return { cfg, validation: v };
}

/** Start a run in the background; resolves with runId immediately. */
function startRun(opts) {
  const { cfg, validation } = prepareConfig(opts);
  const runId = makeRunId(cfg.benchmark.id);
  store.write(runId, 'config.json', { ...stripPrivate(cfg), _baseDir: cfg._baseDir });
  setStatus(runId, {
    runId, benchmarkId: cfg.benchmark.id, name: cfg.benchmark.name || cfg.benchmark.id, version: cfg.benchmark.version || '1.0.0',
    createdAt: nowIso(), state: 'queued', phase: 'queued', progress: { done: 0, total: 0 }, configHash: cfg._hash, warnings: validation.warnings, log: [],
  });
  const handle = { stop: false };
  active.set(runId, handle);
  const promise = execute(runId, cfg, opts, handle).catch((e) => {
    setStatus(runId, { state: 'failed', phase: 'failed', error: e.message, logLine: `FAILED: ${e.message}` });
  }).finally(() => active.delete(runId));
  return { runId, promise };
}

function stopRun(runId) { const h = active.get(runId); if (h) { h.stop = true; return true; } return false; }

async function execute(runId, cfg, opts, handle) {
  const log = (m) => setStatus(runId, { logLine: m });
  setStatus(runId, { state: 'running', phase: 'Layer 1: reference inputs' });
  const ds = loadDataset(cfg);
  cfg._datasetHash = ds.hash;
  store.write(runId, 'dataset.json', { hash: ds.hash, balance: ds.balance, warnings: ds.warnings, sources: ds.sources, test: ds.test, devIds: ds.dev.map((d) => d.id) });
  setStatus(runId, { datasetHash: ds.hash, logLine: `Dataset frozen: ${ds.items.length} items, ${ds.test.length} in test, hash ${ds.hash.slice(0, 12)}.` });
  ds.warnings.forEach((w) => log(`warning: ${w}`));

  setStatus(runId, { phase: 'Layer 2: candidates (pre-filter)' });
  let pf;
  if (opts.candidates && opts.candidates.length) {
    const { size } = describeSpace(cfg.space.factors);
    pf = { originalSize: size.toString(), prunedSize: String(opts.candidates.length), candidates: opts.candidates, rationale: {}, summary: 'Candidates supplied by the researcher (pre-filter result reviewed/edited in the UI).', agent: 'researcher', reduction: `${formatBig(size)} → ${opts.candidates.length}` };
  } else {
    pf = await prefilter(cfg, { onLog: log });
  }
  store.write(runId, 'prefilter.json', pf);
  const indep = independenceWarnings(cfg, pf.candidates);
  indep.forEach((w) => log(`warning: ${w}`));
  log(`Candidates under test: ${pf.candidates.length}.`);

  setStatus(runId, { phase: 'Layer 3: standard outputs', progress: { done: 0, total: pf.candidates.length * ds.test.length * cfg.run.repeats } });
  let lastWrite = 0;
  const gen = await runGeneration(cfg, {
    candidates: pf.candidates, items: ds.test, shouldStop: () => handle.stop,
    onProgress: (d, t) => { if (Date.now() - lastWrite > 400 || d === t) { lastWrite = Date.now(); setStatus(runId, { progress: { done: d, total: t } }); } },
  });
  if (handle.stop) { setStatus(runId, { state: 'stopped', phase: 'stopped', logLine: 'Run stopped by user.' }); return; }
  store.write(runId, 'records.json', gen.records);
  store.write(runId, 'key.json', { key: gen.key, codes: gen.codes, mockQuality: gen.mockQuality });
  const fails = gen.records.filter((r) => !r.ok).length;
  log(`Generated ${gen.records.length} outputs; ${fails} failed schema/parse after retry (scored 0, kept).`);

  const itemsById = Object.fromEntries(ds.test.map((i) => [i.id, i]));
  setStatus(runId, { phase: 'Layer 4a: automatic metrics' });
  const metrics = computeMetrics(cfg, gen.records, itemsById);
  store.write(runId, 'metrics.json', metrics);

  setStatus(runId, { phase: 'Layer 4b: LLM judge', progress: { done: 0, total: gen.records.filter((r) => r.ok).length } });
  const judge = await runJudge(cfg, { records: gen.records, itemsById, onProgress: (d, t) => { if (Date.now() - lastWrite > 400 || d === t) { lastWrite = Date.now(); setStatus(runId, { progress: { done: d, total: t } }); } } });
  store.write(runId, 'judge.json', judge);
  log(`Judge scored ${Object.keys(judge.judgements).length} outputs; ${judge.flags.length} flagged for human review.`);

  setStatus(runId, { phase: 'Layer 4c: human sample' });
  const sample = buildSample(cfg, gen.records, judge.flags);
  store.write(runId, 'human/sample.json', sample);
  log(`Human sample: ${sample.length} items (${sample.filter((s) => s.inRandom).length} random stratified, ${sample.filter((s) => !s.inRandom).length} flagged-only).`);

  if (opts.simulateHumans) { simulateHumans(runId); log('Simulated junior and senior ratings added (DEMO ONLY: not real human data).'); }
  const report = recompute(runId);
  setStatus(runId, { state: report.human.complete ? 'complete' : 'awaiting_humans', phase: report.human.complete ? 'Layer 7: results' : 'awaiting human evaluation', logLine: report.human.complete ? 'Run complete.' : 'Automatic lanes complete; waiting for human ratings (report is provisional).' });
}

function loadRun(runId) {
  const cfgRaw = store.read(runId, 'config.json');
  if (!cfgRaw) throw new Error(`Run ${runId} not found`);
  const cfg = normalizeConfig(cfgRaw, cfgRaw._baseDir);
  const ds = store.read(runId, 'dataset.json');
  return {
    cfg, ds,
    prefilter: store.read(runId, 'prefilter.json'),
    records: store.read(runId, 'records.json', []),
    key: store.read(runId, 'key.json', { key: {}, codes: {}, mockQuality: {} }),
    metrics: store.read(runId, 'metrics.json', {}),
    judge: store.read(runId, 'judge.json', { judgements: {}, flags: [] }),
    sample: store.read(runId, 'human/sample.json', []),
    ratings: store.readRatings(runId),
    status: store.read(runId, 'status.json'),
  };
}

/** Layers 5-7: recompute calibration, aggregation and report from stored artefacts + current human ratings. */
function recompute(runId) {
  const R = loadRun(runId);
  const hs = humanStatus(R.cfg, R.sample, R.ratings);
  const calibration = calibrate(R.cfg, { records: R.records, metrics: R.metrics, judgements: R.judge.judgements, humanStatus: hs });
  store.write(runId, 'calibration.json', calibration);
  const agg = aggregate(R.cfg, { records: R.records, candidates: R.prefilter.candidates, items: R.ds.test, metrics: R.metrics, judgements: R.judge.judgements, humanStatus: hs, calibration, codes: R.key.codes });
  const report = buildReport(R, hs, calibration, agg);
  store.write(runId, 'report.json', report);
  if (R.status && ['awaiting_humans', 'complete'].includes(R.status.state)) {
    setStatus(runId, { state: report.human.complete ? 'complete' : 'awaiting_humans', phase: report.human.complete ? 'Layer 7: results' : 'awaiting human evaluation' });
  }
  return report;
}

function errorAnalysis(R) {
  const byMsg = {};
  for (const r of R.records.filter((x) => !x.ok)) { const k = String(r.error).split(':').slice(0, 2).join(':').slice(0, 80); byMsg[k] = (byMsg[k] || 0) + 1; }
  const flagReasons = {};
  for (const f of R.judge.flags || []) for (const reason of f.reasons) { const k = reason.replace(/\d+(\.\d+)?/g, '#'); flagReasons[k] = (flagReasons[k] || 0) + 1; }
  return {
    failureModes: Object.entries(byMsg).map(([mode, count]) => ({ mode, count })).sort((a, b) => b.count - a.count),
    judgeFlagReasons: Object.entries(flagReasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

function buildReport(R, hs, calibration, agg) {
  const done = hs.filter((s) => s.complete).length;
  return {
    generatedAt: nowIso(),
    benchmark: { id: R.cfg.benchmark.id, name: R.cfg.benchmark.name, version: R.cfg.benchmark.version || '1.0.0', decision: R.cfg.benchmark.decision, task: R.cfg.task.description },
    hashes: { config: R.status?.configHash, dataset: R.ds.hash },
    dataset: { testItems: R.ds.test.length, sources: R.ds.sources, balance: R.ds.balance, warnings: R.ds.warnings },
    prefilter: { agent: R.prefilter.agent, originalSize: R.prefilter.originalSize, prunedSize: R.prefilter.prunedSize, reduction: R.prefilter.reduction, candidates: R.prefilter.candidates.length, rationale: R.prefilter.rationale, summary: R.prefilter.summary },
    human: {
      sampled: hs.length, completed: done, complete: hs.length > 0 && done === hs.length,
      juniorPending: hs.filter((s) => !s.juniorDone).length, seniorPending: hs.filter((s) => s.needsSenior && !s.seniorDone).length,
      disagreements: hs.filter((s) => s.disagreement.disagree).length, simulated: R.ratings.some((r) => r.simulated),
    },
    calibration,
    aggregation: agg,
    errorAnalysis: errorAnalysis(R),
    verdict: agg.verdict,
  };
}

/** DEMO ONLY: fill junior + senior ratings from the mock latent quality (or judge scores for real models). */
function simulateHumans(runId) {
  const R = loadRun(runId);
  const crit = R.cfg.rubric.criteria || [];
  const recById = Object.fromEntries(R.records.map((r) => [r.recordId, r]));
  const nJ = R.cfg.human.junior.raters_per_item;
  const qualityOf = (rid) => {
    if (R.key.mockQuality && rid in R.key.mockQuality) return R.key.mockQuality[rid];
    const j = R.judge.judgements[rid];
    if (!j) return 0.5;
    const vals = crit.map((c) => (j.scores[c.id]?.score - c.scale[0]) / (c.scale[1] - c.scale[0])).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.5;
  };
  for (const s of R.sample) {
    if (!recById[s.recordId]) continue;
    const q = qualityOf(s.recordId);
    for (let j = 1; j <= nJ; j++) {
      const rater = `sim-junior-${j}`;
      const scores = Object.fromEntries(crit.map((c) => [c.id, simulatedHumanScore({ quality: q, scale: c.scale, role: 'junior', raterId: rater, key: `${s.recordId}|${c.id}` })]));
      store.appendRating(runId, { recordId: s.recordId, role: 'junior', rater, scores, comment: '', simulated: true, timestamp: nowIso() });
    }
  }
  const after = humanStatus(R.cfg, R.sample, store.readRatings(runId));
  for (const s of after.filter((x) => x.needsSenior)) {
    const q = qualityOf(s.recordId);
    const scores = Object.fromEntries(crit.map((c) => [c.id, simulatedHumanScore({ quality: q, scale: c.scale, role: 'senior', raterId: 'sim-senior-1', key: `${s.recordId}|${c.id}` })]));
    store.appendRating(runId, { recordId: s.recordId, role: 'senior', rater: 'sim-senior-1', scores, comment: 'simulated adjudication', simulated: true, timestamp: nowIso() });
  }
}

/** Reproducibility package: everything needed to audit or rerun (media omitted, referenced by hash). */
function reproPackage(runId) {
  const R = loadRun(runId);
  const test = R.ds.test.map((it) => ({ ...it, media: it.media.map((m) => ({ field: m.field, type: m.type, mime: m.mime, ref: m.ref, bytes: m.bytes })) }));
  return {
    genbenchVersion: require('../../package.json').version,
    runId, status: R.status, config: stripPrivate(R.cfg), dataset: { ...R.ds, test },
    prefilter: R.prefilter, records: R.records, unblindingKey: R.key.key, metrics: R.metrics, judge: R.judge,
    humanSample: R.sample, humanRatings: R.ratings, calibration: store.read(runId, 'calibration.json'), report: store.read(runId, 'report.json'),
  };
}

module.exports = { startRun, stopRun, recompute, loadRun, simulateHumans, reproPackage, prepareConfig, path };
