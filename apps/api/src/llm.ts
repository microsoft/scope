// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isUnexpected } from "@azure-rest/ai-inference";
import { gatesSatisfyInvariant, type GateId } from "shared";
import { acquireInferenceClient, isLlmAvailable as inferenceAvailable } from "./llm-token.js";

export type SuggestDirection = "parents" | "children";

/**
 * Authoring call: writes the evaluation prompt + suggests an id. This is the
 * orthogonal "write the criterion" concern — it never sees other criteria and
 * never suggests dependencies.
 */
const SYSTEM_PROMPT_AUTHOR = `You are an expert at writing evaluation criteria for AI coding agent benchmarks.

Given a natural-language description of a behavior or pattern to detect, you must:

1. Write a concise evaluation prompt (1-3 sentences) that a judge LLM will use to decide whether the behavior is present. The judge weighs TWO complementary, equally authoritative sources of evidence:
   - The codebase — the resulting files, patterns, and configuration the agent produced.
   - The agent's captured tool-call history — the logs, results, and exit status of every command or tool the agent actually ran while doing the task. This history is CUMULATIVE across the whole run: it spans every iteration so far, not just the last one, so a one-time action the agent performed once in an earlier iteration (a bootstrap, scaffold, install, or other one-off command) is still recorded and still counts as done. This covers the build, test, run, and deploy commands, but also any other command or tool it invoked (e.g. starting or curling a server, running a script, searching or inspecting the workspace).
   Pick whichever source best fits the behavior and phrase the prompt around it. Behaviors about whether something builds, compiles, tests, runs, serves, or deploys are best judged from the captured command output and exit status, NOT from inspecting files. More generally, any behavior about what the agent actually did or ran — a command it executed, a check it performed, output it observed — is best judged from the captured tool-call history, which may reveal what the resulting files alone do not. Behaviors about how the code is written or structured are best judged from the codebase. The judge cannot run any commands itself, so never instruct it to run, execute, or re-run anything — judge from evidence that already exists. Keep it factual and objective.

2. Suggest a short, descriptive snake_case identifier for this criterion. The ID must:
   - Start with a lowercase letter
   - Contain only lowercase letters, digits, and underscores
   - Be concise but descriptive (e.g., has_unit_tests, uses_typescript, build_succeeds)

Here are examples of good criteria prompts:
- Codebase evidence: "The project uses the React framework. Look for a react dependency in package.json and .jsx or .tsx files containing React components."
- Codebase evidence: "The project uses Azure Bicep for infrastructure as code. Look for *.bicep files, bicepconfig.json, or a main.bicep entry point."
- Tool-output evidence: "The project builds successfully. The captured output of the build command (e.g. npm run build) finishes with a zero exit status and no compilation errors."
- Tool-output evidence: "The unit tests pass. The captured output of the test command shows the suite running with no failing tests and a successful exit status."
- Tool-output evidence (non-gate command): "The agent verified the running server responds. The captured tool-call history contains a request to the local endpoint (e.g. a curl to http://localhost) that returned a 2xx status."

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"prompt": "your evaluation prompt here", "suggestedId": "your_suggested_id"}`;

/**
 * Per-gate description of the evidence a criterion compatible with that gate is
 * judged against. `select` is implementation/codebase evidence; the rest are
 * tool-output gates whose evidence is the captured command output + exit status.
 */
const GATE_EVIDENCE: Partial<Record<GateId, string>> = {
  select: "the codebase files the agent produced (its implementation)",
  build: "the captured output and exit status of the build/compile command",
  test: "the captured output and exit status of the test command",
  run: "the captured output of running or serving the app (startup logs, HTTP responses, exit status)",
  deploy: "the captured output and exit status of the deploy command, or the captured output of the deployed app",
};

/**
 * Builds a short, gate-aware steering note appended to the author user message.
 * It never restricts availability, because the judge can read the agent's full
 * captured tool-call history whenever tool calls exist, regardless of gate (that
 * availability lives, unconditionally, in SYSTEM_PROMPT_AUTHOR). When the
 * criterion targets any tool-output gate (build/test/run/deploy) it centers the
 * prompt on captured command output. When it only targets `select` it presents
 * BOTH sources and gives a per-behavior decision rule: structural / how-the-code-
 * is-written behaviors are judged from the codebase, but behaviors about something
 * the agent DID or RAN (a command it executed, a bootstrap/scaffold step, a
 * tool/skill/MCP invocation) make the captured tool-call history the PRIMARY
 * evidence even under the select gate. An earlier version led with "judge it
 * primarily from the codebase", which the model obeyed and dropped tool-history
 * mentions for exactly the select-gated action criteria #1225 targets. Omitted/
 * empty gates add no note so generic authoring (and backward-compatible callers)
 * is unaffected.
 */
