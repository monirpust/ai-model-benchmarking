'use strict';
// GenBench web application: REST API + static JavaScript front-end.
require('../src/util/env').loadEnv();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { parseConfigText, normalizeConfig, validateConfig } = require('../src/config/loader');
const { describeSpace, formatBig, levelId } = require('../src/space/space');
const { prefilter } = require('../src/space/prefilter');
const { providerStatus } = require('../src/providers');
const runner = require('../src/pipeline/runner');
const store = require('../src/store/runstore');
const { humanStatus, nextTask, validateRating } = require('../src/lanes/human');
const { nowIso } = require('../src/util/core');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message, validation: e.validation }));

function exampleDir(name) {
  if (!name) return null;
  if (!/^[\w-]+$/.test(name)) throw Object.assign(new Error('invalid example name'), { status: 400 });
  const dir = path.join(EXAMPLES, name);
  if (!fs.existsSync(dir)) throw Object.assign(new Error(`example "${name}" not found`), { status: 404 });
  return dir;
}

/** Build a config from the request: YAML/JSON text, optional example folder (for relative paths), optional inline JSONL dataset. */
function configFromBody(body) {
  const raw = parseConfigText(body.configText || '', body.format === 'json' ? 'c.json' : 'c.yaml');
  if (body.datasetText) {
    raw.inputs = raw.inputs || {};
    raw.inputs.items = String(body.datasetText).split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch (e) { throw new Error(`dataset line ${i + 1}: ${e.message}`); }
    });
    delete raw.inputs.dataset;
  }
  return normalizeConfig(raw, exampleDir(body.example) || process.cwd());
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: require('../package.json').version, providers: providerStatus(), time: nowIso() }));

app.get('/api/examples', wrap((req, res) => {
  const list = fs.readdirSync(EXAMPLES).filter((d) => fs.existsSync(path.join(EXAMPLES, d, 'config.yaml'))).map((d) => {
    const text = fs.readFileSync(path.join(EXAMPLES, d, 'config.yaml'), 'utf8');
    const cfg = parseConfigText(text);
    return { name: d, title: cfg.benchmark?.name || d, decision: cfg.benchmark?.decision || '', configText: text };
  });
  res.json(list);
}));

app.post('/api/config/validate', wrap((req, res) => {
  const cfg = configFromBody(req.body);
  const v = validateConfig(cfg);
  let space = null;
  if (cfg.space && cfg.space.factors && Object.keys(cfg.space.factors).length) {
    try {
      const { dims, size } = describeSpace(cfg.space.factors);
      space = { size: size.toString(), sizeFormatted: formatBig(size), dims: dims.map((d) => ({ name: d.name, count: d.count, levels: d.levels.map(levelId), description: d.description })) };
    } catch (e) { v.errors.push(`space: ${e.message}`); }
  }
  res.json({ ...v, ok: v.errors.length === 0, space, inputTypes: (cfg.inputs.fields || []).map((f) => `${f.name}:${f.type}${f.optional ? '?' : ''}`) });
}));

app.post('/api/prefilter', wrap(async (req, res) => {
  const cfg = configFromBody(req.body);
  const v = validateConfig(cfg);
  if (!v.ok) return res.status(400).json({ error: 'Invalid config', validation: v });
  const log = [];
  const result = await prefilter(cfg, { target: Number(req.body.target) || undefined, onLog: (m) => log.push(m) });
  res.json({ ...result, log, originalSizeFormatted: formatBig(result.originalSize), prunedSizeFormatted: formatBig(result.prunedSize) });
}));

app.post('/api/runs', wrap((req, res) => {
  const cfg = configFromBody(req.body);
  if (req.body.target) cfg.space.prefilter.target_size = Number(req.body.target);
  const { runId } = runner.startRun({ config: cfg, baseDir: cfg._baseDir, candidates: req.body.candidates, simulateHumans: Boolean(req.body.simulateHumans) });
  res.status(202).json({ runId });
}));

app.get('/api/runs', wrap((req, res) => res.json(store.listRuns())));

app.get('/api/runs/:id', wrap((req, res) => {
  const status = store.read(req.params.id, 'status.json');
  if (!status) return res.status(404).json({ error: 'run not found' });
  res.json({ status, report: store.read(req.params.id, 'report.json') || null });
}));

app.post('/api/runs/:id/stop', wrap((req, res) => res.json({ stopped: runner.stopRun(req.params.id) })));

