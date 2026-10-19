# SPFx Project Upgrade — Readout

**Date:** April 28, 2026
**Scenario:** SPFx upgrade v1.21.1 to v1.22.2 (implicit)
**Instruction:** "Upgrade the project to v1.22.2"
**Scenario type:** Code
**Workspace snapshot:** spfx-1211-webpart-react (SPFx v1.21.1 → v1.22.2)
**Runs per profile:** 5
**Benchmark:** 2026-04-24T094941068Z

---

## Layer 1: Scorecard

### Scenario drill-down: SPFx upgrade to v1.22.2

```
Scenario: SPFx upgrade v1.21.1 to v1.22.2 (implicit)

Profile                                                        Δ lift  Δ defects  Δ tokens  Select  Build  Test  Run  Idiomatic  Currency  Config   Defects    Tokens
─────────────────────────────────────────────────────────────  ──────  ─────────  ────────  ──────  ─────  ────  ───  ─────────  ────────  ──────   ───────    ──────
Copilot Chat · Claude Sonnet 4.6 · bare                          —       —          —        5/5    5/5    5/5  5/5    3/5        0/5       0/5     0 avg     1,133k avg
Copilot Chat · Claude Sonnet 4.6 · + anti-hallucination skill  +0.06    —         −101k      5/5    5/5    5/5  5/5    5/5        0/5       0/5     0 avg     1,032k avg
Copilot Chat · Claude Sonnet 4.6 · + CLI for Microsoft 365    +0.20    —        +2,743k     5/5    5/5    N/A  5/5    3/5        4/5       2/5     0 avg     3,875k avg
Copilot Chat · Claude Sonnet 4.6 · + skill + context7 MCP     +0.03    —         −151k      5/5    5/5    5/5  5/5    4/5        0/5       0/5     0 avg       982k avg
```

**Code generation rate:** All profiles: 100%

**Δ defects note:** All profiles average 0 defects. Δ defects is not applicable.

**Δ tokens note:** The CLI profile uses ~3.4× more tokens than bare (3,875k vs. 1,133k), driven by the `m365 spfx project upgrade` command's output and the agent processing its detailed instructions (59 avg requests vs. 33.6 for bare).

### How to read this table

- **Select 5/5 across all profiles.** All profiles correctly target v1.22.2 in every run. v1.22.2 is the latest SPFx version — the agent consistently resolves to it regardless of extension point configuration. The challenge shifts entirely to upgrade quality.
- **Build, Test, Run: 100% across all profiles.** Every run compiles, passes tests (when produced), and runs successfully. Zero defects. The distinction between profiles is entirely in the quality dimensions.
- **Test: 5/5 (bare, skill, skill+ctx7), N/A (CLI).** The CLI-guided agent does not produce tests. The other profiles consistently do.
- **Idiomatic: 3/5 (bare, CLI) → 5/5 (skill) and 4/5 (skill+ctx7).** The skill profiles improve ESLint rule migration. The CLI provides explicit ESLint rule migration instructions, but the agent misapplies them in 2/5 runs — matching bare's failure rate.
- **Currency: 0/5 (bare, skill, skill+ctx7) → 4/5 (CLI).** Only the CLI profile achieves any dimension-level currency passes. The css-loader and @types/react criteria universally fail across all non-CLI profiles.
- **Config: 0/5 (bare, skill, skill+ctx7) → 2/5 (CLI).** Only the CLI profile achieves any config dimension passes, in the 2/5 runs where all 16 remaining config criteria pass.

### Lift interpretation

**CLI for Microsoft 365 (+0.20 Δ lift)** delivers its value through two axes:

1. **Currency lift (Currency: +0.80).** The `m365 spfx project upgrade --toVersion 1.22.2` command provides comprehensive dependency version guidance. The CLI profile achieves 49/50 currency criteria (98%) vs. bare's 34/50 (68%). The dimension pass rate jumps from 0/5 to 4/5 because the CLI resolves the two criteria (css-loader, @types/react) that bare universally fails.

2. **Config lift (Config: +0.40).** The CLI profile achieves 2/5 config dimension passes vs. 0/5 for bare. The two passing runs (d09f, d0a0) used `--output md` and clear all 16 config criteria. The three failing runs are blocked by config/rig.json (2 runs, both `--output text`) and config/typescript.json (3 runs, both formats). The `--output text` formatter drops the config/rig.json creation instruction (FN015014) entirely — a bug in the CLI's text output. At the criteria level, CLI achieves 75/80 (94%) vs. bare's 30/80 (38%).

