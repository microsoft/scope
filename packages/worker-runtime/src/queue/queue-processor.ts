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
  OsInfo,
} from "@scope/core";
import type { McpServerConfig } from "@scope/core";
import type { SkillConfig } from "@scope/core";
import type { ExtensionConfig } from "@scope/core";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import { cancelExit } from "./cancel-exit.js";
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";
import { HEARTBEAT_VISIBILITY_SECONDS } from "./visibility-heartbeat.js";
import { BlobStorage } from "@scope/platform";
import { withRetry } from "@scope/core";
import { sanitizeHarFile } from "@scope/platform";
import { JudgeClient } from "../judge/judge-client.js";
import { runMultiTurnLoop } from "../judge/multi-turn-loop.js";
import { McpServerClient } from "@scope/agent-protocol";
import { McpSecretClient } from "@scope/agent-protocol";
import { SkillClient } from "@scope/agent-protocol";
import { ExtensionClient } from "@scope/platform";
import { extractSkillsToWorkspace } from "@scope/agent-protocol";

/**
 * Queue processor for coding agent workers.
 * Extends BaseQueueProcessor with one-shot and multi-turn processing logic,
 * including judge evaluation loops, workspace snapshots, and visibility timeout extension.
 */
export class CodingAgentQueueProcessor extends BaseQueueProcessor<RequestDocument> {
  private processor: WorkerProcessor;
  private postProcessorQueueClient: QueueClient | null = null;

  constructor(config: QueueProcessorConfig, processor: WorkerProcessor) {
    super(config, processor.workerName);
    this.processor = processor;

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
    const agentVersion = this.processor.getAgentVersion?.();
    if (agentVersion) {
      const gitCommit = process.env.GIT_COMMIT || "unknown";
      const buildTime = process.env.BUILD_TIME || "unknown";
      fields.workerVersion = `${agentVersion}-${buildTime}-${gitCommit}`;
    }
    return fields;
  }

  protected async handleRequest(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    payload?: Record<string, unknown>,
  ): Promise<void> {
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
        // Original worker is still beating — drop the duplicate, keep run state.
        const beatDesc = heartbeatAt
          ? `last beat ${Math.round(ageMs / 1000)}s ago`
          : `no heartbeat yet, picked up ${startedAt ? Math.round((Date.now() - startedAt.getTime()) / 1000) : "?"}s ago`;
        console.warn(
          `[${this.workerName}] Duplicate message for ${requestDoc._id} (runId=${requestDoc.run._id}) — original worker still alive (${workerDesc}, ${beatDesc}); dropping`,
        );
        await log(
          "warn",
          `Duplicate queue message dropped — original worker still heart-beating (${workerDesc}, ${beatDesc})`,
          { runId: requestDoc.run._id },
        );
        await this.safeDeleteMessage(message.messageId, heartbeat.popReceipt);
        return;
      }

