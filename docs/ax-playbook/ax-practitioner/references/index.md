# AX Practitioner Playbook — Routing Index

**Source:** *The AX Practitioner Playbook* — "How to evaluate, diagnose, and improve your technology's agent experience (AX)."

This index is a map, not an answer source. Use it to pick the smallest set of fragments to open, then answer **only** from the text of those fragments. All fragments live in `references/playbook/` and contain the playbook text verbatim (each starts with a provenance comment giving the original line range).

Approximate size per fragment is listed so loading cost is predictable. Open one fragment at a time; open a second only when the question genuinely spans chapters.

---

## 1. Fragment catalog

### Part 1: Why this matters

**`ch01-the-game-has-changed.md`** (~1,300 words)
Why AI coding agents are a new audience, and why stale training data makes them get technologies wrong. The chapter intro also gives a quick hands-on check any team can do: ask a coding agent to build something with your technology and watch what happens (code looks reasonable and may compile, but has wrong SDK version, deprecated auth, unrecommended partition key strategy).
- Agents are another audience: the traditional role of product teams, maintainers, and developer advocates (build products and extensions, write docs and samples, make the technology approachable) was built for developers who read docs; now agents make SDK/version/auth decisions instead of the developer; surfaces you control (docs, MCP tools, skills, plugins, instructions, CLIs, APIs); knowledge cutoff is a poor proxy; "waiting for models to get better isn't a strategy"
- What this looks like in practice: DevRel at Microsoft, fall 2025, hundreds of sessions (Azure, Cosmos DB, SPFx, M365 Copilot extensions); agents ignoring CLIs, anchoring on wrong docs section, loading but not calling tools
- What happened when we looked: Cosmos DB Agent Kit (46 improvements), SPFx dev skill; `release-1.22.md` → `release-1.22.0.md` rename (0/4 → 4/5); tip → warning that invalidates the plan
- Who this is for: product teams, maintainers, docs writers, platform teams, developer advocates; importance of domain expertise; not about tuning your own agent setup
- What you'll be able to do: evaluate, diagnose, drive improvements

### Part 2: How we evaluate

**`ch02-the-evaluation-model.md`** (~1,300 words)
The commitments that make an AX evaluation trustworthy; why benchmarks (SWE-bench) don't answer the AX question.
- Four building blocks: **scenarios, criteria, profiles, gates**
- Criteria judge meaning, and judge it the same way twice (no word matching; consistent verdicts; optional criteria areas)
- Run in the environment your developers use (OS, harness, model, extensions; harness matters; IDE on Windows vs CLI on Linux)
- Prove the code runs, don't assume it: stacked gates — prerequisite → build → tests → run → deploy
- Compare against a baseline, and count the cost: bare baseline, **lift**, **drag**, pass-rate delta; traps: usage ≠ success, ignoring cost
- Run it more than once: at least 5 runs; 1/5 = variance, 5/5 failing = fixable problem
- Keep the evidence: trajectories, outputs, verdicts
- What this gives you: defensible results ("wrong SDK in 4 of 5 runs because a docs page hardcodes an outdated version")

**`ch03-the-eval-lifecycle.md`** (~180 words)
The five-step process: design scenario → write criteria → choose profiles → run → generate & interpret readout. Short; good for "what are the steps?" questions.

**`ch04-designing-scenarios.md`** (~570 words)
- What makes a good scenario: realistic developer prompt, no eval instructions/hints; vague prompts are valid; "upgrade this project to the latest version"
- **Propensity vs. efficacy** (discovery vs. quality); which to start with (new product vs. established product, competitive scenarios)
- Things to be aware of: complex prompts increase variance; prompt-crafting is a trap; internal vocabulary
- Your turn: 3 self-check questions

**`ch05-writing-evaluation-criteria.md`** (~1,450 words)
The hardest part of the process.
- What criteria are: LLM judge rules on pass/fail/skip about *choices*; build/run belong in gates; ASIDE on deterministic vs. LLM judges
- What good criteria look like: avoid "current"; name packages, versions, APIs, wrong patterns; Cosmos DB examples (`PartitionKeyBuilder`, `DefaultAzureCredential`, `AccountKey=`); SPFx upgrade (`package.json`, `.yo-rc.json`, one change per criterion)
- Writing criteria that work: the 4 parts (what checked / passes / fails / when to skip); Draft 1 → 2 → 3 evolution for `@azure/cosmos` v4.x; using a model to find ambiguity
- Calibrate before you lock: 5-step calibration cycle; keep calibration separate; don't rewrite after a surprising score
- Maintaining criteria: versioning the criteria set; cross-version comparisons; older supported product versions; defects in locked criteria; judge model/prompt changes as a measurement boundary; two kinds of ownership
- Common traps: letting an LLM write criteria; style vs. correctness; things the agent can't control; conflating concerns; vague language
- Your turn: write 3 criteria + self-check