app.delete('/api/runs/:id', wrap((req, res) => { store.deleteRun(req.params.id); res.json({ deleted: true }); }));

app.post('/api/runs/:id/recompute', wrap((req, res) => res.json(runner.recompute(req.params.id))));

app.get('/api/runs/:id/package', wrap((req, res) => {
  res.setHeader('content-disposition', `attachment; filename="${req.params.id}-repro.json"`);
  res.json(runner.reproPackage(req.params.id));
}));

/** Browse outputs. Candidate identities stay blinded unless ?unblind=1 (results view, after scoring). */
app.get('/api/runs/:id/records', wrap((req, res) => {
  const R = runner.loadRun(req.params.id);
  const unblind = req.query.unblind === '1';
  const cand = req.query.candidate;
  const rows = R.records.filter((r) => !cand || r.blind === cand || r.candidateId === cand).slice(0, Number(req.query.limit) || 50).map((r) => ({
    recordId: r.recordId, blind: r.blind, candidateId: unblind ? r.candidateId : undefined, itemId: r.itemId, repeat: r.repeat, ok: r.ok, error: r.error,
    output: r.output, metrics: R.metrics[r.recordId], judge: R.judge.judgements[r.recordId],
  }));
  res.json(rows);
}));

// ---------- two-tier human evaluation ----------
function seniorAllowed(req) {
  const code = process.env.GENBENCH_SENIOR_CODE;
  return !code || req.get('x-senior-code') === code || req.body?.seniorCode === code || req.query.seniorCode === code;
}

app.get('/api/runs/:id/human/status', wrap((req, res) => {
  const R = runner.loadRun(req.params.id);
  const hs = humanStatus(R.cfg, R.sample, R.ratings);
  const raters = {};
  for (const r of R.ratings) { const k = `${r.role}:${r.rater}`; raters[k] = (raters[k] || 0) + 1; }
  res.json({
    sampled: hs.length, randomPart: hs.filter((s) => s.inRandom).length, flaggedOnly: hs.filter((s) => !s.inRandom).length,
    juniorDone: hs.filter((s) => s.juniorDone).length, needsSenior: hs.filter((s) => s.needsSenior).length, seniorDone: hs.filter((s) => s.seniorDone).length,
    complete: hs.filter((s) => s.complete).length, ratersPerItem: R.cfg.human.junior.raters_per_item,
    raters: Object.entries(raters).map(([k, n]) => ({ role: k.split(':')[0], rater: k.split(':').slice(1).join(':'), ratings: n })),
    seniorProtected: Boolean(process.env.GENBENCH_SENIOR_CODE),
  });
}));

app.get('/api/runs/:id/human/next', wrap((req, res) => {
  const { role = 'junior', rater } = req.query;
  if (!rater) return res.status(400).json({ error: 'rater is required' });
  if (role === 'senior' && !seniorAllowed(req)) return res.status(403).json({ error: 'senior access code required' });
  const R = runner.loadRun(req.params.id);
  const itemsById = Object.fromEntries(R.ds.test.map((i) => [i.id, i]));
  res.json(nextTask(R.cfg, { role, rater, sample: R.sample, ratings: R.ratings, records: R.records, itemsById }));
}));

app.post('/api/runs/:id/human/ratings', wrap((req, res) => {
  const R = runner.loadRun(req.params.id);
  const errs = validateRating(R.cfg, req.body);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  if (req.body.role === 'senior' && !seniorAllowed(req)) return res.status(403).json({ error: 'senior access code required' });
  if (!R.sample.some((s) => s.recordId === req.body.recordId)) return res.status(400).json({ error: 'record is not in the human sample' });
  const scores = Object.fromEntries((R.cfg.rubric.criteria || []).map((c) => [c.id, Number(req.body.scores[c.id])]));
  store.appendRating(req.params.id, { recordId: req.body.recordId, role: req.body.role, rater: req.body.rater.trim(), scores, comment: String(req.body.comment || '').slice(0, 2000), timestamp: nowIso() });
  runner.recompute(req.params.id);
  res.json({ saved: true });
}));

app.post('/api/runs/:id/human/simulate', wrap((req, res) => {
  runner.simulateHumans(req.params.id);
  res.json(runner.recompute(req.params.id));
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT || 3000);
if (require.main === module || process.env.GENBENCH_AUTOSTART !== '0') {
  app.listen(PORT, () => console.log(`GenBench running at http://localhost:${PORT}`));
}

module.exports = app;
