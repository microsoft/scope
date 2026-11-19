// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DequeuedMessageItem, QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import os from "node:os";
import {
  RequestDocument,
  WorkerProcessor,
  QueueProcessorConfig,
  LogEvent,
  MULTI_TURN_DEFAULTS,
  ConversationTurn,
  GateRunSummary,
  OsInfo,
} from "../types/types.js";
import type { McpServerConfig } from "../types/mcp.js";
import type { SkillConfig } from "../types/skill.js";
import type { ExtensionConfig } from "../types/extension.js";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import { cancelExit } from "./cancel-exit.js";
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";
import { HEARTBEAT_VISIBILITY_SECONDS } from "./visibility-heartbeat.js";
import { BlobStorage } from "../storage/blob-storage.js";
import { withRetry } from "../utils/retry.js";
import { durationSetFields } from "../run-duration.js";
import { sanitizeHarFile } from "../har/har-parser.js";
import { JudgeClient } from "../judge/judge-client.js";
import { runGatedLoop, ResolvedGate } from "../judge/gated-loop.js";
import { normalizeGates } from "../gates/gates.js";
import { McpServerClient } from "../mcp/mcp-server-client.js";
import { McpSecretClient } from "../mcp/mcp-secret-client.js";
import { SkillClient } from "../skills/skill-client.js";
import { ExtensionClient } from "../extensions/extension-client.js";
import { extractSkillsToWorkspace } from "../skills/skill-extractor.js";
import { PromptClient } from "../task-prompts/prompt-client.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodebaseClient } from "../codebases/codebase-client.js";
import { ResourceClient } from "../resources/resource-client.js";
import type { ResourceConfig } from "../types/resource.js";
import { seedCodebaseToWorkspace } from "../codebases/codebase-seeder.js";

/**
 * Pair each resource binding with its resolved config, preserving submission
 * order and per-binding parameters.
 *
 * Driven by the bindings rather than by the resolver's output so the run gets
 * exactly one config per binding. Configs are looked up by revisionId, so a
 * resolver that reorders or dedupes cannot pair a resource with another's
 * parameters — and binding the same revision twice with different parameters
 * yields two independent configs instead of both silently receiving the first
 * binding's parameters.
 *
 * @throws if the resolver did not return a config for some binding.
 */
export function pairBindingsWithConfigs(
  bindings: ReadonlyArray<{ ref: string; revisionId: string; params?: Record<string, string> }>,
  resolved: ReadonlyArray<ResourceConfig>,
): ResourceConfig[] {
  const configByRevisionId = new Map(resolved.map((config) => [config.revisionId, config]));
  return bindings.map((binding) => {
    const config = configByRevisionId.get(binding.revisionId);
    if (!config) {
      throw new Error(
        `Resource '${binding.ref}' (revision ${binding.revisionId}) was not returned by the resolver`
      );
    }
    return Object.keys(binding.params ?? {}).length > 0
      ? { ...config, params: binding.params }
      : config;
  });
}

/**
 * Queue processor for coding agent workers.
 * Extends BaseQueueProcessor with one-shot and multi-turn processing logic,
 * including judge evaluation loops, workspace snapshots, and visibility timeout extension.
 */
export class CodingAgentQueueProcessor extends BaseQueueProcessor<RequestDocument> {
  private processor: WorkerProcessor;
  private readonly runtimeAgentVersion: string;
  private postProcessorQueueClient: QueueClient | null = null;

  constructor(config: QueueProcessorConfig, processor: WorkerProcessor) {
    super(config, processor.workerName);
    this.processor = processor;
    this.runtimeAgentVersion =
      process.env.SCOPE_AGENT_VERSION?.trim() ||
      processor.getAgentVersion?.()?.trim() ||
      "";
    if (!this.runtimeAgentVersion) {
      throw new Error(
        `Worker ${processor.workerName} must provide SCOPE_AGENT_VERSION or getAgentVersion()`,
      );
    }

    // Create post-processor queue client if configured (event-driven dispatch)
    if (config.postProcessorQueueName) {
      if (config.storageConnectionString) {
        this.postProcessorQueueClient = new QueueClient(
          config.storageConnectionString,
          config.postProcessorQueueName,
        );
      } else {
        const credential = new DefaultAzureCredential();
        const queueUrl = `https://${config.storageAccountName}.queue.core.windows.net`;
        this.postProcessorQueueClient = new QueueClient(
          `${queueUrl}/${config.postProcessorQueueName}`,
          credential,
        );
      }
    }
  }

  /**
   * Enqueue a post-processing message (non-fatal on failure — polling dispatcher
   * will catch up within 2s if this fails).
   */
  private async enqueuePostProcessing(requestId: string, runId: string): Promise<void> {
    if (!this.postProcessorQueueClient) return;
    try {
      const message = Buffer.from(
        JSON.stringify({ type: "atif", requestId, runId }),
      ).toString("base64");
      await this.postProcessorQueueClient.sendMessage(message);
      console.log(`[${this.workerName}] Post-processing enqueued for ${requestId}`);
    } catch (err) {
      console.warn(`[${this.workerName}] Failed to enqueue post-processing for ${requestId}:`, err);
    }
  }