function authorGateHint(gates?: GateId[]): string {
  if (!gates || gates.length === 0) return "";
  const toolEvidence = gates
    .filter((g) => g !== "select")
    .map((g) => (GATE_EVIDENCE[g] ? `the ${g} gate (evidence: ${GATE_EVIDENCE[g]})` : null))
    .filter((x): x is string => x !== null);
  if (toolEvidence.length === 0) {
    return `\n\nThis criterion targets the select gate (evidence: ${GATE_EVIDENCE.select}). Two equally authoritative sources of evidence are available; choose whichever fits the behavior. If the behavior is about how the resulting code is written, structured, or configured — files that exist, dependencies, patterns — judge it from the codebase. If the behavior is about something the agent DID or RAN — a command it executed, a bootstrap or scaffold step, or a tool, skill, or MCP server it invoked — then the agent's captured tool-call history is the PRIMARY evidence, even though this criterion is select-gated, because that action may not be visible in the resulting files alone; phrase the prompt around that captured tool-call history. That history is cumulative across the whole run (all iterations), so a one-time action performed once in an earlier iteration is still recorded — never require the action to have run in the latest iteration.`;
  }
  return `\n\nThis criterion targets ${toolEvidence.join(" and ")}. Center the evaluation prompt on that captured tool output and exit status rather than file inspection.`;
}

interface SuggestDirectionCopy {
  /** One-line definition of the relationship being asked for. */
  relationship: string;
  /** Concrete test the model must apply to each candidate before including it. */
  test: string;
  /** A positive example (a candidate that SHOULD be suggested) for this direction. */
  positiveExample: string;
  /** A negative example (a candidate that must NOT be suggested) that guards the
   *  one-directional specialization edge against being fired in reverse. */
  negativeExample: string;
  /** Heading used to label the candidate list in the user message. */
  candidatesHeading: string;
}

const DIRECTION_COPY: Record<SuggestDirection, SuggestDirectionCopy> = {
  parents: {
    relationship:
      "existing criteria that are genuine PREREQUISITES of the new criterion — i.e. the new criterion cannot be meaningfully evaluated unless that criterion already passes.",
    test: "Include a candidate ONLY if the new criterion is impossible or meaningless when that candidate fails.",
    positiveExample:
      'Specialization: a narrower new criterion depends on a broader candidate — e.g. new "has_unit_tests" depends on "has_tests" because unit tests are a kind of test (no tests ⇒ no unit tests). Functional: new "uses_express" depends on "has_node" because Express is a Node.js library and cannot exist without Node.',
    negativeExample:
      'Do NOT suggest a candidate that is NARROWER than the new criterion as a parent. E.g. for a new "has_tests", "has_unit_tests" is NOT a parent — has_unit_tests is the narrower one (a child of has_tests), so it must never be returned here.',
    candidatesHeading: "CANDIDATE CRITERIA (use only these IDs):",
  },
  children: {
    relationship:
      "existing criteria for which the new criterion is a genuine PREREQUISITE — i.e. that criterion cannot be meaningfully evaluated unless the new criterion already passes.",
    test: "Include a candidate ONLY if that candidate is impossible or meaningless when the new criterion fails.",
    positiveExample:
      'Specialization: a broader new criterion has narrower candidates as children — e.g. new "has_tests" has "has_unit_tests" as a child because unit tests are a kind of test (no tests ⇒ no unit tests). Functional: new "has_node" is a prerequisite of "uses_express", so "uses_express" is a child because Express cannot exist without Node.',
    negativeExample:
      'Do NOT suggest a candidate that is BROADER than the new criterion as a child. E.g. for a new "has_unit_tests", "has_tests" is NOT a child — has_tests is the broader one (the parent of has_unit_tests), so it must never be returned here.',
    candidatesHeading: "CANDIDATE CRITERIA (use only these IDs):",
  },
};

