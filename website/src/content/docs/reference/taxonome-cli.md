---
title: Taxonome CLI commands
description: Command and option reference for run, eval, optimize, and readout.
---

Taxonome exposes four commands:

| Command | Purpose |
|---|---|
| `taxonome run` | Evaluate plain ATIF or Scope archives. |
| `taxonome eval` | Compare assessments with reviewed ground truth. |
| `taxonome optimize` | Optimize one, several, or every prompt instruction. |
| `taxonome readout` | Aggregate exact results with revalidated evidence. |

Every command requiring taxonomy context uses `--taxonomy <path>`.

## Common run and eval options

- `--plugin <specifier>`: repeatable trusted deterministic plugin.
- `--model <id>`: exact Copilot model.
- `--element-override <path>`: repeatable complete standard element YAML.
- `--json`: ANSI-free machine output.

Overrides replace exact element IDs before validation and digest calculation.
The optimization manifest is never a runtime dependency.

## Evaluation

`eval --split` accepts `train`, `validation`, `test`, or `all`. Inputs are
repeatable JSONL files/globs with stable disjoint IDs. Ground-truth JSON is
keyed by input ID and element ID.

## Optimization

Choose exactly one publication mode:

- `--output-dir <dir>` refuses to overwrite candidate files;
- `--in-place` atomically replaces writable local path-referenced elements.

`--element <id>` is repeatable and optional. Explicit deterministic, unknown,
or duplicate IDs fail before model initialization. Omission selects all prompt
elements and reports deterministic elements as skipped. `--max-metric-calls`
is a per-element search setting.

Optimization uses Train and Validation inputs only. Final Test evaluation is a
separate `eval --split test` command.
