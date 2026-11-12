// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExperimentEvidence } from "./readout-builder.js";

const TASK_MAX_CHARS = 4_000;
const RESULT_MAX_CHARS = 6_000;
const ERROR_MAX_CHARS = 2_000;
const TURN_TEXT_MAX_CHARS = 3_000;
const FEEDBACK_MAX_CHARS = 2_000;
const CRITERION_PROMPT_MAX_CHARS = 2_000;
const TRAJECTORY_MAX_CHARS = 8_000;

export const READOUT_SYSTEM_PROMPT = `You synthesize an Experiment benchmark readout from an exact immutable execution vector of Scope runs.

The user message contains JSON evidence for every request/run pair in that vector: request metadata, coding outcome, profile metadata, criteria definitions, run-level and per-iteration observations, and ATIF trajectories.

Return raw JSON only with this shape:
{
  "title": "string",
  "executiveSummary": "string",
  "profiles": [
    { "profileId": "optional string", "requestIds": ["string"], "summary": "string" }
  ],
  "runs": [
    { "requestId": "string", "runId": "string", "trajectoryHighlights": ["string"] }
  ],
  "findings": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "severity": "critical|high|medium|low|info",
      "evidence": [
        {
          "requestId": "string",
          "runId": "string",
          "iteration": 0,
          "criterionId": "optional string",
          "excerpt": "string"
        }
      ]
    }
  ],
  "actions": [
    {
      "id": "string",
      "title": "string",
      "priority": "critical|high|medium|low",
      "description": "string",
      "relatedFindingIds": ["string"]
    }
  ]
}

Rules:
- Use only requestId, runId, iteration, criterionId, and profileId values present in the evidence.
- Treat failed coding outcomes as valid evidence.
- Treat observation results with passed:false as evidence, not as missing data.
- An empty selected-observation set is valid; summarize trajectory and outcome evidence without inventing observations.
- Include every exact-vector run once in runs and every request once in a profile group.
- Preserve disagreements and mixed results instead of averaging them away.
- Ground every finding in at least one evidence reference.
- Return no Markdown fences or commentary.`;

function boundedText(value: string | undefined, maxChars: number) {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated]`;
}

/**
 * Keeps exact identities, outcomes, observations, and representative trajectory
 * evidence while preventing large workspaces or ATIF payloads from overflowing
 * the readout model context.
 */
export function composeReadoutPromptEvidence(evidence: ExperimentEvidence) {
  return {
    experimentId: evidence.experimentId,
    experimentExecutionId: evidence.experimentExecutionId,
    runs: evidence.runs.map(({ request, run, criteria, trajectories }) => ({
      request: {
        _id: request._id,
        scenario: {
          task: boundedText(request.scenario.task, TASK_MAX_CHARS),
          criteria: request.scenario.criteria,
        },
        workerType: request.workerType,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        agentVersion: request.agentVersion,
        profileId: request.profileId,
        mcpServers: request.mcpServers,
        skillRevisions: request.skillRevisions,
        extensions: request.extensions,
      },
      run: {
        _id: run._id,
        attemptNumber: run.attemptNumber,
        status: run.status,
        outcome: run.outcome,
        error: boundedText(run.error, ERROR_MAX_CHARS),
        result: boundedText(run.result, RESULT_MAX_CHARS),
        observationResults: (run.observationResults ?? []).map((result) => ({
          ...result,
          feedback: boundedText(result.feedback, FEEDBACK_MAX_CHARS),
        })),
        turns: (run.turns ?? []).map((turn) => ({
          iteration: turn.iteration,
          passed: turn.passed,
          codingAgentResponse: boundedText(
            turn.codingAgentResponse,
            TURN_TEXT_MAX_CHARS,
          ),
          judgeFeedback: boundedText(
            turn.judgeFeedback,
            FEEDBACK_MAX_CHARS,
          ),
          observationResults: (turn.observationResults ?? []).map((result) => ({
            ...result,
            feedback: boundedText(result.feedback, FEEDBACK_MAX_CHARS),
          })),
        })),
      },
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        prompt: boundedText(
          criterion.prompt,
          CRITERION_PROMPT_MAX_CHARS,
        ),
        kind: criterion.kind,
        subject: criterion.subject,
        taxonomyElementId: criterion.taxonomyElementId,
      })),
      trajectories: trajectories.map(({ iteration, trajectory }) => ({
        iteration,
        excerpt: boundedText(
          JSON.stringify(trajectory),
          TRAJECTORY_MAX_CHARS,
        ),
      })),
    })),
  };
}

export function composeReadoutUserPrompt(evidence: ExperimentEvidence): string {
  return [
    "Generate the Experiment readout synthesis for this exact immutable execution evidence vector.",
    JSON.stringify(composeReadoutPromptEvidence(evidence)),
  ].join("\n\n");
}