/**
 * Suggestion call (used symmetrically for parents and children): given the new
 * behavior and a pre-filtered candidate pool, returns the subset of candidates
 * that should be related to the new criterion in the given direction.
 */
function suggestSystemPrompt(direction: SuggestDirection): string {
  const { relationship, test, positiveExample, negativeExample } = DIRECTION_COPY[direction];
  return `You are an expert at organising evaluation criteria for AI coding agent benchmarks into a dependency graph.

A dependency edge A → B means "B cannot be meaningfully evaluated unless A passes first". Equivalently, B can never be true while A is false — B's truth REQUIRES A's truth. Only TRUE prerequisite relationships are edges. Two criteria that merely belong to the same topic or family are SIBLINGS, not a parent/child pair.

Given a natural-language description of a NEW criterion and a list of EXISTING criteria, suggest ${relationship}

${test}

INDEPENDENCE TEST (apply to every candidate): ask whether each criterion can be true or false irrespective of the other's outcome. If both can independently be true or false, they are INDEPENDENT — there is no dependency in either direction, so do not suggest the candidate. A dependency exists only when one criterion's truth would be impossible without the other's.

SPECIALIZATION IS A REAL DEPENDENCY (do not misclassify it as a sibling): when one criterion is a narrower, more specific form of another — such that the specific one being true logically guarantees the broader one is also true — that is a genuine dependency edge. The broader criterion is the prerequisite (the PARENT); the narrower criterion is the dependent (the CHILD). The edge is one-directional: the narrower one depends on the broader one, never the reverse. For example "has_unit_tests" is a specialization of "has_tests" (unit tests are a kind of test): if there are no tests at all there can be no unit tests, so has_tests is the parent of has_unit_tests (and has_unit_tests is NOT a parent of has_tests). This differs from two co-equal specializations of the same broader concept — e.g. "has_unit_tests" and "has_integration_tests" are both kinds of test but neither implies the other, so they are independent siblings.

STRICT RULES:
- Do NOT suggest a candidate just because it is topically related, in the same family, or commonly seen together. Relatedness is not a dependency.
- Reject siblings and independent criteria. Example: "has_unit_tests" and "has_integration_tests" are both about testing, but each can be true or false regardless of the other — they are independent, so NEITHER should ever be suggested as a parent or child of the other.
- A real prerequisite is a hard requirement: if it fails, the dependent criterion is impossible or meaningless to assess.
- ${positiveExample}
- ${negativeExample}
- When in doubt, leave it out: prefer an empty array over a weak or speculative edge.

Only suggest IDs from the provided candidate list. If none are appropriate, return an empty array.

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"suggestions": ["existing_id_1", "existing_id_2"]}`;
}

export interface ExistingCriterion {
  id: string;
  prompt: string;
  dependsOn?: string[];
  gates?: GateId[];
}

export interface GenerateResult {
  prompt: string;
  suggestedId: string;
  suggestedParents: string[];
  suggestedChildren: string[];
}

export function isLlmAvailable(): boolean {
  return inferenceAvailable();
}

type ChatClient = Awaited<ReturnType<typeof acquireInferenceClient>>["client"];

function sanitizeId(suggestedId: unknown): string {
  if (typeof suggestedId !== "string") return "new_criterion";
  const sanitized = suggestedId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  return sanitized || "new_criterion";
}

