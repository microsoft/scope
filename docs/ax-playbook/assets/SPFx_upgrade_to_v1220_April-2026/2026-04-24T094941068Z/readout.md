# SPFx Project Upgrade — Readout

**Date:** April 28, 2026
**Scenario:** SPFx upgrade to v1.22.0 (implicit)
**Instruction:** "Upgrade the project to v1.22.0"
**Scenario type:** Code
**Workspace snapshot:** spfx-1211-webpart-react (SPFx v1.21.1 → v1.22.0)
**Runs per profile:** 5
**Benchmark:** 2026-04-24T094941068Z

---

## Layer 1: Scorecard

### Scenario drill-down: SPFx upgrade to v1.22.0

```
Scenario: SPFx upgrade to v1.22.0 (implicit)

Profile                                                        Δ lift  Δ defects  Δ tokens  Select  Build  Test  Run  Idiomatic  Currency  Config   Defects    Tokens
─────────────────────────────────────────────────────────────  ──────  ─────────  ────────  ──────  ─────  ────  ───  ─────────  ────────  ──────   ───────    ──────
Copilot Chat · Claude Sonnet 4.6 · bare                          —       —          —        1/5    1/1    1/1  1/1    1/1        0/1       0/1     0 avg     1,535k avg
Copilot Chat · Claude Sonnet 4.6 · + anti-hallucination skill  +0.03    —         −646k      2/5    2/2    2/2  2/2    2/2        0/2       0/2     0 avg       889k avg
Copilot Chat · Claude Sonnet 4.6 · + CLI for Microsoft 365    +0.17    —         −647k      5/5    5/5    N/A  5/5    4/5        2/5       0/5     0 avg       888k avg
Copilot Chat · Claude Sonnet 4.6 · + skill + context7 MCP     −0.30    —          N/A       0/5     —      —    —      —          —         —      0 avg       859k avg
```

**Code generation rate:** All profiles: 100%

**Δ tokens note:** Bare baseline has 1 Select-passing run (n=1, 4,175k tokens), making per-successful-run token comparison fragile. Δ tokens shown uses all-run averages instead. All extension profiles use ~650k fewer tokens than bare's all-run average (1,535k), primarily because bare consumes more requests (40.4 avg vs. ~29 for others).

### How to read this table

- **Select 1/5 → 5/5 (CLI) but 1/5 → 0/5 (skill + context7 MCP).** The CLI for Microsoft 365 eliminates version-targeting failures entirely. The anti-hallucination skill provides marginal improvement (2/5). Adding context7 MCP on top of the skill makes things *worse* — the agent discovers but never invokes the MCP tools and instead follows misleading documentation, failing Select in every run.
- **Build, Test, Run: 100% when reached.** Every run that passes Select also builds, tests (when tests are produced), and runs successfully. The challenge is targeting the correct version, not compilation or execution.
- **Test: 1/1 (bare), 2/2 (skill), N/A (CLI).** The Test gate checks whether the project has runnable tests and executes them. All profiles start from the same snapshot. Bare and skill Select-passing runs retain a working test setup and pass. The CLI profile migrates the build system from gulp to heft, which changes the test pipeline — all 5 CLI runs show Test as N/A, meaning the platform found no runnable test command after the migration. The CLI's upgrade instructions restructure package.json scripts but may not fully configure heft's test runner.
- **Idiomatic: 1/1 → 4/5 (CLI) and 2/2 (skill).** Both the bare and skill profiles achieve perfect idiomatic pass rates on their Select-passing runs. The CLI achieves 4/5, but 1 run still fails both ESLint rule criteria due to an agent execution error (combined separate ADD/REMOVE operations into a single replacement), not a CLI output issue.
- **Currency: 0/1 → 2/5 (CLI).** The CLI profile is the only one with any currency dimension passes. The bare and skill profiles both fail on css-loader and @types/react resolution. The CLI fixes those but introduces inconsistency on other dependencies (css-loader 2/5, @types/heft-jest 3/5, @typescript-eslint/parser 4/5).
- **Config: 0/N for all profiles.** No profile achieves complete configuration correctness in any run. This is the universal failure dimension.

### Lift interpretation

**CLI for Microsoft 365 (+0.17 Δ lift)** delivers its value through two axes:

1. **Reliability lift (Select: +0.80).** The `m365 spfx project upgrade --toVersion 1.22.0` command pins the correct target version, eliminating the bare profile's dominant failure mode.
2. **Currency lift (Currency: +0.40).** The CLI provides dependency version guidance that the bare profile lacks entirely.

The lift is moderated by:
- **Idiomatic use (−0.20).** The bare profile's single Select-passing run achieved perfect idiomatic scores (1/1), while the CLI achieves 4/5. This is a statistical artifact of bare's n=1 — 4/5 on 5 runs is more meaningful than 1/1 on 1 run.
- **Configuration correctness (0.00).** Both profiles fail every run. The CLI dramatically improves per-criteria pass rates (69/80 vs. 7/16) but persistent gaps prevent any run from clearing the dimension.

**Anti-hallucination skill (+0.03 Δ lift)** provides minimal improvement. The Select gain (+0.20) is real but modest — 2/5 vs. 1/5. All other dimensions show zero delta because the skill doesn't provide SPFx-specific upgrade knowledge.

**Skill + context7 MCP (−0.30 Δ lift)** is actively harmful. Adding context7 MCP drops Select from 2/5 (skill alone) to 0/5. The root cause: the MCP tool descriptions don't match SPFx upgrade vocabulary (VocabularyMismatch 5/5), so the agent never successfully invokes context7 for relevant documentation. Instead, it falls back to fetching Microsoft Learn pages directly, which contain v1.22.1 examples. The model then prioritizes these documentation version numbers over the user's explicit v1.22.0 request (ToolOutputOverWeighting 5/5).

### Criteria breakdown: SPFx upgrade to v1.22.0

```
Profile comparison (Select-passing runs only)
  bare: 1 run  |  skill: 2 runs  |  CLI: 5 runs  |  skill+ctx7: 0 runs (not evaluable)

Dependency currency
  Criterion                                    bare    skill   CLI
  ─────────────────────────────────────────    ────    ─────   ───
  SPFx runtime dependencies at 1.22.0          1/1      2/2    5/5
  SPFx build rig and plugins at 1.22.0         1/1      2/2    5/5
  Heft build system at correct version         1/1      2/2    4/5    ← CLI run 4 used wrong version
  TypeScript at 5.8.x                          1/1      2/2    5/5
  @typescript-eslint/parser version            1/1      2/2    4/5    ← CLI run 4 used wrong version
  @rushstack/eslint-config version             1/1      2/2    5/5
  css-loader version                           0/1      0/2    2/5    ← CLI report includes 7.1.2 but agent ignores script
  @types/heft-jest version                     1/1      2/2    3/5    ← CLI runs 4,5 used wrong version
  Legacy build dependencies removed            1/1      2/2    4/5    ← CLI run 4 retained legacy deps
  @types/react resolution                      0/1      0/2    5/5    ← fixed by CLI

  Dimension pass rate                          0/1      0/2    2/5

Configuration correctness
  Criterion                                    bare    skill   CLI
  ─────────────────────────────────────────    ────    ─────   ───
  .yo-rc.json version                          0/1      0/2    5/5    ← fixed by CLI
  .yo-rc.json useGulp                          0/1      0/2    5/5    ← fixed by CLI
  tsconfig.json extends build rig              1/1      2/2    4/5
  config/rig.json created                      1/1      2/2    5/5
  config/typescript.json created               1/1      1/2    3/5    ← intermittent across all profiles
  package.json scripts.build uses heft         1/1      2/2    4/5
  package.json scripts.clean uses heft         0/1      2/2    3/5
  package.json scripts.start uses heft         0/1      0/2    5/5    ← fixed by CLI
  package.json scripts.eject-webpack           0/1      0/2    4/5    ← mostly fixed by CLI
  package.json main property removed           0/1      0/2    5/5    ← fixed by CLI
  package.json overrides for @rushstack/heft   0/1      0/2    4/5    ← mostly fixed by CLI
  package.json gulp test script removed        1/1      2/2    4/5
  gulpfile.js removed                          1/1      2/2    5/5
  src/index.ts removed                         0/1      0/2    4/5    ← mostly fixed by CLI
  .gitignore updated for heft output           0/1      0/2    5/5    ← fixed by CLI
  SASS configuration updated                   1/1      2/2    4/5

  Dimension pass rate                          0/1      0/2    0/5

Idiomatic use
  Criterion                                    bare    skill   CLI
  ─────────────────────────────────────────    ────    ─────   ───
  ESLint import-requires-chunk-name rule       1/1      2/2    4/5    ← CLI run 1 failed
  ESLint pair-react-dom-render-unmount rule    1/1      2/2    4/5    ← CLI run 1 failed

  Dimension pass rate                          1/1      2/2    4/5
```

