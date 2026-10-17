# Experiments Architecture

> **Status:** PR A foundation and client contract, current as of October 2026.

Experiments are project-scoped, named benchmark compositions. An Experiment
stores durable metadata, one immutable revision, and one current processing
execution. Previous executions are immutable history records.

PR A provides the canonical storage model, project-scoped public API contract,
CLI commands, Portal creation/list/detail flows, and run correlation. It does
not add mutable membership or cascading lifecycle behavior.

## Model

```mermaid
erDiagram
    EXPERIMENT ||--|| EXPERIMENT_REVISION : fixes
    EXPERIMENT ||--|| CURRENT_EXECUTION : owns
    EXPERIMENT ||--o{ EXECUTION_HISTORY : archives
    CURRENT_EXECUTION ||--|| FIXED_REQUEST_VECTOR : processes
    FIXED_REQUEST_VECTOR ||--o{ REQUEST_STATE : contains
    FIXED_REQUEST_VECTOR ||--o{ EXPERIMENT_CHUNK : may_use

    EXPERIMENT {
        string experimentId
        string projectId
        string storageProfileVersion
        number stateVersion
        datetime finalizedAt
    }

    EXPERIMENT_REVISION {
        string experimentRevisionId
        number revisionNumber
        number memberCount
        string membershipFingerprint
        string definitionFingerprint
    }

    CURRENT_EXECUTION {
        string experimentExecutionId
        number attemptNumber
        number version
        string vectorFingerprint
        datetime frozenAt
    }

    REQUEST_STATE {
        string requestId
        string runId
    }
```

### Revision versus execution

An **Experiment revision** describes the composition itself:

- `experimentRevisionId` and sequential `revisionNumber`;
- exact `memberCount`;
- `membershipFingerprint` for the member set;
- `definitionFingerprint` for the complete definition;
- immutable creation time.

An **Experiment execution** is one processing attempt over that revision:

- `experimentExecutionId` and sequential `attemptNumber`;
- optimistic-concurrency `version`;
- the exact request/run vector and its `vectorFingerprint`;
- handler status, blockers, and processing timestamps;
- freeze, discard, and supersession state.

Retry creates a new execution attempt over the same stored request vector. It
does not create a new revision or retry member runs. Revision membership
mutation is deferred to PR C.

### Exact request/run vector

Each `ExperimentRequestState` is a bounded, nonrecursive leaf containing the
exact `requestId`, exact `runId`, dependency projections, and blockers captured
for that member. Request IDs are unique within the vector. Each dependency and
blocker list is bounded to 32 entries, and each serialized request state is
limited to 4 KiB.

The exact `{requestId, runId}` identity vector is immutable after publication
and covered by `vectorFingerprint`. Dependency projections and blockers are
mutable bounded state covered by the `FixedPayload` descriptor's
`payloadFingerprint`. Reads reconstruct the original position order and reject
missing positions, duplicates, count mismatches, identity mismatches, or
fingerprint mismatches.

## FixedPayload storage

`FixedPayload<T>` has two representations:

| Representation | Stored on the execution | Use |
| --- | --- | --- |
| `inline` | `entryCount`, `payloadFingerprint`, and `entries[]` | The complete Experiment document fits the operational target |
| `chunked` | `entryCount`, `payloadFingerprint`, assignment version, `bucketCount`, and deterministic `chunkIds[]` | The inline document exceeds the operational target |

The storage profile is versioned as `cosmos-mongo-2mb-v1`.

- **2 MiB hard ceiling:** no selected Experiment or chunk document may exceed
  `maxDocumentBytes`.
- **256 KiB operational target:** inline storage is used only when the complete
  Experiment document is at or below `targetDocumentBytes`.
- Chunk selection reserves 16 KiB for metadata and applies an 80% load factor
  to the remaining target.
- Empty vectors are always inline.
- The bucket search is bounded to 65,536 buckets and fails explicitly when no
  safe layout exists.

### Deterministic routing and chunk identity

Chunk routing is versioned as `sha256-mod-v1`. For a chosen bucket count, the
store hashes:

```text
"experiment-request-bucket:v1\0" + requestId
```

The full SHA-256 digest is interpreted as an unsigned big-endian integer, then
reduced modulo `bucketCount`. This makes assignment independent of input order
and stable across processes.

Chunk IDs are also deterministic. The store serializes this canonical tuple:

```text
["sha256-v1", projectId, experimentId, kind, ownerId, generation, chunkIndex]
```

It hashes the JSON bytes with SHA-256, encodes the digest as base64url, and
prefixes it with `ec_v1_`. `ownerId` is the execution ID and `generation` is
the attempt number. Upserts use `$setOnInsert`; a read-back comparison rejects
an existing deterministic ID whose identity or contents differ.

## Publication and concurrency

Experiment creation and execution rollover use a prepare-then-publish protocol.