The lift is moderated by:
- **Token cost (+2,743k).** The CLI profile uses 3.4× more tokens than bare. The high variance in CLI token usage (754k–7,471k across runs) suggests the agent sometimes struggles to process the CLI's upgrade report efficiently.
- **No idiomatic improvement (0.00).** The CLI provides explicit ESLint rule migration instructions (`Add override rule @rushstack/import-requires-chunk-name`, `Remove override rule @microsoft/spfx/import-requires-chunk-name`, etc.) in every run. The agent attempts the edit in all 5 runs and the tool reports success, but in 2/5 runs the rules are missing from the final workspace — the agent applies the edit to the wrong section of .eslintrc.js (ContentMisused).

**Anti-hallucination skill (+0.06 Δ lift)** delivers its value through idiomatic improvement:
- **Idiomatic: 3/5 → 5/5.** The skill profile achieves perfect ESLint rule migration across all 5 runs. The skill's general instruction to avoid hallucination appears to stabilize the agent's ESLint rule handling.
- **Token cost (−101k).** Slightly cheaper than bare.

**Skill + context7 MCP (+0.03 Δ lift)** shows minimal improvement:
- **Idiomatic: 3/5 → 4/5.** Slight improvement over bare but worse than skill alone (5/5). Adding context7 MCP may introduce noise that destabilizes the ESLint migration in 1/5 runs.
- **Context7 MCP server failed in 3/5 runs.** The MCP server didn't start in 3/5 runs (tools not registered). In the 2/5 runs where tools were available, the agent skipped them.

### Criteria breakdown: SPFx upgrade to v1.22.2

```
Profile comparison (all runs — all profiles pass Select 5/5)

Dependency currency
  Criterion                                    bare    skill   CLI     skill+ctx7
  ─────────────────────────────────────────    ────    ─────   ───     ──────────
  SPFx runtime dependencies at 1.22.2          5/5      5/5    5/5       5/5
  SPFx build rig and plugins at 1.22.2         5/5      5/5    5/5       5/5
  Heft build system at correct version         4/5      5/5    5/5       5/5
  TypeScript at 5.8.x                          4/5      5/5    5/5       5/5
  @typescript-eslint/parser version            4/5      5/5    5/5       5/5
  @rushstack/eslint-config version             4/5      5/5    5/5       4/5       ← skill+ctx7 run 2 X
  css-loader version                           0/5      0/5    5/5       0/5       ← fixed only by CLI
  @types/heft-jest version                     4/5      4/5    5/5       5/5
  Legacy build dependencies removed            4/5      4/5    4/5       5/5       ← CLI run 5 retained legacy deps
  @types/react resolution                      0/5      0/5    5/5       0/5       ← fixed only by CLI

  Dimension pass rate                          0/5      0/5    4/5       0/5

Configuration correctness
  Criterion                                    bare    skill   CLI     skill+ctx7
  ─────────────────────────────────────────    ────    ─────   ───     ──────────
  .yo-rc.json version                          1/5      0/5    5/5       0/5       ← fixed by CLI
  .yo-rc.json useGulp                          0/5      0/5    5/5       0/5       ← fixed by CLI
  tsconfig.json extends build rig              4/5      5/5    5/5       5/5
  config/rig.json created                      4/5      5/5    3/5       5/5
  config/typescript.json created               3/5      2/5    2/5       4/5       ← intermittent across all profiles
  package.json scripts.build uses heft         4/5      4/5    5/5       5/5
  package.json scripts.clean uses heft         3/5      5/5    5/5       5/5
  package.json scripts.start uses heft         0/5      1/5    5/5       1/5       ← fixed by CLI
  package.json scripts.eject-webpack           0/5      0/5    5/5       1/5       ← fixed by CLI
  package.json main property removed           0/5      0/5    5/5       0/5       ← fixed by CLI
  package.json overrides for @rushstack/heft   0/5      0/5    5/5       0/5       ← fixed by CLI
  package.json gulp test script removed        3/5      5/5    5/5       5/5
  gulpfile.js removed                          4/5      5/5    5/5       5/5
  src/index.ts removed                         0/5      0/5    5/5       0/5       ← fixed by CLI
  .gitignore updated for heft output           0/5      0/5    5/5       0/5       ← fixed by CLI
  SASS configuration updated                   4/5      5/5    5/5       5/5

  Dimension pass rate                          0/5      0/5    2/5       0/5

Idiomatic use
  Criterion                                    bare    skill   CLI     skill+ctx7
  ─────────────────────────────────────────    ────    ─────   ───     ──────────
  ESLint import-requires-chunk-name rule       4/5      5/5    4/5       4/5       ← bare R2–3, CLI R1+5, ctx7 R5 fail
  ESLint pair-react-dom-render-unmount rule    4/5      5/5    4/5       5/5       ← bare R2–3, CLI R1+5 fail

  Dimension pass rate                          3/5      5/5    3/5       4/5
```