**Key observations from criteria breakdown:**

- **CLI for Microsoft 365 fixes 8 configuration criteria** that bare consistently misses (.yo-rc.json version and useGulp, scripts.start, scripts.eject-webpack, main property removed, .gitignore updated, @types/react resolution, src/index.ts removed). These are all explicitly covered by the CLI's upgrade report.
- **css-loader version fails across all profiles** (bare 0/1, skill 0/2, CLI 2/5). The CLI report includes `css-loader@7.1.2` in both finding FN002033 and the summary script, but 4 of 5 CLI runs ignored the script and manually edited package.json — introducing version errors. The single run that executed the npm commands (run 5) got css-loader correct.
- **Config dimension fails for ALL profiles** despite the CLI achieving 69/80 criteria (86%). The remaining failures are distributed across different criteria per run, preventing any single run from achieving full correctness. The most persistent gap is config/typescript.json creation (3/5), followed by various package.json scripts entries.
- **Idiomatic use: CLI achieves 4/5.** The ESLint rule migration succeeds in 4 of 5 runs. Only CLI run 1 fails both ESLint criteria.
- **Bare and skill profiles achieve perfect idiomatic scores** on their Select-passing runs (1/1 and 2/2), but with very small sample sizes. The agent gets ESLint right when it targets the correct version.

---

## Layer 2: Behavior Analysis

### Bare profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · bare

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            1/5   SPFx v1.22 release notes (learn.microsoft.com)
               Discovered            1/5   Migration guide (migrate-gulptoolchain-hefttoolchain)
               Discovered            1/5   Both release notes and migration guide

Consumption    Content misused       4/5   Migration guide hardcodes v1.22.1 in npm install examples

Execution      Wrong outcome         4/5   package.json — agent installed v1.22.1 instead of v1.22.0

Recovery       No recovery           1/5   package.json — agent did not detect wrong version
```

**Bare behavior summary:** The agent discovers Microsoft's migration guide, which hardcodes `@1.22.1` in all npm install examples. In 4 of 5 runs, the agent faithfully follows these examples, installing v1.22.1 instead of v1.22.0. The single passing run (run 4) consumed 4,175k tokens — nearly 3× the average of failing runs — suggesting the agent needed significantly more effort to arrive at the correct version independently.

### Anti-hallucination skill profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + anti-hallucination skill

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            2/5   Migration guide (migrate-gulptoolchain-hefttoolchain)
               Discovered            1/5   Both release notes and migration guide

Invocation     Correct invocation    1/5   Release notes page accessed via fetch_webpage
               Correct invocation    1/5   Migration guide instructions followed

Consumption    Content misused       4/5   Migration guide hardcodes v1.22.1 in npm install examples

Execution      Wrong outcome         2/5   package.json — agent installed wrong version
               Wrong outcome         1/5   Migration guide led to wrong version
               Partially correct     1/5   Multiple files partially upgraded
               Partially correct     1/5   Most files correct, some gaps

Recovery       No recovery           2/5   package.json — agent did not detect wrong version
               No recovery           1/5   Migration guide — agent did not cross-reference versions
```

**Skill behavior summary:** The anti-hallucination skill marginally improves Select (2/5 vs. 1/5) by making the agent slightly more cautious about version numbers. But the migration guide's v1.22.1 examples still dominate — 4/5 runs encounter the same ContentMisused pattern as bare. The skill doesn't provide SPFx-specific version mappings, so it can only reduce hallucination tendencies generally, not override specific misleading documentation.

### CLI for Microsoft 365 profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + CLI for Microsoft 365

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            5/5   m365 spfx project upgrade command

Invocation     Correct invocation    5/5   m365 spfx project upgrade --toVersion 1.22.0 --output md

