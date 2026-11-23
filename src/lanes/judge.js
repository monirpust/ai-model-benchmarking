'use strict';
// Lane 4b: LLM judge. Scores every valid output per rubric criterion with a
// reason and evidence quote, blind to the candidate. A re-score sample checks
// self-consistency; inconsistent or invalid judgements are FLAGGED and sent
// to the junior human sample (lane 4c). Judge scores are kept either way.
const { generate, parseModelId } = require('../providers');
const { mockJudge } = require('../providers/mocksim');
const { extractJson, pool, rng, renderTemplate } = require('../util/core');
const { levelId } = require('../space/space');

const SYSTEM = `You are an expert evaluator in a blinded benchmark. You will see a task, an input, a model output
and a scoring rubric with anchored levels. Score each criterion independently on its integer scale.
Do not reward length for its own sake. For every score give a short reason and quote verbatim evidence
from the output that justifies it. Return JSON only.`;

function rubricText(criteria) {
  return criteria.map((c) => {
    const anchors = Object.entries(c.anchors || {}).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([lvl, txt]) => `    ${lvl}: ${typeof txt === 'object' ? `${txt.description}${txt.example ? ` e.g. "${txt.example}"` : ''}` : txt}`).join('\n');
    return `- ${c.id} [${c.scale[0]}-${c.scale[1]}]: ${c.description}\n${anchors}`;
  }).join('\n');
}

function judgePrompt(cfg, item, output, criteria) {
  const tpl = cfg.judge.prompt || `TASK:\n{{task}}\n\nINPUT:\n{{input_json}}\n{{reference_block}}\nMODEL OUTPUT:\n{{output_json}}\n\nRUBRIC:\n{{rubric}}\n\nReturn JSON: {"scores": {"<criterion id>": {"score": <int>, "reason": "<short>", "evidence": "<verbatim quote from output>"}}}`;
  return renderTemplate(tpl, {
    task: cfg.task.description,
    input_json: JSON.stringify(item.input, null, 2),
    reference_block: cfg.judge.include_reference && Object.keys(item.reference).length ? `\nREFERENCE (for the evaluator only):\n${JSON.stringify(item.reference, null, 2)}\n` : '',
    output_json: JSON.stringify(output, null, 2),
    rubric: rubricText(criteria),
  });
}

function validateJudgement(parsed, criteria, output) {
  const problems = [];
  const outStr = JSON.stringify(output);
  const scores = {};
  for (const c of criteria) {
    const s = parsed?.scores?.[c.id];
    const val = Number(s?.score ?? s);
    if (!Number.isFinite(val) || val < c.scale[0] || val > c.scale[1]) { problems.push(`${c.id}: score missing or out of range`); continue; }
    const ev = s?.evidence ? String(s.evidence) : '';
    const evOk = !ev || outStr.includes(ev.slice(0, 40).replace(/"/g, '\\"')) || outStr.includes(ev.slice(0, 40));
    if (!evOk) problems.push(`${c.id}: evidence not found in output`);
    scores[c.id] = { score: Math.round(val), reason: s?.reason || '', evidence: ev, evidenceOk: evOk };
  }
  return { scores, problems };
}

async function judgeOnce(modelId, cfg, item, record, criteria, seedTag) {
  const reply = await generate(modelId, {
    system: SYSTEM, prompt: judgePrompt(cfg, item, record.output, criteria), temperature: cfg.judge.temperature ?? 0, maxTokens: 1500, json: true,
    media: cfg.judge.include_media ? item.media : [],
    mock: () => mockJudge({ criteria, item, output: record.output, seed: `${record.recordId}|${modelId}|${seedTag}` }),
  });
  const parsed = extractJson(reply.text);
  if (!parsed.ok) return { scores: {}, problems: ['unparseable judge reply'], usage: reply.usage };
  return { ...validateJudgement(parsed.value, criteria, record.output), usage: reply.usage };
}

function judgeModels(cfg) {
  const j = cfg.judge;
  const list = j.models && j.models.length ? j.models : [j.provider === 'mock' ? `mock:${j.model}` : `${j.provider}:${j.model}`];
  return list;
}

/** Warn when a judge shares a provider family with a candidate (self-preference risk). */
function independenceWarnings(cfg, candidates) {
  const judgeProviders = new Set(judgeModels(cfg).map((m) => parseModelId(m).provider).filter((p) => p !== 'mock'));
  const candProviders = new Set(candidates.map((c) => parseModelId(levelId(c.choice.model)).provider));
  const shared = [...judgeProviders].filter((p) => candProviders.has(p));
  return shared.length ? [`LLM judge shares provider family (${shared.join(', ')}) with candidates; self-preference bias is possible. Use judge.models with two families or an independent judge.`] : [];
}

async function runJudge(cfg, { records, itemsById, onProgress = () => {} }) {
  const criteria = cfg.rubric.criteria || [];
  const result = {};
  if (!cfg.judge.enabled || !criteria.length) return { judgements: result, flags: [] };
  const models = judgeModels(cfg);
  const valid = records.filter((r) => r.ok);
  const rand = rng(`recheck-${cfg.run.seed}`);
  const recheck = new Set(valid.filter(() => rand() < cfg.judge.recheck_fraction).map((r) => r.recordId));
  let done = 0;
  await pool(valid, cfg.run.max_concurrency, async (r) => {
    const item = itemsById[r.itemId];
    const perModel = [];
    for (const m of models) {
      try { perModel.push(await judgeOnce(m, cfg, item, r, criteria, 'a')); } catch (e) { perModel.push({ scores: {}, problems: [`judge error: ${e.message}`] }); }
    }
    const scores = {}; const problems = perModel.flatMap((p) => p.problems);
    for (const c of criteria) {
      const vals = perModel.map((p) => p.scores[c.id]?.score).filter(Number.isFinite);
      if (vals.length) scores[c.id] = { score: vals.reduce((a, b) => a + b, 0) / vals.length, reason: perModel[0].scores[c.id]?.reason || '', evidence: perModel[0].scores[c.id]?.evidence || '', perJudge: vals };
    }
    let consistency = null;
    if (recheck.has(r.recordId)) {
      try {
        const again = await judgeOnce(models[0], cfg, item, r, criteria, 'b');
        const diffs = criteria.map((c) => Math.abs((again.scores[c.id]?.score ?? NaN) - (perModel[0].scores[c.id]?.score ?? NaN))).filter(Number.isFinite);
        const maxDiff = diffs.length ? Math.max(...diffs) : 0;
        consistency = { rechecked: true, maxDiff, consistent: maxDiff <= cfg.judge.consistency_tolerance };
        if (!consistency.consistent) problems.push(`inconsistent on re-score (max diff ${maxDiff})`);
      } catch (e) { problems.push(`re-score failed: ${e.message}`); }
    }
    result[r.recordId] = { scores, problems, consistency, flagged: problems.length > 0 };
    done++; onProgress(done, valid.length);
  });
  const flags = Object.entries(result).filter(([, j]) => j.flagged).map(([id, j]) => ({ recordId: id, reasons: j.problems }));
  return { judgements: result, flags, models };
}

module.exports = { runJudge, judgePrompt, rubricText, validateJudgement, independenceWarnings, judgeModels };
