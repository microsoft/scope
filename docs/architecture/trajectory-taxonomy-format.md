# Trajectory Taxonomy Format

## Status and conformance

This document is the normative, implementer-facing specification for the
experimental Trajectory Taxonomy Format used by Taxonome. It defines taxonomy
authoring, assessment production, evidence references, exact-input binding,
evaluation envelopes, and downstream reporting independently of TypeScript,
Ax, the GitHub Copilot SDK, or the Taxonome CLI.

The active identifiers remain:

| Contract | Identifier |
|---|---|
| Taxonomy authoring | `scope/taxonomy/v1` |
| Evaluation envelope | `scope/taxonomy-evaluation/v1` |
| Readout report | `scope/taxonomy-readout/v1` |
| Plugin API | `scope/taxonome-plugin/v1` |
| Optimized prompt artifact | `scope/taxonome-ax/v2` |

These identifiers describe an unreleased experimental stack. Implementations
MUST validate structure and contract hashes rather than treating an identifier
match as proof that an older draft shape is compatible.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are normative.

- An **author** writes a taxonomy and its elements.
- A **producer** or **classifier** emits an assessment for one element and one
  normalized ATIF document.
- A **validating engine** loads the taxonomy, normalizes ATIF, resolves evidence,
  validates assessments, and creates evaluation envelopes.
- A **consumer** revalidates exact-input binding and evidence before reporting.

A conforming implementation can load and validate the fixtures under
`packages/taxonomy-engine/conformance/trajectory-taxonomy-format/` without
Taxonome source code. Conformance has four independent levels:

1. **Authoring conformance**: taxonomy fields, defaults, digests, and role
   contracts are implemented exactly.
2. **Producer conformance**: emitted assessments use the shared closed schema
   and only declared evidence roles.
3. **Resolver conformance**: definite JSONPaths canonicalize, resolve, type,
   and relate nodes exactly as specified.
4. **Consumer conformance**: evaluation identity, failures, coverage, and
   occurrence counting are revalidated rather than trusted.

Taxonome's CLI, multi-run files, resume behavior, and text-only provider are an
implementation profile described later. They are not required dependencies for
the core format.

## Taxonomy authoring

### Root document

A taxonomy is YAML representing this closed object:

```yaml
schema_version: scope/taxonomy/v1
id: agent-behavior
version: 3.0.0
surfaces:
  - id: surface-mcp
    label: MCP
    description: Optional author-facing description.
elements:
  - path: elements/discovered.yaml
```

| Field | Requirement |
|---|---|
| `schema_version` | MUST equal `scope/taxonomy/v1`. |
| `id` | Required; `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. |
| `version` | Required semantic version string. |
| `surfaces` | Required array, at most 100; IDs MUST be unique. |
| `elements` | Required nonempty array, at most 200; inline elements or `{path}` references. |

A surface is a closed object containing required nonempty `id` and `label`,
plus optional nonempty `description`.

An element reference is exactly `{path: string}`. A path is resolved relative
to the taxonomy manifest. Absolute paths, `..`, symlinks, duplicate references,
cycles, and paths escaping the manifest directory MUST be rejected.

### Element document

An element is this closed object:

```yaml
schema_version: scope/taxonomy/v1 # optional when inherited
id: beh-content-misused
label: Content Misused
description: Optional longer description.
category_id: behavior-category-invocation
implementation:
  type: prompt
  prompt: Assess whether returned content was later misused.
preconditions:
  requires_recorded_discovery: false
  requires_complete_trajectory: true
  requires_task: true
output:
  evidence_roles:
    returned_content:
      type: atif.observation_result
      max: 1
      description: Content returned by the invoked action.
    misuse:
      type: atif.step
      description: Later agent behavior that misuses the returned content.
  constraints:
    - kind: after
      role: misuse
      reference_role: returned_content
      within: $.steps
