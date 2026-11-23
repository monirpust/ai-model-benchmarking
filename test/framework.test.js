'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.GENBENCH_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'genbench-test-'));
process.env.GENBENCH_AUTOSTART = '0';

const stats = require('../src/util/stats');
const { extractJson, renderTemplate } = require('../src/util/core');
const { validate } = require('../src/util/jsonschema');
const { loadConfigFile, validateConfig, normalizeConfig } = require('../src/config/loader');
const { describeSpace, candidateAt, sampleCandidates, violates } = require('../src/space/space');
const { prefilter } = require('../src/space/prefilter');
const { itemMetric } = require('../src/lanes/metrics');
const { humanStatus } = require('../src/lanes/human');
const runner = require('../src/pipeline/runner');
const store = require('../src/store/runstore');

const QG = path.join(__dirname, '..', 'examples', 'question-generation', 'config.yaml');
const GR = path.join(__dirname, '..', 'examples', 'ai-grading', 'config.yaml');

test('weighted kappa: perfect, chance and partial agreement', () => {
  assert.strictEqual(stats.cohenKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], { min: 1, max: 5 }), 1);
  const k = stats.cohenKappa([1, 2, 3, 4, 5, 1, 2], [2, 2, 3, 5, 5, 1, 3], { min: 1, max: 5 });
  assert.ok(k > 0.7 && k < 1, `kappa ${k}`);
  assert.ok(stats.cohenKappa([1, 5, 1, 5], [5, 1, 5, 1], { min: 1, max: 5 }) < 0);
});

