---
title: Create your own taxonomy
description: Create a taxonomy with prompt and deterministic elements, reviewed evaluation data, and optimized prompt instructions.
---

This workflow keeps the taxonomy manifest, element definitions, evaluation
data, and ground truth as separate reviewable files.

## 1. Create the taxonomy manifest

```yaml
schema_version: scope/taxonomy/v1
id: example-taxonomy
version: 1.0.0
surfaces:
  - id: surface-cli
    label: CLI
elements:
  - path: elements/help-before-guessing.yaml
  - path: elements/command-discovered.yaml
```

The taxonomy identity, surfaces, digest, and element composition remain part of
every evaluation and optimization contract.

## 2. Add a prompt element

```yaml
id: help-before-guessing
label: Help before guessing
description: The agent checks authoritative CLI help before inventing options.
implementation:
  type: prompt
  prompt: Assess whether the trajectory checks relevant CLI help before guessing.
preconditions:
  requires_complete_trajectory: true
  requires_task: true
output:
  evidence_roles:
    call:
      type: atif.tool_call
      max: 1
      description: Help command invocation.
```

The top-level `description` remains fixed. Optimization may change only
`implementation.prompt`.

## 3. Add a deterministic handler

Use the public Taxonome plugin contract:

```ts
import { defineTaxonomePlugin } from "taxonomy-engine";
import { z } from "zod";

export default defineTaxonomePlugin({
  api_version: "scope/taxonome-plugin/v1",
  provider: { name: "example-taxonomy", version: "1.0.0" },
  handlers: {
    "example/command-discovered-v1": {
      configSchema: z.object({ command: z.string() }),
      evaluate(input, config) {
        const step = input.atif.steps.find((candidate) =>
          candidate.extra?.scope?.discoveries?.some((item) =>
            item.extension_point === config.command
          )
        );
        return step
          ? {
              state: "completed",
              observed: true,
              occurrences: [{
                evidence: [{
                  role: "discovery",
                  path: `$.steps[${input.atif.steps.indexOf(step)}].extra.scope.discoveries[0]`,
                }],
              }],
            }
          : { state: "completed", observed: false };
      },
    },
  },
});
```

Test handler configuration, positive/negative outcomes, and exact evidence
paths before using the plugin.

## 4. Prepare ground truth and splits

Ground truth is the reviewed expected assessment keyed by input ID and element
ID. It is not a dataset split.

- **Train** inputs drive GEPA instruction proposals.
- **Validation** inputs are disjoint and guide scoring and candidate selection.
- **Test** inputs are disjoint final unseen evaluation inputs.

Avoid family and originating-run leakage between Train and Validation.
Freeze the taxonomy, data, ground truth, optimizer settings, and seed before
the final Test comparison. Rehearse with separate development-only inputs; do
not tune instructions or labels from held-out Test outcomes.

## 5. Establish the baseline

```bash
taxonome eval --taxonomy taxonomy.yaml \
  --inputs "evaluation/*.jsonl" \
  --ground-truth "evaluation/*-ground-truth.json" \
  --split test
```

`PASS` means the detector matched the expected result for this test case—not
that the behavior occurred or the task succeeded.

## 6. Optimize prompt instructions

One prompt element:

```bash
taxonome optimize --taxonomy taxonomy.yaml \
  --inputs "evaluation/*.jsonl" \
  --ground-truth "evaluation/*-ground-truth.json" \
  --element help-before-guessing --output-dir optimized
```

Repeat `--element` for several prompt elements. Omit it to optimize every
prompt-backed element; deterministic elements are reported as skipped.
Optimization consumes Train and Validation only and uses `bootstrap: false`.
The interactive dashboard reports only Ax/GEPA signals that exist: active
phase, trial and candidate counts, consumed metric calls, latest and best
scores, Pareto frontier size, and the convergence or stop reason. There are no
synthetic completion percentages. Multi-element runs also keep stable rows for
running, completed, waiting, failed, and skipped elements.
It writes:

- `optimized/help-before-guessing.optimized.yaml`;
- `optimized/help-before-guessing.optimization.manifest.json`.

The YAML is the runtime input. The manifest is provenance only and contains no
complete ATIF, examples, demonstrations, or serialized runtime program.

## 7. Evaluate side by side

```bash
taxonome eval --taxonomy taxonomy.yaml \
  --element-override optimized/help-before-guessing.optimized.yaml \
  --inputs "evaluation/*.jsonl" \
  --ground-truth "evaluation/*-ground-truth.json" \
  --split test
```

Compare baseline and optimized-element evaluation on the same final Test
inputs only after candidate selection is frozen. Do not infer improvement
unless the measured results show it. `--element-override` leaves the authored
taxonomy unchanged, which makes the comparison reviewable.

## 8. Promote in place

```bash
taxonome optimize --taxonomy taxonomy.yaml \
  --from-candidate optimized/help-before-guessing.optimized.yaml \
  --in-place
git diff -- elements/help-before-guessing.yaml
```

In-place publication requires a writable local `{ path }` reference and writes
the exact selected candidate plus its matching provenance manifest
transactionally. It does not rerun the model. Normal `run` and `eval` then use
the promoted YAML without `--element-override`. Review the focused diff and
reject metadata-only, formatting-only, or unrelated changes.

Finish by generating a readout as described in [Using
Taxonome](/guides/taxonome/#build-a-readout).
