# Static Prompt Evaluations

This workspace runs Scope-owned static prompt families through production
TypeScript adapters and grades the output JSONL with deterministic checks and,
for generative families, the Azure AI Evaluation SDK. Cloud red teaming is
extracted into a separate dependent contribution.
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

Generative quality targets use `PROMPT_EVAL_MODEL` plus the existing inference
credentials. AI-assisted quality grading requires
`SCOPE_EVAL_AZURE_OPENAI_ENDPOINT` and
`SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT` (or their `AZURE_OPENAI_*` fallbacks);
an API key is optional because `DefaultAzureCredential` is supported.
The non-generative `contribution-decision` target uses a separate, explicitly
configured Microsoft-Decision-1 deployment and no Azure grader. Setting
`PROMPT_EVAL_MODEL` to a decision-model name does not configure that transport.

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

## Community contribution families

Two independent families cover the report-only P0 community-PR pipeline:

| Family | Responsibility | Evaluation |
| --- | --- | --- |
| `contribution-insights/default` | Copilot supplies all insights, evidence, limitations, reviewer brief, and feedback drafts | Production schema/Markdown checks and insight-quality graders |
| `contribution-decision/default` | Microsoft-Decision-1 alone selects the authoritative final review-action classification from captured facts and fixed Copilot insights | Production response parsing, generation/schema checks, and deterministic `decision_accuracy` |

Neither stage approves or rejects a PR, posts feedback, or establishes merge
readiness. Human approval requirements remain unchanged.

### Copilot insights only

`contribution-insights/default` evaluates schema-version-2 Copilot assessments.
The production validator rejects both `recommendation` and `decision` fields
from Copilot. This family's rubric rewards complete, evidence-grounded insights
across all six P0 scenarios, not a final action; the former
`contribution_decision` label grader is no longer assigned to it.

Its adapter reads the actual workflow instructions and report-tool contract,
loads trusted repository policies through the production helper, and uses the
production validator and renderer. The gh-aw engine wrapper, sandbox, and
native file transport are not reproduced; request fidelity is explicitly
`partial`.

For a real local assessment before deploying the Actions workflow:

```bash
pnpm contribution-insights:local --pr 1492
```

This runs the installed Copilot CLI through a restricted, isolated SDK session,
using `gh` authentication (or `COPILOT_GITHUB_TOKEN` for inference). It reuses the
same prompt/collector/report contract and saves local-only artifacts in
`results/contribution-insights-local/`. It never dispatches Actions or posts
feedback. The native run is not the hosted gh-aw sandbox or threat-detection
pipeline, and is separate from the static-prompt evaluation baseline.
Without an enabled Decision-1 stage, the local command preserves the Copilot
insights but reports no final decision; Copilot never becomes a fallback
decision-maker. After securely configuring an existing deployment, `--decision`
requires that stage, or `CONTRIBUTION_DECISION_ENABLED=true` enables it by
environment.

Eight synthetic contract fixtures cover documentation-only changes, Portal/CLI
parity, skipped fork checks and CLA, overlapping work, authentication/project
isolation, truncated evidence, product decisions, and dependency notices.
They are not assessments of real PRs at their example URLs. The repository
workflow has no Scope integration endpoint, so harvesting retains these
explicit synthetic fixtures alongside the integration-derived families.
Expectations remain subject to normal human review before merge.

Run the focused insights plumbing smoke from the repository root:

```bash
pnpm --filter static-prompt-evals evaluate:quality -- \
  --smoke --offline --samples 1 \
  --dataset datasets/v1/contribution-insights.jsonl
```

Smoke mode selects one case per family; the dataset adapter-contract suite
parses all eight fixtures. Fake-model output verifies plumbing and deterministic
contracts, not AI triage quality. A real model-quality baseline requires
explicit approval. See
[Contribution Insights](../../docs/architecture/contribution-insights.md)
for workflow operation and the separate hosted rollout.

### Authoritative Decision-1 classification

The decision adapter validates the fixed Copilot assessment with the production
schema-version-2 report parser, binds it to exactly one captured PR/head SHA,
and calls the production `buildDecisionInput`. Every Copilot insight is retained;
previous decisions and expected classifications are not model input. Trusted
questions come from the production helper, never an evaluation-only prompt copy.

The optional typed `AdapterContext.decide` seam calls production `callDecision`
at the Foundry resource's `/providers/microsoft/v1/systemone` route with
`{model: deployment, state, questions}`. It never sends the decision through
chat completions, Copilot, another service, or a locally trained substitute.
`request.decisionRequest` retains the actual state/questions payload. Any
chat-role messages are only a grader projection with `fidelity: partial`;
Python normalization retains the native request separately as `decision_request`.

Protocol grounding:

- The [Foundry Decision-1 how-to](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision)
  defines the typed `choice` request and selected option with per-option probabilities.
- Microsoft's [Azure Databricks System One reference](https://learn.microsoft.com/en-us/azure/databricks/machine-learning/model-serving/query-systemone-models#response-format)
  documents the concrete `answers`, `confidence`, `probabilities`, and token-usage
  response structure. It is a format reference, not an alternative deployment or
  backend for this integration.

The production parser preserves confidence independently of the selected
option's probability, accepts small rounding error in the probability
distribution, and validates all five configured labels. The actual API JSON is
retained unchanged in `rawResponse`; normalized output also retains the returned
model, token usage, question version, input hash, and duration.

Real decision generation requires `CONTRIBUTION_DECISION_ENDPOINT` (an HTTPS
Foundry resource root), `CONTRIBUTION_DECISION_DEPLOYMENT`, and exactly one of
`CONTRIBUTION_DECISION_API_KEY` or `CONTRIBUTION_DECISION_ENTRA_TOKEN`. Selecting
this evaluation family explicitly requests Decision-1; missing or invalid
configuration fails closed as infrastructure, without an inference call or
fallback. The full committed dataset includes this family, so a real full run
requires its configuration as well as the generative targets' configuration.
No resources are provisioned by these commands. Only explicit HTTP 429s are
retried by the production client; timeouts, network failures, and 5xx responses
are not automatically repeated.

`datasets/v1/contribution-decision.jsonl` contains eight fixed hand-authored
Copilot insight fixtures plus captured synthetic facts, spanning the same eight
categories as the insights family. The truncation case tests
`manual-review-required` abstention; all five review-action classes have
reviewed expectations. Expected actions exist only in `expected.action`.
`decision_accuracy` compares the selected class exactly, including abstention;
it is not feature precision/recall, a prose-quality score, or a second LLM's
choice. No relevance, fluency, or Azure-assisted grader runs for this family.
Other families' historical thresholds and cases are unchanged.

Offline validation needs no deployment or credentials:

```bash
pnpm --filter static-prompt-evals evaluate:quality -- \
  --offline --samples 1 \
  --dataset datasets/v1/contribution-decision.jsonl
```

The fake decision transport always returns a production-parsed,
`manual-review-required` fixture with an explicit `fake: true` raw-response
marker and fake invocation source. It never reads expected labels or predicts
the desired answer. This verifies plumbing for all eight cases, not accuracy,
calibration, hosted operation, or a live Decision-1 quality baseline. A real
endpoint compatibility and quality run requires separate approval and an
existing deployment; none is implied by offline success.

## Authoring quality cases

Curated JSONL is input, not generated output. Each reviewed row must include:

- a stable case ID, `family`, and `variant`;
- JSON-serializable adapter input;
- deterministic and, where applicable, AI-assisted evaluator names;
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
