'use strict';
/* GenBench front-end: plain JavaScript, no build step. Hash routes:
   #/            runs dashboard
   #/new         build a benchmark: config -> validate -> pre-filter -> launch
   #/run/:id     run progress and results
   #/human       pick a run for human evaluation
   #/human/:id   two-tier human evaluation workspace
   #/docs        guide */

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 3) => (Number.isFinite(x) ? Number(x).toFixed(d) : '–');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');
const lid = (v) => (v && typeof v === 'object' ? v.id : v);
let pollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.data = data; throw e; }
  return data;
}

function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (_) { return null; } return null; }

function stateKind(s) { return { complete: 'good', awaiting_humans: 'warn', running: '', queued: 'muted', failed: 'bad', stopped: 'muted' }[s] ?? 'muted'; }
function stateLabel(s) { return { awaiting_humans: 'awaiting humans' }[s] || s; }

function candDesc(choice, keys) {
  return Object.entries(choice).filter(([k]) => !keys || keys.includes(k)).map(([k, v]) => `${esc(k)}=<b>${esc(lid(v))}</b>`).join(' · ');
}

/* ---------------- Dashboard ---------------- */
async function viewRuns() {
  const runs = await api('/api/runs');
  $app.innerHTML = `
    <h1>Benchmark runs</h1>
    <p class="sub">Each run executes one configuration file through all eight layers: spec, inputs, candidates, outputs, three scoring lanes, calibration, aggregation and results.</p>
    <div class="row" style="margin-bottom:16px"><a class="btn primary" href="#/new">New benchmark</a><a class="btn" href="#/docs">How it works</a></div>
    <div class="panel">${runs.length ? `
      <table><thead><tr><th>Run</th><th>Benchmark</th><th>State</th><th>Phase</th><th>Created</th><th></th></tr></thead><tbody>
      ${runs.map((r) => `<tr>
        <td class="mono"><a href="#/run/${esc(r.runId)}">${esc(r.runId)}</a></td>
        <td>${esc(r.name)} <span class="small">v${esc(r.version)}</span></td>
        <td><span class="pill ${stateKind(r.state)}">${esc(stateLabel(r.state))}</span></td>
        <td class="small">${esc(r.phase)}</td>
        <td class="small">${esc((r.createdAt || '').replace('T', ' ').slice(0, 16))}</td>
        <td>${['awaiting_humans', 'complete'].includes(r.state) ? `<a href="#/human/${esc(r.runId)}">Rate</a>` : ''}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No runs yet. Start with <a href="#/new">New benchmark</a> and pick one of the two paper use cases.</div>'}
    </div>`;
}

/* ---------------- Builder ---------------- */
const builder = { example: null, configText: '', datasetText: '', validation: null, prefilter: null, selected: new Set() };

async function viewNew() {
  const examples = await api('/api/examples');
  if (!builder.configText && examples.length) { builder.example = examples[0].name; builder.configText = examples[0].configText; }
  $app.innerHTML = `
    <h1>New benchmark</h1>
    <p class="sub">One configuration file defines the inputs, the fixed output structure, the factor space, prompts, metrics, the rubric, judges and human evaluation.</p>
    <div class="panel">
      <h2>1 · Configuration</h2>
      <div class="row" style="margin-bottom:10px">
        <label>Start from <select id="ex">${examples.map((e) => `<option value="${esc(e.name)}" ${e.name === builder.example ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}<option value="">(blank / my own)</option></select></label>
        <button id="validate" class="primary">Validate</button>
        <span class="small">Relative dataset and media paths resolve inside the chosen example folder.</span>
      </div>
      <textarea id="cfg" class="code" spellcheck="false">${esc(builder.configText)}</textarea>
      <details style="margin-top:10px"><summary>Use my own dataset (JSONL, one item per line)</summary>
        <p class="small">Each line: {"id","source","strata":{...},"input":{field: text | "data:image/png;base64,..."},"reference":{...}}. Overrides inputs.dataset.</p>
        <textarea id="ds" class="data" spellcheck="false" placeholder='{"id":"q1","source":"course-a","strata":{"level":"year1"},"input":{"content":"..."},"reference":{}}'>${esc(builder.datasetText)}</textarea>
      </details>
      <div id="vres"></div>
    </div>
    <div class="panel" id="pfpanel"><h2>2 · Pre-filter the configuration space</h2><p class="small">Validate first.</p></div>
    <div class="panel" id="launch"><h2>3 · Launch</h2><p class="small">Run the pre-filter first, or launch directly to let the run pre-filter automatically.</p>
      <div class="row"><label><input type="checkbox" id="sim"> Add simulated human ratings (demo only, clearly marked)</label><button id="go" class="primary">Launch run</button></div><div id="lres"></div></div>`;
  const body = () => ({ configText: document.getElementById('cfg').value, datasetText: document.getElementById('ds').value.trim() || undefined, example: builder.example || undefined });
  document.getElementById('ex').onchange = (e) => {
    const ex = examples.find((x) => x.name === e.target.value);
    builder.example = e.target.value || null;
    builder.configText = ex ? ex.configText : 'benchmark:\n  id: my-benchmark\n  decision: ""\ntask:\n  description: ""\n';
    builder.prefilter = null; viewNew();
  };
  document.getElementById('cfg').oninput = (e) => { builder.configText = e.target.value; };
  document.getElementById('ds').oninput = (e) => { builder.datasetText = e.target.value; };
  document.getElementById('validate').onclick = async () => {
    const box = document.getElementById('vres');
    try {
      const v = await api('/api/config/validate', { method: 'POST', body: body() });
      builder.validation = v;
      box.innerHTML = `${v.ok ? '<div class="msg good">Configuration is valid.</div>' : `<div class="msg bad">${v.errors.map(esc).join('\n')}</div>`}
        ${v.warnings.length ? `<div class="msg warn">${v.warnings.map(esc).join('<br>')}</div>` : ''}
        ${v.space ? `<h3>Configuration space: ${esc(v.space.sizeFormatted)} combinations</h3>
        <table><thead><tr><th>Factor</th><th class="num">Levels</th><th>Values</th></tr></thead><tbody>
        ${v.space.dims.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td class="num">${d.count}</td><td class="small">${d.levels.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table>
        <p class="small">Inputs: ${v.inputTypes.map(esc).join(', ')}</p>` : ''}`;
      if (v.ok) renderPrefilterPanel(body);
    } catch (e) { box.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
  };
  document.getElementById('go').onclick = async () => {
    const out = document.getElementById('lres');
    try {
      const candidates = builder.prefilter ? builder.prefilter.candidates.filter((c) => builder.selected.has(c.id)) : undefined;
      if (candidates && !candidates.length) throw new Error('Select at least one candidate.');
      const { runId } = await api('/api/runs', { method: 'POST', body: { ...body(), candidates, simulateHumans: document.getElementById('sim').checked } });
      location.hash = `#/run/${runId}`;
    } catch (e) { out.innerHTML = `<div class="msg bad">${esc(e.message)}${e.data?.validation ? `\n${e.data.validation.errors.join('\n')}` : ''}</div>`; }
  };
  if (builder.prefilter) renderPrefilterPanel(body, true);
}

