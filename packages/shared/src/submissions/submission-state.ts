// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  HandlerRunStatus,
  HandlerServiceDocument,
  RunState,
  SubmissionBlockingDetail,
  SubmissionDependencyProjection,
  SubmissionHandlerState,
  SubmissionReadiness,
  SubmissionRequestRef,
  SubmissionRunState,
} from "../types/types.js";
import { DependencyGraph } from "../graph/dependency-graph.js";

export const OBSERVATIONS_HANDLER_ID = "pp-observations";
export const READOUT_HANDLER_ID = "pp-readout";

export function computeSubmissionVectorFingerprint(
  requests: readonly SubmissionRequestRef[],
): string {
  const canonical = [...requests]
    .sort((left, right) => left.requestId.localeCompare(right.requestId))
    .map(({ requestId, runId }) => `${requestId}:${runId}`)
    .join("\n");
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index++) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function evaluateNamedHandlerState(
  handlerId: string,
  handlers: readonly HandlerServiceDocument[],
  handlerStatus: Record<string, HandlerRunStatus> | undefined,
): SubmissionHandlerState {
  const status = handlerStatus?.[handlerId];
  if (status?.status === "done") return "ready";
  if (status?.status === "failed") return "failed";

  const graph = new DependencyGraph(
    handlers.map((handler) => ({
      id: handler._id,
      dependsOn: handler.dependsOn,
    })),
  );

  if (!handlers.some((handler) => handler._id === handlerId)) {
    return "waiting";
  }

  for (const ancestorId of graph.getAncestors(handlerId)) {
    if (handlerStatus?.[ancestorId]?.status === "failed") return "blocked";
  }
  return "waiting";
}

function isTerminalHandlerState(
  handlerId: string,
  graph: DependencyGraph,
  handlerStatus: Record<string, HandlerRunStatus> | undefined,
): boolean {
  const status = handlerStatus?.[handlerId]?.status;
  if (status === "done" || status === "failed") return true;
  if (status !== undefined) return false;
  for (const ancestorId of graph.getAncestors(handlerId)) {
    if (handlerStatus?.[ancestorId]?.status === "failed") return true;
  }
  return false;
}

export function isHandlerDagDrained(
  handlers: readonly HandlerServiceDocument[],
  handlerStatus: Record<string, HandlerRunStatus> | undefined,
): boolean {
  const graph = new DependencyGraph(
    handlers.map((handler) => ({
      id: handler._id,
      dependsOn: handler.dependsOn,
    })),
  );
  return handlers.every((handler) =>
    isTerminalHandlerState(handler._id, graph, handlerStatus),
  );
}

export function projectSubmissionDependency(input: {
  requestId: string;
  expectedRunId: string;
  run?: RunState;
  handlers: readonly HandlerServiceDocument[];
  handlerId?: string;
}): {
  projection: SubmissionDependencyProjection;
  blocking?: SubmissionBlockingDetail;
  drifted: boolean;
} {
  const handlerId = input.handlerId ?? OBSERVATIONS_HANDLER_ID;
  if (!input.run) {
    return {
      projection: {
        requestId: input.requestId,
        runId: input.expectedRunId,
        handlerId,
        state: "blocked",
      },
      blocking: {
        requestId: input.requestId,
        runId: input.expectedRunId,
        handlerId,
        reason: "request-missing",
      },
      drifted: false,
    };
  }
  if (input.run._id !== input.expectedRunId) {
    return {
      projection: {
        requestId: input.requestId,
        runId: input.expectedRunId,
        handlerId,
        state: "blocked",
      },
      blocking: {
        requestId: input.requestId,
        runId: input.expectedRunId,
        handlerId,
        reason: "run-changed",
      },
      drifted: true,
    };
  }

  const source = input.run.handlerStatus?.[handlerId];
  const state = evaluateNamedHandlerState(
    handlerId,
    input.handlers,
    input.run.handlerStatus,
  );
  const projection: SubmissionDependencyProjection = {
    requestId: input.requestId,
    runId: input.expectedRunId,
    handlerId,
    state,
    ...(source?.version !== undefined ? { version: source.version } : {}),
    ...(source?.updatedAt ? { updatedAt: source.updatedAt } : {}),
    ...(source?.error ? { error: source.error } : {}),
  };
  if (state !== "failed" && state !== "blocked") {
    return { projection, drifted: false };
  }
  return {
    projection,
    blocking: {
      requestId: input.requestId,
      runId: input.expectedRunId,
      handlerId,
      reason: state === "failed" ? "dependency-failed" : "dependency-blocked",
      ...(source?.error ? { error: source.error } : {}),
    },
    drifted: false,
  };
}

export function deriveSubmissionReadiness(run: SubmissionRunState): SubmissionReadiness {
  const readout = run.handlerStatus?.[READOUT_HANDLER_ID];
  if (readout?.status === "done") return "done";
  if (readout?.status === "failed") return "failed";
  if (readout?.status === "queued" || readout?.status === "processing") {
    return "processing";
  }
  if (run.blocking.length > 0) return "blocked";
  if (
    run.requests.length > 0 &&
    run.dependencyProjection.length === run.requests.length &&
    run.dependencyProjection.every((dependency) => dependency.state === "ready")
  ) {
    return "ready";
  }
  return "waiting";
}