Consumption    Script ignored        4/5   CLI summary script (npm un, npm i -SE, npm i -DE, npm dedupe)
               Script used           1/5   CLI summary script — run 5 executed all npm commands

Execution      Partially correct     5/5   Most upgrade steps applied, residual gaps per run

Recovery       (none observed)
```

**CLI behavior summary:** The agent consistently discovers and correctly invokes the `m365 spfx project upgrade` command (5/5 discovery, 5/5 correct invocation). The CLI output provides comprehensive upgrade instructions that the agent follows with high fidelity (69/80 configuration criteria pass, 42/50 currency criteria pass). ContentMisused drops from 4/5 (bare/skill) to 0/5 (CLI) — the CLI's structured output eliminates the migration guide's version-number trap entirely.

A notable consumption pattern: the CLI's `--output md` format includes both individual findings AND a summary section with runnable shell commands (`npm un`, `npm i -SE`, `npm i -DE`, `npm dedupe`). In 4 of 5 runs, the agent ignored the provided script entirely and instead manually edited package.json dependency version strings using file editing tools. Only run 5 executed the npm commands — using a hybrid approach (manual edits for config/structural changes, npm commands for dependency changes). The agent's default behavior is to treat the CLI report as a specification document and reimplement its instructions via file edits, bypassing the provided automation.

The ESLint failure in run 1 (idiomatic 4/5) is an agent execution error — the agent combined separate ADD and REMOVE operations into a single in-place replacement — not a content quality issue. The CLI's ESLint findings (FN025002–FN025005) are clear and correctly structured; 4 of 5 runs interpreted them correctly.

### Skill + context7 MCP profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + anti-hallucination skill + context7 MCP

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Invocation     Skipped invocation    5/5   context7 MCP tools registered but not invoked

Consumption    Content misused       5/5   Migration guide hardcodes v1.22.1 in npm install examples

Execution      Wrong outcome         5/5   package.json — agent installed wrong version

Recovery       No recovery           3/5   Agent did not detect wrong version
```

**Skill + context7 behavior summary:** The context7 MCP server is never effectively used. The MCP tools are registered in the agent's tool list in every run, but the agent skips invocation in all 5 runs. The root cause is VocabularyMismatch — the MCP tool descriptions (generic documentation lookup) don't match SPFx upgrade terminology, so the agent doesn't recognize them as relevant. Without MCP-sourced content, the agent falls back to fetching Microsoft Learn pages directly and follows the v1.22.1 examples in every run (ContentMisused 5/5, WrongOutcome 5/5). The context7 MCP doesn't just fail to help — it appears to consume agent attention during tool discovery, reducing the runs available for productive work.

---

## Layer 3: What to Fix

### CLI for Microsoft 365 action list

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + CLI for Microsoft 365

FIX (existing extension points)
Priority  Root Cause               Runs Affected  Behavior → Effect                                                Fix Target
────────  ──────────               ─────────────  ─────────────────                                                ──────────
  1       ScriptIgnored            4/5            Agent ignores CLI summary script and manually edits              CLI for Microsoft 365 — change --output md
                                                  package.json dependency versions via file editing tools.          to a format that foregrounds the script as
                                                  Manual edits introduce version errors (css-loader 2/5,           the primary action, or add explicit
                                                  @types/heft-jest 3/5) despite correct versions being             instructions in the report to run the
                                                  present in the CLI's summary script. Run 5 (ScriptUsed)          provided commands rather than manually
                                                  executed the npm commands and got all versions correct.           editing files.

