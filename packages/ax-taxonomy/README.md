# ax-taxonomy

`ax-taxonomy` contains the shipped Ax taxonomy, its reviewed
inputs/ground truth, and the concrete Discovered, Malformed Invocation, and
Timeout handlers. The generic loader, evaluation engine, Copilot transport,
optimization support, and CLI remain in `taxonomy-engine` and `taxonome`.
Elements implement the normative
[Trajectory Taxonomy Format](../../docs/architecture/trajectory-taxonomy-format.md).

## Evaluate the catalog

From this package directory, `pnpm eval` is a direct shortcut to the native
Taxonome CLI:

```bash
pnpm eval
pnpm eval -- --element beh-wrong-discovery
pnpm eval -- --concurrency 8
pnpm eval -- --help
```

Valid selectors are `beh-discovered`, `beh-skipped-invocation`,
`beh-wrong-discovery`, `beh-content-misused`,
`beh-malformed-invocation`, and `beh-timeout`.

The package script supplies the catalog taxonomy plus quoted repeatable globs:

```text
--inputs "packages/ax-taxonomy/fixtures/*-inputs.jsonl"
--ground-truth "packages/ax-taxonomy/fixtures/*-ground-truth.json"
```

Taxonome resolves, sorts, and deduplicates matching files. Inputs and reviewed
expectations are joined by stable input ID plus element ID. Each input's
`elements` array determines applicability. Without `--element`, every input is
evaluated against its declared elements. A selector filters to inputs that
declare exactly that stable element and evaluates only that element.

The active split vocabulary is exactly `train`, `validation`, and `test`.
`test` is final unseen evaluation, including the representative deterministic
evaluation inputs. Ordinary deterministic unit coverage remains in Vitest and
is not an evaluation-data split. The package command defaults to all splits.
Add `-- --split test` when only final unseen inputs are desired.

## Output and progress

Human-readable output is the default. Live progress is streamed to stderr
before the final stdout summary and includes:

- input file, input ID, and repetition;
- `Prompt` or `Code/Deterministic` for every element;
- whether model calls are possible;
- PASS/FAIL completion for each element and input.

Evaluation jobs are flattened in stable sample/input/element order and run
through a global worker pool. `--concurrency <1..16>` defaults to `4`; final
human/JSON rows retain planned order regardless of completion order.

Interactive terminals show a fixed numeric dashboard in taxonomy order:
`STATUS TYPE ELEMENT DONE PASS FAIL RUN WAIT ACTIVE`, plus overall counts.
Prompt rows are magenta, code rows blue, running status cyan, pass green, fail
red, and waiting dim. `NO_COLOR` keeps the in-place dashboard plain. Non-TTY
stderr uses append-only START/PASS/FAIL events.

Ctrl-C stops new scheduling, aborts active prompt requests, closes worker
runtimes, restores terminal state, and exits nonzero. Failure details are
appended after dashboard finalization in stable element/input/sample order.
Interactive TTYs then print only a compact evaluation-level result such as
`Result  18 passed • 3 failed • 21 evaluations • 4.2s`; cancelled evaluations
are included when nonzero. Successful inputs are not repeated after the
dashboard. Non-TTY human output retains the detailed file/input summary. Both
forms include elapsed wall time.

Machine mode remains one ANSI-free JSON document on stdout:

```bash
pnpm eval -- --json
pnpm eval -- --element beh-timeout --json
```

The package-local pnpm reporter is silent so its script banner does not
contaminate JSON stdout. Progress and diagnostics remain on stderr.

## Authentication and artifacts

Discovered, Malformed Invocation, and Timeout are deterministic and require no
credentials. Eligible Skipped Invocation, Wrong Discovery, and Content Misused
inputs may make model calls.

Taxonome uses the first non-empty `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or
`GITHUB_TOKEN`; otherwise it reads the active account through `gh auth token`.
The token remains in memory and is never printed or persisted. Without an
environment override, install and authenticate GitHub CLI with `gh auth login`.

`--element-override <path>` is repeatable for side-by-side evaluation of
complete optimized element YAML. Duplicate, unknown, or mismatched IDs fail
before model submission. Optimization manifests are provenance only.

The current CLI has no cumulative budget or ledger option. Optimization's
`--max-metric-calls` limits Ax's bounded search only; it is not a global SDK
call counter.

## Evaluate downloaded Scope archive collections

Use deterministic elements to process a multi-run export without credentials:

```bash
taxonome run submission.tar.gz \
  --taxonomy packages/ax-taxonomy/taxonomy/taxonomy.yaml \
  --elements beh-discovered,beh-malformed-invocation,beh-timeout \
  --output-dir ./taxonome-results \
  --concurrency 4

taxonome readout "./taxonome-results/*.json" \
  --taxonomy packages/ax-taxonomy/taxonomy/taxonomy.yaml \
  --inputs submission.tar.gz \
  --markdown ./taxonome-results/readout.md
```

Existing compatible success files resume automatically. The compatibility key
includes request/run identity, retained-evidence SHA-256, taxonomy digest,
selected element IDs, model, and artifact contract hashes. Use `--force` only
when every root should be recomputed.

The command first shows streaming archive scan progress, then one row per run.
`DONE/RUN/WAIT` are selected-element counts for that run; `ACTIVE` identifies
the current taxonomy element and whether it is Prompt or Code. Run concurrency
is bounded globally, while each active run evaluates its elements sequentially
in taxonomy order. A second compatible invocation renders every run as
`RESUMED` and leaves result mtimes unchanged.
