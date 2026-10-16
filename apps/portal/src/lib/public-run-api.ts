// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import ky, { HTTPError } from "ky";
import {
  RUN_SHARE_HEADER, RUN_SHARE_PAGE, RunShareTokenSchema, SharedRunSchema, SharedRunReportsSchema, SharedRunLogsSchema,
  type SharedRunArtifact,
} from "shared/run-sharing";

// This client deliberately has no MSAL hooks, cookies, or private API imports.
const client = ky.create({
  credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
  timeout: 30_000,
  retry: { limit: 2, methods: ["get"], statusCodes: [429, 500, 502, 503, 504], maxRetryAfter: 10_000 },
});
const base = "/api/v1/shared/runs";

export class SharedRunError extends Error {
  constructor(readonly status: number) {
    super(status === 404 ? "Shared run is unavailable"
      : status === 413 ? "This artifact exceeds the 128 MiB public download limit"
      : status === 429 ? "Too many requests. Please wait before trying again."
      : "Unable to load shared content. Please try again.");
  }
}

export function isSharedRunPage(path: string): boolean {
  return path === RUN_SHARE_PAGE || path === `${RUN_SHARE_PAGE}/`;
}

export function tokenFromFragment(fragment: string): string | null {
  const token = fragment.slice(1);
  return RunShareTokenSchema.safeParse(token).success ? token : null;
}

async function publicResponse(token: string, path: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await client(`${base}${path}`, {
      headers: { [RUN_SHARE_HEADER]: token }, signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SharedRunError(error instanceof HTTPError ? error.response.status : 0);
  }
}

export const publicRunApi = {
  view: async (token: string, signal?: AbortSignal) => {
    const value: unknown = await (await publicResponse(token, "/view", signal)).json();
    return SharedRunSchema.parse(value);
  },
  logs: async (token: string, signal?: AbortSignal) => {
    const value: unknown = await (await publicResponse(token, "/logs", signal)).json();
    return SharedRunLogsSchema.parse(value);
  },
  reports: async (token: string, after?: string, signal?: AbortSignal) => {
    const path = `/reports${after ? `?after=${encodeURIComponent(after)}` : ""}`;
    const value: unknown = await (await publicResponse(token, path, signal)).json();
    return SharedRunReportsSchema.parse(value);
  },
  artifact: async (token: string, artifact: SharedRunArtifact, signal?: AbortSignal) =>
    (await publicResponse(token, `/artifacts/${encodeURIComponent(artifact.id)}`, signal)).blob(),
};