**Key observations from criteria breakdown:**

- **CLI for Microsoft 365 fixes 9 configuration criteria** that bare universally misses (.yo-rc.json version and useGulp, scripts.start, scripts.eject-webpack, main property removed, overrides for @rushstack/heft, src/index.ts removed, .gitignore updated, plus @types/react resolution in currency). These are all explicitly covered by the CLI's upgrade report.
- **css-loader and @types/react fail across all non-CLI profiles** (0/5 each). These two criteria are the sole blockers preventing any non-CLI profile from achieving a single currency dimension pass. The CLI resolves both completely (5/5 each).
- **CLI achieves 2/5 config dimension passes.** The two passing runs (d09f, d0a0) both used `--output md`. The two `--output text` runs (d09e, d0a2) fail on config/rig.json because the text formatter drops the FN015014 finding entirely — the config/rig.json creation command is absent from text output while present in md output. config/typescript.json fails across both formats (d09e, d0a1, d0a2).
- **Config dimension fails for bare, skill, and ctx7** despite CLI achieving 75/80 criteria (94%). The remaining CLI failures are config/rig.json (3/5 — text format bug) and config/typescript.json (2/5).
- **Skill achieves perfect idiomatic scores (5/5)** — the only profile to do so. The anti-hallucination skill stabilizes ESLint rule migration that bare and CLI each miss in 2/5 runs.

---

## Layer 2: Behavior Analysis

### Bare profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · bare

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            3/5   SPFx migration guide (learn.microsoft.com)
               Correct invocation    1/5   SPFx v1.22 release notes
               Correct invocation    1/5   npm registry (npm view)
               Correct invocation    1/5   fetch_webpage on learn.microsoft.com

Consumption    Content misused       2/5   Migration guide (migrate-gulptoolchain-hefttoolchain)
               Content misused       1/5   Microsoft Learn migration guide
               Content ignored       1/5   npm registry — @microsoft/spfx-heft-plugins@1.22.2

Execution      Partially correct     4/5   Various configuration files partially upgraded
               Partially correct     1/5   package.json only partially correct

Recovery       No recovery           1/5   Agent completed without verification
               Successful recovery   1/5   npm view commands used to verify versions
```

**Bare behavior summary:** The agent consistently targets v1.22.2 correctly (5/5 Select) but struggles with upgrade completeness. It discovers the Microsoft Learn migration guide in 3/5 runs, but the guide's content leads to partial upgrades — it covers the gulp-to-heft migration but doesn't provide a complete checklist of all required file changes. The agent misses 8 configuration changes consistently (src/index.ts removal, .gitignore update, main property removal, etc.) because these aren't prominent in the migration documentation. In 1/5 runs, the agent successfully used npm view to verify dependency versions, showing nascent recovery behavior.

### Anti-hallucination skill profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + anti-hallucination skill

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            4/5   Migration guide (migrate-gulptoolchain-hefttoolchain)
               Correct invocation    2/5   SPFx v1.22 release notes

Consumption    Content misused       4/5   Migration guide (migrate-gulptoolchain-hefttoolchain)

Execution      Partially correct     5/5   Various configuration files partially upgraded

Recovery       No recovery           1/5   Agent completed without verification
```

**Skill behavior summary:** The anti-hallucination skill increases migration guide discovery (4/5 vs. 3/5 for bare) and achieves perfect ESLint handling (5/5 idiomatic). However, the same ContentMisused pattern persists (4/5) — the migration guide's incomplete coverage causes the same configuration gaps as bare. The skill's value is narrow: it stabilizes ESLint rule migration but doesn't compensate for missing SPFx-specific upgrade knowledge. Configuration pass rates are similar to bare (37/80 vs. 30/80), with gains coming from tsconfig extends (5/5 vs. 4/5), scripts.clean (5/5 vs. 3/5), and gulpfile removal (5/5 vs. 4/5).

### CLI for Microsoft 365 profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + CLI for Microsoft 365

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            4/5   m365 spfx project upgrade command

Invocation     Correct invocation    4/5   m365 spfx project upgrade --toVersion 1.22.2 --output md/text

Consumption    Content misused       2/5   CLI ESLint rule instructions — agent edits wrong section of .eslintrc.js

Execution      Partially correct     5/5   Most upgrade steps applied, residual gaps per run