```

Required fields are `id`, `label`, `implementation`, and `output`.
`description`, `category_id`, and `preconditions` are optional. An element-local
`schema_version`, when present, MUST equal the root version. Element IDs MUST be
unique after references are expanded.

`implementation` is one of these closed shapes:

```yaml
type: prompt
prompt: Nonempty classifier instructions.
```

```yaml
type: deterministic
handler: scope/timeout-v1
config: {} # optional, validated by the selected handler
```

`preconditions` is closed and contains these booleans, each defaulting to
`false`:

| Field | Meaning |
|---|---|
| `requires_recorded_discovery` | For an otherwise eligible prompt element on a complete trajectory, zero recorded `scope.discovery` events returns completed `observed:false` without model execution. Partial/unknown trajectories and deterministic elements are exempt from this shortcut. |
| `requires_complete_trajectory` | A partial or unknown trajectory blocks the entire element evaluation and returns `indeterminate` before task/discovery checks or classifier execution. Missing trajectory state defaults to complete. |
| `requires_task` | Task-context presence is required to assess relevance. Taxonome currently treats `extra.scope.task` or any nonempty user-step message text as task context. This is a presence heuristic, not a Scope Task ID lookup or semantic task extraction. |

An authored `output_schema` field is invalid and MUST produce an actionable
diagnostic directing the author to `output.evidence_roles`.
An authored element-level `evidence` field is obsolete and MUST direct the
author to `preconditions`. This rename does not affect occurrence `evidence`,
`output.evidence_roles`, evidence references/types, or ATIF evidence fields.
The obsolete keys `complete_for_negative` and `requires_discovery_event` are
rejected in favor of `requires_complete_trajectory` and
`requires_recorded_discovery`; there are no runtime aliases.

Taxonome's pure implementation is intentionally discoverable under
`packages/taxonomy-engine/src/preconditions/`: `schema.ts`, ordered
`evaluate.ts`, and one file per flag:
`requires-complete-trajectory.ts`, `requires-task.ts`, and
`requires-recorded-discovery.ts`.

### YAML safety

Implementations MUST reject duplicate keys, aliases, anchors, executable tags,
and non-JSON values. One file is limited to 1 MiB, expanded taxonomy YAML to
4 MiB, and referenced element files to 100 in the Taxonome profile.

Unknown fields in every taxonomy-owned object MUST be rejected. Extension data
belongs in ATIF `extra` objects, not arbitrary taxonomy fields.

## Shared assessment

Every element uses this one closed assessment union:

```ts
type Assessment =
  | {
      state: "completed";
      observed: true;
      occurrences: Occurrence[];
    }
  | {
      state: "completed";
      observed: false;
    }
  | {
      state: "indeterminate" | "inapplicable";
      reason: string;
    };

interface Occurrence {
  evidence: EvidenceReference[];
}

interface EvidenceReference {
  role: string;
  path: string;
}
```

Rules:

- A positive assessment MUST have at least one occurrence.
- Every occurrence MUST have at least one evidence reference.
- `reason`, role names, and paths MUST be nonempty strings.
- All objects reject undeclared properties.
- Completed-negative assessments have only `state` and `observed`.
- Indeterminate/inapplicable assessments have only `state` and `reason`.
- A producer MUST NOT emit confidence, rationale, diagnostics, copied source
  objects, duplicated issue payloads, arbitrary details, or execution errors.
- `occurrences` count distinct semantic findings. Multiple references inside
  one occurrence remain one finding.

Two discoveries in one step are two occurrences when the element considers
them distinct findings. One misuse finding with a returned result and three
later steps is one occurrence containing four references.

Machine-readable schemas are exported from `taxonomy-engine`; the conformance
fixtures use those exports rather than a second evaluation-only schema.

## Evidence roles

`output.evidence_roles` is a nonempty object keyed by role name. Role names use
`/^[A-Za-z][A-Za-z0-9_]*$/` and MUST be unique.

Each role is a closed object:

| Field | Requirement |
|---|---|
| `type` | Required shared type ID from the registry below. |
| `description` | Required nonempty author-facing text. |
| `min` | Optional nonnegative integer; defaults to `1`. |
| `max` | Optional nonnegative integer; omitted means unbounded within shared limits. |

`max` MUST be greater than or equal to normalized `min`. Per occurrence, a role
must appear between `min` and `max` times. Duplicate role/path pairs after path
canonicalization are invalid and cannot satisfy cardinality more than once.
Unknown roles and unknown type IDs are invalid. A positive occurrence still
requires nonempty evidence when all declared roles have `min: 0`.

The Taxonome profile limits an assessment to 100 occurrences, 100 references
per occurrence, and 1,000 references total.

### Constraints

`output.constraints` is optional and defaults to `[]`. Constraints assert
structure between resolved evidence references; they do not classify behavior.
They are evaluated per occurrence after role cardinality, JSONPath resolution,
and type validation. If the target `role` has no references, the constraint is
skipped. For `owned_by` and `descendant_of`, every present target requires at
least one matching owner/ancestor even when that reference role has `min: 0`;
zero references therefore fails. For `after`, comparison is the all-pairs
quantifier and is vacuously satisfied when its optional reference role is
absent. Role cardinality independently determines whether absence is allowed.

The constraint language contains exactly these closed shapes:

```yaml
- kind: owned_by
  role: issue
  owner_role: call
```

For `owned_by`, every reference using `role` MUST resolve to a node whose
owning tool-call canonical path equals one reference using `owner_role` in the
same occurrence. The `role` target type MUST expose tool-call ownership. The
`owner_role` target type MUST be `atif.tool_call`.

```yaml
- kind: after
  role: misuse
  reference_role: returned_content
  within: $.steps
