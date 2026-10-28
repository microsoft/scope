# Taxonome

Standalone experimental YAML taxonomy CLI for plain ATIF and existing Scope run
archives. The catalog evaluates Skipped Invocation, Wrong Discovery, and
Content Misused through Ax/Copilot SDK, plus Discovered, Malformed Invocation,
and Timeout through deterministic TypeScript. Explicit local or
installed-package plugins can add custom deterministic handlers without
modifying Taxonome. No Scope backing services are needed.

The generic runtime is `packages/taxonomy-engine`; the shipped
agent-behavior definitions and Timeout handler are isolated in
`packages/ax-taxonomy`. The CLI explicitly composes both packages.

See [the architecture and usage guide](../../docs/architecture/taxonome.md)
for YAML and `extra.scope` contracts, archive safety, plugin authoring,
build/run/eval/optimization/replay commands, the typed API, evidence policy,
and scope limitations. A runnable custom project lives in
[`examples/taxonome-custom-handler`](../../examples/taxonome-custom-handler/README.md).
The language-neutral authoring/result/reference contract is the
[Trajectory Taxonomy Format](../../docs/architecture/trajectory-taxonomy-format.md).

`run`, `eval`, and `optimize` default to concise human-readable output even
when redirected. Pass `--json` for their complete machine-readable shapes.
`readout` always emits JSON and can optionally write Markdown.

`taxonome run` auto-detects single-run and multi-run Scope archives. Single-run
stdout remains unchanged. Multi-run archives require `--output-dir`, write one
atomic `<request-id>--<run-id>.json` record per root, and use
`--concurrency <1..16>` (default `4`). Compatible successful records resume
automatically without being rewritten; errors, corrupt/stale records, and
configuration or evidence-fingerprint mismatches are retried. Pass `--force`
to recompute every root. Archive scanning streams and discards workspace
snapshots, nested code archives, HAR, logs, and raw chat while retaining only
`run.yaml`, ATIF trajectories, and tool-call evidence.

Archive progress is visible before evaluation starts. TTYs use one throttled
scanner line, then switch to one stable row per archive root/run. Each row
shows final/run state, selected-element `DONE/RUN/WAIT` counts, and the active
element with `Prompt` or `Code` distinction. Rows remain in archive order;
narrow/short terminals keep active and failed runs visible and summarize
hidden rows. Non-TTY and `--json` modes emit bounded, plain append-only scan,
run, and element lifecycle lines on stderr. JSON stdout remains one document.

`--concurrency` bounds active runs, not elements. A worker evaluates one run's
selected elements sequentially in taxonomy order, reusing only its own healthy
prompt transport. An authored element error is recorded and later elements
continue when safe; poisoned transports are closed and replaced before the
next prompt element or run.

`taxonome readout` requires `--taxonomy` plus repeatable `--inputs` selections
covering the exact plain ATIF files or local Scope archives used by results.
Result arguments accept explicit files, directories, and quoted globs.
Taxonome matches normalized input identity/fingerprint, revalidates every
role/path/type/constraint, and resolves source attribution from ATIF.
Included error records add a failed-runs section and cause a nonzero exit while
preserving the partial JSON/Markdown report.

Prompt commands use `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` when
set; otherwise they securely resolve the active GitHub CLI account. No token is
printed or persisted.

Element preflight rules are authored under optional `preconditions` and
implemented as pure modules in
`packages/taxonomy-engine/src/preconditions/`, with one file per flag plus the
ordered evaluator.

From `packages/ax-taxonomy`, `pnpm eval` delegates directly to native
`taxonome eval` with quoted input/ground-truth globs. Add
`-- --element <stable-id>` to filter applicability to one element. Native eval
streams input/element progress, continues after reviewed failures, and keeps
`pnpm eval -- --json` as one clean machine document.

`--concurrency <1..16>` defaults to four global workers. Human TTYs receive a
fixed numeric in-place dashboard; non-TTY streams receive append-only
completion events. After a TTY dashboard, only a compact evaluation-level
Result line is printed; non-TTY human output retains detailed input rows.
Prompt workers own independent lazy SDK transports, while deterministic-only
workers never initialize the SDK.

The [recorded findings](../../docs/architecture/taxonome.md#recorded-spike-findings-2026-10-21)
link the actual SDK baselines, complete Ax artifacts, fresh final comparisons,
the historical one-off 256/500-call ledger, and deterministic JSON/Markdown
preview. The current CLI does not expose that ledger/budget feature.