CONSTRAINT (cannot fix via extension points)
Priority  Constraint               Runs Affected  Behavior → Effect                                                Mitigation
────────  ──────────               ─────────────  ─────────────────                                                ──────────
  —       StaleTrainingData        1/5            Base model occasionally uses outdated dependency versions         Script execution (#1) bypasses model
                                                  when manually editing package.json                               version knowledge entirely
```

### Bare profile action list

```
Profile: Copilot Chat · Claude Sonnet 4.6 · bare

FIX (existing extension points)
Priority  Root Cause               Runs Affected  Behavior → Effect                                                Fix Target
────────  ──────────               ─────────────  ─────────────────                                                ──────────
  1       ResponseFormat           2/5            Content misused → agent installs v1.22.1 from docs              Microsoft Learn migration guide
                                                  examples (contributes to 4/5 Select failures)                   (migrate-gulptoolchain-hefttoolchain):
                                                                                                                   replace hardcoded @1.22.1 with version-
                                                                                                                   variable examples or @latest

CREATE (new extension points)
Priority  Gap                      Runs Affected  Behavior → Effect                                                What to Build
────────  ───                      ─────────────  ─────────────────                                                ─────────────
  2       MissingGroundingContent  4/5            No recovery → agent has no fallback when docs lead to           Skill: SPFx version upgrade workflow with
                                                  wrong version; no instruction to cross-check target              version targeting, dependency version
                                                  version against user request                                     manifest, and configuration checklist

CONSTRAINT (cannot fix via extension points)
Priority  Constraint               Runs Affected  Behavior → Effect                                                Mitigation
────────  ──────────               ─────────────  ─────────────────                                                ──────────
  —       ToolOutputOverWeighting  4/5            Agent follows documentation version numbers verbatim             Migration guide fix (#1) eliminates the
                                                  without cross-checking against user's explicit request           trigger; skill (#2) adds verification step
```

---

## Summary

### Profile comparison

| Metric | bare | + skill | + CLI for M365 | + skill + ctx7 |
|---|---|---|---|---|
| Select | 1/5 | 2/5 | **5/5** | 0/5 |
| Build | 1/1 | 2/2 | **5/5** | — |
| Test | 1/1 | 2/2 | N/A | — |
| Run | 1/1 | 2/2 | **5/5** | — |
| Idiomatic (dimension) | 1/1 | 2/2 | **4/5** | — |
| Currency (dimension) | 0/1 | 0/2 | **2/5** | — |
| Config (dimension) | 0/1 | 0/2 | 0/5 | — |
| Avg tokens (all runs) | 1,535k | 889k | **888k** | 859k |
| Avg requests | 40.4 | 29.0 | **28.8** | 28.8 |
| Δ lift | — | +0.03 | **+0.17** | −0.30 |

### Key findings

1. **CLI for Microsoft 365 is the only effective extension point.** It delivers reliable version targeting (5/5 Select), strong dependency currency (2/5 dimension, 42/50 criteria), and dramatically improved configuration correctness at the criteria level (69/80 vs. 7/16 bare). No other profile approaches this level of performance.

2. **Anti-hallucination skill provides marginal improvement.** Select improves from 1/5 to 2/5, but the skill lacks SPFx-specific knowledge. The 2 Select-passing runs show identical weakness patterns to bare — the skill prevents hallucination generally but can't override specific misleading documentation content.

3. **Context7 MCP is actively harmful for this scenario.** Adding context7 MCP drops Select from 2/5 (skill alone) to 0/5. The MCP tool descriptions don't match SPFx upgrade vocabulary, so the agent never invokes them. The MCP server's presence appears to consume agent attention without providing useful content, while the agent still falls victim to the migration guide's v1.22.1 examples.

4. **Configuration correctness is the universal ceiling.** No profile achieves a single run with complete configuration correctness. For the CLI profile, 69/80 criteria pass (86%) but the remaining failures are distributed across different criteria per run, preventing any run from clearing the dimension bar. The most persistent gap is config/typescript.json creation (3/5), followed by various package.json scripts entries.

5. **ESLint idiomatic use: CLI achieves 4/5.** Bare and skill both achieve perfect idiomatic scores on their Select-passing runs. The single CLI failure (run 1) is an agent execution error — the agent combined separate ADD/REMOVE operations into one replacement — not a CLI output quality issue. The CLI's ESLint findings are clear and correctly structured.

### Investment recommendation

| Priority | Action | Owner | Expected impact |
|---|---|---|---|
| 1 | Fix migration guide hardcoded v1.22.1 examples | SPFx docs team | Bare Select: 1/5 → ~5/5 (eliminates dominant failure mode) |
| 2 | Encourage script execution over manual file edits (output format or instructions) | CLI for Microsoft 365 team | Currency dimension: 2/5 → ~5/5 (script has all correct versions) |
| 3 | Do **not** recommend context7 MCP for SPFx upgrade scenarios | — | Avoid −0.30 Δ lift regression |
