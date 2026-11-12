// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import type {
  ExperimentDocument,
  ExperimentExecutionHistoryDocument,
  ExperimentRequestState,
  FixedPayload,
} from "./types.js";

export interface ExperimentRunPair {
  experimentId: string;
  requestId: string;
  runId: string;
}

interface ProjectedExecution {
  experimentExecutionId: string;
  taxonomy?: { taxonomyRevisionId: string };
  requests: FixedPayload<ExperimentRequestState>;
}

interface ProjectedExperiment extends Document {
  _id: string;
  execution: ProjectedExecution;
}

interface ProjectedHistory extends ProjectedExecution, Document {
  _id: string;
  experimentId: string;
}

interface ProjectedChunk extends Document {
  experimentId: string;
  ownerId: string;
  entries: Array<{ state: ExperimentRequestState }>;
}

function pairKey(pair: ExperimentRunPair): string {
  return `${pair.experimentId}\0${pair.requestId}\0${pair.runId}`;
}

function inlineContainsPair(
  experimentId: string,
  execution: ProjectedExecution,
  requestedPairs: ReadonlySet<string>,
): boolean {
  return execution.requests.storage === "inline" &&
    execution.requests.entries.some((state) =>
      requestedPairs.has(pairKey({
        experimentId,
        requestId: state.requestId,
        runId: state.runId,
      }))
    );
}

/**
 * Resolves taxonomy expectation for exact Experiment request/run pairs using
 * a fixed number of page-scoped collection queries.
 */
export class TaxonomyExpectationStore {
  constructor(
    private readonly collections: {
      experiments: Collection<ExperimentDocument>;
      executions: Collection<ExperimentExecutionHistoryDocument>;
      chunks: Collection<Document>;
    },
  ) {}

  async findExpectedPairs(
    projectId: string,
    pairs: readonly ExperimentRunPair[],
  ): Promise<Set<string>> {
    if (pairs.length === 0) return new Set();

    const requestedPairs = new Set(pairs.map(pairKey));
    const experimentIds = [...new Set(pairs.map(({ experimentId }) => experimentId))];
    const requestIds = [...new Set(pairs.map(({ requestId }) => requestId))];

    // Current roots and matching chunks are independent page-scoped reads.
    const [rootDocuments, chunkDocuments] = await Promise.all([
      this.collections.experiments.find<ProjectedExperiment>(
        {
          projectId,
          _id: { $in: experimentIds },
          finalizedAt: { $exists: true },
        } as Document,
        {
          projection: {
            _id: 1,
            "execution.experimentExecutionId": 1,
            "execution.taxonomy.taxonomyRevisionId": 1,
            "execution.requests": 1,
          },
        },
      ).toArray(),
      this.collections.chunks.find<ProjectedChunk>(
        {
          projectId,
          experimentId: { $in: experimentIds },
          kind: "requests",
          "entries.state.requestId": { $in: requestIds },
        } as Document,
        {
          projection: {
            experimentId: 1,
            ownerId: 1,
            "entries.state.requestId": 1,
            "entries.state.runId": 1,
          },
        },
      ).toArray(),
    ]);

    const chunkPairsByOwner = new Map<string, Set<string>>();
    for (const chunk of chunkDocuments) {
      const ownerKey = `${chunk.experimentId}\0${chunk.ownerId}`;
      const matches = chunkPairsByOwner.get(ownerKey) ?? new Set<string>();
      for (const { state } of chunk.entries) {
        const key = pairKey({
          experimentId: chunk.experimentId,
          requestId: state.requestId,
          runId: state.runId,
        });
        if (requestedPairs.has(key)) matches.add(key);
      }
      if (matches.size > 0) chunkPairsByOwner.set(ownerKey, matches);
    }

    const expected = new Set<string>();
    for (const root of rootDocuments) {
      if (!root.execution.taxonomy) continue;
      if (inlineContainsPair(root._id, root.execution, requestedPairs)) {
        for (const state of root.execution.requests.storage === "inline"
          ? root.execution.requests.entries
          : []) {
          const key = pairKey({
            experimentId: root._id,
            requestId: state.requestId,
            runId: state.runId,
          });
          if (requestedPairs.has(key)) expected.add(key);
        }
      }
      const chunkMatches = chunkPairsByOwner.get(
        `${root._id}\0${root.execution.experimentExecutionId}`,
      );
      if (chunkMatches) {
        for (const key of chunkMatches) expected.add(key);
      }
    }

    const chunkOwnerIds = [...new Set(
      chunkDocuments.map(({ ownerId }) => ownerId),
    )];
    const historyDocuments = await this.collections.executions.find<ProjectedHistory>(
      {
        projectId,
        experimentId: { $in: experimentIds },
        $or: [
          {
            "requests.storage": "inline",
            "requests.entries.requestId": { $in: requestIds },
          },
          ...(
            chunkOwnerIds.length > 0
              ? [{ _id: { $in: chunkOwnerIds } }]
              : []
          ),
        ],
      } as Document,
      {
        projection: {
          _id: 1,
          experimentId: 1,
          experimentExecutionId: 1,
          "taxonomy.taxonomyRevisionId": 1,
          requests: 1,
        },
      },
    ).toArray();

    for (const history of historyDocuments) {
      if (!history.taxonomy) continue;
      if (history.requests.storage === "inline") {
        for (const state of history.requests.entries) {
          const key = pairKey({
            experimentId: history.experimentId,
            requestId: state.requestId,
            runId: state.runId,
          });
          if (requestedPairs.has(key)) expected.add(key);
        }
      }
      const chunkMatches = chunkPairsByOwner.get(
        `${history.experimentId}\0${history.experimentExecutionId}`,
      );
      if (chunkMatches) {
        for (const key of chunkMatches) expected.add(key);
      }
    }

    return expected;
  }

  static key(pair: ExperimentRunPair): string {
    return pairKey(pair);
  }
}