```

For `after`, `within` is a definite JSONPath that MUST resolve to an array.
The loader canonicalizes `within` using the JSONPath rules below before
taxonomy/prompt/artifact/resume hashing.
Every target and reference path MUST be strictly below that axis and its first
selector after the axis MUST be an array index. That immediate child index is
the comparison value. Every `role` index MUST be strictly greater than every
`reference_role` index. Equal indices fail. The algorithm does not inspect
ATIF step metadata, JSON values, object-member order, timestamps, or type-
specific ownership. It works for any typed evidence nodes nested below the
selected array, including arrays other than `$.steps`. Missing, unresolved, or
non-array axes and references outside the axis fail the constraint.

```yaml
- kind: descendant_of
  role: issue
  reference_role: call
```

For `descendant_of`, every `role` path MUST be a strict selector-sequence
descendant of at least one `reference_role` path. The target sequence must be
longer and begin with every selector of the ancestor sequence. Self-reference
and unrelated paths fail. Selectors are compared structurally, so array index
`1` is not a textual prefix of index `10`.

Unknown constraint kinds or fields are rejected. The obsolete
`output.relationships` and `step_after` shapes are rejected with explicit
migration guidance. This is the complete constraint language; implementations
MUST NOT evaluate arbitrary taxonomy
expressions.

Type and constraint validity establish grounded structure, not predicate
truth. The prompt or deterministic handler remains responsible for deciding
whether the evidence semantically proves the behavior.

## Evaluation envelope and execution failure

The engine creates one of these closed envelope variants:

```ts
type Evaluation =
  | {
      schema_version: "scope/taxonomy-evaluation/v1";
      taxonomy: { id: string; version: string; digest: string };
      element: { id: string; label: string; category_id?: string };
      implementation: {
        type: "prompt" | "deterministic";
        handler?: string;
        provider?: object;
        attempts: AttemptProvenance[];
      };
      input: InputIdentity;
      status: "succeeded";
      result: Assessment;
    }
  | {
      // same schema_version, taxonomy, element, implementation, input
      status: "failed";
      error: EvaluationError;
    };