**`ch06-choosing-agent-profiles.md`** (~680 words)
- Definition of an **agent profile** (OS, harness, model + reasoning level/context window, extensions)
- Start with the baseline (bare profile; strong vs. weak baseline; baseline-only is fine with no extension)
- Add extensions one at a time (bare / skill only / MCP only / full stack; composition isn't additive)
- Common profiles and what they test (table); "bare + one extension is enough" to start
- When custom profiles matter: pick the majority audience profile; include commonly installed MCP servers; don't add profiles for coverage

**`ch07-running-evals-and-generating-the-readout.md`** (~600 words)
- Choosing an evaluation system: build vs. off-the-shelf vs. **Scope**; required capabilities (representative environment, reset workspace, repeated runs, deterministic checks + LLM judge, evidence retention)
- Where Scope fits (open source, implements the playbook method)
- Running the evaluation: ≥5 runs per scenario-profile; what to preserve per run
- Generating the readout

### Part 3: From results to impact

**`ch08-interpreting-the-readout.md`** (~550 words)
- What a readout should contain: prerequisite gate, output evaluation (build/run/deploy), criteria results (5/5, 2/5, 0/5), profile comparison (lift/drag), **task cost** (input/output/cache token pricing), recommended next steps
- What to look for first: extension not used; bare beats extension (drag); 0/5 across all profiles; 2/5–3/5 inconsistent; cost differences for similar outcomes
- What the readout can't tell you → trajectories

**`ch09-investigating-agent-trajectories.md`** (~980 words)
- What a trajectory is; **ATIF** (Agent Trajectory Interchange Format); ATIF Preview VS Code extension
- How to read a trajectory: decision points, chain-of-thought, tool calls, file reads, decision sequences
- **Discovery failure vs. lack of invocation vs. application failure** — and the different fix for each
- Contradictory behaviors (same scenario, different runs; weakly motivated decisions = highest-value improvements)
- Attribution: documentation / extension / training data / agent (harness + model) problem; "Don't band-aid a doc problem with a skill"; new skill as last resort
- Worked example: SPFx v1.22.0 wrong version due to hardcoded `@1.22.1` in migration guide

**`ch10-common-failure-patterns.md`** (~1,600 words)
Each pattern: what you see → why → what to fix.
- Agent ignores your extension and uses training data (tool description vocabulary)
- Agent follows docs too literally (hardcoded versions like `@azure/cosmos@4.1.0`; use `@latest`/variables; balanced coverage; keep docs current)
- Agent has a plan before it reads your content (invalidate the wrong path; "Manually updating package.json alone will result in build failures")
- Agent picks the wrong tool when multiple overlap (distinctive product-specific vocabulary)
- Too many extensions make everything worse (4x tokens, worst results in 2 of 3 scenarios; net lift)
- Agent does manual work instead of running your CLI
- Agent anchors on retrieved content over correct knowledge (three multi-tenancy models collapsed into one)
- Agent scaffolds from 2020 (training data volume; `npx` unpinned; `npm deprecate`, "DEPRECATED: Do not use X. Use Y instead.")
- Agent can't follow your tool's routing instructions (MCP subrouting)
- From failure to surface: observation → first surface to inspect (table); change one surface at a time

**`ch11-turning-findings-into-improvements.md`** (~1,200 words)
- If you own the affected surface: prioritization order; fix the source; treat change as hypothesis
- If you can collaborate directly with the owner: lead with baseline; owner responses (want to test a fix / expect models to improve / already measure AX / can't prioritize); simulate changes by intercepting requests
- If you need to contribute through public channels: issue contents, sanitizing evidence, focused PRs, private reporting
- When the source can't change: temporary **bridge** skill/instructions; labeling, maintenance, retirement condition
- Presenting the evidence: constructive, bounded, precise scope
- Keep measuring: rerun cadence, same locked definition, new version when things change
- Following up: verify fixes; revisit in 2–3 months

### Appendices

**`appendix-a-quality-checklist.md`** (~780 words)
Checkbox lists: scenario quality; criteria accuracy, calibration, consistency; criteria calibration; criteria maintenance; profile selection; before running; ongoing measurement; **evaluation system readiness**. Use for reviews of a user's eval design.

**`appendix-b-worked-example-spfx-end-to-end.md`** (~1,530 words)
Complete SPFx upgrade evaluation ("Upgrade the project to 1.22.2", v1.21.1 start). Also the place for any question about "the evaluation", "the engagement", or "the example" without a named topic: what was assessed and why this scenario was chosen, who contributed what (product team knew correct upgrade; advocates knew measurement; collaboration is common but not required), and what the agent did step by step.
- The scenario and environment (why upgrades; minimal prompt; VS Code + GitHub Copilot Chat, Windows 11, Claude Sonnet 4.6)
- Criteria classifications (prerequisite, dependency currency, configuration correctness, idiomatic use) + execution gates
- Profiles (bare, + anti-hallucination skill created by the SPFx team to verify SPFx facts against authoritative docs, + skill + context7 MCP) and baseline results table
- What investigation revealed (agent already knows SPFx and plans before using tools; SemVer page confusion — fetched `release-1.22` not `release-1.22.2`; doc hardcodes)
- Hypothesis-driven fixes with **Dev Proxy** (Fix 1 rename release notes, PR #10855; Fix 2 warning callout; Fix 3 conceptual migration guide, PR #10921; 30/80 → 83/85)
- CLI for Microsoft 365 `spfx project upgrade` results; report format comparison (Markdown vs. summary-first vs. **JSON** vs. JSONL, tokens)
- Harness findings (`Accept: text/markdown` in GitHub Copilot Chat/CLI)
- What shipped; links to readouts (`readout.json`, `readout.md`)

---

## 2. Key terms → where defined

| Term | Fragment (section) |
|------|--------------------|
| AX / agent experience | ch01 (intro) |
| Scenario | ch02 (intro), ch04 |
| Criteria / LLM judge / pass-fail-skip | ch02, ch05 |
| Deterministic vs. LLM judge | ch05 (ASIDE) |
| Criteria areas / classifications | ch02, appendix-b (The criteria) |
| Calibration, locking, criteria-set versioning | ch05 (Calibrate before you lock; Maintaining criteria) |
| Agent profile / harness | ch02, ch06 |
| Bare baseline | ch02, ch06 |
| Lift / drag | ch02 (Compare against a baseline), ch08 |
| Gates (prerequisite, build, test, run, deploy) | ch02 (Prove the code runs), ch08 |
| Propensity / efficacy | ch04 |
| Readout / task cost | ch07, ch08 |
| Trajectory / ATIF | ch09 |
| Discovery failure / lack of invocation / application failure | ch09 |
| Contradictory behaviors / variance | ch02 (Run it more than once), ch09 |
| Attribution | ch09 |
| Plan invalidation | ch10 (The agent has a plan…), appendix-b (Fix 2) |
| Subrouting | ch10 (routing instructions) |
| Bridge (temporary skill) | ch11 (When the source can't change) |
| Scope (evaluation system) | ch07 (Where Scope fits), ch11 (Keep measuring) |
| Dev Proxy | appendix-b (Hypothesis-driven fixes) |
| CLI for Microsoft 365 | ch01, appendix-b |
| context7 | appendix-b (The profiles) |

## 3. Question routing

| If the user asks about… | Open first | Then, if needed |
|---|---|---|
| What AX is / why it matters / who it's for | ch01 | ch02 |
| Overall process / where to start | ch03 | ch04 |
| How trustworthy evals work, benchmarks vs. AX evals | ch02 | — |
| Writing or reviewing a prompt/scenario | ch04 | appendix-a (Scenario quality) |
| Writing, fixing, or reviewing criteria | ch05 | appendix-a (Criteria sections) |
| Which agents/models/extensions to test | ch06 | appendix-a (Profile selection) |
| How many runs, tooling, evaluation systems, Scope | ch07 | ch02 (Run it more than once) |
| Reading results, scores, cost, lift/drag | ch08 | ch02 |
| Why the agent did something, debugging a failed run | ch09 | ch10 |
| A specific symptom (ignores tool, wrong version, edits files instead of CLI, too many extensions) | ch10 | ch09 |
| How to fix docs/skills/MCP tools, work with owning teams, open issues/PRs | ch11 | ch10 (From failure to surface) |
| Re-running, regressions, criteria/judge changes over time | ch11 (Keep measuring) | ch05 (Maintaining criteria) |
| A concrete end-to-end example, real numbers, SPFx, JSON vs. Markdown output | appendix-b | ch01 |
| Questions about "the evaluation / the example / the source" with no named topic; who did what; why a scenario was picked | appendix-b | ch01 (intro) |
| Quick first check of how an agent handles my technology; what the traditional DevRel/product-team role was | ch01 | ch04 |
| "Is my eval ready?" / review checklist | appendix-a | relevant chapter |
| Anything not matching a row above (e.g., observability, pricing of specific models, vendor product features) | grep for key terms first | If no hits → "Not covered" block in SKILL.md |

## 4. Searching instead of reading

For narrow factual lookups (a number, a name, a quoted phrase), and to confirm that a topic is genuinely absent before reporting "not covered", search the fragments before opening one, then read only the surrounding section. Run from the skill directory:

```
grep -n -i "<term>" references/playbook/*.md
```

Useful patterns: `"at least 5"`, `"lift"`, `"drag"`, `"propensity"`, `"ATIF"`, `"Scope"`, `"Dev Proxy"`, `"JSON"`, `"deprecat"`, `"bridge"`, `"calibrat"`, `"skip"`, `"cost"`.