Recovery       No recovery           1/5   Agent verification behavior
```

**CLI behavior summary:** The agent consistently discovers and invokes the `m365 spfx project upgrade` command (4/5 discovery, 4/5 correct invocation). The agent chooses between `--output md` (3 runs) and `--output text` (2 runs). The md format produces a structured report with finding IDs (FN015014, FN015015, etc.) that the agent follows with high fidelity. The text format produces PowerShell commands but has a bug: it drops the config/rig.json creation instruction (FN015014) entirely — the two config/rig.json failures (d09e, d0a2) are both text-format runs. Overall, the CLI achieves 75/80 configuration criteria (94%) and 49/50 currency criteria (98%). ContentMisused drops from 4/5 (bare/skill) to 2/5 (CLI) — both misuse instances are ESLint rule edits where the agent applies the CLI's explicit instructions to the wrong section of .eslintrc.js. The high token cost (3,875k avg, with runs ranging from 754k to 7,471k) reflects the agent processing the CLI's detailed output.

### Skill + context7 MCP profile behaviors

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + anti-hallucination skill + context7 MCP

Category       Behavior              Rate  Source
─────────────  ────────────────────  ────  ──────
Discovery      Discovered            1/5   context7 MCP server (via fetch_webpage)
               Discovered            1/5   SPFx v1.22 release notes

Invocation     Correct invocation    1/5   context7 MCP (fetch_webpage tool)
               Correct invocation    1/5   npm show dependencies
               Correct invocation    1/5   Migration guide (learn.microsoft.com)
               Not discovered        3/5   context7 MCP server failed to start — tools not registered
               Skipped invocation    2/5   context7 MCP tools registered but not invoked

Consumption    Content misused       4/5   Migration guide (various sources)

Execution      Partially correct     5/5   Various configuration files partially upgraded

Recovery       No recovery           1/5   Agent completed without verification
```

**Skill + context7 behavior summary:** The context7 MCP server provides negligible value. The MCP server failed to start in 3/5 runs (MissingExtensionPoint) — the context7 tools are simply absent from the agent's tool list. In the 2/5 runs where tools are registered, the agent skips invocation — the MCP tool descriptions (generic documentation lookup) don't match SPFx upgrade terminology (VocabularyMismatch). The profile performs marginally better than bare on idiomatic use (4/5 vs. 3/5) due to the anti-hallucination skill component, but shows no improvement on currency or configuration.

---

## Layer 3: What to Fix

### CLI for Microsoft 365 action list

```
Profile: Copilot Chat · Claude Sonnet 4.6 · + CLI for Microsoft 365

FIX (existing extension points)
Priority  Root Cause               Runs Affected  Behavior → Effect                                               Fix Target
────────  ──────────               ─────────────  ─────────────────                                               ──────────
  1       OutputFormatBug          2/5            --output text drops FN015014 → config/rig.json                  CLI for Microsoft 365 — m365 spfx project upgrade
                                                  never created (both text-format runs fail this                  Fix --output text formatter to include
                                                  criterion; all 3 md-format runs pass)                           config/rig.json creation command

CONSTRAINT (cannot fix via extension points)
Priority  Constraint               Runs Affected  Behavior → Effect                                               Mitigation
────────  ──────────               ─────────────  ─────────────────                                               ──────────
  —       StaleTrainingData        1/5            Base model occasionally retains legacy dependencies              CLI fix (#1) overrides model defaults with
                                                  when CLI output is ambiguous (1/5 legacy deps retained)          explicit removal instructions
```

### Bare profile action list

```
Profile: Copilot Chat · Claude Sonnet 4.6 · bare

FIX (existing extension points)
Priority  Root Cause               Runs Affected  Behavior → Effect                                               Fix Target
────────  ──────────               ─────────────  ─────────────────                                               ──────────
  1       ResponseFormat           4/5            Content misused → migration guide does not cover                Microsoft Learn migration guide
                                                  8 configuration changes (src/index.ts removal,                  (migrate-gulptoolchain-hefttoolchain):
                                                  .gitignore update, main property, overrides,                    add complete file-change checklist with
                                                  eject-webpack, scripts.start, .yo-rc useGulp,                   all required configuration changes, not
                                                  css-loader/react-types versions)                                just gulp-to-heft migration steps

CREATE (new extension points)
Priority  Gap                      Runs Affected  Behavior → Effect                                               What to Build
────────  ───                      ─────────────  ─────────────────                                               ─────────────
  2       MissingGroundingContent  3/5            No recovery → agent has no fallback when migration              Skill: SPFx version upgrade workflow
                                                  guide is incomplete; no comprehensive checklist                  with complete dependency version manifest,
                                                  of all required file changes exists                              configuration checklist, and file-level
                                                                                                                   change instructions

CONSTRAINT (cannot fix via extension points)
Priority  Constraint               Runs Affected  Behavior → Effect                                               Mitigation
────────  ──────────               ─────────────  ─────────────────                                               ──────────
  —       StaleTrainingData        4/5            Base model lacks knowledge of SPFx v1.22.2                      Migration guide fix (#1) + skill (#2)
                                                  configuration requirements — css-loader 7.1.2,                   provide explicit version pins and
                                                  @types/react resolution, .yo-rc.json useGulp field               configuration requirements
```

