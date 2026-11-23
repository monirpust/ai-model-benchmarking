# Configuration reference

A benchmark is one YAML (or JSON) file. Relative dataset and media paths resolve against the file's folder. The two annotated examples are the best starting point:

- [`examples/question-generation/config.yaml`](../examples/question-generation/config.yaml)
- [`examples/ai-grading/config.yaml`](../examples/ai-grading/config.yaml)

## Sections

| Section | Required fields | Optional fields (defaults) |
| --- | --- | --- |
| `benchmark` | `id`, `decision` | `name`, `version`, `audience`, `owner` |
| `task` | `description` | — |
| `inputs` | `fields[]` (`name`, `type: text\|image\|audio`), `dataset` or `items` | `optional` per field; `strata`; `min_per_stratum` (2); `split: {by: source, test_fraction: 1.0, seed: 42}` |
| `output` | `schema` | `instructions` |
| `space` | `factors` with `model` | any other factors; `constraints[]`; `prefilter: {enabled: true, provider: mock, model, target_size: 10, guidance, require_available_providers}` |
| `prompts` | one template per `prompt` level (or `default`) | `system` |
| `run` | — | `repeats` (1), `seed` (42), `max_concurrency` (4), `retry_invalid` (1), `max_items`, `temperature`, `max_tokens` |
| `metrics` | `id`, `type` | see metric types |
| `rubric` | `criteria[]`: `id`, `description`, `scale: [min, max]` | `anchors: {level: text \| {description, example}}` |
| `judge` | — | `enabled` (true), `provider` (mock), `model`, `models[]`, `recheck_fraction` (0.2), `consistency_tolerance` (1), `include_reference`, `include_media`, `temperature`, `prompt` |
| `human` | — | `junior: {raters_per_item: 2, sample_fraction: 0.2, include_flagged: true, min_per_stratum: 1}`, `senior: {adjudicate: disagreements\|all, disagreement_threshold: 1}`, `agreement_threshold` (0.6), `show_reference` |
| `calibration` | — | `judge_human_threshold` (0.6), `metric_human_threshold` (0.5), `min_items` (8) |
| `aggregation` | — | `weights` (equal), `min_meaningful_gap` (0.05), `bootstrap_iterations` (1000), `cluster_by: source\|item`, `weight_perturbation` (0.1), `alpha` (0.05) |
| `pricing` | — | `"provider:model": {input, output}` USD per 1M tokens |

## Template variables

`{{<input field>}}`, `{{input.<field>}}`, `{{factors.<factor>}}` (a level's `text`, else its `id`), `{{strata.<name>}}`, `{{task}}`, `{{output_schema}}`, `{{output_instructions}}`.

## Factor levels

Plain values (`0.3`) or objects: `id` plus optional `description`, `tags`, `supports` (input types a model can read), `tier`, `text`, `recommended`, `discouraged`. Constraint example:

```yaml
constraints:
  - { if: { model: "compat:*" }, then_not: { input_mode: multimodal } }
```

Special factors used by the runner: `model` (required), `prompt`, `temperature`, `max_tokens`, `input_mode` (`text_only` drops media).

## Metric types

| Type | Options | Score in [0, 1] | Objective |
| --- | --- | --- | --- |
| `schema_valid` | — | 1 if output passed the schema | yes |
| `count` | `path`, `min`, `max` | 1 if array length in range | yes |
| `field_match` | `path`, `reference`, `case_sensitive` | share of values equal to / in reference | yes |
| `numeric_error` | `path`, `reference`, `scale` | 1 − normalised absolute error | yes |
| `within_tolerance` | `path`, `reference`, `tolerance` | 1 if abs error ≤ tolerance | yes |
| `qwk` | `path`, `reference`, `scale` | quadratic weighted kappa vs reference (candidate level) | yes |
| `grounding` | `path`, `against: [fields]` | share of output tokens found in inputs | needs validation |
| `distinct_ratio` | `path`, `threshold` (0.8) | 1 − near-duplicate share | needs validation |
| `length` | `path`, `range` or `scale` | 1 if word count in range | needs validation |
| `regex` | `path`, `pattern`, `flags` | share matching | needs validation |
| `enum_coverage` | `path`, `expected[]` | share of expected values present | needs validation |

Paths use dots and `[]` to map over arrays, for example `questions[].bloom_level`. Set `objective: true|false` on a metric to override the default.

## Dataset format (JSONL)

```json
{"id": "item-1", "source": "course-a", "strata": {"level": "year1"}, "input": {"content": "...", "diagram": "media/fig.png", "clip": "data:audio/wav;base64,..."}, "reference": {"score": 7}}
```

`source` is the clustering unit for the dev/test split and the bootstrap.