```mermaid
sequenceDiagram
    participant Client
    participant Store as ExperimentStore
    participant Chunks as experiment-chunks
    participant Current as experiments
    participant History as experiment-executions

    Client->>Store: createPending(metadata, revision, vector)
    Store->>Chunks: prepare deterministic chunks if needed
    Store->>Current: setOnInsert pending Experiment
    Client->>Store: finalizeCreation(expected IDs and stateVersion)
    Store->>Chunks: verify complete FixedPayload
    Store->>Current: CAS set finalizedAt

    Client->>Store: freezeCurrent(expected execution version)
    Store->>Current: CAS set frozenAt
    Client->>Store: rollover or retry
    Store->>Chunks: prepare next execution payload
    Store->>Current: CAS publish rollover claim
    Store->>History: archive old execution with setOnInsert
    Store->>Current: install next execution
```

### Compare-and-swap rules

- `stateVersion` protects whole-document publication transitions.
- `execution.version` protects handler claims/completions, freeze, discard, and
  rollover.
- Handler writes require the expected execution ID and version, the expected
  handler version/status, and an unfrozen execution with no rollover claim.
- Freeze competes through the same execution-version compare-and-swap. A
  writer/freezer race has one winner.
- Rollover requires the current execution to be frozen and records an embedded
  claim containing the complete next execution before replacing the current
  pointer.

### Finalization, archive, and repair

`createPending()` may prepare chunks before the root document exists.
`finalizeCreation()` verifies the complete payload and atomically sets
`finalizedAt`. Public `get` and `list` operations return only finalized
Experiments, so partially published state is never visible.

Before rollover, the current execution is frozen. Archival writes an immutable
history document keyed by `experimentExecutionId` with `$setOnInsert`, then
reads it back and requires exact equality. The history record includes the
revision and supersession metadata.

The rollover claim is the repair journal. `repairRollover()` verifies the next
payload, idempotently archives the old execution, and installs the claimed next
execution. A caller can resume this sequence after interruption without
inventing state. Prepared chunks that were never published can be removed with
`discardUnpublished()`.

## Collection and index ownership

| Collection | Owner and contents | Indexes created by migration 034 |
| --- | --- | --- |
| `experiments` | One finalized/current document per Experiment; `_id` equals `experimentId` | `{ projectId: 1, _id: 1 }` for project-scoped paging and lookup |
| `experiment-executions` | Immutable archived execution history; `_id` equals `experimentExecutionId` | `{ projectId: 1 }`; `{ experimentId: 1, attemptNumber: -1 }` |
| `experiment-chunks` | Deterministic immutable request-vector chunks | No secondary index; chunks are addressed directly by deterministic `_id` |

The `ExperimentStore` owns root and history writes. `FixedPayloadStore` owns
chunk preparation, read verification, and unpublished cleanup. Migration
`034-create-experiment-storage-indexes.ts` owns the secondary indexes and
intentionally leaves removal to a manual operation in `down()`.

Every lookup includes `projectId` in addition to the entity ID. An Experiment
ID is never resolved globally.

## Runtime ownership

The API owns `ExperimentCoordinator`, including authoritative run projection,
readiness, rollover, retry, publication repair, and Experiment-handler
dispatch policy. Its polling loop repairs missed notifications, vector drift,
dropped queue notices, and interrupted publication or rollover.

The scheduler continues to own coding-agent and per-run handler dispatch. For
Experiment handlers it only applies exact claim and completion messages
through shared `ExperimentStore` compare-and-swap primitives. Storage layout,
routing, fingerprinting, and state transitions remain reusable typed modules
under `packages/shared/src/experiments`; they do not own workflow policy.

## Public API