      const errorMsg = `Worker presumed dead (${workerDesc}, last heartbeat ${heartbeatAt ? `${Math.round(ageMs / 1000)}s ago` : "never"}, threshold ${Math.round(staleThresholdMs / 1000)}s); queue message redelivered while run was in 'processing' state`;
      // Atomic claim: gate on the *current* run.worker.instanceId. If a
      // peer worker has already taken over (rewrote run.worker.instanceId)
      // between our read and write, our filter no-ops and we drop the dupe.
      const currentOwnerId = workerInfo?.instanceId;
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
            "run.finishedAt": new Date(),
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
    // Resolve MCP server slugs to configs via API
    let mcpServerConfigs: McpServerConfig[] | undefined;
    if (requestDoc.mcpServers && requestDoc.mcpServers.length > 0) {
      const apiBaseUrl = (this.config as QueueProcessorConfig).apiBaseUrl;
      if (!apiBaseUrl) {
        throw new Error("MCP servers requested but SCOPE_MT_API_URL is not configured");
      }
      const mcpClient = new McpServerClient(apiBaseUrl);
      await log("info", `Resolving ${requestDoc.mcpServers.length} MCP server(s)`, { mcpServers: requestDoc.mcpServers });
      mcpServerConfigs = await mcpClient.resolveServers(requestDoc.mcpServers);
      await log("info", `Resolved MCP servers: ${mcpServerConfigs.map(s => s.name).join(", ")}`);

      // Hydrate configs with real plaintext secrets from Token Manager
      const tokenManagerUrl = (this.config as QueueProcessorConfig).tokenManagerUrl;
      if (tokenManagerUrl) {
        const secretClient = new McpSecretClient(tokenManagerUrl);
        const hydratedNames: string[] = [];
        mcpServerConfigs = await Promise.all(
          mcpServerConfigs.map(async (config) => {
            try {
              const resolved = await secretClient.resolveSecrets(config.slug);
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
      skillConfigs = await skillClient.resolveSkills(requestDoc.skillRevisions);
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
      extensionConfigs = await extensionClient.resolveExtensions(requestDoc.extensions);
      await log("info", `Resolved extensions: ${extensionConfigs.map(e => e.version ? `${e.id}@${e.version}` : e.id).join(", ")}`);
    }

    await this.processMultiTurn(requestDoc, message, heartbeat, log, mcpServerConfigs, skillConfigs, extensionConfigs);
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
    const agentType = requestDoc.workerType.includes("claude") ? "claude-code"
      : requestDoc.workerType.includes("copilot") ? "copilot"
      : undefined;
    const skillClient = new SkillClient(apiBaseUrl);
    const installedPaths = await extractSkillsToWorkspace({
      refs: requestDoc.skillRevisions,
      skillConfigs,
      skillClient,
      workspacePath,
      agentType,
      log: async (msg) => { await log("info", msg); },
    });
    await log("info", `Installed ${installedPaths.length} skill path(s) to workspace`, { installedPaths });
  }

  /**
   * Multi-turn processing with judge loop.
   */
  private async processMultiTurn(
    requestDoc: RequestDocument,
    message: DequeuedMessageItem,
    heartbeat: VisibilityHeartbeat,
    log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
    mcpServerConfigs?: McpServerConfig[],
    skillConfigs?: SkillConfig[],
    extensionConfigs?: ExtensionConfig[]
  ): Promise<void> {
    const requestId = requestDoc._id;
    // Resolve the runId for blob paths. New requests always have run._id;
    // legacy/pre-migration docs may not, in which case we fall back to the
    // requestId so the layout matches the legacy `{requestId}/...` scheme.
    const runId = requestDoc.run?._id ?? requestId;
    const hasCriteria = requestDoc.scenario.criteria && requestDoc.scenario.criteria.length > 0;
    const judgeServiceUrl = process.env.JUDGE_SERVICE_URL;

    if (hasCriteria && !judgeServiceUrl) {
      throw new Error("JUDGE_SERVICE_URL is not configured but request has criteria to evaluate");
    }

    // Update status to iterating (preserve logs from handleRequest — MCP/skill resolution).
    // Write to run.* (run-retry-attempts) plus a top-level updatedAt for index freshness.
    // Stamp run.worker (instance identity) atomically with the status change
    // so the redelivery handler in another worker can immediately see this
    // pickup. The accompanying liveness heartbeat is written to Redis (not
    // Mongo) immediately after to avoid recurring CosmosDB RU cost.
    const versionFields = this.getVersionFields();
    const now = new Date();
    await withRetry(() => this.collection.updateOne(
      { _id: requestId },
      {
        $set: {
          "run.status": "processing",
          "run.startedAt": now,
          "run.updatedAt": now,
          "run.worker": {
            instanceId: this.instanceId,
            ...(this.podName ? { podName: this.podName } : {}),
          },
          "run.turns": [],
          "run.workerVersion": versionFields.workerVersion,
          "run.os": versionFields.os,
          updatedAt: now,
        },
      }
    ));
    // Seed the Redis liveness heartbeat right after pickup so a redelivery
    // arriving immediately afterwards sees a fresh beat instead of falling
    // through to the missing-heartbeat guard.
    await this.heartbeatStore.set(requestDoc.run!._id, now);

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
    });

    // Only create JudgeClient when criteria exist and judge will actually be called
    const judgeClient = hasCriteria && judgeServiceUrl ? new JudgeClient(judgeServiceUrl) : undefined;
    const blobStorage = new BlobStorage({
      storageAccountName: this.config.storageAccountName,
      storageConnectionString: this.config.storageConnectionString,
    });

    const maxIterations = requestDoc.maxIterations || MULTI_TURN_DEFAULTS.MAX_ITERATIONS;

    // Setup: create workspace, extract skills, upload setup videos
    if (this.processor.setup) {
      const setupResult = await this.processor.setup(log, { model: requestDoc.model, mcpServerConfigs, skillConfigs, extensionConfigs });

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

    // Extract skills to the workspace (after setup so workspacePath is resolved)
    if (skillConfigs) {
      await this.extractSkills(requestDoc, skillConfigs, log);
    }

    // Resolve workspace path after setup
    const workspacePath = this.processor.workspacePath || process.env.WORKSPACE_PATH || "/workspace";

    let result;
    try {
      result = await runMultiTurnLoop({
        processor: this.processor,
        task: requestDoc.scenario.task,
        criteria: requestDoc.scenario.criteria,
        maxIterations,
        workspacePath,
        judgeClient,
        blobStorage,
        requestId,
        runId,
        log,
        personaInstructions: requestDoc.personaInstructions,
        model: requestDoc.model,
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
      });
    } finally {
      // Lifecycle: always call teardown() if setup() exists, even on error
      if (this.processor.teardown) {
        await this.processor.teardown(log);
      }
      // Unsubscribe from cancel notifications — normal completion path
      unsubCancel();
    }

    const finalStatus = "done";
    const finalOutcome = result.passed
      ? "succeeded"
      : result.hadError
        ? "failed"
        : result.turns.length >= maxIterations
          ? "finished"
          : "failed";
    await log("info", `Multi-turn processing ${finalOutcome}`, {
      passed: result.passed,
      totalIterations: result.turns.length,
      final: true,
    });

    const totalAiCallCount = result.turns.reduce((sum, t) => sum + (t.aiCallCount ?? 0), 0);

    // Guard final write: only update if the run is still "processing" for this
    // specific run._id. If a cancel already set status="done", this no-ops.
    const finalWrite = await withRetry(() => this.collection.updateOne(
      { _id: requestId, "run._id": runId, "run.status": "processing" },
      {
        $set: {
          "run.status": finalStatus,
          "run.outcome": finalOutcome,
          "run.result": result.finalResult,
          "run.finishedAt": new Date(),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
          ...(totalAiCallCount > 0 && { "run.aiCallCount": totalAiCallCount }),
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
