// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import {
  AuthError,
  hashRunToken,
  parseRunToken,
  runTokenHashesEqual,
  type RequestDocument,
} from "shared";

/** Default absolute lifetime of a run token, measured from the run's claim. */
export const DEFAULT_RUN_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Verified run caller derived from a run token. */
export interface VerifiedRun {
  requestId: string;
  runId: string;
  projectId: string;
  /** Hex digest of the presented token (for 8-char log correlation only). */
  tokenHash: string;
}

/** Verifies a raw run token, throwing {@link AuthError} when it is not accepted. */
export type RunTokenVerifier = (token: string) => Promise<VerifiedRun>;

/** Options for {@link createRunTokenVerifier}. */
export interface RunTokenVerifierOptions {
  /** Absolute max age from `run.startedAt`. Defaults to {@link DEFAULT_RUN_TOKEN_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Parse `RUN_TOKEN_MAX_AGE_MS`, falling back to the default on missing/invalid input. */
export function resolveRunTokenMaxAgeMs(raw = process.env.RUN_TOKEN_MAX_AGE_MS): number {
  if (!raw) return DEFAULT_RUN_TOKEN_MAX_AGE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_TOKEN_MAX_AGE_MS;
}

/**
 * Build a run-token verifier backed by a point read on the requests collection.
 * A token is valid only while its run is `processing` under the claim that
 * minted it and within the absolute max age.
 */
export function createRunTokenVerifier(
  getCollection: () => Collection<RequestDocument> | undefined,
  options: RunTokenVerifierOptions = {},
): RunTokenVerifier {
  const maxAgeMs = options.maxAgeMs ?? resolveRunTokenMaxAgeMs();
  const now = options.now ?? Date.now;

  return async (token) => {
    const parsed = parseRunToken(token);
    if (!parsed) throw new AuthError("invalid_run_token", "Malformed run token");

    const collection = getCollection();
    if (!collection) {
      throw new AuthError("service_unavailable", "Run token verification unavailable");
    }

    let doc: Pick<RequestDocument, "_id" | "projectId" | "deletedAt" | "run"> | null;
    try {
      doc = await collection.findOne(
        { _id: parsed.requestId },
        {
          projection: {
            projectId: 1,
            deletedAt: 1,
            "run._id": 1,
            "run.status": 1,
            "run.tokenHash": 1,
            "run.startedAt": 1,
          },
        },
      );
    } catch {
      throw new AuthError("service_unavailable", "Run token verification unavailable");
    }

    const tokenHash = hashRunToken(token);
    const run = doc?.run;
    if (!doc || doc.deletedAt || !run?.tokenHash || !runTokenHashesEqual(run.tokenHash, tokenHash)) {
      throw new AuthError("invalid_run_token", "Invalid run token");
    }
    if (run.status !== "processing") {
      throw new AuthError("run_not_active", "Run is not active");
    }
    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : NaN;
    if (!Number.isFinite(startedAt) || now() - startedAt > maxAgeMs) {
      throw new AuthError("run_token_expired", "Run token expired");
    }
    return { requestId: doc._id, runId: run._id, projectId: doc.projectId, tokenHash };
  };
}
