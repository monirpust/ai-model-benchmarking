# Contributing to GenBench

Thanks for helping. GenBench aims to make AI benchmarking rigorous and reproducible.

1. Open an issue describing the change (new metric type, provider, use case, bug).
2. Fork, create a branch, and keep changes focused.
3. Run `npm test` and both example configs (`node bin/genbench.js run examples/<name>/config.yaml --simulate-humans`).
4. Add tests for new behaviour under `test/`.
5. Open a pull request explaining which framework layer the change touches.

**Adding a metric:** implement it in `src/lanes/metrics.js` (`itemMetric` or `candidateMetric`), add its type to `METRIC_TYPES` in `src/config/loader.js`, and document it in `docs/CONFIG_REFERENCE.md`.

**Adding a provider:** add an adapter in `src/providers/index.js` that returns `{ text, usage, latencyMs }`, or call `registerProvider()` from your own code.

**Adding a use case:** create `examples/<name>/config.yaml` and `data/items.jsonl`. Keep the data licensed for redistribution.
