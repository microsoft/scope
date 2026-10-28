# Trajectory Taxonomy Format conformance fixtures

These language-neutral fixtures implement the matrix in
`docs/architecture/trajectory-taxonomy-format.md`.

- `valid/taxonomy.yaml` supplies role and constraint contracts.
- `valid/atif-v17.json` and `valid/atif-v18-mixed-media.json` exercise the
  supported ATIF versions and Scope extension types.
- Assessment fixtures contain `{element_id, assessment}`.
- Invalid fixtures name the expected stable validation code.
- `fingerprints.json` contains canonical JSON and normalized-ATIF known-answer
  vectors.

Production tests load these files through the public taxonomy, ATIF, canonical
JSON, JSONPath, and assessment validators.

The committed acceptance matrices live in:

- `src/evidence-constraints.test.ts` for table-driven `after`,
  `descendant_of`, `owned_by`, stale authoring, axes, and digest behavior.
- `src/evidence-roles.test.ts` for authoring/cardinality, occurrence isolation,
  path failures, exhaustive positive/wrong-location coverage for every
  exported shared evidence type, and every distinct expected/actual registered
  type mismatch pair.