All routes require `?projectId=`:

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/api/v1/experiments` | Create from `{ mode: "compose", metadata, requests }` or `{ mode: "empty", metadata, requests: [] }` |
| `GET` | `/api/v1/experiments` | Cursor-page finalized Experiments |
| `GET` | `/api/v1/experiments/:id` | Read the public Experiment and current execution |
| `GET` | `/api/v1/experiments/:id/executions` | List current and archived execution summaries |
| `GET` | `/api/v1/experiments/:id/executions/:experimentExecutionId` | Read one exact current or archived execution |
| `POST` | `/api/v1/experiments/:id/retry` | Start a new processing attempt for the current exact vector |

Creation metadata requires `name` and accepts an optional `description`.
Compose mode requires one or more complete request definitions and empty mode
requires an empty request array.

The public view exposes identity, project, metadata, revision, current
execution, readiness, blockers, handler progress, supersession, current report,
and linked request summaries when available. Creation additionally returns
`requestIds`. List responses and execution-list responses use
`{ data, nextCursor? }`.

## CLI and Portal

The CLI provides:

```text
scope experiment create
scope experiment list
scope experiment get <experiment-id>
scope experiment executions <experiment-id> [experiment-execution-id]
scope experiment retry <experiment-id> --execution <current-execution-id>
```

Creation reuses run configuration flags, adds Experiment metadata, supports
composition preview, and supports explicit empty creation. Every command
requires project scope.

The Portal provides `/experiments`, `/experiments/new`, and
`/experiments/:id`. The shared creation form retains the established run
configuration and expansion count and adds Experiment metadata. No selected
scenario creates an empty Experiment; selecting a scenario reveals the run
composition controls and creates the expanded run count. The Portal navigates
to Experiment Detail after creation. The Experiments list uses the shared
full-height, edge-to-edge `ListLayout`, `FilterRail`, `DataTable`, column
customization, and cursor-aware `Pagination` interaction model used by Runs
while retaining Experiment-specific status, revision, attempt, and run-count
columns.

Experiment Detail keeps the Experiment identity, concise status, and global
attempt selector in a compact header. The horizontal **Runs**, **Reports**, and
**Processing** tabs follow that header directly so their active content is
available without scrolling through overview cards. The selected attempt
scopes all three tabs:

- **Runs** renders the exact stored request/run vector in an inset,
  sortable, customizable, paginated shared `DataTable`. Rows link to the exact
  request/run pair.
- **Reports** groups append-only report documents by persisted `templateId` or
  reporter identity. It shows a type selector only when multiple report types
  exist and a version selector only when a type has history. The newest type
  and newest version are the defaults, and exactly one version is rendered.
  Markdown, structured JSON, the global report-detail link, loading/error
  retry, and status use the exact
  `experimentId + experimentExecutionId + reportId` identity. Completed,
  processing, failed, blocked, and no-artifact states share one stable panel
  shell: identity, selectors, badges, and actions keep their positions while
  only the content region changes. Artifact-only actions are disabled when no
  artifact exists, while addressable report versions retain their direct link.
- **Processing** owns handler progress, blockers, errors, execution metadata,
  and processing retry/recovery. Retry remains current-attempt-only.

Browser history preserves the selected attempt, tab, report type, and report
version through `executionId`, `tab`, `reportType`, and `reportId` query
parameters. Missing parameters retain backward-compatible defaults. Stale
values fall back safely to the current data and are removed from the URL.
Detail defaults to **Reports** when a report document exists, **Processing**
while an artifact-free attempt is active or blocked, and **Runs** otherwise.
Public UI terminology remains generic **Reports**; `pp-readout` is only the
internal handler identifier. This projection does not add Experiment report
template attachment, selection, or triggering; those remain deferred to PR D.
Run list and detail views link `experimentId` back to the Experiment. A
historical correlation that has no Experiment document is view-only and cannot
trigger retry.

## Permanent request creation and composition deprecation

`POST /api/v1/requests`, `scope run submit`, and the Portal's **New Run** flow
remain permanent for one request, including:

- one inline/manual configuration;
- one saved profile;
- ordinary model, tool, criterion, resource, and codebase configuration;
- `count: 1`;
- no profile variations.

Only these overlapping request-creation controls are deprecated:

- `count` greater than `1`; or
- a non-empty `profileVariations` array.

Clients identify this case as `legacy-request-composition`. Existing expansion,
response, status, and navigation behavior remain intact. The CLI writes the
warning only to stderr. The Portal renders an accessible status notice only
when one of those two conditions is true. New multi-request compositions use
Experiment creation.

## Deferred capabilities

The following are explicitly outside PR A:

| Follow-up | Deferred capability |
| --- | --- |
| PR B | Additional derived readout orchestration beyond PR A's stored/public current and historical execution views |
| PR C | Membership mutation and new revision creation after initial publication |
| PR D | Report-template attachment or template-driven report orchestration |
| PR E | Cascading lifecycle operations across an Experiment and its member requests/runs |

GEPA restacking is also excluded. PR A must not imply these capabilities
through storage methods, client actions, or API contracts.

## Key files

| File | Purpose |
| --- | --- |
| `packages/shared/src/experiments/types.ts` | Canonical Experiment, revision, execution, and `FixedPayload` types |
| `packages/shared/src/experiments/schemas.ts` | Strict persisted-boundary validation |
| `packages/shared/src/experiments/layout.ts` | BSON limits and inline/chunked layout selection |
| `packages/shared/src/experiments/routing.ts` | SHA-256 bucket routing, chunk IDs, and fingerprints |
| `packages/shared/src/experiments/fixed-payload-store.ts` | Deterministic chunk publication and verified reads |
| `packages/shared/src/experiments/experiment-store.ts` | Creation, CAS processing, freeze, archive, rollover, retry, and repair |
| `packages/db-migrations/src/migrations/034-create-experiment-storage-indexes.ts` | Collection index ownership |
| `apps/api/src/experiment-coordinator.ts` | API-owned workflow policy and repair |
| `apps/api/src/experiment-dispatcher.ts` | Durable polling and queue delivery |
| `apps/cli/src/commands/experiment.ts` | Project-scoped CLI surface |
| `apps/portal/src/lib/experiments.ts` | Public response parsing |
| `apps/portal/src/pages/ExperimentsList.tsx` | Experiment list |
| `apps/portal/src/pages/ExperimentDetail.tsx` | Current state, history, and retry |
