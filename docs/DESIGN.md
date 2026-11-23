# GenBench design document v1.0

MSIB Research Group · 23 November 2026. Companion pages: [CODE_FLOW.md](CODE_FLOW.md) (architecture, run flow, module map) and [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) (every config field).

GenBench is an open-source Node.js framework and web application that runs a complete, reproducible AI benchmark from **one configuration file**. It implements the eight-layer Generalized Benchmarking Framework v2. This document freezes the design: any change to a decision below requires a new document version.

**Scope:** any task where AI models turn an input (text, image, audio or a mix) into a structured output that can be scored. Reference use cases: **question generation** and **AI grading**. **Out of scope for v1.0:** training or fine-tuning, production monitoring, multi-turn agent environments.

## 1. Locked-in decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | One YAML/JSON config defines a benchmark completely | The config is the spec (Layer 0); hashed and versioned |
| D2 | Inputs are typed fields (`text`, `image`, `audio`); any mix per item | Dynamic multimodal inputs without code changes |
| D3 | Outputs must match a JSON schema; invalid outputs retried once, then scored 0, never dropped | Standard outputs, honest failure accounting |
| D4 | Candidate space = Cartesian product of named factors; never enumerated | Millions of combinations stay tractable |
| D5 | An LLM pre-filter agent prunes the space to a target size before testing, with a rationale per factor | Cost control; auditable pruning |
| D6 | Three scoring lanes on the same blinded outputs: metrics, LLM judge, two-tier humans | Layers 4a, 4b, 4c |
| D7 | Junior judges rate a stratified sample plus all judge-flagged items; senior judges adjudicate every disagreement | Gold standard with explicit adjudication |
| D8 | No lane enters the ranking until calibration shows agreement with senior-adjudicated scores | Trust earned per criterion (Layer 5) |
| D9 | Fixed-scale normalisation, config weights only, cluster-bootstrap CIs, ties below the minimum meaningful gap | Defensible ranking (Layer 6) |
| D10 | Pluggable providers: OpenAI, Anthropic, Gemini, OpenAI-compatible, offline mock | Vendor neutrality; runs without keys |
| D11 | MIT licence, example configs, sample data, tests | Free public use |

## 2. Concepts

| Term | Meaning | Layer |
| --- | --- | --- |
| Item | One test unit: typed inputs, strata, source, optional reference | 1 |
| Stratum | Metadata used to balance sampling and report breakdowns | 1 |
| Factor / level | A named dimension of variation and its values | 2 |
| Candidate | One level per factor | 2 |
| Output record | One candidate's output for one item and repeat, with provenance and blind code | 3 |
| Junior / senior judge | Human raters; seniors adjudicate juniors | 4c |
| Score-source map | Per criterion, the lane whose score enters the ranking | 5 |

## 3. LLM-based pre-filtering

The question-generation example has 12 factors and **1,555,200** combinations. At 18 test items and 2 repeats, testing all of them would take about 56 million model calls before any judging. The pre-filter:

1. computes the exact space size (BigInt) without enumerating it; candidates are decoded by mixed-radix index;
2. sends the planner LLM the task description, decision, required modalities, factors with level metadata, target size and researcher guidance;
3. receives JSON with levels to keep, extra constraints and a rationale per factor (falls back to a deterministic heuristic planner if the reply is unusable);
4. restricts each factor to the kept levels and merges constraints;
5. selects the final candidates with a seeded, diversity-preserving sampler (round-robin across models);
6. shows the funnel, rationale and candidate table in the UI, where the researcher can untick candidates.

Safeguards: the agent never sees test data or results; every decision is stored with its rationale; original size, pruned size and final candidates are always reported.

## 4. Scoring lanes

**4a Metrics** (program, all outputs): objective metrics (schema, count, key match, numeric error, tolerance, QWK) always count; heuristic metrics (grounding, distinctness, length, regex, enum coverage) count only if calibration validates them.

