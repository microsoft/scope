// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { FixedPayloadStore } from "./fixed-payload-store.js";
import { fingerprintExperimentPayload } from "./routing.js";
import type {
  ExperimentLifecycleTarget,
  ExperimentRequestState,
  FixedPayload,
} from "./types.js";

function targetKey(target: ExperimentLifecycleTarget): string {
  return fingerprintExperimentPayload([target.kind, target.id]);
}

function toState(target: ExperimentLifecycleTarget): ExperimentRequestState {
  return {
    requestId: targetKey(target),
    runId: target.kind,
    dependencies: [{
      handlerId: target.id,
      state: "ready",
    }],
    blockers: [],
  };
}

function fromState(state: ExperimentRequestState): ExperimentLifecycleTarget {
  const id = state.dependencies[0]?.handlerId;
  if (
    (state.runId !== "request" && state.runId !== "report") ||
    state.dependencies.length !== 1 ||
    !id
  ) {
    throw new Error("Invalid Experiment lifecycle target state");
  }
  const target = { kind: state.runId, id } satisfies ExperimentLifecycleTarget;
  if (state.requestId !== targetKey(target)) {
    throw new Error("Experiment lifecycle target fingerprint mismatch");
  }
  return target;
}

export class ExperimentLifecycleTargetStore {
  private readonly payloads: FixedPayloadStore;

  constructor(chunks: Collection<Document>) {
    this.payloads = new FixedPayloadStore(chunks);
  }

  async prepare(input: {
    projectId: string;
    experimentId: string;
    operationId: string;
    targets: readonly ExperimentLifecycleTarget[];
    inlineDocument: (
      payload: FixedPayload<ExperimentRequestState>,
    ) => object;
    now?: Date;
  }): Promise<FixedPayload<ExperimentRequestState>> {
    const seen = new Set<string>();
    const canonical = [...input.targets]
      .sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
      )
      .map((target) => {
        const key = `${target.kind}\0${target.id}`;
        if (seen.has(key)) {
          throw new Error(`Duplicate Experiment lifecycle target ${target.kind}:${target.id}`);
        }
        seen.add(key);
        return toState(target);
      });
    return this.payloads.prepareRequests({
      identity: {
        projectId: input.projectId,
        experimentId: input.experimentId,
        ownerId: input.operationId,
        generation: 1,
      },
      entries: canonical,
      inlineDocument: input.inlineDocument,
      now: input.now,
    });
  }

  async read(input: {
    projectId: string;
    experimentId: string;
    operationId: string;
    payload: FixedPayload<ExperimentRequestState>;
  }): Promise<ExperimentLifecycleTarget[]> {
    const states = await this.payloads.readRequests(
      {
        projectId: input.projectId,
        experimentId: input.experimentId,
        ownerId: input.operationId,
        generation: 1,
      },
      input.payload,
    );
    return states.map(fromState);
  }

  async discard(payload: FixedPayload<ExperimentRequestState>): Promise<void> {
    await this.payloads.discardUnpublished(payload);
  }
}