  /** Override base hook to enqueue post-processing when a run completes via the error path. */
  protected override async onRunTerminal(requestId: string, runId: string): Promise<void> {
    await this.enqueuePostProcessing(requestId, runId);
  }

  /** Build workerVersion and OS fields for stamping on request documents.
   *  agentVersion is set at submission time by the API — the worker only adds workerVersion.
   *  OS info is always captured regardless of agentVersion availability. */
  private getVersionFields(): { os: OsInfo; workerVersion?: string } {
    const fields: { os: OsInfo; workerVersion?: string } = {
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
    };
    const gitCommit = process.env.GIT_COMMIT || "unknown";
    const buildTime = process.env.BUILD_TIME || "unknown";
    fields.workerVersion = `${this.runtimeAgentVersion}-${buildTime}-${gitCommit}`;
    return fields;
  }

  protected async handleRequest(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const runtimeAgentVersion = this.runtimeAgentVersion;
    if (requestDoc.run?.status === "pending") {
      console.log(
        `[${this.workerName}] Discarding stale queue message for pending request ${requestDoc._id}`,
      );
      await log("info", "Stale queue message discarded after scheduler recovery");
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    if (
      requestDoc.run?.queuedQueueName &&
      requestDoc.run.queuedQueueName !== this.config.queueName
    ) {
      console.log(
        `[${this.workerName}] Discarding stale queue message for ${requestDoc._id} ` +
          `(queued=${requestDoc.run.queuedQueueName}, current=${this.config.queueName})`,
      );
      await log("info", "Stale queue message discarded after queue reassignment", {
        queuedQueueName: requestDoc.run.queuedQueueName,
        currentQueueName: this.config.queueName,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    if (
      requestDoc.workerType !== this.workerName ||
      requestDoc.agentVersion !== runtimeAgentVersion
    ) {
      const popReceipt = heartbeat.stop();
      console.warn(
        `[${this.workerName}] Deferring request ${requestDoc._id} for a different target ` +
          `(requested=${requestDoc.workerType}@${requestDoc.agentVersion ?? "(missing)"}, ` +
          `runtime=${this.workerName}@${runtimeAgentVersion ?? "(missing)"})`,
      );
      await log("warn", "Queue message belongs to a different worker target", {
        requestedWorkerType: requestDoc.workerType,
        requestedAgentVersion: requestDoc.agentVersion,
        runtimeWorkerType: this.workerName,
        runtimeAgentVersion,
      });
      // Release immediately. Queue ownership rules prevent this in new registry
      // state, but deferral preserves recoverability for legacy/racing records.
      await this.safeDeferMessage(message.messageId, popReceipt, 0);
      return;
    }

    // Run-retry-attempts: verify the message targets the request's CURRENT run.
    // If a retry has since started a new attempt, this message is stale and
    // must be discarded so we don't clobber the new run's state.
    const messageRunId = typeof payload?.runId === "string" ? payload.runId : undefined;
    const currentRunId = requestDoc.run?._id;
    if (messageRunId && currentRunId && messageRunId !== currentRunId) {
      console.log(
        `[${this.workerName}] Stale message for ${requestDoc._id}: runId=${messageRunId} but current=${currentRunId} \u2014 discarding`,
      );
      await log("warn", `Stale queue message discarded (runId mismatch)`, {
        messageRunId,
        currentRunId,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    // If the request was paused while sitting in the queue, discard the
    // message. The scheduler will re-enqueue when the user resumes.
    if (requestDoc.run?.status === "paused") {
      console.log(
        `[${this.workerName}] Request ${requestDoc._id} is paused — discarding queue message`,
      );
      await log("info", `Request paused — discarding queue message`);
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    // Terminal status guard: if the run is already done (e.g. cancelled while
    // this message was in the queue or redelivered after process.exit), discard.
    if (requestDoc.run?.status === "done") {
      console.log(
        `[${this.workerName}] Request ${requestDoc._id} is already terminal (done) — discarding queue message`,
      );
      await log("info", `Run already terminal — discarding queue message`);
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }
    // Redelivery handling: if the run is already in "processing" state, the
    // message was redelivered by Azure Storage Queue while the original
    // worker was busy. There are two cases we need to disambiguate using
    // the per-run liveness heartbeat in Redis (run.worker stays in Mongo as
    // persistent identity):
    //
    //   1. Original worker is alive (fresh Redis heartbeat) — a spurious
    //      redelivery (transient queue-extension miss, throttling, etc.).
    //      Drop the duplicate message and leave the run untouched so the
    //      original worker keeps making progress.
    //
    //   2. Original worker is dead (stale or missing Redis heartbeat AND
    //      run was picked up long enough ago) — mark the run failed
    //      atomically so the user can retry.
    //
    // Atomicity of the claim is gated on the existing run.worker.instanceId
    // in the findOneAndUpdate filter: if a peer worker has already taken
    // over (rewriting run.worker.instanceId), our update no-ops.
    if (requestDoc.run?.status === "processing") {
      const staleThresholdMs =
        Number(process.env.SCOPE_RUN_HEARTBEAT_STALE_MS) ||
        2 * HEARTBEAT_VISIBILITY_SECONDS * 1000;
      // How far to push a duplicate's visibility when the original worker is
      // still alive. Defaults to the staleness threshold so the message
      // resurfaces for another liveness re-check right around the time the
      // run would be declared dead if the worker stopped beating.
      const redeliverDeferMs =
        Number(process.env.SCOPE_RUN_REDELIVER_DEFER_MS) || staleThresholdMs;
      const heartbeatAt = await this.heartbeatStore.get(requestDoc.run._id);
      const startedAt = requestDoc.run.startedAt instanceof Date
        ? requestDoc.run.startedAt
        : requestDoc.run.startedAt
          ? new Date(requestDoc.run.startedAt as any)
          : undefined;
      const ageMs = heartbeatAt ? Date.now() - heartbeatAt.getTime() : Infinity;
      // Missing-heartbeat guard: if Redis returns null we don't immediately
      // declare the worker dead — a transient Redis blip would otherwise
      // mass-fail healthy in-flight runs. Only treat "missing" as stale if
      // the run was picked up longer ago than the staleness threshold.
      const isStale = heartbeatAt
        ? ageMs > staleThresholdMs
        : (!startedAt || Date.now() - startedAt.getTime() > staleThresholdMs);
      const workerInfo = requestDoc.run.worker;
      const workerDesc = workerInfo
        ? `instance=${workerInfo.instanceId}${workerInfo.podName ? ` pod=${workerInfo.podName}` : ""}`
        : "unknown worker";

      if (!isStale) {
        // Original worker is still beating. Do NOT delete the duplicate —
        // that would destroy the only at-least-once recovery trigger if the
        // original worker later dies hard (the scheduler only dispatches
        // `pending` runs, never `processing`). Instead, re-defer the message
        // so it resurfaces later for another liveness re-check: if the worker
        // is still alive then, we re-defer again (cheap); if it died, the
        // next dequeue sees a stale heartbeat and marks the run failed.
        const beatDesc = heartbeatAt
          ? `last beat ${Math.round(ageMs / 1000)}s ago`
          : `no heartbeat yet, picked up ${startedAt ? Math.round((Date.now() - startedAt.getTime()) / 1000) : "?"}s ago`;
        const deferSeconds = Math.max(1, Math.round(redeliverDeferMs / 1000));
        console.warn(
          `[${this.workerName}] Duplicate message for ${requestDoc._id} (runId=${requestDoc.run._id}) — original worker still alive (${workerDesc}, ${beatDesc}); re-deferring ${deferSeconds}s`,
        );
        await log(
          "warn",
          `Duplicate queue message re-deferred — original worker still heart-beating (${workerDesc}, ${beatDesc})`,
          { runId: requestDoc.run._id },
        );
        // Stop THIS (duplicate) worker's visibility heartbeat first so the pop
        // receipt is frozen — otherwise a concurrent heartbeat tick could
        // rotate it out from under our re-defer. safeDeferMessage swallows
        // failures so a stale receipt never falls through to the error path.
        const frozenReceipt = heartbeat.stop();
        await this.safeDeferMessage(message.messageId, frozenReceipt, deferSeconds);
        return;
      }

      const errorMsg = `Worker presumed dead (${workerDesc}, last heartbeat ${heartbeatAt ? `${Math.round(ageMs / 1000)}s ago` : "never"}, threshold ${Math.round(staleThresholdMs / 1000)}s); queue message redelivered while run was in 'processing' state`;
      // Atomic claim: gate on the *current* run.worker.instanceId. If a
      // peer worker has already taken over (rewrote run.worker.instanceId)
      // between our read and write, our filter no-ops and we drop the dupe.
      const currentOwnerId = workerInfo?.instanceId;
      const staleFinishedAt = new Date();
      const claim = await withRetry(() => this.collection.findOneAndUpdate(
        {
          _id: requestDoc._id,
          "run._id": requestDoc.run!._id,
          "run.status": "processing",
          ...(currentOwnerId
            ? { "run.worker.instanceId": currentOwnerId }
            : { "run.worker": { $exists: false } }),
        } as any,
        {
          $set: {
            "run.status": "done",
            "run.outcome": "failed",
            "run.error": errorMsg,
            "run.finishedAt": staleFinishedAt,
            ...durationSetFields(requestDoc.run?.startedAt, staleFinishedAt),
            "run.updatedAt": new Date(),
            updatedAt: new Date(),
            ...(this.postProcessorQueueClient ? { "run.postProcessorStatus": "queued" } : {}),
          },
        } as any,
      ));
      if (claim) {
        console.warn(
          `[${this.workerName}] Stale-heartbeat redelivery for ${requestDoc._id} (runId=${requestDoc.run._id}, ${workerDesc}) — marked run as failed`,
        );
        await log(
          "error",
          `Run marked failed: ${errorMsg}. Use the retry endpoint to start a new attempt.`,
          { final: true, runId: requestDoc.run._id },
        );
        // Run is terminal — drop the heartbeat key so the API stops
        // surfacing it (TTL would expire it eventually anyway).
        await this.heartbeatStore.delete(requestDoc.run!._id);
        // Enqueue post-processing even for failed runs (partial trajectory is useful)
        await this.enqueuePostProcessing(requestDoc._id, requestDoc.run!._id);
      } else {
        // Either the original worker resumed beating between our read and
        // write, or a concurrent retry already demoted this run, or the
        // original just finished. Nothing to do — drop the duplicate.
        console.log(
          `[${this.workerName}] Redelivery for ${requestDoc._id} but run state / heartbeat changed concurrently — discarding`,
        );
      }
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }

    const startedAt = await this.claimRunForProcessing(requestDoc);
    if (!startedAt) {
      console.log(
        `[${this.workerName}] Request ${requestDoc._id} could not be claimed — run state changed concurrently; discarding`,
      );
      await log("warn", "Run could not be claimed for processing because its state changed concurrently", {
        runId: requestDoc.run?._id,
      });
      await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
      return;
    }

    // Fail fast on a missing project scope. Every downstream resolver below
    // (MCP servers, skills, extensions, secrets, and the report-generator) builds
    // `?projectId=${encodeURIComponent(projectId)}` URLs, so an absent value
    // would `encodeURIComponent(undefined)` into the literal string
    // "undefined" and silently query a project named "undefined" — a confusing
    // 404 instead of a clear error. A run should never reach here without a
    // projectId (the API sets it on submit and migration 026 backfills legacy
    // docs), so treat its absence as a hard, explicit failure.
    if (!requestDoc.projectId) {
      throw new Error(
        `Request ${requestDoc._id} has no projectId — cannot resolve project-scoped resources (MCP servers, skills, secrets)`,
      );
    }
    // Resolve MCP server slugs to configs via API
    let mcpServerConfigs: McpServerConfig[] | undefined;
    if (requestDoc.mcpServers && requestDoc.mcpServers.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("MCP servers requested but SCOPE_MT_API_URL is not configured");
      }
      const mcpClient = new McpServerClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.mcpServers.length} MCP server(s)`, { mcpServers: requestDoc.mcpServers });
      mcpServerConfigs = await mcpClient.resolveServers(requestDoc.projectId, requestDoc.mcpServers);
      await log("info", `Resolved MCP servers: ${mcpServerConfigs.map(s => s.name).join(", ")}`);

      // Hydrate configs with real plaintext secrets from Token Manager
      const tokenManagerUrl = (this.config as QueueProcessorConfig).tokenManagerUrl;
      if (tokenManagerUrl) {
        const secretClient = new McpSecretClient(tokenManagerUrl);
        const hydratedNames: string[] = [];
        mcpServerConfigs = await Promise.all(
          mcpServerConfigs.map(async (config) => {
            try {
              const resolved = await secretClient.resolveSecrets(requestDoc.projectId, config.slug);
              if ('env' in resolved && resolved.env && Object.keys(resolved.env).length > 0) {
                hydratedNames.push(config.name);
                return { ...config, env: resolved.env };
              }
              if ('headers' in resolved && resolved.headers && resolved.headers.length > 0) {
                hydratedNames.push(config.name);
                return { ...config, headers: resolved.headers };
              }
              return config;
            } catch (err) {
              await log("warn", `Failed to hydrate secrets for MCP server '${config.name}' (${config.slug})`, {
                error: err instanceof Error ? err.message : String(err),
              });
              return config;
            }
          })
        );
        if (hydratedNames.length > 0) {
          await log("info", `Hydrated secrets for MCP servers: ${hydratedNames.join(", ")}`);
        }
      } else {
        await log("warn", "TOKEN_MANAGER_URL not configured — MCP server secrets will not be resolved");
      }
    }

    // Resolve skill revision refs to configs via API
    let skillConfigs: SkillConfig[] | undefined;
    if (requestDoc.skillRevisions && requestDoc.skillRevisions.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("Skill revisions requested but SCOPE_MT_API_URL is not configured");
      }
      const skillClient = new SkillClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.skillRevisions.length} skill revision(s)`, { skillRevisions: requestDoc.skillRevisions });
      skillConfigs = await skillClient.resolveSkills(requestDoc.projectId, requestDoc.skillRevisions);
      await log("info", `Resolved skills: ${skillConfigs.map(s => s.name).join(", ")}`);
    }

    // Resolve extension specs (id or id@version) to configs via API
    let extensionConfigs: ExtensionConfig[] | undefined;
    if (requestDoc.extensions && requestDoc.extensions.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("Extensions requested but SCOPE_MT_API_URL is not configured");
      }
      const extensionClient = new ExtensionClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.extensions.length} extension(s)`, { extensions: requestDoc.extensions });
      extensionConfigs = await extensionClient.resolveExtensions(requestDoc.projectId, requestDoc.extensions);
      await log("info", `Resolved extensions: ${extensionConfigs.map(e => e.version ? `${e.id}@${e.version}` : e.id).join(", ")}`);
    }

    // Resolve resource revisions to configs via API. Resolved here rather than
    // inside the worker so a failure to find a resource fails the run before any
    // setup work happens.
    let resourceConfigs: ResourceConfig[] | undefined;
    if (requestDoc.resources && requestDoc.resources.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("Resources requested but SCOPE_MT_API_URL is not configured");
      }
      const bindings = requestDoc.resources;
      const resourceClient = new ResourceClient(apiBaseUrl);
      await log("info", `Resolving ${bindings.length} resource(s)`, { resources: bindings.map(b => b.ref) });
      const resolved = await resourceClient.resolveResources(
        requestDoc.projectId,
        bindings.map(b => b.revisionId)
      );
      resourceConfigs = pairBindingsWithConfigs(bindings, resolved);
      await log("info", `Resolved resources: ${resourceConfigs.map(r => r.ref).join(", ")}`);
    }

    await this.processMultiTurn(requestDoc, message, heartbeat, log, startedAt, mcpServerConfigs, skillConfigs, extensionConfigs, resourceConfigs);
  }

  /**
   * Atomically claim the exact queued run before resolving any fallible runtime
   * resources. This both excludes duplicate execution and guarantees the base
   * error path can terminalize setup failures against an owned processing run.
   */
  private async claimRunForProcessing(requestDoc: RequestDocument): Promise<Date | undefined> {
    const runId = requestDoc.run?._id;
    if (!runId) {
      throw new Error(`Request ${requestDoc._id} has no current run id`);
    }

    const versionFields = this.getVersionFields();
    const startedAt = new Date();
    const result = await withRetry(() => this.collection.updateOne(
      {
        _id: requestDoc._id,
        "run._id": runId,
        "run.status": "queued",
        "run.queuedQueueName": this.config.queueName,
      } as any,
      {
        $set: {
          "run.status": "processing",
          "run.startedAt": startedAt,
          "run.updatedAt": startedAt,
          "run.worker": {
            instanceId: this.instanceId,
            ...(this.podName ? { podName: this.podName } : {}),
          },
          "run.turns": [],
          gateSummaries: [],
          "run.workerVersion": versionFields.workerVersion,
          "run.os": versionFields.os,
          updatedAt: startedAt,
        },
        $unset: { "run.queuedQueueName": "" },
      } as any,
    ));

    if ((result.matchedCount ?? 0) === 0) {
      return undefined;
    }

    requestDoc.run!.status = "processing";
    requestDoc.run!.startedAt = startedAt;
    requestDoc.run!.worker = {
      instanceId: this.instanceId,
      ...(this.podName ? { podName: this.podName } : {}),
    };

    // Seed liveness immediately so a fast redelivery observes this claim.
    await this.heartbeatStore.set(runId, startedAt);
    return startedAt;
  }

  /**
   * Fire-and-forget report generation trigger via REST API.
   * Calls the trigger endpoint which evaluates all report templates' triggers
   * and creates a report for each matching template.
   */
  private async triggerReportGeneration(requestId: string): Promise<void> {
    const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
    if (!apiBaseUrl) return;

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/reports/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (response.ok) {
        const result = await response.json() as { triggered: number };
        console.log(`[${this.workerName}] Triggered report generation for request ${requestId}: ${result.triggered} report(s) created`);
      } else {
        console.warn(`[${this.workerName}] Failed to trigger report generation: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.warn(`[${this.workerName}] Failed to trigger report generation: ${error}`);
    }
  }

  /**
   * Extract skill archives to the workspace filesystem so agents can discover them.
   * Must be called after setup() so that processor.workspacePath points to the
   * freshly-created temp directory rather than the stale default.
   */
  private async extractSkills(
    requestDoc: RequestDocument,
    skillConfigs: SkillConfig[],
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    if (!requestDoc.skillRevisions || requestDoc.skillRevisions.length === 0) return;

    const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
    if (!apiBaseUrl) return;

    const workspacePath = this.processor.workspacePath || process.env.WORKSPACE_PATH || "/workspace";
    const skillClient = new SkillClient(apiBaseUrl);
    const installedPaths = await extractSkillsToWorkspace({
      refs: requestDoc.skillRevisions,
      skillConfigs,
      skillClient,
      projectId: requestDoc.projectId,
      workspacePath,
      agentType: this.processor.skillAgentType,
      log: async (msg) => { await log("info", msg); },
    });
    await log("info", `Installed ${installedPaths.length} skill path(s) to workspace`, { installedPaths });
  }

  /**
   * Write the AGENTS.md body into the workspace root before the run starts.
   *
   * The body is constant for the whole run, so it is resolved once and written
   * to `<workspace>/AGENTS.md` before the first turn. The text is resolved via
   * the API (`GET /api/v1/task-prompts/:id/content`), which downloads from blob
   * storage when the prompt is blob-backed — the worker never touches blob.
   *
   * Fails loudly (throws) when `agentsMdPromptId` is set but `apiBaseUrl` is
   * missing or the fetch/write fails, so the run is marked failed rather than
   * silently evaluating the baseline worker (which would corrupt results).
   */
  private async writeAgentsMd(
    requestDoc: RequestDocument,
    workspacePath: string,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const agentsMdPromptId = requestDoc.agentsMdPromptId;
    if (!agentsMdPromptId) return;

    const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
    if (!apiBaseUrl) {
      throw new Error(
        `Request has agentsMdPromptId '${agentsMdPromptId}' but no apiBaseUrl is configured; cannot resolve AGENTS.md`,
      );
    }

    const promptClient = new PromptClient(apiBaseUrl);
    const text = await promptClient.getText(agentsMdPromptId);
    const agentsMdPath = join(workspacePath, "AGENTS.md");
    await writeFile(agentsMdPath, text, "utf-8");
    await log("info", `Wrote AGENTS.md to workspace`, {
      agentsMdPromptId,
      path: agentsMdPath,
      bytes: Buffer.byteLength(text, "utf-8"),
    });
  }

  /**
   * Resolve a typed prompt entity's text by id via the API. Used for non-Select
   * gates whose prompt is referenced by id on the request's gate config. Throws
   * when the prompt cannot be resolved — a misconfigured gate must fail the run
   * rather than silently run with an empty prompt.
   */
  private async resolveGatePromptText(
    promptId: string,
    apiBaseUrl: string | undefined,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<string> {
    if (!promptId) {
      throw new Error("Gate is missing a promptId");
    }
    if (!apiBaseUrl) {
      throw new Error("apiBaseUrl is not configured but a gate references a prompt by id");
    }
    const url = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/task-prompts/${encodeURIComponent(promptId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to resolve gate prompt '${promptId}': HTTP ${res.status}`);
    }
    const doc = (await res.json()) as { text?: string };
    if (!doc?.text || !doc.text.trim()) {
      throw new Error(`Gate prompt '${promptId}' resolved to empty text`);
    }
    await log("info", `Resolved gate prompt '${promptId}'`, { promptId, length: doc.text.length });
    return doc.text;
  }

  /**
   * Record lifecycle observations (resource outcomes, MCP registration) on the
   * request document.
   *
   * Best-effort: failing to record observability must not change the run's
   * outcome, which is the thing the run actually exists to report. Safe to call
   * more than once — the second call simply overwrites with the same or fresher
   * values.
   */
  private async persistRunObservations(
    requestId: string,
    log: (level: "info" | "warn" | "error" | "debug", message: string, data?: Record<string, unknown>) => Promise<void> | void,
  ): Promise<void> {
    if (!this.processor.getRunObservations) return;
    try {
      const obs = this.processor.getRunObservations();
      const fields: Record<string, unknown> = { "run.updatedAt": new Date(), updatedAt: new Date() };
      if (obs.resources && obs.resources.length > 0) fields["run.resources"] = obs.resources;
      if (obs.mcpRegistered !== undefined) fields["run.mcpRegistered"] = obs.mcpRegistered;
      if (Object.keys(fields).length > 2) {
        await withRetry(() => this.collection.updateOne({ _id: requestId }, { $set: fields } as any));
      }
    } catch (err) {
      await log("warn", `Failed to record run observations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Multi-turn processing with judge loop.
   */
  private async processMultiTurn(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    startedAt: Date,
    mcpServerConfigs?: McpServerConfig[],
    skillConfigs?: SkillConfig[],
    extensionConfigs?: ExtensionConfig[],
    resourceConfigs?: ResourceConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;
    // Resolve the runId for blob paths. New requests always have run._id;
    // legacy/pre-migration docs may not, in which case we fall back to the
    // requestId so the layout matches the legacy `{requestId}/...` scheme.
    const runId = requestDoc.run?._id ?? requestId;

    // Normalise the request into an ordered list of gate configs. When the
    // request carries no `gates`, this yields a single Select gate built from
    // the legacy fields (scenario.criteria + maxIterations + taskPromptId), so
    // existing requests behave identically. See docs/design/gates.md §4.3.
    const requestMaxIterations = requestDoc.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS;
    const gateConfigs = normalizeGates({
      gates: requestDoc.gates,
      scenarioCriteria: requestDoc.scenario.criteria,
      maxIterations: requestDoc.maxIterations,
      taskPromptId: requestDoc.taskPromptId,
    });
    const hasCriteria = gateConfigs.some((g) => g.criteria && g.criteria.length > 0);
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (hasCriteria && !judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but request has criteria to evaluate");
    }

    const now = startedAt;

    // Subscribe to instant cancel notifications via Redis Pub/Sub.
    // If a cancel signal arrives, exit immediately — the run is already
    // marked done/failed in DB by the cancel API. K8s (or docker compose
    // restart) will bring up a fresh worker.
    const unsubCancel = this.heartbeatStore.subscribeCancellation(
      requestDoc.run!._id,
      () => {
        console.log(
          `[${this.workerName}] Run ${requestDoc.run!._id} cancelled via pub/sub — exiting process`,
        );
        cancelExit();
      },
    );

    await log("info", `Starting multi-turn processing with ${this.processor.workerName}`, {
      criteria: requestDoc.scenario.criteria,
      maxIterations: requestDoc.maxIterations,
      ...(requestDoc.model ? { model: requestDoc.model } : {}),
      ...(requestDoc.reasoningEffort ? { reasoningEffort: requestDoc.reasoningEffort } : {}),
    });

    // Only create JudgeClient when criteria exist and judge will actually be called
    const judgeClient = hasCriteria && judgeServiceUrl ? new JudgeClient(judgeServiceUrl) : undefined;
    const blobStorage = new BlobStorage({
      storageAccountName: this.config.storageAccountName,
      storageConnectionString: this.config.storageConnectionString,
    });

    const maxIterations = requestMaxIterations;

    let result;
    try {
      // Setup: create workspace, extract skills, upload setup videos
      if (this.processor.setup) {
        const setupResult = await this.processor.setup(log, { model: requestDoc.model, projectId: requestDoc.projectId, mcpServerConfigs, skillConfigs, extensionConfigs, resourceConfigs });

        if (setupResult?.videoFilePaths && setupResult.videoFilePaths.length > 0) {
          try {
            const setupVideoUrls: string[] = [];
            for (let i = 0; i < setupResult.videoFilePaths.length; i++) {
              const videoBlobName = `${requestId}/runs/${runId}/setup/video-${i}.webm`;
              const videoUrl = await blobStorage.uploadFile(
                setupResult.videoFilePaths[i],
                videoBlobName,
                "video/webm"
              );
              setupVideoUrls.push(videoUrl);
            }
            await log("info", "Setup video files uploaded", { videoCount: setupResult.videoFilePaths.length });
            if (setupVideoUrls.length > 0) {
              await withRetry(() => this.collection.updateOne(
                { _id: requestId },
                { $set: { "run.setupVideoUrls": setupVideoUrls, "run.updatedAt": new Date(), updatedAt: new Date() } }
              ));
            }
          } catch (uploadError) {
            const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
            await log("warn", `Failed to upload setup video files: ${msg}`);
          }
        }
      }

      // Seed the workspace from a selected codebase revision (after setup so
      // workspacePath is resolved, BEFORE skills so skills overlay the project).
      // Seeding is a hard prerequisite — a failure here fails the run rather than
      // silently starting the agent from an empty workspace.
      if (requestDoc.codebaseRevisionId) {
        const apiBaseUrl = process.env.SCOPE_MT_API_URL;
        if (!apiBaseUrl) {
          throw new Error("Codebase revision requested but SCOPE_MT_API_URL is not configured");
        }
        const codebaseWorkspacePath =
          this.processor.workspacePath || process.env.WORKSPACE_PATH || "/workspace";
        const codebaseClient = new CodebaseClient(apiBaseUrl);
        await seedCodebaseToWorkspace({
          revisionId: requestDoc.codebaseRevisionId,
          codebaseClient,
          workspacePath: codebaseWorkspacePath,
          log: (msg) => log("info", msg),
        });
      }

      // Extract skills to the workspace (after setup so workspacePath is resolved)
      if (skillConfigs) {
        await this.extractSkills(requestDoc, skillConfigs, log);
      }

      // Resolve workspace path after setup
      const workspacePath = this.processor.workspacePath || process.env.WORKSPACE_PATH || "/workspace";

      // Write AGENTS.md into the workspace once before the run (constant for the
      // whole run). Throws → run is marked failed (fail loudly, never no-op).
      await this.writeAgentsMd(requestDoc, workspacePath, log);

      // Resolve each gate's prompt text. The Select gate uses the already-resolved
      // scenario task; other gates resolve their typed prompt entity by id via the
      // API. See docs/design/gates.md §4.4/§4.5.
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      const resolvedGates: ResolvedGate[] = [];
      for (const gc of gateConfigs) {
        let promptText: string;
        if (gc.gate === "select") {
          promptText = requestDoc.scenario.task;
        } else {
          if (!gc.promptId) {
            throw new Error(`Gate '${gc.gate}' is missing a resolved promptId.`);
          }
          promptText = await this.resolveGatePromptText(gc.promptId, apiBaseUrl, log);
        }
        resolvedGates.push({
          gate: gc.gate,
          promptText,
          criteria: gc.criteria,
          maxIterations: gc.maxIterations ?? maxIterations,
        });
      }

      result = await runGatedLoop({
        processor: this.processor,
        gates: resolvedGates,
        workspacePath,
        judgeClient,
        blobStorage,
        requestId,
        runId,
        log,
        projectId: requestDoc.projectId,
        personaInstructions: requestDoc.personaInstructions,
        model: requestDoc.model,
        reasoningEffort: requestDoc.reasoningEffort,
        mcpServerConfigs,
        skillConfigs,
        extensionConfigs,
        onTurnComplete: async (turn: ConversationTurn) => {
          // Persist each turn incrementally to MongoDB (retry on CosmosDB 429).
          // Push to run.turns (run-retry-attempts shape).
          await withRetry(() => this.collection.updateOne(
            { _id: requestId },
            {
              $push: { "run.turns": turn },
              $set: { "run.updatedAt": new Date(), updatedAt: new Date() },
            } as any
          ));
        },
        onGateComplete: async (summary: GateRunSummary) => {
          // Persist per-gate summaries incrementally for cheap querying / UI.
          await withRetry(() => this.collection.updateOne(
            { _id: requestId },
            {
              $push: { gateSummaries: summary },
              $set: { "run.updatedAt": new Date(), updatedAt: new Date() },
            } as any
          ));
        },
      });
    } finally {
      // Lifecycle: teardown covers everything from setup onward, not just the
      // agent loop. Resource provisioning happens inside setup(), so a failure in
      // MCP registration, codebase seeding, skill extraction, or gate-prompt
      // resolution would otherwise leave provisioned resources running. teardown()
      // is idempotent, so the widened boundary is safe.
      if (this.processor.teardown) {
        await this.processor.teardown(log);
      }
      // Persist lifecycle observations AFTER teardown so teardownRan is accurate.
      await this.persistRunObservations(requestId, log);
      // Unsubscribe from cancel notifications — normal completion path
      unsubCancel();
    }

    const finalStatus = "done";
    const finalOutcome = result.passed
      ? "succeeded"
      : result.hadError
        ? "failed"
        : "finished";
    await log("info", `Multi-turn processing ${finalOutcome}`, {
      passed: result.passed,
      totalIterations: result.turns.length,
      final: true,
    });

    const totalAiCallCount = result.turns.reduce((sum, t) => sum + (t.aiCallCount ?? 0), 0);

    // Aggregate per-turn tokenUsage into run-level totals
    const hasAnyTokenUsage = result.turns.some((t) => t.tokenUsage);
    const totalTokenUsage = hasAnyTokenUsage
      ? result.turns.reduce(
          (acc, t) => {
            if (!t.tokenUsage) return acc;
            return {
              promptTokens: acc.promptTokens + t.tokenUsage.promptTokens,
              completionTokens: acc.completionTokens + t.tokenUsage.completionTokens,
              totalTokens: acc.totalTokens + t.tokenUsage.totalTokens,
            };
          },
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        )
      : undefined;

    // Guard final write: only update if the run is still "processing" for this
    // specific run._id. If a cancel already set status="done", this no-ops.
    const finishedAt = new Date();
    const finalWrite = await withRetry(() => this.collection.updateOne(
      { _id: requestId, "run._id": runId, "run.status": "processing" },
      {
        $set: {
          "run.status": finalStatus,
          "run.outcome": finalOutcome,
          "run.result": result.finalResult,
          "run.finishedAt": finishedAt,
          // Denormalize duration (finishedAt − startedAt) for server-side sort.
          // `now` is this attempt's startedAt (set at pickup above).
          ...durationSetFields(now, finishedAt),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
          ...(totalAiCallCount > 0 && { "run.aiCallCount": totalAiCallCount }),
          ...(totalTokenUsage && { "run.tokenUsage": totalTokenUsage }),
          ...(result.passed ? {} : { "run.error": result.finalResult }),
          // Claim for post-processing atomically so polling dispatcher won't re-enqueue
          ...(this.postProcessorQueueClient ? { "run.postProcessorStatus": "queued" } : {}),
        },
      }
    ));

    if (finalWrite.matchedCount === 0) {
      console.warn(
        `[${this.workerName}] Final write for ${requestId} (runId=${runId}) did not match — run was cancelled or retried concurrently`,
      );
      await log("warn", "Run was cancelled or retried concurrently — skipping final update");
    } else {
      console.log(
        `[${this.workerName}] Multi-turn ${finalStatus} for request ${requestId} (${result.turns.length} iterations)`
      );

      // Event-driven post-processor dispatch — enqueue immediately on completion
      await this.enqueuePostProcessing(requestId, runId);
    }

    // Drop the Redis liveness heartbeat now that the run is terminal so it
    // doesn't surface in the API's "still processing" enrichment. (TTL would
    // eventually expire it anyway, but explicit cleanup is tidier.)
    await this.heartbeatStore.delete(requestDoc.run!._id);

    // Stop the heartbeat before deleting so the pop receipt is stable —
    // a tick landing between read and delete would invalidate it. The
    // base class also calls stop() in its finally block (it's idempotent).
    const finalPopReceipt = heartbeat.stop();
    await this.safeDeleteMessage(message.messageId, finalPopReceipt);
  }
}
