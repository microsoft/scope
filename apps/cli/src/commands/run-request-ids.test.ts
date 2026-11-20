// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  assertBatchArchiveLimit,
  assertResolvedRequestIds,
  isFullUuid,
  resolvePaginatedRequestIds,
  selectBatchIdSource,
} from "./run-request-ids.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("run download-batch ID resolution", () => {
  it("requires exactly one source and preserves explicit IDs", () => {
    expect(() => selectBatchIdSource({}))
      .toThrow("exactly one of --ids, --experiment-id, or --submission-id");
    expect(() => selectBatchIdSource({
      ids: ["run-1"],
      submissionId: "submission-1",
    })).toThrow("exactly one");
    expect(selectBatchIdSource({ ids: ["run-1", "run-2"] })).toEqual({
      kind: "ids",
      ids: ["run-1", "run-2"],
    });
  });

  it("walks cursors with encoded filters and stable deduplication", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        data: [{ id: "run-1" }, { _id: "run-2" }],
        cursors: { next: "cursor / two?" },
      }))
      .mockResolvedValueOnce(response({
        data: [{ id: "run-2" }, { id: "run-3" }],
        cursors: { next: null },
      }));

    const ids = await resolvePaginatedRequestIds({
      baseUrl: "http://localhost:3100",
      projectId: "project-1",
      filter: "experimentId",
      value: "experiment / value?",
      fetcher,
    });

    expect(ids).toEqual(["run-1", "run-2", "run-3"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstPath = fetcher.mock.calls[0][1] as string;
    const secondPath = fetcher.mock.calls[1][1] as string;
    expect(new URL(`http://scope${firstPath}`).searchParams.get("experimentId"))
      .toBe("experiment / value?");
    expect(new URL(`http://scope${firstPath}`).searchParams.get("limit"))
      .toBe("100");
    expect(new URL(`http://scope${secondPath}`).searchParams.get("after"))
      .toBe("cursor / two?");
    expect(fetcher.mock.calls[0][2]).toEqual({ projectId: "project-1" });
  });

  it("filters a full UUID submission selector to exact matches", async () => {
    const submissionId = "01234567-89ab-4cde-8fab-0123456789ab";
    expect(isFullUuid(submissionId)).toBe(true);
    const fetcher = vi.fn().mockResolvedValue(response({
      data: [
        { id: "exact-1", submissionId },
        { id: "prefix-only", submissionId: `${submissionId}-suffix` },
        { id: "other", submissionId: "01234567-89ab-4cde-8fab-000000000000" },
        { id: "exact-2", submissionId },
      ],
      cursors: { next: null },
    }));

    await expect(resolvePaginatedRequestIds({
      baseUrl: "http://localhost:3100",
      projectId: "project-1",
      filter: "submissionId",
      value: submissionId,
      fetcher,
    })).resolves.toEqual(["exact-1", "exact-2"]);
    const path = fetcher.mock.calls[0][1] as string;
    expect(new URL(`http://scope${path}`).searchParams.get("submissionId"))
      .toBe(submissionId);
    expect(fetcher.mock.calls[0][2]).toEqual({ projectId: "project-1" });
  });

  it("rejects empty exact results and selections above the archive limit", async () => {
    const submissionId = "01234567-89ab-4cde-8fab-0123456789ab";
    const empty = vi.fn().mockResolvedValue(response({
      data: [{ id: "prefix", submissionId: `${submissionId}-suffix` }],
      cursors: { next: null },
    }));
    await expect(resolvePaginatedRequestIds({
      baseUrl: "http://localhost:3100",
      projectId: "project-1",
      filter: "submissionId",
      value: submissionId,
      fetcher: empty,
    })).resolves.toEqual([]);
    expect(() => assertResolvedRequestIds([], "submission"))
      .toThrow("No exact runs found for this submission");

    expect(() => assertBatchArchiveLimit(
      Array.from({ length: 101 }, (_, index) => `run-${index}`),
    )).toThrow("at most 100 run IDs");
  });

  it("rejects a paginated selector as soon as it exceeds 100 IDs", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: `run-${index}`,
        })),
        cursors: { next: "next" },
      }))
      .mockResolvedValueOnce(response({
        data: [{ id: "run-100" }],
        cursors: { next: null },
      }));

    await expect(resolvePaginatedRequestIds({
      baseUrl: "http://localhost:3100",
      projectId: "project-1",
      filter: "experimentId",
      value: "experiment-1",
      fetcher,
    })).rejects.toThrow("resolved 101");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated pagination cursors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        data: [{ id: "run-1" }],
        cursors: { next: "same-cursor" },
      }))
      .mockResolvedValueOnce(response({
        data: [{ id: "run-2" }],
        cursors: { next: "same-cursor" },
      }));

    await expect(resolvePaginatedRequestIds({
      baseUrl: "http://localhost:3100",
      projectId: "project-1",
      filter: "experimentId",
      value: "experiment-1",
      fetcher,
    })).rejects.toThrow("repeated cursor");
  });
});