**4b LLM judge** (all valid outputs): per-criterion integer score with reason and verbatim evidence; validation of range and evidence; re-score of a `recheck_fraction` sample; invalid or inconsistent judgements are flagged and sent to humans; optional two-family judge ensemble; warning when the judge shares a provider with a candidate.

**4c Two-tier humans:**

1. Stratified random sample of repeat-0 valid outputs, with stored inclusion probabilities, plus all flagged items (`inRandom: false`).
2. `raters_per_item` junior judges per item, blind to model, judge and each other; inputs shown with images and audio players; anchored rubric.
3. Disagreement when junior scores differ by at least `disagreement_threshold` on any criterion.
4. Senior judges see disputed items with junior scores and give the final score (optional access code).
5. Gold score = senior score, else the juniors' agreed score.
6. Every saved rating recomputes calibration, ranking and report.

## 5. Calibration and aggregation

Agreement uses only the random part of the human sample. See the gate table in [CODE_FLOW.md](CODE_FLOW.md#calibration-gates-layer-5). Until `min_items` gold items exist, everything is marked provisional.

Aggregation: normalise each component to [0, 1] on its fixed scale (failures 0); weight with `aggregation.weights` renormalised over surviving components; cluster bootstrap by source for 95% CIs; run-to-run SD across repeats; paired bootstrap leader-vs-each with Holm correction; tie when gap < `min_meaningful_gap` or not significant; weight perturbation ±`weight_perturbation`; cost and latency reported separately.

## 6. Use case 1: question generation

| Element | Specification |
| --- | --- |
| Decision | Which configuration should draft Bloom-aligned assessment questions from engineering course content, before teacher review? |
| Inputs | `content` (text), optional `diagram` (image), optional `lecture_audio` (audio) |
| Dataset | 24 passages, 12 modules, 4 subjects × 3 years; split by module, 18 test items |
| Output | `questions[]` (3–5) with `question`, `answer`, `bloom_level`, `difficulty` |
| Space | 12 factors, 1,555,200 combinations |
| Metrics | schema, count, Bloom target match, grounding, distinctness, well-formed |
| Rubric | relevance, clarity, answerability, Bloom alignment, difficulty (1–5, anchored) |

## 7. Use case 2: AI grading

| Element | Specification |
| --- | --- |
| Decision | Which configuration can propose marks and feedback close enough to teacher marks for a first pass? |
| Inputs | `question`, `rubric`, `student_answer`; optional `answer_image`, `oral_answer` |
| Dataset | 24 answers to 4 questions with teacher marks (0–10) |
| Output | `score` (0–10), `feedback`, `strengths[]`, `improvements[]` |
| Space | 12 factors, 1,036,800 combinations |
| Metrics | schema, QWK vs teacher, within one mark, absolute error, feedback length, feedback grounding |
| Rubric (feedback) | specificity, correctness, actionability, tone (1–5, anchored) |

Marks are checked objectively against the teacher key; judges and humans rate only the feedback.

**Pipeline checks** for both use cases were run with offline mock models and simulated raters. They confirm the pruning, tie detection, demotion, score-source fallback and loop-back paths work. They are **not** research results; real conclusions need real models and real teacher ratings.

## 8. Milestones

| Milestone | Status |
| --- | --- |
| Document and lock in ideas | Done |
| Polish draft document | Done |
| Generic, config-driven framework code | Done |
| Dynamic inputs, fixed outputs, configurable rubrics | Done |
| LLM-based space pre-filtering | Done |
| Two paper use cases | Done (mock validation) |
| Two-tier human evaluation | Done |
| Document and code flow | Done |
| Publish and open-source | Ready to push |
| Real-model runs with teacher raters | Next |

## 9. Known limitations

- Sample datasets are small and illustrative; paper studies need larger, consented datasets with more sources per stratum.
- Mock models and simulated raters validate the pipeline only.
- Audio support varies by provider; use `supports` and constraints.
- Raters are identified by name; deploy behind institutional login when identity matters.
