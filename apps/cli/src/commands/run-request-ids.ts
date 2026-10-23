// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { apiFetch } from "../utils/api-client.js";

export const MAX_BATCH_ARCHIVE_IDS = 100;

/** One supported source of run IDs for `run download-batch`. */
export type BatchIdSource =
  | { kind: "ids"; ids: string[] }
  | { kind: "experiment"; value: string }
  | { kind: "submission"; value: string };

/** Minimal request-list item needed for batch resolution. */
interface RequestListItem {
  id: string;
  experimentId?: string;
  submissionId?: string;
}

/** Cursor-paged request-list response. */
interface RequestListPage {
  data: RequestListItem[];
  next: string | null;
}

type RequestFetcher = typeof apiFetch;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Narrows the request-list JSON boundary immediately after parsing. */
function parseRequestListPage(value: unknown): RequestListPage {
  const page = record(value);
  const rawData = Array.isArray(value)
    ? value
    : Array.isArray(page?.data)
      ? page.data
      : undefined;
  if (!rawData) {
    throw new Error("Request list response is missing a data array");
  }

  const data = rawData.map((raw, index) => {
    const item = record(raw);
    const id = typeof item?.id === "string"
      ? item.id
      : typeof item?._id === "string"
        ? item._id
        : undefined;
    if (!id) {
      throw new Error(`Request list item ${index} is missing an id`);
    }
    return {
      id,
      ...(typeof item?.experimentId === "string"
        ? { experimentId: item.experimentId }
        : {}),
      ...(typeof item?.submissionId === "string"
        ? { submissionId: item.submissionId }
        : {}),
    };
  });

  const cursors = record(page?.cursors);
  const next = typeof cursors?.next === "string" && cursors.next
    ? cursors.next
    : null;
  return { data, next };
}

/** Returns true only for a complete canonical UUID selector. */
export function isFullUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

/** Validates the exactly-one ID source contract. */
export function selectBatchIdSource(options: {
  ids?: string[];
  experimentId?: string;
  submissionId?: string;
}): BatchIdSource {
  const sources = [
    options.ids?.length ? "ids" : undefined,
    options.experimentId ? "experiment" : undefined,
    options.submissionId ? "submission" : undefined,
  ].filter((source): source is string => source !== undefined);

  if (sources.length !== 1) {
    throw new Error(
      "Provide exactly one of --ids, --experiment-id, or --submission-id",
    );
  }
  if (sources[0] === "ids") {
    return { kind: "ids", ids: options.ids! };
  }
  if (sources[0] === "experiment") {
    return { kind: "experiment", value: options.experimentId! };
  }
  return { kind: "submission", value: options.submissionId! };
}

/** Enforces the request archive endpoint's documented ID limit. */
export function assertBatchArchiveLimit(ids: readonly string[]): void {
  if (ids.length > MAX_BATCH_ARCHIVE_IDS) {
    throw new Error(
      `Batch archive supports at most ${MAX_BATCH_ARCHIVE_IDS} run IDs; ` +
      `the selector resolved ${ids.length}. Narrow the selection or download smaller batches.`,
    );
  }
}

/** Fails when a resolved experiment/submission contains no exact runs. */
export function assertResolvedRequestIds(
  ids: readonly string[],
  source: "experiment" | "submission",
): void {
  if (ids.length === 0) {
    throw new Error(`No exact runs found for this ${source}`);
  }
}

/**
 * Resolves request IDs from a cursor-paged API filter.
 *
 * Submission UUIDs are filtered exactly because the API filter is prefix-based.
 */
export async function resolvePaginatedRequestIds(options: {
  baseUrl: string | undefined;
  projectId: string;
  filter: "experimentId" | "submissionId";
  value: string;
  fetcher?: RequestFetcher;
}): Promise<string[]> {
  const fetcher = options.fetcher ?? apiFetch;
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  const requireExactSubmission =
    options.filter === "submissionId" && isFullUuid(options.value);

  do {
    const params = new URLSearchParams({
      [options.filter]: options.value,
      limit: "100",
    });
    if (after) params.set("after", after);

    const response = await fetcher(
      options.baseUrl,
      `/requests?${params.toString()}`,
      { projectId: options.projectId },
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const message = typeof record(body)?.error === "string"
        ? String(record(body)?.error)
        : `HTTP ${response.status}`;
      throw new Error(`Failed to resolve runs: ${message}`);
    }

    const page = parseRequestListPage(await response.json() as unknown);
    for (const request of page.data) {
      if (
        requireExactSubmission &&
        request.submissionId !== options.value
      ) {
        continue;
      }
      if (!seenIds.has(request.id)) {
        seenIds.add(request.id);
        ids.push(request.id);
        assertBatchArchiveLimit(ids);
      }
    }

    after = page.next ?? undefined;
    if (after) {
      if (seenCursors.has(after)) {
        throw new Error("Request pagination returned a repeated cursor");
      }
      seenCursors.add(after);
    }
  } while (after);

  return ids;
}
