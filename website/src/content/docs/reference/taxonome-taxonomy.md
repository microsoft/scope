---
title: Taxonome taxonomy and result format
description: Portable taxonomy, element, assessment, evidence, and revision contracts.
---

Taxonome YAML uses `schema_version: scope/taxonomy/v1`. A root defines a
portable business `id`, semantic `version`, source `surfaces`, and ordered
elements. Elements may be embedded or referenced by safe relative `{ path }`.

Scope stores the portable content directly in immutable database revisions.
Portable semantic version and Scope revision are independent: the shipped
`ax-taxonomy` content is version `1.0.0`, while its first Scope revision is
`ax-taxonomy@r1`.

Prompt implementations contain only:

```yaml
implementation:
  type: prompt
  prompt: Assess the recorded behavior.
```

Deterministic implementations use a registered handler ID and optional config.
Preconditions decide when sufficient evidence exists. Output contracts define
typed evidence roles and structural constraints.

Evaluations bind the exact taxonomy ID/version/digest, element identity,
normalized input SHA, implementation provenance, attempts, and either a
validated assessment or engine-owned failure.

See the normative [Trajectory Taxonomy
Format](https://github.com/microsoft/scope/blob/main/docs/architecture/trajectory-taxonomy-format.md).