```

`status` describes engine execution. A successful completed-negative,
indeterminate, or inapplicable assessment uses `status: "succeeded"`.
Classifier output never sets `status` and never creates `error`.

`EvaluationError` is:

```ts
interface EvaluationError {
  code: string;
  message: string;
  validation_errors?: ValidationDiagnostic[];
  source_locations?: Array<{
    normalized_path: string;
    original_path: string;
    file?: string;
    archive_entry?: string;
    jsonl_line?: number;
    generated_by?: string;
  }>;
}
```

Stable error codes include `execution_failed`, `cancelled`, `invalid_output`,
and `invalid_input_binding`. Messages and diagnostics are bounded and
redacted. A failed evaluation has no `result`; a succeeded evaluation has no
`error`. `validation_errors` remain normalized producer/correction diagnostics.
`source_locations`, when available, are consumer-facing provenance for those
same evidence paths and are never sent back as model-authored paths.
Syntactically invalid result paths remain `invalid_jsonpath` diagnostics:
consumers attach the original input locator/container without attempting to
resolve the invalid query through the source map.

`ValidationDiagnostic` is a closed object with required `code` and
`output_path`, plus optional `role`, `evidence_path`, `expected_type`,
`actual_type`, and bounded `message`. Stable validation codes are:

- `invalid_json`
- `schema_mismatch`
- `unknown_role`
- `role_cardinality`
- `duplicate_reference`
- `invalid_jsonpath`
- `unresolved_reference`
- `reference_type_mismatch`
- `reference_constraint_mismatch`

`output_path` points into the produced assessment. `evidence_path` points into
normalized ATIF. No diagnostic contains an unbounded candidate, tool response,
credential, or media payload.

Attempt provenance records engine orchestration only:

```ts
interface AttemptProvenance {
  attempt: 1 | 2;
  kind: "initial" | "repair";
  outcome: "succeeded" | "invalid_output" | "execution_failed" | "cancelled";
}
```

Raw model candidates are not persisted by default.

## ATIF binding and type registry

### Supported input versions

The core evidence input is an official ATIF `Trajectory` declaring
`ATIF-v1.6`, `ATIF-v1.7`, or `ATIF-v1.8`. Taxonome accepts either the trajectory
object or a root array containing exactly one trajectory object. Empty,
multi-item, nested, null, and primitive root arrays are invalid. Taxonome also
supports the closed `scope.atif-extension.v1` objects documented below.

Each source document MUST validate against its declared historical schema
before conversion. Taxonome then applies only adjacent, pure upcasters
(`v1.6-to-v1.7`, then `v1.7-to-v1.8`) and validates the target after every hop.
The canonical in-memory evidence document is always `ATIF-v1.8`. Invalid
historical content is rejected rather than repaired under a newer schema.

The upstream definitions reviewed for this contract are Harbor revision
`e77a18bfeed53f907f335b9132d87006e01b3dfd`:

- [ATIF RFC](https://github.com/harbor-framework/harbor/blob/e77a18bfeed53f907f335b9132d87006e01b3dfd/rfcs/0001-trajectory-format.md)
- [ContentPart, ImageSource, AudioSource](https://github.com/harbor-framework/harbor/blob/e77a18bfeed53f907f335b9132d87006e01b3dfd/src/harbor/models/trajectories/content.py)
- [Observation](https://github.com/harbor-framework/harbor/blob/e77a18bfeed53f907f335b9132d87006e01b3dfd/src/harbor/models/trajectories/observation.py)
- [ObservationResult](https://github.com/harbor-framework/harbor/blob/e77a18bfeed53f907f335b9132d87006e01b3dfd/src/harbor/models/trajectories/observation_result.py)

ATIF v1.6 and v1.7 accept text and image content parts. ATIF v1.8 additionally
accepts audio. `ContentPart` uses discriminator `type`, never `kind`:

```json
{"type":"text","text":"hello"}
{"type":"image","source":{"media_type":"image/png","path":"images/a.png"}}
{"type":"audio","source":{"media_type":"audio/mpeg","path":"audio/a.mp3","duration_sec":1.5}}
```

Text parts require `text`; their inactive `source` field may be absent or
`null`. Image/audio parts require `source`; their inactive `text` field may be
absent or `null`. Image media types are `image/jpeg`, `image/png`, `image/gif`,
and `image/webp`. Canonical audio media types are:

`audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`,
`audio/flac`, `audio/webm`, and `audio/aiff`.

These aliases normalize before hashing:

| Input alias | Canonical value |
|---|---|
| `audio/mp3`, `audio/mpga`, `audio/x-mpeg` | `audio/mpeg` |
| `audio/x-wav`, `audio/wave`, `audio/vnd.wave` | `audio/wav` |
| `audio/x-m4a`, `audio/m4a` | `audio/mp4` |
| `audio/x-aac` | `audio/aac` |
| `audio/x-flac` | `audio/flac` |
| `audio/x-aiff` | `audio/aiff` |

Step `message` and observation-result `content` preserve their original string
or content-part-array form and array positions. Implementations MUST NOT create
synthetic text parts or flatten arrays.

All versions require `agent.version`, object-valued tool-call arguments,
strictly increasing step IDs, and version-legal fields. Observation content is
a string, valid content-part array, `null`, or absent; arbitrary object,
number, and boolean content is invalid. The earlier Scope compatibility lane
for missing versions and arbitrary JSON content no longer exists.

Scope metadata MUST remain under legal `extra.scope` slots. Root and step
`extra` are legal in v1.6; tool-call and observation-result `extra` begin in
v1.7. Other valid vendor namespaces under `extra` survive upcasting. Upcasters
do not invent required IDs, evidence, calls, or results.

`Observation` is the container at `step.observation`.
`ObservationResult` is one item in `observation.results`; it can omit
`source_call_id`, content, or both, and can carry delegated-trajectory
references. Embedded v1.7/v1.8 child trajectories validate recursively and
require unique `trajectory_id` values. Explicit external file references remain
references and are not fetched. A v1.6 session-only subagent reference that
cannot identify an unambiguous trajectory fails at its original source path.
Child trajectories are never flattened or traversed as parent evidence.

`trajectory_id` is the document identifier when present. `session_id` is
run-scoped, optional in v1.7+, and MUST NOT be treated as document-unique.

### Shared type registry

Types are recognized by structural location **and** runtime schema:

| Type ID | Required canonical location | Ownership |
|---|---|---|
| `atif.step` | `$.steps[i]` | step `i` |
| `atif.tool_call` | `$.steps[i].tool_calls[j]` | step `i`, call itself |
| `atif.observation` | `$.steps[i].observation` | step `i` |
| `atif.observation_result` | `$.steps[i].observation.results[j]` | step `i`; owning call when `source_call_id` resolves |
| `atif.content_part` | `$.steps[i].message[j]` or `$.steps[i].observation.results[j].content[k]` | enclosing step/result/call |
| `atif.image_source` | `.source` of an image content part | inherited |
| `atif.audio_source` | `.source` of an audio content part; v1.8 only | inherited |
| `scope.discovery` | `$.steps[i].extra.scope.discoveries[j]` | step `i` |
| `scope.input_validation_issue` | `$.steps[i].tool_calls[j].extra.scope.input_validation.issues[k]` where status is `invalid` | step `i`, call `j` |

A lookalike object elsewhere has no registry type. A null value can resolve as
a JSON node but cannot satisfy any registered type.

A typed resolution returns the canonical path, node, type, owning step path and
array index, owning call path when applicable, and archive-origin metadata when
present. This index is computed from ATIF and is never emitted as a producer-
authored source catalog.

### Scope extension

`scope.atif-extension.v1` may record trajectory completeness, task/run context,
available/configured capabilities, discoveries, tool-call outcome/timing,
input-validation issues, and archive origin. A discovery is evidence only when
it occurs in `step.extra.scope.discoveries`; an available/configured capability
is not a discovery.

Attribution is resolved only from recorded ATIF fields such as
`tool_call.extra.scope.source_id`. Consumers MUST NOT infer an MCP server or
capability from `function_name`.

## Definite JSONPath language

Evidence paths are absolute and root at the exact normalized ATIF document.
The grammar is:

```abnf
path       = "$" selector*
selector   = name-selector / quoted-selector / index-selector
name-selector = "." name
name       = (ALPHA / "_") *(ALPHA / DIGIT / "_")
quoted-selector = "[" json-string "]"
index-selector  = "[" index "]"
index      = "0" / (%x31-39 *DIGIT)
```

`json-string` uses JSON double-quoted string escapes. For author convenience,
single-quoted property selectors are accepted only when their contents use
JSON-compatible escapes; they canonicalize to the same representation as a
double-quoted selector.

Canonicalization rules:

1. Root is `$`.
2. A property matching `/^[A-Za-z_][A-Za-z0-9_]*$/` is emitted as `.name`.
3. Other properties are emitted as `[<JSON.stringify(property)>]`.
4. Indices are emitted in minimal base-10 form with no leading zero.
5. `__proto__`, `prototype`, and `constructor` are rejected at every property
   selector.

Examples:

| Accepted input | Canonical path |
|---|---|
| `$["steps"][1]` | `$.steps[1]` |
| `$['steps'][1]['tool_calls'][0]` | `$.steps[1].tool_calls[0]` |
| `$.extra["scope-data"]` | `$.extra["scope-data"]` |

Wildcards, recursive descent, filters, scripts/eval, unions, slices, negative
indices, omitted indices, relative paths, and trailing junk MUST be rejected.
Paths are limited to 2,048 UTF-8 bytes and 64 selectors.

Resolution traverses own properties only. Every selector MUST exist; an array
index MUST be less than array length. The result is exactly one node. The
resolved path is then looked up in the immutable type registry.

`$.steps[1]` means the second array entry, not `step_id === 1`.
`$.steps[0].message[1].source` is a media descriptor only when its enclosing
part is a matching image/audio part. A media descriptor's `path` string is
data, not JSONPath and not authorization to read or fetch anything.

## Exact-input normalization and hashing

### Normalized document

The normalization contract identifier is
`scope/taxonome-normalized-atif/v1`. It performs:

1. Decode an object or singleton object array and retain the original container
   path.
2. Strictly validate declared ATIF v1.6, v1.7, or v1.8.
3. Apply and validate adjacent upcasters until canonical ATIF v1.8.
4. Normalize audio MIME aliases listed above.
5. Preserve all legal object values, string-vs-parts forms, and array order.
6. Add the default Scope extension only when `extra.scope` is absent:

   ```json
   {
     "schema_version": "scope.atif-extension.v1",
     "trajectory_state": "complete",
     "available_sources": []
   }
   ```

7. When a tool call records `extra.scope.response` but no observation result
   references that call, append one normalized observation result in call order
   with `source_call_id` set to the call ID. String/content-part responses are
   preserved; other JSON responses become their RFC-8785 canonical JSON text.
   Existing observation results are never replaced.
8. For Scope archives, stitch iterations in declared iteration order, assign
   deterministic global step IDs, rewrite colliding call IDs/references, and
   retain original identities under `extra.scope.origin` as documented in the
   Taxonome architecture guide. Every constituent validates/upcasts before
   stitching and the normalized root is always `ATIF-v1.8`. Agent metadata is
   retained from the first declared iteration.

Normalization MUST NOT sort arrays, flatten subagents, fetch continuation
files, load media, or infer missing evidence.

Original-source provenance is retained outside the ATIF evidence value. It
records file/URL, archive entry, JSONL line/field context, original JSONPath,
adjacent upcasters, and generated-value causes. Prefix mappings compare parsed
definite path segments, so quoted and dot spellings are equivalent. Generated
defaults use nearest-cause anchors rather than inventing nonexistent original
children. Diagnostics are bounded/redacted and do not persist raw invalid
payloads. Structural, Scope/taxonomy semantic, and readout evidence failures
resolve normalized evidence paths through this same map. Model-facing
assessment/repair paths remain canonical normalized paths; original paths are
diagnostic context, not producer output. Provenance never contributes to
canonical hashing.

### Canonical serialization

The normalized document is serialized using RFC 8785 JSON Canonicalization
Scheme:

- UTF-8 output with no BOM or trailing newline;
- object keys sorted by UTF-16 code units;
- array order preserved;
- strings escaped as JSON;
- finite numbers serialized with ECMAScript JSON number serialization;
- no `undefined`, nonfinite number, bigint, sparse-array, or non-JSON value.

The input fingerprint is lowercase hexadecimal SHA-256 of those exact bytes.

`InputIdentity` contains:

```json
{
  "normalization": "scope/taxonome-normalized-atif/v1",
  "sha256": "<64 lowercase hex>",
  "trajectory_id": "optional-document-id",
  "session_id": "optional-run-id",
  "request_id": "optional-scope-request-id",
  "run_id": "optional-scope-run-id",
  "archive_root": "optional-source-root"
}
```

Only `normalization` and `sha256` are required. Optional identity fields are
matching aids; none replaces the fingerprint and `session_id` is never assumed
unique.

### Known-answer vectors

Conformance fixtures include these vectors:

```json
{"b":2,"a":[3,{"z":false,"é":"text"}]}
```

Canonical bytes:

```json
{"a":[3,{"z":false,"é":"text"}],"b":2}
```

SHA-256:

```text
0abd23271492b02886cb3f22661f44b59637d6cd5eefc9ad288d9ac3d40210af
```

The normalized-ATIF fixture
`valid/atif-v18-mixed-media.json` and its expected fingerprint are stored in
`fingerprints.json`. Production tests MUST calculate and verify that vector.

Taxonomy digests use the same canonical serializer over the normalized
serializable taxonomy. Role defaults and constraints are included. Prompt
contract hashes additionally include the effective shared assessment schema,
role/type/constraint contract, normalization identifier, effective ATIF
validation/upcast policy hash, Ax output signature/mode, correction policy, and
trusted production wrapper. Resume/artifact mismatch MUST fail even though
version identifiers did not change.

## Validation and repair

The pure validator runs these phases in order:

1. Parse received JSON when the producer boundary is text. The Ax runtime wire
   uses one `observation:json` field; after that parse, the value MUST already
   be one assessment object and MUST NOT be decoded from another string.
2. Validate the strict shared assessment schema.
3. Validate declared roles, duplicate canonical references, and cardinality.
4. Parse/canonicalize and resolve every evidence JSONPath.
5. Validate structural registry type.
6. Validate declared constraints.

If a prerequisite phase fails, dependent phases do not invent diagnostics.
Any diagnostic rejects the whole assessment; implementations MUST NOT salvage
occurrences, drop references, guess paths, or coerce a positive result to
negative/indeterminate.

### Prompt execution

A prompt element receives one initial model completion. Its signature is
`trajectory_context:string -> observation:json`; the input name intentionally
does not collide with any assessment property, because Ax renders signature
field titles into the prompt. Composition tests MUST verify that nested schema
keys such as lower-case `evidence` remain unchanged. Ax parses the declared
`observation:json` field and applies the complete Taxonome validator as a
forward-scoped assertion bound to the exact input and element. If and only if a
model response was received and JSON parsing or
assessment/role/reference/type/constraint validation fails, Ax MAY request
exactly one correction completion. The engine does not make another model call.

The correction uses the same model, input, element, restored artifact, role
contract, and fingerprint. Ax supplies the prior response plus bounded
validation feedback and requires a complete replacement assessment. The
complete assertion runs again; the engine then performs one final non-retrying
validation before persistence.

There is no correction for authentication, SDK/network failure, timeout,
cancellation, invalid taxonomy/input, a valid judgment that disagrees with
ground truth, or cleanup failure. No third completion is allowed. SDK/provider
retries remain disabled; Ax owns only the validation-correction budget.
The current Copilot adapter honestly advertises no native structured-output
support. Shape enforcement is Ax JSON parsing plus client-side Taxonome
validation, not provider-constrained decoding.

A deterministic handler runs once. Invalid deterministic output immediately
creates a failed evaluation. It MUST NOT initialize credentials, Ax, or an SDK
and MUST NOT be retried or repaired by a model.

The production-path repair policy is included in contract hashes:

```json
{"prompt_initial_attempts":1,"prompt_repair_attempts":1,"prompt_correction_owner":"ax","optimizer_repair_attempts":0,"deterministic_attempts":1}
```

### Optimizer fitness

The Ax optimizer metric validates the raw parsed candidate with this same pure
validator against the example's exact normalized ATIF and element contract.
Invalid JSON, roles, paths, types, or constraints score `0`. A candidate
scores `1` only when fully valid and semantically matches reviewed ground
truth. The metric attaches no runtime assertion, performs no correction and no
additional model call, and records invalid generations as score-zero metric
observations rather than aborting scoring. Its trace records
schema, role, resolution, type, constraint, and semantic errors.

Raw optimizer fitness therefore measures first-attempt quality. Repaired
production-path quality is a separate runtime measurement.

## Downstream consumption and reporting

A consumer MUST receive:

- the matching taxonomy;
- succeeded/failed evaluation envelopes;
- the exact normalized ATIF inputs or source files/archives needed to reproduce
  them.

Batch records produced from `--files-from` additionally carry a source origin
outside normalized ATIF: canonical selected local input plus actual archive
root when present. Consumers MUST use that verified origin together with the
normalized fingerprint to distinguish equal-content files, overlapping
archives, and duplicate business/run IDs. The source-scoped wrapper run ID is
not a replacement for the unchanged ATIF request/run/session identity.
The loader MUST distinguish plain and archive containers explicitly; it MUST
NOT infer container kind from the root string. An archive root literally named
`input` retains `archive_root: "input"`, while a plain input does not receive
an archive root.
Legacy records without this origin remain valid only when fingerprint/root
matching is unambiguous; ambiguous legacy collections fail closed.

It MUST recompute taxonomy and input fingerprints, match evaluation input
identity, and revalidate every assessment and evidence reference. Missing,
ambiguous, stale, or mismatched inputs fail explicitly.
Caller-supplied identity metadata is never the fingerprint authority: consumers
recompute identity from normalized ATIF plus trusted ingestion context and
compare any supplied metadata to that result.

Reporting rules:

- Occurrence count is the number of occurrences, never the number of references.
- Distinct-run behavior count includes a run once when at least one valid
  positive occurrence exists.
- Source attribution is derived from owning call/result Scope metadata only
  when present.
- Source frequency deduplicates one source within one occurrence.
- Completed-negative, indeterminate, inapplicable, failed execution, and
  missing evaluation coverage remain separate.
- Invalid references/evaluations are errors, never silently omitted.
- Partial reports MAY include valid successes but MUST list failed/missing
  runs and exit/report non-success.

## Taxonome multi-run implementation profile

For a multi-root Scope archive, Taxonome:

- requires `--output-dir`;
- writes one atomic `<request-id>--<run-id>.json` per root;
- stores success as `{run, results, metadata}` and a schema-versioned per-run
  error record otherwise;
- binds resume to exact request/run/root, normalized-input fingerprint,
  taxonomy/role/prompt/repair contracts, selected elements, model, and artifact
  hashes;
- never treats a failed or invalid evaluation as a successful resume hit;
- preserves compatible file mtimes;
- retries errors/corrupt/stale files and supports explicit `--force`.

The success wrapper (`run`, `results`, optional `metadata`) is one shared strict
schema used by resume and readout. Resume additionally verifies run context,
taxonomy/element metadata, every input identity field, selected element order,
model, artifacts, and evidence validity.

When readout scans a result directory, valid unrelated JSON MAY be ignored.
Malformed JSON and JSON that is recognizable as a Taxonome run/error record but
does not validate MUST fail with the source filename and explicit recomputation
guidance; stale records are never silently dropped.

`readout` requires `--taxonomy` and repeatable `--inputs` selections. Inputs
may be explicit files, quoted globs, plain local ATIF, or local single/multi-run
Scope archives. Result matching uses identity plus fingerprint, not filename
order. A safely scanned archive may contain invalid roots alongside valid
roots. Readout retains those invalid-root diagnostics and permits the valid
portion only when a matching persisted Taxonome error record is supplied; the
report remains partial and exits nonzero. Whole-archive corruption that
prevents safe scanning fails outright.

## Security and capability boundary

All taxonomy, trajectory, classifier, and error text is untrusted data.

- YAML is non-executable and bounded.
- JSONPath is the non-executable definite subset above.
- Resolution uses own properties only and rejects prototype selectors.
- Diagnostics and persisted errors are bounded and redacted.
- Media descriptors are metadata. Referencing
  `$.steps[0].message[1].source` does not permit file/network access and does
  not prove image/audio bytes were viewed.
- Taxonome's current provider profile is text-only. It does not load, decode,
  transcribe, embed, upload, or fetch media. When semantic judgment requires
  unavailable media contents, a producer should return `indeterminate`.
- External/continued subagent references are not followed automatically.

A future explicitly authorized multimodal implementation may load media, but
that capability is outside this format's reference semantics and requires its
own security boundary.

## Compatibility and migration

This redesign keeps all existing identifiers because the stack is unreleased.
It intentionally removes the old draft runtime lane:

- `output_schema` authoring is rejected.
- Old result envelopes lacking `status`, exact input identity, and typed
  evidence are incompatible.
- Old artifacts fail contract hash validation and must be reoptimized.
- Old result directories must be recomputed explicitly; paid/frozen evidence is
  not migrated in place.
- Strict ATIF v1.6, v1.7, and v1.8 sources remain supported through explicit
  adjacent upcasters; canonical evidence is always v1.8.

Historical evidence, manifests, optimizer artifacts, and recordings remain
byte-immutable and accurately labeled for their original contracts.

## Worked example

### Taxonomy element

```yaml
schema_version: scope/taxonomy/v1
id: malformed
label: Malformed Invocation
implementation:
  type: deterministic
  handler: scope/malformed-invocation-v1
  config: {}
