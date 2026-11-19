# Static Prompt Evaluations

This workspace runs Scope-owned static prompt families through production
TypeScript adapters and grades the generated JSONL with the Azure AI Evaluation
SDK. Cloud red teaming is extracted into a separate dependent contribution.
The extraction does not change the normal evaluations or the evidence shared
with OneRAI; no historical review findings are fixed by this scope change.

Read [the architecture and maintenance guide](../../docs/architecture/prompt-evaluations.md)
before changing adapters, datasets, rubrics, or thresholds.

## Setup

From the repository root:

```bash
pnpm install
pnpm --filter static-prompt-evals... build
pnpm --filter static-prompt-evals setup:python
az login
```

The dependency-inclusive build prepares `shared` and `telemetry` before checking
the production-backed adapters. Both are declared workspace dependencies so
clean recursive builds use the same ordering without pre-existing `dist` files.

The setup and evaluation commands check for `uv` first. If it is unavailable,
they stop before execution and print platform-specific installation guidance
linked to Astral's official instructions.

Set the prompt-evaluation environment variables described in
[`ENV_VARIABLES.md`](../../ENV_VARIABLES.md#prompt-evaluation-configuration).
Do not put credentials or project/model endpoints in committed files.

Quality generation uses `PROMPT_EVAL_MODEL` plus the existing inference
credentials. Quality grading requires
`SCOPE_EVAL_AZURE_OPENAI_ENDPOINT` and
`SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT` (or their `AZURE_OPENAI_*` fallbacks);
an API key is optional because `DefaultAzureCredential` is supported.

## Commands

```bash
# Run normal static prompt evaluations (quality is the default)
pnpm eval:prompts -- --mode quality

# Convenience commands
pnpm eval:static-prompts
pnpm eval:static-prompts:smoke

# Refresh and validate committed inputs
pnpm eval:static-prompts:harvest -- --project-name "Default Project"
pnpm eval:static-prompts:validate-data

# Package tests and type checking
pnpm --filter static-prompt-evals test
pnpm --filter static-prompt-evals typecheck

# Render an ignored Markdown report for an existing run
pnpm --filter static-prompt-evals report -- \
  results/<run-id>
```

Quality generation defaults to three samples per nondeterministic case. Pass
additional runner arguments after `--`, for example:

```bash
pnpm eval:prompts -- --mode quality --samples 5
```

The command returns nonzero for policy/threshold failures and infrastructure
failures. Inspect the run manifest to distinguish them. The offline smoke
command records deterministic prompt-policy failures in `policyStatus` but
returns success when the framework itself completes.

The Azure AI Evaluation SDK does not provide a native Markdown report
exporter. The package report command renders `REPORT.md` from the persisted
shared `quality/decision-summary.json`, summary, and finding artifacts. Reports lead
with execution, acceptance, and evaluator integrity, then blocking gate
violations—not an unweighted average. Reports remain inside the
ignored run directory unless `--output` explicitly selects another path.
Gate rows explain incomplete coverage even when every evaluated case passed.
Displayed mean scores are rounded for readability; decisions use unrounded values.
Existing historical reports cannot be overwritten: provide a new `--output`.
For a legacy canvas/client, `--decision-output NEW_PATH --decision-only` exports the same
hash-verified historical decision without changing source artifacts.
The destination must be outside the source run and must not already exist.

The runner accepts `--samples N`, `--smoke`, `--results-dir PATH`, and
`--dataset PATH`. The existing `--mode quality` command is unchanged.
`--mode red-team` and `--mode both` are rejected before execution.

### Replay original responses without regeneration

Run these commands from this package directory. Always use explicit absolute
source/new-run paths rather than selecting the latest directory.

```bash
# No credentials or paid calls: reparse native output and list affected graders.
uv run python -m static_prompt_evals.cli --mode quality \
  --source-run /absolute/path/to/results/SOURCE_RUN --offline

# Review NEW_RUN/quality/replay-plan.json, then explicitly select affected graders.
# This command may make paid Azure calls, but makes ZERO generator calls.
uv run python -m static_prompt_evals.cli --mode quality \
  --source-run /absolute/path/to/results/SOURCE_RUN \
  --regrade parent-dependency-suggestion/relevance \
  --regrade parent-dependency-suggestion/dependency_direction

uv run python -m static_prompt_evals.report /absolute/path/to/results/NEW_RUN

# Export only the legacy decision into an alternate canvas preview directory.
uv run python -m static_prompt_evals.report /absolute/path/to/results/SOURCE_RUN \
  --decision-output /absolute/path/to/EXTERNAL_PREVIEW/quality/decision-summary.json \
  --decision-only
```

Selections are repeatable, exact `family/evaluator` keys. Unselected affected
graders remain unresolved; no automatic scope growth occurs. Native output is
reused only when mapped inputs and resolved grader specifications match and
the source configuration hash can be verified. Regrading requires the original
evaluator deployment and SDK version. All original case IDs, sample indices,
inputs, responses, and model metadata are retained. The current dataset and
sample flags do not change source selection. `--source-run` is quality-only and
cannot combine with `--smoke`.

Each replay creates a new ignored run. `replay-plan.json` records affected
graders, per-grader provenance and hashes; `source-integrity.json` verifies
the original run stayed unchanged and zero generator calls occurred;
`comparison.json` distinguishes policy-only changes from parser corrections
and newly graded outcomes. Unknown historical generator revisions/models and
missing tool traces remain explicit limitations, not invented coverage.
The plan also supplies `regradeArgv` and shell-quoted `regradeCommand` for
reviewed execution of the complete affected set.

The current rubric edits formerly higher aggregate pass-rate floors to 80%;
lower floors remain unchanged. This policy lives only in `rubrics.yaml`:
the generic evaluator accepts configured rates through 100% without clamping
them or baseline-derived requirements. Individual schema/security checks and minimum mean scores are still
exact. For 25 cases, 20 passing meets 80%, whereas 19 fails. Native malformed
labels/scores are invalid assessments, not failed prompt votes. Old runs use
their original hash-matched policy, including former 100% floors. See the
architecture guide for the full decision schema and incomplete-coverage math.

The harvester defaults to the integration base URL, `Default Project`, dataset
version `v1`, seed `scope-static-prompts-v1`, and this package's `datasets/`
directory. Available overrides are `--base-url`, `--project-id` or
`--project-name`, `--dataset-version`, `--seed`, `--output-dir`, and
`--token-env` (the last names an environment variable; it is not the token
itself). Use `--harvested-at <ISO timestamp>` for byte-for-byte reproducible
regeneration. Validation accepts `--dataset-root`.

Equivalent package-local commands are:

```bash
pnpm --dir evaluations/static-prompts harvest -- \
  --project-name "Default Project" \
  --dataset-version v1 \
  --seed scope-static-prompts-v1
pnpm --dir evaluations/static-prompts validate-data

# Protected integration environments, after securely exporting SCOPE_API_TOKEN
pnpm --dir evaluations/static-prompts harvest -- \
  --token-env SCOPE_API_TOKEN
```

The validator reads `evaluation-manifest.yaml`, `evaluators/rubrics.yaml`,
`datasets/manifest.json`, and the versioned JSONL files. Run its focused tests
with:

```bash
pnpm --dir evaluations/static-prompts exec vitest run \
  scripts/harvest.test.ts \
  scripts/validate-dataset.test.ts \
  scripts/dataset-adapter-contract.test.ts
```

The CLI retains `datasets/quality-cases.jsonl` as its legacy default argument.
When that file is absent, the quality loader follows the ordered file list in
`datasets/manifest.json` and verifies every SHA-256 and row count. It does not
discover inputs by globbing `datasets/v1/`.

## Authoring quality cases

Curated JSONL is input, not generated output. Each reviewed row must include:

- a stable case ID, `family`, and `variant`;
- JSON-serializable adapter input;
- deterministic and AI-assisted evaluator names;
- reviewed expectations or labels;
- a source category and human-approved state; and
- provenance: source endpoint, project ID, source entity IDs, harvest time,
  code revision, selection seed, and content hashes.

`task-prompt-variation` rows use `input.existingPrompt`,
`input.existingPrompts`, and `input.description`; their reviewed reference is
`expected.referenceTaskPrompt`. There is no separate `guidance` field.

Use the harvester for candidates, then minimize, redact, deduplicate, balance,
and review them. Integration is never contacted by normal tests or evaluation
runs. Do not hand-edit generated output into the curated dataset.

When adding or changing a static family:

1. register it in `evaluation-manifest.yaml`;
2. add or update the production TypeScript adapter;
3. add approved curated cases;
4. add deterministic assertions and rubric mappings; and
5. run data validation, tests, the fake-model smoke path, and the relevant real
   quality command.

Adapters must call production prompt composition and parsing. Do not copy
production prompt text into this package.

## Results and version control

Every invocation creates:

```text
results/<run-id>/
  manifest.json
  quality/
    selected-cases.jsonl
    production-rows.jsonl
    normalized-rows.jsonl
    deterministic-row-results.jsonl
    azure-row-results.jsonl
    azure-native/
      index.json
      <family>/
        <evaluator>-input.jsonl
        <evaluator>.json
        <evaluator>-diagnostics.json
    findings.json
    summary.json
    decision-summary.json
    rubric-snapshot.yaml
    # Source-replay runs also include:
    replay-plan.json
    source-integrity.json
    source-rubric-snapshot.yaml
    comparison.json
```

The runner updates `manifest.json` even on partial or infrastructure failure.
Native evaluator diagnostics preserve redacted SDK batch/per-row errors even
when the SDK returns rows without `outputs.*`. The index links their sidecars
with `diagnosticArtifact`. Local SDK validator/converter preflight rejects
invalid tool-call message shapes before a paid evaluation call.

For focused quality-engine validation:

```bash
cd evaluations/static-prompts
uv run pytest tests/quality tests/test_report.py tests/test_cli.py --basetemp=results/test-work -q
uv run python -m static_prompt_evals.cli --mode quality
```

The default generation subprocess runs from this package as:

```bash
pnpm generate -- \
  --input <selected-cases.jsonl> \
  --output <production-rows.jsonl> \
  --samples <N>
```

`results/` is ignored. Never commit generated responses, SDK/cloud output, run
manifests, summaries, findings, or portal URLs. Commit only curated inputs and
their provenance, schemas, rubrics, reviewed threshold policy, and evaluator
configuration. Existing OneRAI evidence remains outside version control and is
not regenerated or modified as part of extracting red teaming.