function renderPrefilterPanel(body, keep) {
  const p = document.getElementById('pfpanel');
  const target = builder.prefilter?.target || 10;
  p.innerHTML = `<h2>2 · Pre-filter the configuration space</h2>
    <p class="small">An LLM agent reads the task description and the factor list, and prunes the space to a small relevant set before any test runs. Every decision comes with a rationale. You can untick candidates before launching.</p>
    <div class="row"><label>Target candidates <input id="target" type="number" min="1" max="500" value="${target}" style="width:90px"></label><button id="runpf" class="primary">Run pre-filter agent</button></div>
    <div id="pfres"></div>`;
  document.getElementById('runpf').onclick = async () => {
    const box = document.getElementById('pfres');
    box.innerHTML = '<p class="small">Pruning…</p>';
    try {
      builder.prefilter = await api('/api/prefilter', { method: 'POST', body: { ...body(), target: Number(document.getElementById('target').value) } });
      builder.selected = new Set(builder.prefilter.candidates.map((c) => c.id));
      drawPrefilter();
    } catch (e) { box.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
  };
  if (keep && builder.prefilter) drawPrefilter();
}

function drawPrefilter() {
  const pf = builder.prefilter;
  const box = document.getElementById('pfres');
  const varying = pf.candidates.length ? Object.keys(pf.candidates[0].choice).filter((k) => new Set(pf.candidates.map((c) => JSON.stringify(c.choice[k]))).size > 1) : [];
  const fixed = pf.candidates.length ? Object.keys(pf.candidates[0].choice).filter((k) => !varying.includes(k)) : [];
  box.innerHTML = `
    <div class="funnel"><div class="stage"><b>${esc(pf.originalSizeFormatted)}</b>full space</div><span class="arrow">→</span>
      <div class="stage"><b>${esc(pf.prunedSizeFormatted)}</b>after pruning levels</div><span class="arrow">→</span>
      <div class="stage"><b>${pf.candidates.length}</b>candidates to test</div></div>
    <p class="small">Agent: ${esc(pf.agent)}. ${esc(pf.summary)}</p>
    <h3>Rationale per factor</h3>
    <table><tbody>${Object.entries(pf.rationale || {}).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td class="small">${esc(v)}</td></tr>`).join('')}</tbody></table>
    <h3>Candidates</h3>
    <p class="small">Held fixed across all candidates: ${fixed.map((k) => `${esc(k)}=<b>${esc(lid(pf.candidates[0].choice[k]))}</b>`).join(' · ') || 'none'}</p>
    <table><thead><tr><th></th><th>Id</th>${varying.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>
    ${pf.candidates.map((c) => `<tr><td><input type="checkbox" data-id="${esc(c.id)}" ${builder.selected.has(c.id) ? 'checked' : ''}></td><td class="mono">${esc(c.id)}</td>${varying.map((k) => `<td>${esc(lid(c.choice[k]))}</td>`).join('')}</tr>`).join('')}
    </tbody></table>`;
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.onchange = () => { if (cb.checked) builder.selected.add(cb.dataset.id); else builder.selected.delete(cb.dataset.id); }; });
}

/* ---------------- Run view ---------------- */
async function viewRun(id) {
  const { status, report } = await api(`/api/runs/${encodeURIComponent(id)}`);
  const running = ['queued', 'running'].includes(status.state);
  const prog = status.progress && status.progress.total ? status.progress.done / status.progress.total : 0;
  const tab = store('gb-tab') || 'leaderboard';
  $app.innerHTML = `
    <div class="row" style="justify-content:space-between"><div><h1>${esc(status.name)} <span class="small">v${esc(status.version)}</span></h1>
      <p class="sub mono">${esc(status.runId)} · config ${esc((status.configHash || '').slice(0, 12))} · data ${esc((status.datasetHash || '').slice(0, 12))}</p></div>
      <div class="row">${running ? '<button id="stop" class="danger">Stop</button>' : ''}
        ${report ? `<a class="btn" href="#/human/${esc(id)}">Human evaluation</a><button id="recompute">Recompute</button><a class="btn" href="/api/runs/${esc(id)}/package">Download repro package</a>` : ''}
        <button id="del" class="danger">Delete</button></div></div>
    <div class="panel"><div class="row" style="justify-content:space-between"><span><span class="pill ${stateKind(status.state)}">${esc(stateLabel(status.state))}</span> <b>${esc(status.phase)}</b></span>
      <span class="small">${status.progress ? `${status.progress.done}/${status.progress.total}` : ''}</span></div>
      ${running ? `<div class="progress" style="margin-top:8px"><div style="width:${(prog * 100).toFixed(1)}%"></div></div>` : ''}
      ${status.error ? `<div class="msg bad">${esc(status.error)}</div>` : ''}
      <details ${running ? 'open' : ''} style="margin-top:8px"><summary>Run log</summary><div class="log">${(status.log || []).map(esc).join('\n')}</div></details></div>
    ${report ? renderReport(report, id, tab) : ''}`;
  document.getElementById('del').onclick = async () => { if (confirm('Delete this run and all its files?')) { await api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }); location.hash = '#/'; } };
  if (running) { document.getElementById('stop').onclick = () => api(`/api/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' }); pollTimer = setTimeout(() => route(), 1000); }
  if (report) {
    document.getElementById('recompute').onclick = async () => { await api(`/api/runs/${encodeURIComponent(id)}/recompute`, { method: 'POST' }); route(); };
    document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => { store('gb-tab', b.dataset.tab); route(); }; });
    const sim = document.getElementById('simulate');
    if (sim) sim.onclick = async () => { await api(`/api/runs/${encodeURIComponent(id)}/human/simulate`, { method: 'POST' }); route(); };
    const out = document.getElementById('loadouts');
    if (out) out.onclick = () => loadOutputs(id);
  }
}