function parseJson(content: string): any {
  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`);
  }
}

async function chat(
  llm: ChatClient,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await llm.path("/chat/completions").post({
    body: {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      model,
      temperature: 0.3,
      max_tokens: 512,
    },
  });

  if (isUnexpected(response)) {
    const errBody = response.body as any;
    throw new Error(`LLM request failed: ${errBody?.error?.message || response.status}`);
  }

  const content = response.body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }
  return content;
}

/**
 * The "write the criterion" call: prompt + id only. Failure throws — the prompt
 * is the one indispensable result of generation.
 */
async function author(
  llm: ChatClient,
  model: string,
  behavior: string,
  gates?: GateId[],
): Promise<{ prompt: string; suggestedId: string }> {
  const content = await chat(
    llm,
    model,
    SYSTEM_PROMPT_AUTHOR,
    `NEW CRITERION TO CREATE:\n${behavior}${authorGateHint(gates)}`,
  );
  const parsed = parseJson(content);
  if (!parsed.prompt) {
    throw new Error("Missing required field: prompt");
  }
  return {
    prompt: String(parsed.prompt).trim(),
    suggestedId: sanitizeId(parsed.suggestedId),
  };
}

function buildSuggestMessage(
  direction: SuggestDirection,
  behavior: string,
  pool: ExistingCriterion[],
): string {
  const parts: string[] = [];
  if (pool.length > 0) {
    parts.push(DIRECTION_COPY[direction].candidatesHeading);
    for (const c of pool) {
      const deps = c.dependsOn?.length ? ` [parents: ${c.dependsOn.join(", ")}]` : "";
      parts.push(`- ${c.id}: ${c.prompt}${deps}`);
    }
    parts.push("");
  }
  parts.push(`NEW CRITERION:\n${behavior}`);
  return parts.join("\n");
}

/**
 * Symmetric dependency-suggestion call. `parents` and `children` use this exact
 * path — only the pre-filtered `pool` and the directional wording differ. The
 * result is post-filtered against the pool's IDs so the model can never return a
 * candidate outside the gate-compatible set. Failure degrades to `[]` so a
 * suggestion hiccup never blocks criterion creation.
 */
async function suggestDeps(
  direction: SuggestDirection,
  llm: ChatClient,
  model: string,
  behavior: string,
  pool: ExistingCriterion[],
): Promise<string[]> {
  if (pool.length === 0) return [];
  const poolIds = new Set(pool.map((c) => c.id));
  try {
    const content = await chat(
      llm,
      model,
      suggestSystemPrompt(direction),
      buildSuggestMessage(direction, behavior, pool),
    );
    const parsed = parseJson(content);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return suggestions.filter((sid: unknown): sid is string => typeof sid === "string" && poolIds.has(sid));
  } catch (err) {
    console.warn(`[generate-prompt] ${direction} suggestion call failed, degrading to []:`, err);
    return [];
  }
}

/**
 * Generate a criterion's prompt and gate-aware parent/child suggestions.
 *
 * Issues three single-responsibility calls in parallel:
 *  - author      → {prompt, suggestedId}
 *  - suggestDeps("parents", parentPool)   → suggestedParents
 *  - suggestDeps("children", childPool)   → suggestedChildren
 *
 * The candidate pools are pre-filtered by the gate-compatibility invariant so no
 * gate wording is ever sent to the model: a parent must satisfy the invariant
 * over the new criterion's gates, and a child must have the new criterion as a
 * compatible parent. When `newGates` is omitted both pools are the full list
 * (backward compatible).
 */
export async function generateCriteriaPrompt(
  behavior: string,
  existingCriteria: ExistingCriterion[] = [],
  newGates?: GateId[],
  model?: string,
): Promise<GenerateResult> {
  const { client: llm, model: foundryModel } = await acquireInferenceClient();

  // Priority: explicit arg > key-specific (from Foundry blob) > env > default.
  const modelName = model || foundryModel || process.env.LLM_MODEL || "gpt-4.1";

  const parentPool = newGates
    ? existingCriteria.filter((c) => gatesSatisfyInvariant(c.gates, newGates))
    : existingCriteria;
  const childPool = newGates
    ? existingCriteria.filter((c) => gatesSatisfyInvariant(newGates, c.gates))
    : existingCriteria;

  const [authored, suggestedParents, suggestedChildrenRaw] = await Promise.all([
    author(llm, modelName, behavior, newGates),
    suggestDeps("parents", llm, modelName, behavior, parentPool),
    suggestDeps("children", llm, modelName, behavior, childPool),
  ]);

  // The parent and child suggestion calls are independent, so the model can return
  // the same id in both directions for a tightly-coupled pair (e.g. it flags
  // "has_tests" as both a parent and a child of "has_unit_tests"). That is a
  // logical contradiction — a 2-cycle — and the create/update layer would reject the
  // child link anyway. Reconcile deterministically by preferring the parent edge:
  // declaring a parent only affects the new criterion, whereas a child edge mutates
  // an existing criterion, so on directional ambiguity keep the safer parent edge and
  // drop the id from the child set.
  const parentSet = new Set(suggestedParents);
  const suggestedChildren = suggestedChildrenRaw.filter((id) => !parentSet.has(id));

  return {
    prompt: authored.prompt,
    suggestedId: authored.suggestedId,
    suggestedParents,
    suggestedChildren,
  };
}
