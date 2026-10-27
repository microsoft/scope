# Taxonome

Standalone experimental YAML taxonomy CLI for plain ATIF and existing Scope run
archives. The initial taxonomy evaluates Skipped Invocation through Ax and the
Copilot SDK, and Timeout through deterministic TypeScript. Explicit local or
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

The [recorded findings](../../docs/architecture/taxonome.md#recorded-spike-findings-2026-10-21)
link the actual SDK baselines, complete Ax artifacts, fresh final comparisons,
cumulative 256/500-call ledger, and deterministic JSON/Markdown preview.
