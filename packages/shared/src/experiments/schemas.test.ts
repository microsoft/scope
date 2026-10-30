// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  ExperimentDocumentSchema,
  ExperimentExecutionSchema,
  ExperimentMetadataSchema,
  ExperimentRequestStateSchema,
} from "./schemas.js";

describe("experiment schemas", () => {
  it("accepts execution-level taxonomy readout state", () => {
    const now = new Date();
    const execution = ExperimentExecutionSchema.parse({
      experimentExecutionId: "execution-1",
      attemptNumber: 1,
      version: 1,
      requests: {
        storage: "inline",
        entryCount: 0,
        payloadFingerprint: "fingerprint",
        payloadVersion: 1,
        entries: [],
      },
      vectorFingerprint: "vector",
      handlerSummary: {},
      reportTemplates: {},
      blocking: [],
      taxonomyReadout: {
        status: "done",
        experimentExecutionId: "execution-1",
        taxonomyRevisionId: "taxonomy-revision-1",
        jsonUrl: "https://example.test/readout.json",
        markdownUrl: "https://example.test/readout.md",
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    }) as { taxonomyReadout?: { status: string; taxonomyRevisionId: string } };

    expect(execution.taxonomyReadout).toMatchObject({
      status: "done",
      taxonomyRevisionId: "taxonomy-revision-1",
    });
  });

  it("accepts only canonical Experiment metadata fields", () => {
    expect(
      ExperimentMetadataSchema.parse({
        name: "Experiment",
        description: "Comparison",
      }),
    ).toEqual({
      name: "Experiment",
      description: "Comparison",
    });
    expect(() =>
      ExperimentMetadataSchema.parse({
        name: "Experiment",
        tags: ["nightly"],
      }),
    ).toThrow();
  });

  it("parses the bounded request leaf and rejects recursive or unknown data", () => {
    expect(
      ExperimentRequestStateSchema.parse({
        requestId: "request-1",
        runId: "run-1",
        dependencies: [{ handlerId: "obs", state: "ready" }],
        blockers: [],
      }),
    ).toMatchObject({ requestId: "request-1", runId: "run-1" });
    expect(() =>
      ExperimentRequestStateSchema.parse({
        requestId: "request-1",
        runId: "run-1",
        dependencies: [],
        blockers: [],
        requests: [],
      }),
    ).toThrow();
    expect(() =>
      ExperimentRequestStateSchema.parse({
        requestId: "request-1",
        runId: "run-1",
        dependencies: [],
        blockers: Array.from({ length: 33 }, () => ({
          handlerId: "obs",
          reason: "dependency-blocked",
        })),
      }),
    ).toThrow();
  });

  it("rejects an unknown storage profile at the document boundary", () => {
    expect(() =>
      ExperimentDocumentSchema.parse({
        _id: "experiment-1",
        experimentId: "experiment-1",
        projectId: "project-1",
        metadata: { name: "Experiment" },
        storageProfileVersion: "future-profile",
        stateVersion: 1,
        revision: {
          experimentRevisionId: "revision-1",
          revisionNumber: 1,
          memberCount: 0,
          membershipFingerprint: "m",
          definitionFingerprint: "d",
          createdAt: new Date(),
        },
        execution: {
          experimentExecutionId: "execution-1",
          attemptNumber: 1,
          version: 1,
          requests: {
            storage: "inline",
            entryCount: 0,
            payloadFingerprint: "f",
            payloadVersion: 1,
            entries: [],
          },
          vectorFingerprint: "v",
          handlerSummary: {},
          blocking: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow();
  });
});