function renderReport(r, id, tab) {
  const agg = r.aggregation; const cal = r.calibration; const lb = agg.leaderboard;
  const varying = lb.length ? Object.keys(lb[0].choice).filter((k) => new Set(lb.map((x) => JSON.stringify(x.choice[k]))).size > 1) : [];
  const lo = Math.max(0, Math.min(...lb.map((x) => x.ci[0])) - 0.05); const hi = Math.min(1, Math.max(...lb.map((x) => x.ci[1])) + 0.02);
  const X = (v) => `${(((v - lo) / (hi - lo || 1)) * 100).toFixed(1)}%`;
  const provisional = Object.values(cal.scoreSource).some((s) => s.provisional);
  const tabs = [['leaderboard', 'Leaderboard'], ['calibration', 'Calibration'], ['breakdown', 'Breakdowns'], ['errors', 'Error analysis'], ['prefilter', 'Pre-filter'], ['outputs', 'Outputs']];
  let body = '';
  if (tab === 'leaderboard') {
    body = `<p class="small">Overall = weighted sum of normalised components (weights from the spec). Bars show the 95% cluster-bootstrap interval. Candidates sharing rank 1 are statistically tied with the leader. Failed outputs count as 0.</p>
    <table><thead><tr><th>Rank</th><th>Code</th><th>Candidate (varying factors)</th><th class="num">Overall</th><th>95% CI</th><th class="num">Run sd</th><th class="num">Fail</th><th class="num">Cost/item</th></tr></thead><tbody>
    ${lb.map((x) => `<tr><td><b>${x.rank}</b>${x.tiedWithLeader && x.rank === 1 && lb.filter((y) => y.tiedWithLeader).length > 1 ? ' <span class="pill warn">tie</span>' : ''}</td>
      <td class="mono">${esc(x.blind)}</td><td class="cand">${candDesc(x.choice, varying)}</td><td class="num"><b>${fmt(x.overall)}</b></td>
      <td><div class="ci"><div class="band" style="left:${X(x.ci[0])};width:calc(${X(x.ci[1])} - ${X(x.ci[0])})"></div><div class="pt" style="left:${X(x.overall)}"></div></div><span class="small">${fmt(x.ci[0])} – ${fmt(x.ci[1])}</span></td>
      <td class="num">${fmt(x.runStd)}</td><td class="num">${pct(x.failureRate)}</td><td class="num">${x.costPerItem ? `$${x.costPerItem.toFixed(4)}` : '–'}</td></tr>`).join('')}</tbody></table>
    <h3>Components</h3>
    <table><thead><tr><th>Component</th><th>Kind</th><th>Score source</th><th class="num">Weight</th>${lb.slice(0, 5).map((x) => `<th class="num">${esc(x.blind)}</th>`).join('')}</tr></thead><tbody>
    ${agg.components.map((c) => `<tr><td><b>${esc(c.id)}</b></td><td>${esc(c.kind)}</td><td>${esc(c.source)}</td><td class="num">${fmt(c.weight, 2)}</td>${lb.slice(0, 5).map((x) => `<td class="num">${fmt(x.components[c.id])}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="small">Weight sensitivity (±${agg.sensitivity.delta}): ${agg.sensitivity.stable ? 'the leader never changes.' : `${agg.sensitivity.flips.length} perturbation(s) change the leader: ${agg.sensitivity.flips.map((f) => `${esc(f.component)} ${esc(f.change)}`).join(', ')}.`}</p>`;
  } else if (tab === 'calibration') {
    body = `<p class="small">Agreement is computed on the random part of the human sample only (${cal.nComplete} of ${cal.nRandom} items complete). Quadratic-weighted kappa; thresholds come from the spec.</p>
    ${cal.warnings.map((w) => `<div class="msg warn">${esc(w)}</div>`).join('')}
    ${cal.loopBacks.map((l) => `<div class="msg bad">Loop-back ${esc(l.connector)} (${esc(l.criterion)}): ${esc(l.action)}</div>`).join('')}
    <h3>Rubric criteria → score-source map</h3>
    <table><thead><tr><th>Criterion</th><th class="num">Human–human κ</th><th class="num">Judge–human κ</th><th>Source used</th><th>Why</th></tr></thead><tbody>
    ${Object.entries(cal.scoreSource).map(([k, s]) => `<tr><td><b>${esc(k)}</b></td><td class="num">${fmt(cal.humanHuman[k]?.kappa, 2)} <span class="small">n=${cal.humanHuman[k]?.n}</span></td><td class="num">${fmt(cal.judgeHuman[k]?.kappa, 2)} <span class="small">n=${cal.judgeHuman[k]?.n}</span></td>
      <td><span class="pill ${s.provisional ? 'warn' : s.source === 'judge' ? 'good' : ''}">${esc(s.source)}${s.provisional ? ' (provisional)' : ''}</span></td><td class="small">${esc(s.reason)}</td></tr>`).join('')}</tbody></table>
    <h3>Automatic metrics</h3>
    <table><thead><tr><th>Metric</th><th class="num">Spearman ρ vs humans</th><th>Status</th><th>Why</th></tr></thead><tbody>
    ${Object.entries(cal.metricStatus).map(([k, s]) => `<tr><td><b>${esc(k)}</b></td><td class="num">${fmt(cal.metricHuman[k]?.spearman, 2)}</td><td><span class="pill ${s.included ? (s.provisional ? 'warn' : 'good') : 'bad'}">${s.included ? 'in ranking' : 'demoted'}</span></td><td class="small">${esc(s.reason)}</td></tr>`).join('')}</tbody></table>
    <h3>Judge bias checks</h3>
    <p class="small">Length: judge ρ=${fmt(cal.bias.lengthJudge, 2)} vs human ρ=${fmt(cal.bias.lengthHuman, 2)}.</p>
    ${Object.entries(cal.bias.subgroup || {}).map(([sk, g]) => `<p class="small">${esc(sk)}: ${Object.entries(g).map(([k, v]) => `${esc(k)} judge−human ${fmt(v.meanJudgeMinusHuman, 2)}`).join(' · ')}</p>`).join('')}`;
  } else if (tab === 'breakdown') {
    const strataKeys = lb.length ? Object.keys(lb[0].strata) : [];
    body = strataKeys.map((sk) => {
      const vals = Object.keys(lb[0].strata[sk]);
      return `<h3>By ${esc(sk)}</h3><table><thead><tr><th>Code</th>${vals.map((v) => `<th class="num">${esc(v)}</th>`).join('')}</tr></thead><tbody>
      ${lb.map((x) => `<tr><td class="mono">${esc(x.blind)}</td>${vals.map((v) => `<td class="num">${fmt(x.strata[sk][v])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }).join('') || '<p class="small">No strata declared.</p>';
  } else if (tab === 'errors') {
    body = `<h3>Output failures (scored 0)</h3>${r.errorAnalysis.failureModes.length ? `<table><tbody>${r.errorAnalysis.failureModes.map((f) => `<tr><td>${esc(f.mode)}</td><td class="num">${f.count}</td></tr>`).join('')}</tbody></table>` : '<p class="small">None.</p>'}
      <h3>Why the LLM judge flagged items</h3>${r.errorAnalysis.judgeFlagReasons.length ? `<table><tbody>${r.errorAnalysis.judgeFlagReasons.map((f) => `<tr><td>${esc(f.reason)}</td><td class="num">${f.count}</td></tr>`).join('')}</tbody></table>` : '<p class="small">None.</p>'}
      <h3>Dataset</h3><p class="small">${r.dataset.testItems} test items from ${r.dataset.sources.test} sources. ${r.dataset.warnings.map(esc).join(' ')}</p>`;
  } else if (tab === 'prefilter') {
    body = `<div class="funnel"><div class="stage"><b>${esc(Number(r.prefilter.originalSize).toLocaleString())}</b>full space</div><span class="arrow">→</span><div class="stage"><b>${esc(Number(r.prefilter.prunedSize).toLocaleString())}</b>pruned</div><span class="arrow">→</span><div class="stage"><b>${r.prefilter.candidates}</b>tested</div></div>
      <p class="small">Agent: ${esc(r.prefilter.agent)}. ${esc(r.prefilter.summary)}</p>
      <table><tbody>${Object.entries(r.prefilter.rationale || {}).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td class="small">${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  } else if (tab === 'outputs') {
    body = `<p class="small">Browse raw outputs with their metric and judge scores (first 50).</p><button id="loadouts">Load outputs</button><div id="outs"></div>`;
  }
  return `
    <div class="panel"><div class="verdict">${esc(r.verdict)}</div>
      ${provisional ? '<div class="msg warn">Provisional: human evaluation is incomplete, so the LLM judge and heuristic metrics are not yet validated against humans.</div>' : ''}
      ${r.human.simulated ? '<div class="msg warn">This run contains SIMULATED human ratings (demo mode). Do not report them as human evaluation.</div>' : ''}
      <p class="small"><b>Decision:</b> ${esc(r.benchmark.decision)}</p>
      <div class="kpi"><div><b>${esc(r.prefilter.reduction)}</b>pre-filter</div><div><b>${lb.length}</b>candidates</div><div><b>${r.dataset.testItems}</b>test items</div>
        <div><b>${r.human.completed}/${r.human.sampled}</b>human items done</div><div><b>${r.human.seniorPending}</b>awaiting senior</div></div>
      ${!r.human.complete ? '<div class="row" style="margin-top:10px"><a class="btn primary" href="#/human/' + esc(id) + '">Open human evaluation</a><button id="simulate">Fill with simulated ratings (demo)</button></div>' : ''}</div>
    <div class="panel"><div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>${body}</div>`;
}

async function loadOutputs(id) {
  const rows = await api(`/api/runs/${encodeURIComponent(id)}/records?limit=50`);
  document.getElementById('outs').innerHTML = rows.map((r) => `<div class="panel"><div class="row"><span class="mono">${esc(r.blind)}</span><span class="small">item ${esc(r.itemId)} · repeat ${r.repeat}</span>${r.ok ? '<span class="pill good">valid</span>' : `<span class="pill bad">failed</span> <span class="small">${esc(r.error)}</span>`}${r.judge?.flagged ? '<span class="pill warn">judge flagged</span>' : ''}</div>
    ${r.output ? `<pre class="out">${esc(JSON.stringify(r.output, null, 2))}</pre>` : ''}
    <p class="small">Metrics: ${Object.entries(r.metrics || {}).map(([k, v]) => `${esc(k)}=${fmt(v.score, 2)}`).join(' · ')}</p>
    ${r.judge ? `<p class="small">Judge: ${Object.entries(r.judge.scores).map(([k, v]) => `${esc(k)}=${fmt(v.score, 1)}`).join(' · ')}</p>` : ''}</div>`).join('');
}

/* ---------------- Human evaluation ---------------- */
async function viewHumanPick() {
  const runs = (await api('/api/runs')).filter((r) => ['awaiting_humans', 'complete'].includes(r.state));
  $app.innerHTML = `<h1>Human evaluation</h1><p class="sub">Two tiers. Junior judges rate a stratified random sample plus every item the LLM judge flagged, blind and independently. Senior judges adjudicate every junior disagreement; their score is the gold standard.</p>
    <div class="panel">${runs.length ? `<table><tbody>${runs.map((r) => `<tr><td><a href="#/human/${esc(r.runId)}">${esc(r.name)}</a></td><td class="mono small">${esc(r.runId)}</td><td><span class="pill ${stateKind(r.state)}">${esc(stateLabel(r.state))}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No runs are ready for human evaluation yet.</div>'}</div>`;
}

async function viewHuman(id) {
  const st = await api(`/api/runs/${encodeURIComponent(id)}/human/status`);
  const role = store('gb-role') || 'junior';
  const rater = store('gb-rater') || '';
  $app.innerHTML = `
    <div class="row" style="justify-content:space-between"><h1>Human evaluation</h1><a class="btn" href="#/run/${esc(id)}">Back to results</a></div>
    <p class="sub mono">${esc(id)}</p>
    <div class="panel"><div class="kpi">
      <div><b>${st.sampled}</b>items sampled<br><span class="small">${st.randomPart} random · ${st.flaggedOnly} flagged</span></div>
      <div><b>${st.juniorDone}/${st.sampled}</b>junior complete<br><span class="small">${st.ratersPerItem} raters per item</span></div>
      <div><b>${st.seniorDone}/${st.needsSenior}</b>senior adjudications</div><div><b>${st.complete}/${st.sampled}</b>final scores</div></div>
      <div class="row" style="margin-top:14px">
        <label>Role <select id="role"><option value="junior" ${role === 'junior' ? 'selected' : ''}>Junior judge</option><option value="senior" ${role === 'senior' ? 'selected' : ''}>Senior judge</option></select></label>
        <label>Your name <input id="rater" value="${esc(rater)}" placeholder="e.g. Teacher A"></label>
        ${st.seniorProtected ? `<label id="codewrap">Senior code <input id="code" type="password" value="${esc(store('gb-code') || '')}"></label>` : ''}
        <button id="start" class="primary">Next item</button></div></div>
    <div id="task"></div>`;
  document.getElementById('start').onclick = () => loadTask(id);
  if (rater) loadTask(id);
}

async function loadTask(id) {
  const role = document.getElementById('role').value;
  const rater = document.getElementById('rater').value.trim();
  const code = document.getElementById('code')?.value || '';
  const box = document.getElementById('task');
  if (!rater) { box.innerHTML = '<div class="msg bad">Enter your name first, so your ratings can be told apart from other raters.</div>'; return; }
  store('gb-role', role); store('gb-rater', rater); if (code) store('gb-code', code);
  try {
    const { task, remaining } = await api(`/api/runs/${encodeURIComponent(id)}/human/next?role=${role}&rater=${encodeURIComponent(rater)}`, { headers: code ? { 'x-senior-code': code } : {} });
    if (!task) { box.innerHTML = `<div class="panel empty">Nothing left for you as a ${esc(role)} judge. ${role === 'junior' ? 'Senior adjudication starts once two juniors have rated an item.' : 'All disagreements are adjudicated.'}</div>`; return; }
    box.innerHTML = `
      <div class="grid2">
        <div class="panel"><h2>Input</h2>
          ${Object.entries(task.input).filter(([, v]) => !String(v).startsWith('[')).map(([k, v]) => `<div class="small">${esc(k)}</div><div class="task-input">${esc(v)}</div>`).join('')}
          ${task.media.map((m) => `<div class="small">${esc(m.field)} (${esc(m.type)})</div><div class="task-input">${m.type === 'image' ? `<img alt="${esc(m.field)}" src="${m.dataUrl}">` : `<audio controls src="${m.dataUrl}"></audio>`}</div>`).join('')}
          ${task.reference ? `<div class="small">reference (teacher key)</div><div class="task-input">${esc(JSON.stringify(task.reference))}</div>` : ''}
          <h2 style="margin-top:14px">Output <span class="mono small">${esc(task.blind)}</span></h2><pre class="out">${esc(JSON.stringify(task.output, null, 2))}</pre></div>
        <div class="panel"><h2>Rubric</h2><p class="small">${remaining} item(s) left for you. Score each criterion using the anchors.${role === 'senior' ? ' Junior scores are shown; criteria they disagree on are highlighted.' : ' You are blind to the model and to other raters.'}</p>
          <form id="rf">${task.rubric.map((c) => {
            const levels = []; for (let s = c.scale[0]; s <= c.scale[1]; s++) levels.push(s);
            const dis = (task.disagreementOn || []).includes(c.id);
            return `<div class="crit ${dis ? 'disagree' : ''}"><b>${esc(c.id)}</b> <span class="small">${esc(c.description)}</span>
              <ul class="anchors">${Object.entries(c.anchors || {}).map(([lv, a]) => `<li><b>${esc(lv)}</b>: ${esc(typeof a === 'object' ? `${a.description}${a.example ? ` (e.g. "${a.example}")` : ''}` : a)}</li>`).join('')}</ul>
              ${task.juniorScores ? `<p class="small">Juniors: ${task.juniorScores.map((j) => `${esc(j.rater)}=${esc(j.scores[c.id])}`).join(', ')}</p>` : ''}
              <div class="scale">${levels.map((s) => `<label><input type="radio" name="${esc(c.id)}" value="${s}"><span>${s}</span></label>`).join('')}</div></div>`;
          }).join('')}
          <label class="small">Comment (optional)<br><textarea name="comment" rows="2" style="width:100%"></textarea></label>
          <div id="ferr"></div>
          <div class="row" style="margin-top:8px"><button class="primary" type="submit">Submit and next</button><button type="button" id="skip">Skip</button></div></form></div></div>`;
    document.getElementById('skip').onclick = () => loadTask(id);
    document.getElementById('rf').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const scores = {}; const missing = [];
      for (const c of task.rubric) { const v = fd.get(c.id); if (v === null) missing.push(c.id); else scores[c.id] = Number(v); }
      if (missing.length) { document.getElementById('ferr').innerHTML = `<div class="msg bad">Score every criterion first: ${missing.map(esc).join(', ')}</div>`; return; }
      try {
        await api(`/api/runs/${encodeURIComponent(id)}/human/ratings`, { method: 'POST', headers: code ? { 'x-senior-code': code } : {}, body: { recordId: task.recordId, role, rater, scores, comment: fd.get('comment'), seniorCode: code || undefined } });
        viewHuman(id);
      } catch (err) { document.getElementById('ferr').innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
    };
  } catch (e) { box.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
}

/* ---------------- Guide ---------------- */
function viewDocs() {
  $app.innerHTML = `<h1>How GenBench works</h1><p class="sub">GenBench implements the eight layers of the Generalized Benchmarking Framework v2. One configuration file drives everything.</p>
  <div class="panel"><table><thead><tr><th>Layer</th><th>What GenBench does</th><th>Config section</th></tr></thead><tbody>
  <tr><td>0 Spec</td><td>Validates and hashes the config; the decision, task, rubric and thresholds are fixed before any data is touched.</td><td class="mono">benchmark, task, rubric, calibration, aggregation</td></tr>
  <tr><td>1 Inputs</td><td>Loads typed fields (text, image, audio), checks strata, splits dev/test by source, hashes the dataset.</td><td class="mono">inputs</td></tr>
  <tr><td>2 Candidates</td><td>Builds the factor space (often millions of combinations) and lets the LLM pre-filter agent prune it to a small set with a rationale.</td><td class="mono">space.factors, space.prefilter</td></tr>
  <tr><td>3 Outputs</td><td>Runs every candidate on every test item (× repeats), enforces the JSON schema, retries once, scores failures 0, blinds candidates.</td><td class="mono">output, prompts, run</td></tr>
  <tr><td>4a Metrics</td><td>Program checks on 100% of outputs: schema, counts, key matches, grounding, diversity, numeric error, QWK.</td><td class="mono">metrics</td></tr>
  <tr><td>4b LLM judge</td><td>Scores each criterion with reason and evidence; re-scores a sample and flags inconsistent items for humans.</td><td class="mono">judge</td></tr>
  <tr><td>4c Humans</td><td>Junior judges rate a stratified sample plus flagged items; senior judges adjudicate every disagreement.</td><td class="mono">human</td></tr>
  <tr><td>5 Calibration</td><td>Human–human, judge–human and metric–human agreement decide the score source per criterion; weak metrics are demoted.</td><td class="mono">calibration</td></tr>
  <tr><td>6 Aggregation</td><td>Fixed-scale normalisation, spec weights, cluster bootstrap CIs, Holm-corrected tests, ties, weight sensitivity, cost.</td><td class="mono">aggregation, pricing</td></tr>
  <tr><td>7 Results</td><td>Leaderboard, breakdowns by stratum, error analysis, verdict and a downloadable reproducibility package.</td><td class="mono">—</td></tr>
  </tbody></table></div>
  <div class="panel"><h2>Providers</h2><p>Write models as <span class="mono">provider:model</span>: <span class="mono">openai:…</span>, <span class="mono">anthropic:…</span>, <span class="mono">gemini:…</span>, <span class="mono">compat:…</span> (any OpenAI-compatible endpoint such as Ollama or vLLM), or <span class="mono">mock:strong|medium|weak</span> for offline demos. Set API keys in <span class="mono">.env</span>. The chips in the top bar show which providers are configured.</p>
  <h2>Two paper use cases</h2><p><b>Question generation</b> (1,555,200-combination space) and <b>AI grading</b> (1,036,800-combination space) ship as examples under <span class="mono">examples/</span>. Start them from <a href="#/new">New benchmark</a>.</p></div>`;
}

/* ---------------- Router ---------------- */
async function route() {
  clearTimeout(pollTimer);
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${parts[0] || ''}` || (a.getAttribute('href') === '#/' && !parts.length)));
  try {
    if (!parts.length) await viewRuns();
    else if (parts[0] === 'new') await viewNew();
    else if (parts[0] === 'run' && parts[1]) await viewRun(decodeURIComponent(parts[1]));
    else if (parts[0] === 'human' && parts[1]) await viewHuman(decodeURIComponent(parts[1]));
    else if (parts[0] === 'human') await viewHumanPick();
    else if (parts[0] === 'docs') viewDocs();
    else $app.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (e) { $app.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; }
}

window.addEventListener('hashchange', route);
api('/api/health').then((h) => {
  document.getElementById('ver').textContent = h.version;
  document.getElementById('providers').innerHTML = Object.entries(h.providers).map(([k, v]) => `<span class="pill ${v ? 'good' : 'muted'}" title="${v ? 'configured' : 'no API key'}">${esc(k)}</span>`).join('');
}).catch(() => {});
route();
