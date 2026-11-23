# GenBench

**Configuration-driven AI benchmarking with LLM pre-filtering, LLM judges and two-tier human evaluation.**

GenBench runs a complete, reproducible benchmark of AI models from **one YAML file**. It implements the eight layers of the *Generalized Benchmarking Framework v2*:

| Layer | What GenBench does |
| --- | --- |
| 0 Spec | Validates and hashes the config: decision, task, rubric, thresholds |
| 1 Inputs | Typed input fields (`text`, `image`, `audio`), strata, dev/test split **by source**, dataset hash |
| 2 Candidates | Factor space (often millions of combinations) pruned by an **LLM pre-filter agent** to a small, relevant set, with a written rationale |
| 3 Outputs | Every candidate × every test item × repeats; fixed JSON output schema; one retry; failures scored 0; blinding |
| 4a Metrics | Program checks on 100% of outputs (schema, counts, key match, grounding, diversity, numeric error, QWK, regex…) |
| 4b LLM judge | Per-criterion rubric scores with reason and evidence; re-score sample; inconsistent items flagged |
| 4c Humans | **Junior judges** rate a stratified sample plus all flagged items; **senior judges** adjudicate every disagreement |
| 5 Calibration | Human–human, judge–human and metric–human agreement decide the score source per criterion; weak metrics demoted |
| 6 Aggregation | Fixed-scale normalisation, spec weights, cluster-bootstrap CIs, Holm-corrected tests, ties, weight sensitivity, cost |
| 7 Results | Leaderboard, strata breakdowns, error analysis, verdict, reproducibility package |

It ships with two research use cases: **question generation** from course content and **AI grading** of short answers.

## Quick start

```bash
git clone https://github.com/monirpust/ai-model-benchmarking.git && cd ai-model-benchmarking
npm install
npm start                    # http://localhost:3000
```

Everything runs offline with deterministic `mock:` models, so you can try the full pipeline without API keys. To use real models, copy `.env.example` to `.env` and add keys.

Command line:

```bash
node bin/genbench.js validate  examples/question-generation/config.yaml
node bin/genbench.js space     examples/question-generation/config.yaml   # 1,555,200 combinations
node bin/genbench.js prefilter examples/question-generation/config.yaml --target 10
node bin/genbench.js run       examples/ai-grading/config.yaml --simulate-humans
npm test
```

`--simulate-humans` adds clearly marked **simulated** ratings for demos. Never report them as human evaluation.

## Providers

Models are written `provider:model`:

| Provider | Example | Env variable | Inputs |
| --- | --- | --- | --- |
| OpenAI | `openai:gpt-4o-mini` | `OPENAI_API_KEY` | text, image, audio* |
| Anthropic | `anthropic:claude-sonnet-4-5` | `ANTHROPIC_API_KEY` | text, image |
| Google Gemini | `gemini:gemini-2.5-flash` | `GEMINI_API_KEY` | text, image, audio |
| OpenAI-compatible (Ollama, vLLM, LM Studio…) | `compat:llama3.1` | `OPENAI_COMPAT_BASE_URL` | per model |
| Offline mock | `mock:strong`, `mock:medium`, `mock:weak` | none | all |

\*Audio input depends on the OpenAI model. Declare each model's `supports:` list in the config so the pre-filter can drop incompatible models. Add your own provider with `registerProvider(name, fn)`.

## Writing a benchmark

A config has these sections (see `docs/CONFIG_REFERENCE.md` and the two examples):

```yaml
benchmark: { id, name, version, decision }   # Layer 0
task: { description }                         # read by the pre-filter agent and the judge
inputs: { fields: [{name, type: text|image|audio, optional}], dataset, strata, split }
output: { schema: <JSON schema> }             # fixed output structure
space:
  factors: { model: [...], prompt: [...], temperature: [...], <any factor>: [...] }
  constraints: [ { if: {...}, then_not: {...} } ]
  prefilter: { provider, model, target_size, guidance }
prompts: { <prompt id>: "template with {{content}} {{factors.x}} {{output_schema}}" }
metrics: [ { id, type, path, reference, ... } ]
rubric: { criteria: [ { id, description, scale: [1,5], anchors: {...} } ] }
judge: { provider, model, recheck_fraction }
human: { junior: {...}, senior: {...}, agreement_threshold }
calibration: { judge_human_threshold, metric_human_threshold, min_items }
aggregation: { weights, min_meaningful_gap, bootstrap_iterations, cluster_by }
```

Dataset items are JSON lines:

```json
{"id": "q1", "source": "course-a", "strata": {"level": "year1"}, "input": {"content": "...", "diagram": "media/fig.png"}, "reference": {"score": 7}}
```

## Human evaluation

Open **Human evaluation** in the web app, choose *Junior judge* or *Senior judge*, and enter your name. Juniors see the input, the blinded output and the anchored rubric. Seniors also see junior scores, with disagreements highlighted. Set `GENBENCH_SENIOR_CODE` to require an access code for senior judges. Every rating triggers recalibration and re-ranking.

## Project layout

```
bin/genbench.js          CLI
server/server.js         Express REST API + static front-end
public/                  plain-JavaScript single-page app
src/config/loader.js     Layer 0: load, default, validate, hash
src/data/dataset.js      Layer 1: typed inputs, media, split by source
src/space/space.js       Layer 2: factor space, mixed-radix indexing, constraints
src/space/prefilter.js   Layer 2: LLM pre-filter agent
src/pipeline/generate.js Layer 3: outputs, schema, retry, blinding
src/lanes/metrics.js     Layer 4a
src/lanes/judge.js       Layer 4b
src/lanes/human.js       Layer 4c (junior/senior)
src/pipeline/calibration.js  Layer 5
src/pipeline/aggregation.js  Layer 6
src/pipeline/runner.js   orchestration, report (Layer 7), repro package
src/providers/           OpenAI, Anthropic, Gemini, OpenAI-compatible, mock
examples/                question-generation, ai-grading
docs/                    design document, code flow, config reference
```

Runs are stored as plain JSON under `runs/<runId>/`.

## Deploy

```bash
docker build -t genbench . && docker run -p 3000:3000 --env-file .env genbench
```

Any Node.js 18+ host (Render, Railway, Fly.io, a VM) works with `npm start`. Mount `runs/` on persistent storage.

## Citing

If you use GenBench in research, please cite the accompanying paper (MSIB Research Group, 2026) and link this repository.

## Licence

MIT. See `LICENSE`.
