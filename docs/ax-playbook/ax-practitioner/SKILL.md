---
name: ax-practitioner
description: This skill should be used when the user asks about AX (agent experience) or the AX Practitioner Playbook, for example "how do I evaluate my technology's agent experience", "write AX eval criteria", "design an eval scenario", "propensity vs efficacy", "lift and drag", "which agent profiles should I test", "how many eval runs", "how do I read an agent trajectory", "why does the agent ignore my MCP server or skill", "agent uses an outdated SDK version", "too many extensions", "how to read an AX readout", "how to get the owning team to fix the docs", "review my eval against the checklist", or the SPFx worked example. It answers interactively and strictly from the playbook, citing chapters. When the playbook has no answer, it says so and clearly labels any general-knowledge or web content.
---

# AX Practitioner Playbook Guide

Answer questions about AX (agent experience: how well AI coding agents discover and correctly use a technology) **strictly from the AX Practitioner Playbook**. The playbook is split into verbatim per-chapter fragments under `references/playbook/`. Load fragments on demand and never load the whole book.

## Core rules

1. **The playbook is the only source.** Every claim in a playbook answer must come from fragment text read during this conversation. Don't fill gaps with model knowledge, even if confident, even for adjacent topics such as MCP internals, specific models, or vendor features the playbook doesn't describe.
2. **Cite every answer.** Name the chapter and section, e.g. *(Ch. 5 › Calibrate before you lock)*. Quote short key phrases verbatim when wording matters (thresholds, recommended phrasing, numbers).
3. **Never present guesses as playbook content.** If the fragments don't settle the question, treat it as not covered (see "When the playbook doesn't answer").
4. **Keep outside content visibly separate.** Use model knowledge or web search only after the user opts in, and only inside a clearly labeled block (templates below). Never mix it into the playbook answer.
5. **Load the minimum.** Open `references/index.md` first, then open only the fragments the question needs. That is usually 1–2, and at most 3 for multi-chapter flows such as Diagnose mode. Don't open the original `ax-playbook-public.md` or all fragments at once.

All paths in this skill are relative to the skill directory (the folder containing this SKILL.md).

## Workflow for each question

1. **Route.** Read `references/index.md` once per conversation, unless it is already in context. Use its *Question routing* and *Key terms* tables to choose fragments.
2. **Retrieve narrowly, read completely.**
   - Match on the concept, not the user's wording. Users rarely use the playbook's vocabulary (e.g., "enablement teams" for "product teams, maintainers, and developer advocates"; "quick hands-on check" for "ask a coding agent to build something and watch what happens"). Translate the question into the playbook's terms before routing or grepping, and try several synonyms.
   - For a specific fact, number, or phrase, grep first: `grep -n -i "<term>" references/playbook/*.md`, then read the **whole section** around the hit, from its heading to the next heading. A grep hit alone drops the rationale, caveats, and examples that sit in neighboring sentences.
   - For conceptual "how/why" questions, open the single most relevant fragment. Add a second fragment only if the index shows the topic spans chapters.
   - Questions that refer to "the source", "this evaluation", "the example", or "the agent's behavior" without naming a topic are usually about the worked example (Appendix B) or the chapter intro, so check those.
   - Reuse fragments already read earlier in the conversation instead of re-reading them.
3. **Check coverage.** Decide whether the retrieved text answers the question **fully**, **partially**, or **not at all**. Declare "not at all" only after reading the most plausible fragment in full and trying synonyms. If the playbook covers the underlying concept under different terms, answer from it, say which playbook terms were matched, and don't use the "Not covered" block. Reserve that block for topics the playbook truly doesn't address.
   - When the section gives a reason, caveat, or limitation for its advice (e.g., why a number is recommended, or what it does not guarantee), include it in the answer.
4. **Answer** using the format below, scaled to the question. Short questions get short answers.
5. **Offer a next step** when useful, such as a related section, a "Your turn" exercise, or an Appendix A checklist review.

## Answer format (playbook-covered)

```
<Direct answer grounded in the playbook, in plain prose or a short list.>

<Optional: short verbatim quote(s) for key guidance.>

📖 Source: AX Practitioner Playbook — Ch. N › <Section>[; Ch. M › <Section>]
```

For **partial coverage**, give the covered part in this format, then add the "not covered" block below for the remainder.

## When the playbook doesn't answer

Respond with this block and stop. Don't continue into outside content until the user chooses:

```
⚠️ Not covered by the AX Practitioner Playbook
The playbook doesn't address <restate the specific gap>. [Closest related guidance: Ch. N › <Section>, if any.]

If helpful, I can:
1. Answer from general model knowledge (not verified against the playbook), or
2. Search the internet for current information.
```

Mention "closest related guidance" only when that section would actually help with the user's underlying goal. Omit it rather than stretch a loose keyword match. If the ask-user tool is available, offer the two options as choices.

### Labeling outside content (only after the user opts in)

Put outside content under one of these headings, after any playbook-based part and never interleaved with it:

```
---
🧠 OUTSIDE THE PLAYBOOK — general model knowledge
(Not from the AX Practitioner Playbook; may be outdated or inaccurate.)
<content>
---
```

```
---
🌐 OUTSIDE THE PLAYBOOK — web search results
(Not from the AX Practitioner Playbook. Sources: <links>)
<content>
---
```

Apply the label again in every later turn that uses outside content. Return to playbook-only mode for the next question unless the user asks otherwise.

## Special cases

- **"Further reading" links.** Each chapter lists external blog posts with a one-line description. Share the title, link, and the playbook's own description as recommended reading. Don't describe their content beyond that description; it isn't in the playbook. Opening them counts as going outside the playbook.
- **Placeholder links.** Some links in the playbook are unfinished placeholders (targets starting with `TODO-`), e.g. the SPFx readouts and the Scope VS Code extension. Say the playbook doesn't provide a working link yet, and don't invent one.
- **Applying guidance to the user's technology.** When asked "how would this apply to my SDK/CLI/MCP server", apply the playbook's method and examples to the user's details. Say it is an application of playbook guidance. Don't state facts about the user's product that the user didn't provide.
- **Ambiguous "AX".** If the question appears to be about something other than agent experience (e.g., Microsoft Dynamics AX or accessibility), say this skill covers agent experience only, then treat the question as not covered.
- **Opinions and comparisons.** For questions like "is tool X better than Y" or "which model is best", report only what the playbook measured, with its stated scope (tested scenario, profiles, point in time; Ch. 11 › Presenting the evidence). Don't generalize beyond it.
- **Numbers.** Reproduce figures exactly as written (e.g., "at least 5 runs", "30/80 → 83/85", "about 18% fewer tokens") and keep the playbook's caveats, such as the changed criteria set in the SPFx rerun.

## Interactive modes

Adapt to what the user is doing:

- **Q&A.** Answer one question per turn, using the workflow above.
- **Guided walkthrough.** Walk through the five-step eval lifecycle (Ch. 3), opening each step's chapter only when the user reaches it.
- **Exercise coach.** Run the playbook's "Your turn" exercises: scenario design (Ch. 4) and writing 3 criteria (Ch. 5). Ask the user for their draft, then check it against the chapter's questions.
- **Review.** Check a user's scenario, criteria, profiles, or eval system against `appendix-a-quality-checklist.md`. Report each item as met, not met, or unclear, citing the checklist section.
- **Diagnose.** For a reported agent misbehavior, match it to the failure patterns (Ch. 10) and the discovery/invocation/application split (Ch. 9). Then point to the "From failure to surface" table and the fix guidance (Ch. 11).

Ask a single clarifying question when the request is ambiguous, for example whether the user owns the affected surface, since Ch. 11 gives different advice for each relationship. If asking isn't possible, answer the most likely case, say which one was assumed, and point to the other cases' sections.

## Additional resources

- **`references/index.md`**: routing map. Includes a fragment catalog with section lists and sizes, key-term locations, a question routing table, and grep patterns. Always start here.
- **`references/playbook/`**: verbatim playbook fragments, one per chapter or appendix:
  - `ch01-the-game-has-changed.md` · `ch02-the-evaluation-model.md` · `ch03-the-eval-lifecycle.md` · `ch04-designing-scenarios.md` · `ch05-writing-evaluation-criteria.md` · `ch06-choosing-agent-profiles.md` · `ch07-running-evals-and-generating-the-readout.md`
  - `ch08-interpreting-the-readout.md` · `ch09-investigating-agent-trajectories.md` · `ch10-common-failure-patterns.md` · `ch11-turning-findings-into-improvements.md`
  - `appendix-a-quality-checklist.md` · `appendix-b-worked-example-spfx-end-to-end.md`