test('spearman and holm', () => {
  assert.ok(Math.abs(stats.spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9);
  const adj = stats.holm([0.01, 0.04, 0.03]);
  assert.deepStrictEqual(adj.map((x) => +x.toFixed(2)), [0.03, 0.06, 0.06]);
});

test('cluster bootstrap CI contains the mean', () => {
  const m = new Map([['a', [0.8, 0.9]], ['b', [0.7]], ['c', [0.95, 0.85, 0.9]]]);
  const ci = stats.clusterBootstrapCI(m, { iterations: 300 });
  assert.ok(ci.lo <= ci.mean && ci.mean <= ci.hi);
});

test('extractJson handles fences and chatter; templates render nested vars', () => {
  assert.deepStrictEqual(extractJson('Sure!\n```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepStrictEqual(extractJson('Result: {"b":[1,2]} done').value, { b: [1, 2] });
  assert.strictEqual(extractJson('nope').ok, false);
  assert.strictEqual(renderTemplate('{{x}}-{{factors.p}}', { x: 1, factors: { p: 'q' } }), '1-q');
});

test('json schema validation enforces fixed outputs', () => {
  const s = { type: 'object', required: ['score'], properties: { score: { type: 'integer', minimum: 0, maximum: 10 } } };
  assert.deepStrictEqual(validate(s, { score: 7 }), []);
  assert.ok(validate(s, { score: 11 }).length === 1);
  assert.ok(validate(s, {}).length === 1);
});

test('example configs are valid and their spaces exceed one million', () => {
  for (const f of [QG, GR]) {
    const cfg = loadConfigFile(f);
    const v = validateConfig(cfg);
    assert.ok(v.ok, v.errors.join('\n'));
    assert.ok(describeSpace(cfg.space.factors).size > 1000000n);
  }
});

test('invalid config is rejected with useful errors', () => {
  const v = validateConfig(normalizeConfig({ benchmark: { id: 'x' }, inputs: { fields: [{ name: 'a', type: 'video' }] } }));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('decision')));
  assert.ok(v.errors.some((e) => e.includes('invalid type "video"')));
});

test('space indexing decodes without enumeration; constraints exclude combinations', () => {
  const { dims, size } = describeSpace({ model: ['a', 'b'], t: [0, 1, 2], p: ['x', 'y'] });
  assert.strictEqual(size, 12n);
  assert.deepStrictEqual(candidateAt(dims, 0), { model: 'a', t: 0, p: 'x' });
  assert.deepStrictEqual(candidateAt(dims, 11), { model: 'b', t: 2, p: 'y' });
  const cons = [{ if: { model: 'b' }, then_not: { p: 'y' } }];
  assert.ok(violates({ model: 'b', t: 0, p: 'y' }, cons));
  const s = sampleCandidates(dims, 20, { constraints: cons });
  assert.strictEqual(s.length, 9);
});

test('pre-filter prunes >1M combinations to the target with rationale', async () => {
  const cfg = loadConfigFile(QG);
  const pf = await prefilter(cfg, { target: 10 });
  assert.strictEqual(pf.originalSize, '1555200');
  assert.strictEqual(pf.candidates.length, 10);
  assert.ok(Object.keys(pf.rationale).length >= 10);
  assert.ok(new Set(pf.candidates.map((c) => c.choice.model.id)).size >= 2, 'keeps several models');
  assert.ok(pf.candidates.every((c) => c.choice.language.id === 'english'), 'drops irrelevant language level');
});

test('metrics: failures score 0, numeric error is lower-is-better', () => {
  const fail = itemMetric({ id: 'g', type: 'grounding', path: 'x' }, { ok: false }, { input: {} });
  assert.strictEqual(fail.score, 0);
  const m = itemMetric({ id: 'e', type: 'numeric_error', path: 'score', reference: 'score', scale: [0, 10] }, { ok: true, output: { score: 7 } }, { reference: { score: 9 }, input: {} });
  assert.strictEqual(m.value, 2); assert.ok(Math.abs(m.score - 0.8) < 1e-9);
});

test('two-tier human logic: disagreement routes to senior, senior score is final', () => {
  const cfg = loadConfigFile(QG);
  const sample = [{ recordId: 'r1', inRandom: true }, { recordId: 'r2', inRandom: true }];
  const all4 = Object.fromEntries(cfg.rubric.criteria.map((c) => [c.id, 4]));
  const all2 = Object.fromEntries(cfg.rubric.criteria.map((c) => [c.id, 2]));
  const ratings = [
    { recordId: 'r1', role: 'junior', rater: 'a', scores: all4 }, { recordId: 'r1', role: 'junior', rater: 'b', scores: all4 },
    { recordId: 'r2', role: 'junior', rater: 'a', scores: all4 }, { recordId: 'r2', role: 'junior', rater: 'b', scores: all2 },
  ];
  let st = humanStatus(cfg, sample, ratings);
  assert.ok(st[0].complete && !st[0].needsSenior);
  assert.ok(st[1].needsSenior && !st[1].complete);
  st = humanStatus(cfg, sample, [...ratings, { recordId: 'r2', role: 'senior', rater: 's', scores: all2 }]);
  assert.ok(st[1].complete); assert.strictEqual(st[1].final.relevance, 2);
});

for (const [name, file] of [['question generation', QG], ['AI grading', GR]]) {
  test(`end-to-end mock run: ${name}`, async () => {
    const cfg = loadConfigFile(file);
    cfg.aggregation.bootstrap_iterations = 100;
    const { runId, promise } = runner.startRun({ config: cfg, baseDir: cfg._baseDir, simulateHumans: true });
    await promise;
    const status = store.read(runId, 'status.json');
    assert.strictEqual(status.state, 'complete', status.error);
    const report = store.read(runId, 'report.json');
    assert.strictEqual(report.aggregation.leaderboard.length, 10);
    assert.ok(report.human.complete && report.human.simulated);
    const lb = report.aggregation.leaderboard;
    assert.ok(lb.every((r, i) => i === 0 || r.overall <= lb[i - 1].overall + 1e-12), 'sorted');
    assert.ok(lb.every((r) => r.ci[0] <= r.overall + 1e-9 && r.overall <= r.ci[1] + 1e-9), 'point inside CI');
    const top = lb[0].choice.model.id;
    assert.strictEqual(top, 'mock:strong', 'strong mock model should lead');
    const pkg = runner.reproPackage(runId);
    assert.ok(pkg.unblindingKey && pkg.records.length > 0 && pkg.config.benchmark.id);
  });
}

test('web API: health, validate, prefilter', async () => {
  const app = require('../server/server');
  const srv = app.listen(0);
  const base = `http://localhost:${srv.address().port}`;
  try {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.ok(h.ok && h.providers.mock);
    const ex = await (await fetch(`${base}/api/examples`)).json();
    const qg = ex.find((e) => e.name === 'question-generation');
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const v = await post('/api/config/validate', { configText: qg.configText, example: qg.name });
    assert.ok(v.ok); assert.strictEqual(v.space.size, '1555200');
    const pf = await post('/api/prefilter', { configText: qg.configText, example: qg.name, target: 5 });
    assert.strictEqual(pf.candidates.length, 5);
    const bad = await fetch(`${base}/api/config/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ configText: 'benchmark: {id: x}', example: '../etc' }) });
    assert.strictEqual(bad.status, 400);
  } finally { srv.close(); }
});
