---
title: Taxonome deterministic handlers
description: Shipped handler IDs and the public plugin contract.
---

The shipped Ax taxonomy registers three reviewed deterministic handlers:

| Handler | Element | Evidence boundary |
|---|---|---|
| `scope/discovered-v1` | Discovered | Recorded `extra.scope.discoveries` only. |
| `scope/malformed-invocation-v1` | Malformed Invocation | Explicit input-validation issues only. |
| `scope/timeout-v1` | Timeout | Explicit timeout evidence or reliable timing under authored policy. |

External plugins use `scope/taxonome-plugin/v1` and export provider metadata
plus a map of stable handler IDs to `{ configSchema, evaluate }`. External
plugins cannot register the reserved `scope/` namespace.

See [Create your own taxonomy](/guides/create-taxonomy/#3-add-a-deterministic-handler)
for an authored handler and test workflow.
