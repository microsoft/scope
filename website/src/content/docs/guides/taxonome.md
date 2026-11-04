---
title: Using Taxonome
description: Run the shipped Ax taxonomy on ATIF trajectories and build typed readouts.
---

Taxonome classifies recorded agent behavior from ATIF trajectories. The shipped
catalog is **ax-taxonomy** with portable semantic version **1.0.0**. In Scope,
its first immutable database revision is independently identified as
`ax-taxonomy@r1`.

For authoring, evaluation datasets, deterministic handlers, and optimization,
follow [Create your own taxonomy](/guides/create-taxonomy/).

## Run the shipped taxonomy

From a repository checkout with the Taxonome binary on `PATH`:

```bash
export TAXONOMY=packages/ax-taxonomy/taxonomy/taxonomy.yaml
taxonome run trajectory.atif.json --taxonomy "$TAXONOMY"
```

Taxonome validates and upcasts ATIF v1.6 and v1.7 into canonical v1.8 before
evaluation. Scope archives may contain one or many exact run roots:

```bash
export TAXONOMY=packages/ax-taxonomy/taxonomy/taxonomy.yaml
export OUT=taxonome-results
taxonome run submission.tar.gz --taxonomy "$TAXONOMY" \
  --output-dir "$OUT" --concurrency 4
```

Prompt elements initialize the isolated Copilot SDK transport only when their
preconditions require model evaluation. Deterministic elements never initialize
a model client.

## Interpret results

Each element returns one typed state:

- `completed` with `observed: true` and grounded occurrences;
- `completed` with `observed: false`, a valid negative result;
- `indeterminate` when required evidence is unavailable;
- `inapplicable` when the authored contract does not apply; or
- a runtime `failed` envelope.

Evidence contains role and absolute normalized-ATIF JSONPath references. A
reference is not an occurrence count: one occurrence can contain several
evidence references.

## Build a readout

Readout generation revalidates exact input identity and every evidence
reference:

```bash
export TAXONOMY=packages/ax-taxonomy/taxonomy/taxonomy.yaml
taxonome readout "taxonome-results/*.json" --taxonomy "$TAXONOMY" \
  --inputs submission.tar.gz --markdown taxonome-results/readout.md
```

See [CLI commands](/reference/taxonome-cli/), [taxonomy and result
format](/reference/taxonome-taxonomy/), and the generated
[Ax taxonomy catalog](/reference/taxonome-elements/).
