// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExperimentEvidence } from "./readout-builder.js";

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

export function composeReadoutUserPrompt(evidence: ExperimentEvidence): string {
  return [
    "Generate the Experiment readout synthesis for this exact immutable execution evidence vector.",
    JSON.stringify(evidence),
  ].join("\n\n");
}
