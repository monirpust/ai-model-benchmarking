#!/usr/bin/env node
'use strict';
// GenBench command-line interface.
require('../src/util/env').loadEnv();
const path = require('path');
const { loadConfigFile, validateConfig } = require('../src/config/loader');
const { describeSpace, formatBig } = require('../src/space/space');
const { prefilter } = require('../src/space/prefilter');
const runner = require('../src/pipeline/runner');
const store = require('../src/store/runstore');

const HELP = `GenBench - configuration-driven AI benchmarking

Usage:
  genbench validate  <config.yaml>                 Check a config (Layer 0)
  genbench space     <config.yaml>                 Show factors and the size of the configuration space
  genbench prefilter <config.yaml> [--target N]    Run the LLM pre-filter agent and print the candidates
  genbench run       <config.yaml> [--target N] [--simulate-humans]
                                                   Run the full pipeline; --simulate-humans adds DEMO ratings
  genbench recompute <runId>                       Recompute calibration/aggregation after human ratings
  genbench report    <runId>                       Print the leaderboard of a run
  genbench runs                                    List runs
  genbench serve     [--port 3000]                 Start the web application
`;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function printLeaderboard(report) {
  const rows = report.aggregation.leaderboard;
  console.log(`\n${report.benchmark.name} (v${report.benchmark.version})`);
  console.log(`Decision: ${report.benchmark.decision}`);
  console.log(`Pre-filter: ${report.prefilter.reduction} candidates (${report.prefilter.agent})`);
  console.log(`Human evaluation: ${report.human.completed}/${report.human.sampled} items complete${report.human.simulated ? ' (SIMULATED)' : ''}\n`);
  console.log('Rank  Code    Overall  95% CI          Fail%  Candidate');
  for (const r of rows) {
    const desc = Object.entries(r.choice).map(([k, v]) => `${k}=${typeof v === 'object' ? v.id : v}`).join(' ');
    console.log(`${String(r.rank).padEnd(5)} ${r.blind.padEnd(7)} ${r.overall.toFixed(3).padEnd(8)} [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}]  ${(r.failureRate * 100).toFixed(1).padStart(5)}  ${desc}`);
  }
  console.log(`\nScore sources: ${Object.entries(report.calibration.scoreSource).map(([k, v]) => `${k}<-${v.source}${v.provisional ? '*' : ''}`).join(', ')}`);
  const demoted = Object.entries(report.calibration.metricStatus).filter(([, v]) => v.demoted).map(([k]) => k);
  if (demoted.length) console.log(`Demoted metrics (diagnostic only): ${demoted.join(', ')}`);
  for (const w of report.calibration.warnings) console.log(`warning: ${w}`);
  console.log(`\nVerdict: ${report.verdict}\n`);
}

async function main() {
  const [cmd, target] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === 'serve') { process.env.PORT = arg('port', process.env.PORT || 3000); require('../server/server'); return; }
  if (cmd === 'runs') { for (const r of store.listRuns()) console.log(`${r.runId}  ${r.state.padEnd(16)} ${r.name}`); return; }
  if (cmd === 'recompute') { printLeaderboard(runner.recompute(target)); return; }
  if (cmd === 'report') { printLeaderboard(store.read(target, 'report.json')); return; }
  if (!target) { console.error('Missing config path.\n'); console.log(HELP); process.exit(1); }
  const cfg = loadConfigFile(target);
  const v = validateConfig(cfg);
  if (cmd === 'validate') {
    v.errors.forEach((e) => console.log(`error:   ${e}`));
    v.warnings.forEach((w) => console.log(`warning: ${w}`));
    console.log(v.ok ? 'Config is valid.' : 'Config has errors.');
    process.exit(v.ok ? 0 : 1);
  }
  if (!v.ok) { v.errors.forEach((e) => console.error(`error: ${e}`)); process.exit(1); }
  if (cmd === 'space') {
    const { dims, size } = describeSpace(cfg.space.factors);
    for (const d of dims) console.log(`${d.name.padEnd(18)} ${String(d.count).padStart(3)} levels`);
    console.log(`Total combinations: ${formatBig(size)}`);
    return;
  }
  if (cmd === 'prefilter') {
    const t = Number(arg('target', cfg.space.prefilter.target_size));
    const pf = await prefilter(cfg, { target: t, onLog: (m) => console.log(m) });
    for (const [f, r] of Object.entries(pf.rationale)) console.log(`  ${f}: ${r}`);
    pf.candidates.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}. ${c.id}  ${Object.entries(c.choice).map(([k, x]) => `${k}=${typeof x === 'object' ? x.id : x}`).join(' ')}`));
    return;
  }
  if (cmd === 'run') {
    const t = arg('target');
    if (t) cfg.space.prefilter.target_size = Number(t);
    const { runId, promise } = runner.startRun({ config: cfg, baseDir: cfg._baseDir, simulateHumans: Boolean(arg('simulate-humans', false)) });
    console.log(`Run ${runId} started (artefacts in ${path.relative(process.cwd(), store.runDir(runId))})`);
    let last = '';
    const timer = setInterval(() => {
      const s = store.read(runId, 'status.json', {});
      const line = `${s.phase} ${s.progress ? `${s.progress.done}/${s.progress.total}` : ''}`;
      if (line !== last) { process.stdout.write(`  ${line}\n`); last = line; }
    }, 300);
    await promise;
    clearInterval(timer);
    const s = store.read(runId, 'status.json');
    if (s.state === 'failed') { console.error(`Run failed: ${s.error}`); process.exit(1); }
    printLeaderboard(store.read(runId, 'report.json'));
    return;
  }
  console.log(HELP);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
