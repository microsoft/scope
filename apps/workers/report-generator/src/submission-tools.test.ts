// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubmissionReportTools } from "./submission-tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSubmissionReportTools", () => {
  it("loads structured evidence for the exact submission attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            _id: "readout-report",
            submissionRunId: "submission-run-1",
            reporter: { id: "pp-readout" },
            structuredArtifact: { url: "reports/readout-report/structured.json" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            _id: "other-attempt",
            submissionRunId: "submission-run-2",
            reporter: { id: "pp-readout" },
            structuredArtifact: { url: "reports/other/structured.json" },
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ submissionRunId: "submission-run-1", runs: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const tools = createSubmissionReportTools(
      "http://api.test",
      "submission-1",
      "submission-run-1",
    );
    const evidenceTool = tools.find(
      (tool) => tool.name === "get_submission_evidence",
    );

    expect(evidenceTool).toBeDefined();
    const result = await (
      evidenceTool as unknown as {
        handler: (
          args: Record<string, never>,
          context: Record<string, never>,
        ) => Promise<unknown>;
      }
    ).handler({}, {});

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://api.test/api/v1/submissions/submission-1/reports",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://api.test/api/v1/reports/readout-report/structured",
    );
    expect(result).toEqual({
      reportId: "readout-report",
      evidence: { submissionRunId: "submission-run-1", runs: [] },
    });
  });
});
