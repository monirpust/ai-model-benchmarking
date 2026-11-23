# GenBench code flow

The full design document lives in [DESIGN.md](DESIGN.md). This page shows the architecture and the flow of one run.

## Architecture

```mermaid
flowchart TB
  UI["Web UI<br/>public/app.js"] --> API["Express REST API<br/>server/server.js"]
  API --> R
  CLI["CLI<br/>bin/genbench.js"] --> R
  subgraph R["Runner · src/pipeline/runner.js"]
    L0["L0 Config loader"] --> L1["L1 Dataset"] --> L2["L2 Space + pre-filter"] --> L3["L3 Generate outputs"]
    L3 --> L4["L4 Metrics · LLM judge · humans"] --> L5["L5 Calibration"] --> L6["L6 Aggregation"] --> L7["L7 Report"]
  end
  R -- "pre-filter, generation, judge" --> P["Providers<br/>OpenAI · Anthropic · Gemini · OpenAI-compatible · mock"]
  R --> S[("Run store<br/>runs/&lt;runId&gt;/*.json")]
```

## One run

```mermaid
flowchart TB
  A["Load and validate config<br/>config/loader.js"] --> B["Freeze dataset<br/>data/dataset.js"]
  B --> C["Pre-filter the space<br/>space/prefilter.js<br/>millions → ~10"]
  C -.-> C2["Researcher reviews candidates<br/>(web UI)"]
  C --> D["Generate outputs<br/>pipeline/generate.js"]
  D --> E{"Schema valid?"}
  E -- no --> E2["Retry once, then score 0<br/>(kept, never dropped)"] --> D
  E -- yes --> F["Metrics + LLM judge<br/>lanes/metrics.js · lanes/judge.js"]
  F --> F2["Flag doubtful judgements"] --> G
  F --> G["Build human sample<br/>lanes/human.js"]
  G --> H["Junior judges rate<br/>(2 per item, blind)"]
  H --> I{"Juniors disagree?"}
  I -- yes --> J["Senior judge adjudicates"] --> K
  I -- no --> K["Recompute calibration + ranking<br/>calibration.js · aggregation.js<br/>(after every rating)"]
  K --> L["Report + repro package"]
```

## Calibration gates (Layer 5)

| Check | Statistic | If it fails |
| --- | --- | --- |
| Junior–junior agreement per criterion | Quadratic weighted kappa ≥ `human.agreement_threshold` | Loop-back **A**: rewrite unclear rubric anchors; judge used provisionally |
| Judge–gold agreement per criterion | Quadratic weighted kappa ≥ `calibration.judge_human_threshold` | Criterion scored from human gold; loop-back **B**: fix judge prompt/model |
| Heuristic metric vs gold | Spearman ρ ≥ `calibration.metric_human_threshold` | Metric demoted to diagnostic, removed from ranking |

## Module map

| Module | Responsibility |
| --- | --- |
| `src/config/loader.js` | Load YAML/JSON, defaults, validation, SHA-256 hash |
| `src/data/dataset.js` | Items, image/audio to base64, strata, split by source, dataset hash |
| `src/space/space.js` | Space size, mixed-radix decoding, constraints, seeded sampling |
| `src/space/prefilter.js` | LLM planner, heuristic fallback, diversity-preserving selection |
| `src/providers/index.js` | OpenAI, Anthropic, Gemini, OpenAI-compatible, mock; cost |
| `src/providers/mocksim.js` | Offline models, heuristic judge, simulated raters (demo only) |
| `src/pipeline/generate.js` | Prompts, calls, JSON extraction, schema, retry, provenance, blinding |
| `src/lanes/metrics.js` | Item- and candidate-level metrics |
| `src/lanes/judge.js` | Judge prompt, validation, consistency re-score, flags |
| `src/lanes/human.js` | Sampling with inclusion probabilities, junior/senior queues, gold scores |
| `src/pipeline/calibration.js` | Agreement, score-source map, demotion, bias checks |
| `src/pipeline/aggregation.js` | Normalisation, weights, cluster bootstrap, Holm, ties, sensitivity |
| `src/pipeline/runner.js` | Orchestration, report, repro package |
| `server/server.js` | REST API |
| `public/app.js` | Front-end |
