'use strict';
// Layer 3: run every candidate on every test item (x repeats), enforce the
// fixed output schema, retry invalid outputs once, record provenance, blind.
const { generate, costOf } = require('../providers');
const { mockCandidateOutput } = require('../providers/mocksim');
const { renderTemplate, extractJson, pool, rng, shortHash, nowIso } = require('../util/core');
const { validate } = require('../util/jsonschema');
const { levelId } = require('../space/space');

function levelValue(level) {
  if (level && typeof level === 'object') return level.text ?? level.value ?? level.id;
  return level;
}

function promptFor(cfg, choice) {
  const pid = choice.prompt !== undefined ? levelId(choice.prompt) : 'default';
  return cfg.prompts[pid];
}

function buildRequest(cfg, choice, item) {
  const factors = Object.fromEntries(Object.entries(choice).map(([k, v]) => [k, levelValue(v)]));
  const vars = {
    ...item.input, input: item.input, strata: item.strata, factors,
    task: cfg.task.description,
    output_schema: JSON.stringify(cfg.output.schema, null, 2),
    output_instructions: cfg.output.instructions || 'Return only a JSON object that matches the output schema.',
  };
  const template = promptFor(cfg, choice);
  const prompt = renderTemplate(template, vars) + (template.includes('output_schema') ? '' : `\n\nReturn ONLY JSON matching this schema:\n${vars.output_schema}`);
  const system = cfg.prompts.system ? renderTemplate(cfg.prompts.system, vars) : undefined;
  const temperature = choice.temperature !== undefined ? Number(levelValue(choice.temperature)) : (cfg.run.temperature ?? 0);
  const maxTokens = choice.max_tokens !== undefined ? Number(levelValue(choice.max_tokens)) : (cfg.run.max_tokens ?? 1500);
  const useMedia = choice.input_mode === undefined || levelId(choice.input_mode) !== 'text_only';
  return { system, prompt, temperature, maxTokens, media: useMedia ? item.media : [] };
}

/** Assign each candidate a random blind code (e.g. "M-4F2A") and shuffle presentation order. */
function blindCodes(candidates, seed) {
  const rand = rng(`blind-${seed}`);
  const key = {}; const codes = {};
  for (const c of candidates) {
    let code;
    do { code = 'M-' + Math.floor(rand() * 0xffff).toString(16).toUpperCase().padStart(4, '0'); } while (key[code]);
    key[code] = c.id; codes[c.id] = code;
  }
  return { key, codes };
}

async function runGeneration(cfg, { candidates, items, onProgress = () => {}, shouldStop = () => false }) {
  const { key, codes } = blindCodes(candidates, cfg.run.seed);
  const jobs = [];
  for (const c of candidates) for (const it of items) for (let r = 0; r < cfg.run.repeats; r++) jobs.push({ c, it, r });
  const mockQuality = {};
  let done = 0;
  const records = await pool(jobs, cfg.run.max_concurrency, async ({ c, it, r }) => {
    if (shouldStop()) return null;
    const modelId = levelId(c.choice.model);
    const req = buildRequest(cfg, c.choice, it);
    const recordId = 'r_' + shortHash(`${c.id}|${it.id}|${r}`, 12);
    let attempts = 0; let last = null; let usage = { input: 0, output: 0 }; let latency = 0; let quality = null;
    const maxAttempts = 1 + (cfg.run.retry_invalid ?? 1);
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const reply = await generate(modelId, {
          ...req, seed: cfg.run.seed + r,
          mock: () => { const m = mockCandidateOutput({ item: it, cfg, choice: c.choice, repeat: r, attempt: attempts - 1 }); quality = m.quality; return m.text; },
        });
        usage = { input: usage.input + reply.usage.input, output: usage.output + reply.usage.output };
        latency += reply.latencyMs;
        const parsed = extractJson(reply.text);
        if (!parsed.ok) { last = { ok: false, error: `unparseable output: ${parsed.error}`, raw: reply.text }; continue; }
        const errs = validate(cfg.output.schema, parsed.value);
        if (errs.length) { last = { ok: false, error: `schema: ${errs.slice(0, 3).join('; ')}`, raw: reply.text, output: parsed.value }; continue; }
        last = { ok: true, output: parsed.value, raw: reply.text };
        break;
      } catch (e) {
        last = { ok: false, error: `provider error: ${e.message}` };
        if (/not set|Unknown provider|do not accept/.test(e.message)) break; // configuration errors: retrying will not help
      }
    }
    if (quality !== null) mockQuality[recordId] = last.ok ? quality : 0;
    done++;
    onProgress(done, jobs.length);
    return {
      recordId, candidateId: c.id, blind: codes[c.id], itemId: it.id, source: it.source, strata: it.strata, repeat: r,
      ok: last.ok, output: last.ok ? last.output : null, error: last.ok ? null : last.error,
      raw: last.raw ? String(last.raw).slice(0, 4000) : null,
      provenance: { model: modelId, configHash: cfg._hash, timestamp: nowIso(), attempts, latencyMs: latency, usage, costUsd: costOf(modelId, usage, cfg.pricing) },
    };
  });
  return { records: records.filter(Boolean), key, codes, mockQuality };
}

module.exports = { runGeneration, buildRequest, blindCodes, levelValue };
