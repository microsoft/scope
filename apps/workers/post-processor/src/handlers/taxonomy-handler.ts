// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createAgentBehaviorHandlerRegistry } from "ax-taxonomy";
import {
  evaluate,
  normalizeTaxonomyDocuments,
  parseScopeAtif,
  taxonomyRunResultSchema,
  type PromptExecutor,
} from "taxonomy-engine";
import {
  copilotAI,
  openCopilotTransport,
  taxonomyPromptExecutor,
  type OpenCopilotTransportOptions,
  type CopilotTransport,
} from "taxonomy-engine/copilot";
import type {
  ExperimentDocument,
  PortableTaxonomyDocument,
  PortableTaxonomyElementDocument,
  RequestDocument,
  TaxonomyElementRevisionDocument,
  TaxonomyRevisionDocument,
} from "shared";
import type {
  HandlerContext,
  PostProcessHandler,
  PostProcessorMessage,
} from "../types.js";
import { POST_PROCESSOR_VERSION } from "../version.js";
import { resolveTaxonomeModel } from "../taxonomy-config.js";

const gzipAsync = promisify(gzip);
const RUN_RESULT_SCHEMA_VERSION = "scope/taxonomy-run-result/v1";

interface PromptExecutorLease {
  executor?: PromptExecutor;
  close(): Promise<void>;
}

export type PromptExecutorFactory = (
  hasPromptElements: boolean,
) => Promise<PromptExecutorLease>;

export interface PromptExecutorFactoryDependencies {
  /** Environment containing only dedicated post-processor configuration. */
  environment?: NodeJS.ProcessEnv;
  /** Injectable isolated transport factory for offline tests. */
  openTransport?: (
    model: string,
    options: OpenCopilotTransportOptions,
  ) => Promise<CopilotTransport>;
}

/** Builds the lazy production executor without consulting coding-run settings. */
export function createPromptExecutorFactory(
  dependencies: PromptExecutorFactoryDependencies = {},
): PromptExecutorFactory {
  return async (hasPromptElements): Promise<PromptExecutorLease> => {
    if (!hasPromptElements) {
      return { close: async () => undefined };
    }

    const model = resolveTaxonomeModel(dependencies.environment);
    const transport = await (
      dependencies.openTransport ??
      ((configuredModel, options) =>
        openCopilotTransport(configuredModel, undefined, options))
    )(model, { reasoningEffort: false });
    return {
      executor: taxonomyPromptExecutor(copilotAI(transport, model)),
      close: () => transport.close(),
    };
  };
}

const defaultPromptExecutorFactory = createPromptExecutorFactory();

function portableTaxonomy(
  revision: TaxonomyRevisionDocument,
): PortableTaxonomyDocument {
  return {
    schema_version: revision.schema_version,
    id: revision.id,
    version: revision.version,
    surfaces: revision.surfaces,
    elements: revision.elements,
  };
}

function portableElement(
  revision: TaxonomyElementRevisionDocument,
): PortableTaxonomyElementDocument {
  return {
    ...(revision.schema_version
      ? { schema_version: revision.schema_version }
      : {}),
    id: revision.id,
    label: revision.label,
    ...(revision.description ? { description: revision.description } : {}),
    ...(revision.category_id ? { category_id: revision.category_id } : {}),
    implementation: revision.implementation,
    preconditions: revision.preconditions,
    output: revision.output,
  };
}

function mergeAtif(values: unknown[]): unknown {
  if (values.length === 1) return values[0];
  const documents = values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("ATIF artifact must be a JSON object");
    }
    return value as Record<string, unknown>;
  });
  const first = structuredClone(documents[0]!);
  first.steps = documents.flatMap((document) =>
    Array.isArray(document.steps) ? document.steps : [],
  );
  return first;
}

/** Evaluates one exact run with one exact pinned taxonomy revision. */
export class TaxonomyHandler implements PostProcessHandler {
  readonly type = "taxonomy";
  readonly version = POST_PROCESSOR_VERSION;
  readonly autoBackfill = true;

  constructor(
    private readonly executorFactory: PromptExecutorFactory =
      defaultPromptExecutorFactory,
  ) {}