preconditions: {}
output:
  evidence_roles:
    call:
      type: atif.tool_call
      max: 1
      description: Invalid invocation.
    issue:
      type: scope.input_validation_issue
      description: Recorded validation issue for the invocation.
  constraints:
    - kind: descendant_of
      role: issue
      reference_role: call
```

### ATIF evidence

```json
{
  "schema_version": "ATIF-v1.7",
  "trajectory_id": "document-1",
  "session_id": "run-1",
  "agent": {"name": "fixture"},
  "steps": [{
    "step_id": 7,
    "source": "agent",
    "message": "Calling account/query.",
    "tool_calls": [{
      "tool_call_id": "call-1",
      "function_name": "account/query",
      "arguments": {},
      "extra": {"scope": {
        "input_validation": {
          "status": "invalid",
          "issues": [{"code": "missing_field", "path": "$.accountId"}]
        }
      }}
    }]
  }]
}
```

### Positive assessment

```json
{
  "state": "completed",
  "observed": true,
  "occurrences": [{
    "evidence": [
      {"role": "call", "path": "$.steps[0].tool_calls[0]"},
      {"role": "issue", "path": "$.steps[0].tool_calls[0].extra.scope.input_validation.issues[0]"}
    ]
  }]
}
```

Both references resolve, satisfy their role types, and the issue path is a
strict selector descendant of the call path. The occurrence count is one.

### Negative and unavailable assessments

```json
{"state":"completed","observed":false}
```

```json
{"state":"indeterminate","reason":"Input validation evidence is incomplete."}
```

```json
{"state":"inapplicable","reason":"The trajectory contains no tool invocation."}
```

### Failed evaluation

```json
{
  "schema_version": "scope/taxonomy-evaluation/v1",
  "taxonomy": {"id":"agent-behavior","version":"3.0.0","digest":"..."},
  "element": {"id":"malformed","label":"Malformed Invocation"},
  "implementation": {
    "type":"deterministic",
    "handler":"scope/malformed-invocation-v1",
    "attempts":[{"attempt":1,"kind":"initial","outcome":"invalid_output"}]
  },
  "input": {
    "normalization":"scope/taxonome-normalized-atif/v1",
    "sha256":"..."
  },
  "status":"failed",
  "error":{
    "code":"invalid_output",
    "message":"The deterministic assessment failed validation.",
    "validation_errors":[{
      "code":"reference_type_mismatch",
      "output_path":"$.occurrences[0].evidence[0].path",
      "role":"call",
      "evidence_path":"$.steps[0]",
      "expected_type":"atif.tool_call",
      "actual_type":"atif.step"
    }]
  }
}
```

## Conformance fixture matrix

Production tests execute this matrix:

| Fixture | Expected result |
|---|---|
| `valid/taxonomy.yaml` | Loads with normalized role defaults and constraints. |
| `valid/atif-v17.json` | Parses and exposes step/call/result/discovery/issue types. |
| `valid/atif-v18-mixed-media.json` | Parses text/image/audio parts and alias normalization. |
| `valid/positive-assessment.json` | Resolves all role references and constraints. |
| `valid/negative-assessment.json` | Valid completed-negative assessment. |
| `valid/indeterminate-assessment.json` | Valid unavailable assessment. |
| `valid/inapplicable-assessment.json` | Valid inapplicable assessment. |
| `invalid/output-schema-taxonomy.yaml` | Rejects obsolete `output_schema`. |
| `invalid/unknown-type-taxonomy.yaml` | Rejects an unknown shared evidence type. |
| `invalid/role-cardinality-taxonomy.yaml` | Rejects `max < min`. |
| `invalid/relationships-taxonomy.yaml` | Rejects obsolete `output.relationships`. |
| `invalid/step-after-taxonomy.yaml` | Rejects obsolete `step_after`. |
| `invalid/evidence-taxonomy.yaml` | Rejects obsolete element-level `evidence` in favor of `preconditions`. |
| `invalid/precondition-names-taxonomy.yaml` | Rejects obsolete precondition flag names. |
| `invalid/jsonpath-features.json` | Rejects wildcard/filter/descent/slice/union/eval/negative/prototype selectors. |
| `invalid/unknown-role.json` | `unknown_role`. |
| `invalid/cardinality.json` | `role_cardinality`. |
| `invalid/excess-cardinality.json` | `role_cardinality` for an exceeded maximum. |
| `invalid/duplicate-reference.json` | `duplicate_reference` after canonicalization. |
| `invalid/unresolved-reference.json` | `unresolved_reference`. |
| `invalid/type-mismatch.json` | `reference_type_mismatch`. |
| `invalid/ownership.json` | `reference_constraint_mismatch` for semantic `owned_by`. |
| `invalid/descendant.json` | `reference_constraint_mismatch` for generic `descendant_of`. |
| `invalid/order.json` | `reference_constraint_mismatch` for generic `after`. |
| `fingerprints.json` | Canonical JSON and normalized ATIF known-answer SHA-256 vectors. |

The fixture README records expected diagnostic codes and canonical paths.
Implementations may add internal tests, but these language-neutral fixtures
are the interoperability baseline.

Taxonome additionally commits table-driven acceptance suites:
`evidence-constraints.test.ts` exercises all three constraint kinds,
multi-reference quantifiers, optional-role semantics, axes, canonical
selectors, stale shapes, and hash behavior; `evidence-roles.test.ts` covers
role authoring/cardinality and uses an exhaustive `Record<EvidenceType, ...>`
mapping so every shared registry type has both a valid structural location and
a same-shaped wrong-location rejection case. The suite also checks every
distinct expected/actual registered-type pair, so similar registered types
such as observation/result and image/audio source cannot become interchangeable.