---

## Summary

### Profile comparison

| Metric | bare | + skill | + CLI for M365 | + skill + ctx7 |
|---|---|---|---|---|
| Select | 5/5 | 5/5 | 5/5 | 5/5 |
| Build | 5/5 | 5/5 | 5/5 | 5/5 |
| Test | 5/5 | 5/5 | N/A | 5/5 |
| Run | 5/5 | 5/5 | 5/5 | 5/5 |
| Idiomatic (dimension) | 3/5 | **5/5** | 3/5 | 4/5 |
| Currency (dimension) | 0/5 | 0/5 | **4/5** | 0/5 |
| Config (dimension) | 0/5 | 0/5 | **2/5** | 0/5 |
| Currency (criteria) | 34/50 | 38/50 | **49/50** | 39/50 |
| Config (criteria) | 30/80 | 37/80 | **75/80** | 41/80 |
| Avg tokens (all runs) | 1,133k | 1,032k | **3,875k** | **982k** |
| Avg requests | 33.6 | 32.4 | **59** | **30.8** |
| Δ lift | — | +0.06 | **+0.20** | +0.03 |

### Key findings

1. **Version targeting is solved.** All profiles achieve 5/5 Select. When v1.22.2 is the latest version, the agent consistently resolves to it regardless of extension point configuration. The challenge is entirely about upgrade quality, not version targeting.

2. **CLI for Microsoft 365 is the only profile with currency dimension passes.** The CLI's upgrade report resolves css-loader (0/5 → 5/5) and @types/react (0/5 → 5/5) — the two criteria that universally block all non-CLI profiles from any currency dimension pass. At the criteria level, the CLI achieves 49/50 (98%) vs. bare's 34/50 (68%).

3. **Anti-hallucination skill is the only profile with perfect idiomatic scores.** The skill achieves 5/5 idiomatic dimension (both ESLint criteria pass in every run) vs. 3/5 for bare and CLI. This is a narrow but real contribution — the skill stabilizes ESLint rule migration without providing any SPFx-specific knowledge.

4. **CLI and skill deliver complementary value.** The CLI excels at currency (+0.80 dimension delta) and config (+0.40 dimension delta) but not idiomatic use. The skill excels at idiomatic use (+0.40 dimension delta) but not currency or config. No single profile captures all improvements. A combined profile (CLI + anti-hallucination skill) would theoretically achieve all three gains.

5. **Context7 MCP adds no value.** Adding context7 MCP on top of the skill reduces idiomatic performance (4/5 vs. 5/5) and provides no currency or config improvement. The MCP server failed to start in 3/5 runs (MissingExtensionPoint); in the 2/5 runs where tools were available, the agent skipped them due to vocabulary mismatch with SPFx upgrade terminology.

6. **Configuration correctness remains the hardest dimension.** The CLI is the only profile with any config dimension passes (2/5). The two failures on config/rig.json are caused by a bug in `--output text` that drops the FN015014 finding — both text-format runs fail, all three md-format runs pass. config/typescript.json (2/5) fails across both formats.

7. **CLI costs 3.4× more tokens** (3,875k avg vs. 1,133k for bare), with high variance (754k–7,471k). The agent sometimes struggles to efficiently process the CLI's detailed upgrade report. This cost should be weighed against the quality improvement.

### Investment recommendation

| Priority | Action | Owner | Expected impact |
|---|---|---|---|
| 1 | Fix `--output text` formatter bug that drops config/rig.json (FN015014) | CLI for Microsoft 365 team | Config dimension: 2/5 → ~4/5; eliminates format-dependent failures |
| 2 | Fix migration guide incomplete coverage (add full file-change checklist) | SPFx docs team | Bare/skill config: 30–37/80 → potentially much higher |
| 3 | Combine CLI + anti-hallucination skill in a single profile | Scope team | Capture currency lift (CLI), config lift (CLI), and idiomatic lift (skill) |
| 4 | Do **not** recommend context7 MCP for SPFx upgrade scenarios | — | Avoid wasted tool discovery effort with no quality gain |