  async process(
    message: PostProcessorMessage,
    ctx: HandlerContext,
  ): Promise<void> {
    const request = await ctx.collection.findOne({
      _id: message.requestId,
      "run._id": message.runId,
    } as never) as unknown as RequestDocument | null;
    if (!request?.run || request.run._id !== message.runId) {
      throw new Error("Exact run no longer exists");
    }
    if (!request.experimentId) {
      await ctx.log("info", "Run is not attached to an Experiment; skipping Taxonome");
      return;
    }
    if (!ctx.db || !ctx.claimToken) {
      throw new Error("Taxonome handler requires database and claim context");
    }

    const experiment = await ctx.db
      .collection<ExperimentDocument>("experiments")
      .findOne({
        _id: request.experimentId,
        projectId: request.projectId,
      });
    const selection = experiment?.execution.taxonomy;
    if (!experiment || !selection) {
      await ctx.log("info", "Experiment has no pinned taxonomy; skipping Taxonome");
      return;
    }
    const taxonomyRevision = await ctx.db
      .collection<TaxonomyRevisionDocument>("taxonomy-revisions")
      .findOne({
        _id: selection.taxonomyRevisionId,
        projectId: request.projectId,
        ref: selection.ref,
        contentSha256: selection.contentSha256,
      });
    if (!taxonomyRevision) {
      throw new Error("Pinned taxonomy revision integrity check failed");
    }

    const elementRevisions: TaxonomyElementRevisionDocument[] = [];
    for (const reference of taxonomyRevision.elements) {
      if (!("ref" in reference)) {
        throw new Error(
          `Stored taxonomy revision '${taxonomyRevision.ref}' contains unresolved path '${reference.path}'`,
        );
      }
      const element = await ctx.db
        .collection<TaxonomyElementRevisionDocument>(
          "taxonomy-element-revisions",
        )
        .findOne({ projectId: request.projectId, ref: reference.ref });
      if (!element) {
        throw new Error(`Pinned taxonomy element '${reference.ref}' was not found`);
      }
      elementRevisions.push(element);
    }

    const taxonomy = normalizeTaxonomyDocuments(
      {
        ...portableTaxonomy(taxonomyRevision),
        elements: elementRevisions.map(portableElement),
      },
      elementRevisions.map(portableElement),
      { handlers: createAgentBehaviorHandlerRegistry() },
    );
    const atifUrls = (request.run.turns ?? [])
      .map((turn) => turn.atifUrl)
      .filter((url): url is string => Boolean(url));
    if (atifUrls.length === 0) {
      throw new Error("Exact run has no ATIF artifacts");
    }
    const atifDocuments = await Promise.all(
      atifUrls.map((url) => ctx.blobStorage.downloadJson(url)),
    );
    const atif = parseScopeAtif(mergeAtif(atifDocuments), {
      label: `${message.requestId}/${message.runId}`,
    });

    const lease = await this.executorFactory(
      taxonomy.elements.some((element) => element.implementation.type === "prompt"),
    );
    try {
      const results = await evaluate(
        { atif, taxonomy },
        taxonomy.elements.map((element) => element.id),
        lease.executor,
        undefined,
        { requestId: message.requestId, runId: message.runId },
      );
      const scenario = request.scenario;
      const result = taxonomyRunResultSchema.parse({
        run: {
          id: message.runId,
          scenario: {
            id: message.requestId,
            label: "Scope scenario",
            ...(scenario.task ? { task: scenario.task } : {}),
          },
          profile: {
            id: request.profileId ?? "unprofiled",
            label: request.profileId ?? "Unprofiled",
          },
        },
        results,
        metadata: {
          requestId: message.requestId,
          runId: message.runId,
          experimentId: request.experimentId,
          experimentExecutionId: experiment.execution.experimentExecutionId,
          taxonomyRevisionId: taxonomyRevision._id,
          taxonomyRef: taxonomyRevision.ref,
        },
      });
      const json = Buffer.from(JSON.stringify(result), "utf8");
      const compressed = await gzipAsync(json);
      const contentSha256 = createHash("sha256").update(json).digest("hex");
      const blobName =
        `${message.requestId}/runs/${message.runId}/taxonomy-evaluation/` +
        `${ctx.claimToken}/result.json.gz`;
      const url = await ctx.blobStorage.uploadBuffer(
        blobName,
        compressed,
        "application/json",
        "gzip",
      );
      const publication = await ctx.collection.updateOne(
        {
          _id: message.requestId,
          "run._id": message.runId,
          "run.handlerStatus.pp-taxonomy.status": "processing",
          "run.handlerStatus.pp-taxonomy.claimToken": ctx.claimToken,
        } as never,
        {
          $set: {
            "run.taxonomyEvaluation": {
              url,
              schemaVersion: RUN_RESULT_SCHEMA_VERSION,
              contentSha256,
              sizeBytes: json.byteLength,
            },
          },
        },
      );
      if (publication.matchedCount !== 1) {
        throw new Error("Taxonomy evaluation claim became stale before publication");
      }
    } finally {
      await lease.close();
    }
  }
}
