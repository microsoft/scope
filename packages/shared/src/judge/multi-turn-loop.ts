// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ConversationTurn,
  CriterionResult,
  GateId,
  TokenUsage,
  WorkerProcessor,
  WorkerProcessorOptions,
  LogEvent,
  MULTI_TURN_DEFAULTS,
} from "../types/types.js";
import type { McpServerConfig } from "../types/mcp.js";
import type { SkillConfig } from "../types/skill.js";
import type { ExtensionConfig } from "../types/extension.js";
import { BlobStorage, BlobStorageConfig } from "../storage/blob-storage.js";
import { sanitizeHarFile, extractToolCalls } from "../har/har-parser.js";
import { JudgeClient, JudgeInfrastructureError } from "./judge-client.js";

export interface MultiTurnConfig {
  /** The coding worker processor (unchanged interface, called per iteration) */
  processor: WorkerProcessor;
  /** The task to perform */
  task: string;
  /** Judge evaluation criteria (optional when maxIterations is 1) */
  criteria?: string[];
  /** Maximum number of iterations before giving up */
  maxIterations: number;
  /** Workspace directory to snapshot (must be resolved by caller after setup) */
  workspacePath: string;
  /** Judge REST API client (required when criteria are provided) */
  judgeClient?: JudgeClient;
  /** Blob storage client for workspace snapshots */
  blobStorage: BlobStorage;
  /** Request ID (top-level prefix for blob paths) */
  requestId: string;
  /** Run ID for the current attempt. Blobs are stored under
   *  `{requestId}/runs/{runId}/...` so each retry attempt gets its own
   *  isolated path and never overwrites a previous attempt's artifacts. */
  runId: string;
  /** Logging function */
  log: (
    level: LogEvent["level"],
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>;
  /** Called after each iteration to persist the turn to MongoDB */
  onTurnComplete?: (turn: ConversationTurn) => Promise<void>;
  /** Persona instructions for the judge (resolved prose from traits) */
  personaInstructions?: string;
  /** Model to pass to the coding agent */
  model?: string;
  /** Reasoning effort level to pass to the coding agent (e.g. "low", "medium", "high") */
  reasoningEffort?: string;
  /** Resolved MCP server configurations to pass to the coding agent */
  mcpServerConfigs?: McpServerConfig[];
  /** Resolved skill configurations to inject into the agent prompt */
  skillConfigs?: SkillConfig[];
  /** Resolved VS Code extension configurations for runtime installation */
  extensionConfigs?: ExtensionConfig[];
  /**
   * Which gate this loop is evaluating. Stamped on every turn and passed to the
   * judge so it can scope evaluation and inspect tool outputs (build/test/run).
   * Absent ⇒ treated as the Select gate. See docs/design/gates.md §4.4.
   */
  gate?: GateId;
  /**
   * Global iteration offset. The loop labels its iterations
   * `iterationOffset + 1 .. iterationOffset + maxIterations` so that, when
   * several gates run sequentially against the same run, iteration numbers (and
   * therefore blob paths `iteration-N/...`) stay globally unique. Defaults to 0.
   */
  iterationOffset?: number;
  /**
   * The run's project. Threaded to the judge so its criteria resolution is
   * scoped to that project (per-project catalog isolation). Absent ⇒ the judge
   * falls back to global/unscoped criteria (legacy).
   */
  projectId?: string;
}

export interface MultiTurnResult {
  turns: ConversationTurn[];
  passed: boolean;
  finalResult: string;
  /** True when the loop exited because of an unrecoverable error (agent crash, snapshot failure, judge failure), not because iterations were exhausted. */
  hadError: boolean;
}

/**
 * Runs the multi-turn coding + judge loop.
 *
 * For each iteration:
 *   1. Calls the coding agent with the current prompt
 *   2. Snapshots the workspace to blob storage
 *   3. Calls the judge REST API to evaluate the snapshot against criteria
 *   4. If judge says passed → done
 *   5. Otherwise, uses judge feedback as the next prompt
 *
 * The WorkerProcessor interface is unchanged — each iteration is a single processMessage call.
 */
export async function runMultiTurnLoop(
  config: MultiTurnConfig
): Promise<MultiTurnResult> {
  const {
    processor,
    task,
    criteria,
    maxIterations,
    judgeClient,
    blobStorage,
    requestId,
    runId,
    log,
    onTurnComplete,
    personaInstructions,
    model,
    reasoningEffort,
    mcpServerConfigs,
    skillConfigs,
    extensionConfigs,
    workspacePath,
    gate,
    iterationOffset = 0,
    projectId,
  } = config;

  // Defensive: criteria is required when maxIterations > 1
  const hasCriteria = criteria && criteria.length > 0;
  if (!hasCriteria && maxIterations > 1) {
    throw new Error("Criteria is required when maxIterations > 1");
  }

  const turns: ConversationTurn[] = [];
  let nextPrompt = task;

  await log("info", `Starting multi-turn loop (max ${maxIterations} iterations)`, {
    criteria,
    maxIterations,
    mcpServerCount: mcpServerConfigs?.length ?? 0,
    mcpServers: mcpServerConfigs?.map((s) => s.name) ?? [],
    skillCount: skillConfigs?.length ?? 0,
    skills: skillConfigs?.map((s) => s.name) ?? [],
    extensionCount: extensionConfigs?.length ?? 0,
    extensions: extensionConfigs?.map((e) => e.id) ?? [],
  });

  for (let i = 1; i <= maxIterations; i++) {
    const iteration = iterationOffset + i;
    // Create a per-iteration logger that automatically injects the iteration number
    // into every log event's data. This ensures all downstream log calls (including
    // those from inside workers) carry iteration context for the CLI to display.
    const iterLog: typeof log = async (level, message, data) =>
      log(level, message, { ...data, iteration, ...(gate && { gate }) });

    const iterationStartedAt = new Date();

    await iterLog("info", `--- Iteration ${i}/${maxIterations} ---`, {
      promptLength: nextPrompt.length,
      iterationHeader: true,
    });

    // Step 1: Call the coding agent
    await iterLog("info", "Calling coding agent...");
    let codingResponse: string | undefined;
    let turnHarUrl: string | undefined;
    let turnTokenUsage: TokenUsage | undefined;
    let turnAiCallCount: number | undefined;
    let turnToolCallsUrl: string | undefined;
    let turnToolCallCount: number | undefined;
    let turnRawChatUrl: string | undefined;
    let turnRawChatFormat: string | undefined;
    let turnChatResultUrl: string | undefined;
    let turnChatResultFormat: string | undefined;
    const turnVideoUrls: string[] = [];
    try {
      const workerResult = await processor.processMessage(nextPrompt, iterLog, { model, reasoningEffort, mcpServerConfigs, skillConfigs, extensionConfigs, iteration });
      codingResponse = workerResult.response;
      turnTokenUsage = workerResult.tokenUsage;
      turnAiCallCount = workerResult.aiCallCount;

      // Upload HAR file to blob storage if available (sanitized to strip credentials)
      if (workerResult.harFilePath) {
        try {
          const sanitizedHar = await sanitizeHarFile(workerResult.harFilePath, workerResult.harFilePath);
          const harBlobName = `${requestId}/runs/${runId}/iteration-${iteration}/devproxy.har`;
          turnHarUrl = await blobStorage.uploadFile(
            workerResult.harFilePath,
            harBlobName,
            "application/json"
          );
          await iterLog("info", "HAR file uploaded", { harUrl: turnHarUrl });

          // Extract tool calls from the sanitized HAR and write them to a
          // per-iteration JSONL blob alongside the HAR. Storing tool calls
          // out-of-band keeps unbounded lists out of the request document
          // (which is bounded to 2 MB on CosmosDB).
          try {
            const extracted = extractToolCalls(sanitizedHar);
            if (extracted.length > 0) {
              await blobStorage.writeToolCalls(requestId, runId, iteration, extracted);
              turnToolCallsUrl = blobStorage.getToolCallsBlobUrl(requestId, runId, iteration);
              turnToolCallCount = extracted.length;
              await iterLog("info", `Extracted ${extracted.length} tool call(s) from HAR`, {
                toolCallsUrl: turnToolCallsUrl,
                toolCallCount: turnToolCallCount,
              });
            } else {
              // A HAR was captured but yielded zero tool calls. This is almost
              // always an unsupported wire format (e.g. a new API shape the
              // parser doesn't recognize) rather than a genuinely tool-less
              // session — surface it loudly so the judge isn't silently starved
              // of tool-call evidence.
              await iterLog("warn", "HAR captured but 0 tool calls extracted — possible unsupported API format; judge will have no tool-call evidence", {
                harUrl: turnHarUrl,
              });
            }
          } catch (extractError) {
            const msg = extractError instanceof Error ? extractError.message : String(extractError);
            await iterLog("warn", `Failed to extract or persist tool calls from HAR: ${msg}`);
          }
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload HAR file: ${msg}`);
        }
      }

      // Upload video files to blob storage if available
      if (workerResult.videoFilePaths && workerResult.videoFilePaths.length > 0) {
        try {
          for (let i = 0; i < workerResult.videoFilePaths.length; i++) {
            const videoBlobName = `${requestId}/runs/${runId}/iteration-${iteration}/video-${i}.webm`;
            const videoUrl = await blobStorage.uploadFile(
              workerResult.videoFilePaths[i],
              videoBlobName,
              "video/webm"
            );
            turnVideoUrls.push(videoUrl);
          }
          await iterLog("info", "Video files uploaded", { videoUrls: turnVideoUrls });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload video files: ${msg}`);
        }
      }

      // Upload raw chat transcript to blob storage if available
      if (workerResult.rawChatFilePath) {
        try {
          const chatBlobName = `${requestId}/runs/${runId}/iteration-${iteration}/chat-export.json`;
          turnRawChatUrl = await blobStorage.uploadFile(
            workerResult.rawChatFilePath,
            chatBlobName,
            "application/json"
          );
          turnRawChatFormat = workerResult.rawChatFormat;
          await iterLog("info", "Raw chat transcript uploaded", { rawChatUrl: turnRawChatUrl });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload raw chat transcript: ${msg}`);
        }
      }

      // Upload chat result envelope (e.g. VS Code's IChatAgentResult2) for
      // post-hoc diagnostics. Stored as a separate blob so it never bloats
      // the request document — see growth-ecosystems/scope-core#811.
      if (workerResult.chatResultFilePath) {
        try {
          const blobName = `${requestId}/runs/${runId}/iteration-${iteration}/chat-result.json`;
          turnChatResultUrl = await blobStorage.uploadFile(
            workerResult.chatResultFilePath,
            blobName,
            "application/json"
          );
          turnChatResultFormat = workerResult.chatResultFormat;
          await iterLog("info", "Chat result envelope uploaded", { chatResultUrl: turnChatResultUrl });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload chat result envelope: ${msg}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await iterLog("error", `Coding agent failed: ${errorMsg}`, { error: errorMsg });

      // Extract HAR file path from the error if the worker attached it
      const errorHarFilePath: string | undefined = (error as any)?.harFilePath;
      let errorHarUrl: string | undefined;
      if (errorHarFilePath) {
        try {
          await sanitizeHarFile(errorHarFilePath, errorHarFilePath);
          const harBlobName = `${requestId}/runs/${runId}/iteration-${iteration}/devproxy.har`;
          errorHarUrl = await blobStorage.uploadFile(
            errorHarFilePath,
            harBlobName,
            "application/json"
          );
          await iterLog("info", "HAR file uploaded from failed iteration", { harUrl: errorHarUrl });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload HAR file from failed iteration: ${msg}`);
        }
      }

      // Extract aiCallCount from the error if the worker attached it
      const errorAiCallCount: number | undefined = (error as any)?.aiCallCount;

      // Extract video paths from the error if the worker attached them
      const errorVideoPaths: string[] = (error as any)?.videoFilePaths ?? [];
      let errorVideoUrls: string[] = [];
      if (errorVideoPaths.length > 0) {
        try {
          for (let i = 0; i < errorVideoPaths.length; i++) {
            const videoBlobName = `${requestId}/runs/${runId}/iteration-${iteration}/video-${i}.webm`;
            const videoUrl = await blobStorage.uploadFile(
              errorVideoPaths[i],
              videoBlobName,
              "video/webm"
            );
            errorVideoUrls.push(videoUrl);
          }
          await iterLog("info", "Video files uploaded from failed iteration", { videoUrls: errorVideoUrls });
        } catch (uploadError) {
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          await iterLog("warn", `Failed to upload video files: ${msg}`);
        }
      }

      // Persist a partial turn so HAR/video URLs are not lost
      const partialTurn: ConversationTurn = {
        iteration,
        ...(gate && { gate }),
        codingAgentResponse: `Coding agent failed: ${errorMsg}`,
        judgeFeedback: "",
        snapshotUrl: "",
        passed: false,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(errorHarUrl && { harUrl: errorHarUrl }),
        ...(errorVideoUrls.length > 0 && { videoUrls: errorVideoUrls }),
        ...(errorAiCallCount !== undefined && { aiCallCount: errorAiCallCount }),
      };
      turns.push(partialTurn);
      if (onTurnComplete) {
        await onTurnComplete(partialTurn);
      }

      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Coding agent failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await iterLog("info", "Coding agent completed", {
      responseLength: codingResponse?.length ?? 0,
    });

    // Step 2: Snapshot workspace to blob storage
    await iterLog("info", "Uploading workspace snapshot...");
    let snapshotUrl: string;
    let workspaceSizeBytes: number;
    try {
      ({ url: snapshotUrl, sizeBytes: workspaceSizeBytes } = await blobStorage.uploadWorkspaceSnapshot(
        workspacePath,
        requestId,
        runId,
        iteration
      ));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await iterLog("error", `Snapshot upload failed: ${errorMsg}`, { error: errorMsg });

      // Persist a partial turn so video/HAR URLs are not lost
      const partialTurn: ConversationTurn = {
        iteration,
        ...(gate && { gate }),
        ...(codingResponse && { codingAgentResponse: codingResponse }),
        judgeFeedback: `Snapshot upload failed: ${errorMsg}`,
        snapshotUrl: "",
        passed: false,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(turnHarUrl && { harUrl: turnHarUrl }),
        ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
        ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
        ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
        ...(turnChatResultUrl && { chatResultUrl: turnChatResultUrl }),
        ...(turnChatResultFormat && { chatResultFormat: turnChatResultFormat }),
      };
      turns.push(partialTurn);
      if (onTurnComplete) {
        await onTurnComplete(partialTurn);
      }

      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Snapshot upload failed on iteration ${iteration}: ${errorMsg}`,
      };
    }

    await iterLog("info", "Snapshot uploaded", { snapshotUrl, workspaceSizeBytes });

    // Skip judge evaluation when no criteria are provided and maxIterations is 1
    // (single-iteration pass-through mode: run the agent, snapshot, done)
    if (!hasCriteria && maxIterations === 1) {
      await iterLog("info", "No criteria provided with maxIterations=1 — skipping judge evaluation");

      const turn: ConversationTurn = {
        iteration,
        ...(gate && { gate }),
        ...(codingResponse && { codingAgentResponse: codingResponse }),
        judgeFeedback: "No criteria — judge evaluation skipped",
        snapshotUrl,
        workspaceSizeBytes,
        passed: true,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(turnHarUrl && { harUrl: turnHarUrl }),
        ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
        ...(turnTokenUsage && { tokenUsage: turnTokenUsage }),
        ...(turnAiCallCount !== undefined && { aiCallCount: turnAiCallCount }),
        ...(turnToolCallsUrl && { toolCallsUrl: turnToolCallsUrl }),
        ...(turnToolCallCount !== undefined && { toolCallCount: turnToolCallCount }),
        ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
        ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
        ...(turnChatResultUrl && { chatResultUrl: turnChatResultUrl }),
        ...(turnChatResultFormat && { chatResultFormat: turnChatResultFormat }),
      };
      turns.push(turn);
      if (onTurnComplete) {
        await onTurnComplete(turn);
      }

      return {
        turns,
        passed: true,
        hadError: false,
        finalResult: codingResponse ?? "",
      };
    }

    // Step 3: Call the judge
    await iterLog("info", "Calling judge for evaluation...");
    let judgePassed: boolean;
    let judgeFeedback: string;
    let criteriaResults: CriterionResult[] | undefined;
    try {
      const judgeResult = await judgeClient!.evaluate({
        snapshotUrl,
        criteria: criteria!,
        conversationHistory: turns,
        personaInstructions,
        requestId,
        iteration,
        ...(gate && { gate }),
        ...(turnToolCallsUrl && { toolCallsUrl: turnToolCallsUrl }),
        ...(projectId && { projectId }),
        ...(codingResponse && { currentAgentResponse: codingResponse }),
      });
      judgePassed = judgeResult.passed;
      judgeFeedback = judgeResult.feedback;
      criteriaResults = judgeResult.criteriaResults;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isInfra = error instanceof JudgeInfrastructureError;
      const label = isInfra
        ? "Judge infrastructure error (evaluation could not run — not a criteria failure)"
        : "Judge evaluation failed";
      await iterLog("error", `${label}: ${errorMsg}`, {
        error: errorMsg,
        ...(isInfra && {
          judgeInfrastructureError: true,
          ...(error.isVersionMismatch && { protocolVersionMismatch: true }),
        }),
      });

      // Persist a partial turn so video/snapshot URLs are not lost
      const partialTurn: ConversationTurn = {
        iteration,
        ...(gate && { gate }),
        ...(codingResponse && { codingAgentResponse: codingResponse }),
        judgeFeedback: `${label}: ${errorMsg}`,
        snapshotUrl,
        workspaceSizeBytes,
        passed: false,
        timestamp: new Date(),
        startedAt: iterationStartedAt,
        durationMs: Date.now() - iterationStartedAt.getTime(),
        ...(turnHarUrl && { harUrl: turnHarUrl }),
        ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
        ...(turnTokenUsage && { tokenUsage: turnTokenUsage }),
        ...(turnAiCallCount !== undefined && { aiCallCount: turnAiCallCount }),
        ...(turnToolCallsUrl && { toolCallsUrl: turnToolCallsUrl }),
        ...(turnToolCallCount !== undefined && { toolCallCount: turnToolCallCount }),
        ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
        ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
        ...(turnChatResultUrl && { chatResultUrl: turnChatResultUrl }),
        ...(turnChatResultFormat && { chatResultFormat: turnChatResultFormat }),
      };
      turns.push(partialTurn);
      if (onTurnComplete) {
        await onTurnComplete(partialTurn);
      }

      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `${label} on iteration ${iteration}: ${errorMsg}`,
      };
    }

    // Emit DAG summary if criteria results are available
    if (criteriaResults && criteriaResults.length > 0) {
      const passed = criteriaResults.filter(r => r.passed).length;
      const failed = criteriaResults.filter(r => r.evaluated && !r.passed).length;
      const skipped = criteriaResults.filter(r => !r.evaluated).length;
      await iterLog("info", `Criteria DAG: ${passed} passed, ${failed} failed, ${skipped} skipped`, {
        type: "criteria_dag_status",
        results: criteriaResults.map(r => ({
          criterionId: r.criterionId,
          passed: r.passed,
          evaluated: r.evaluated,
          feedback: r.feedback,
        })),
        allPassed: judgePassed,
      });
    }

    // Step 4: Record the turn
    const turn: ConversationTurn = {
      iteration,
      ...(gate && { gate }),
      ...(codingResponse && { codingAgentResponse: codingResponse }),
      judgeFeedback,
      snapshotUrl,
      workspaceSizeBytes,
      passed: judgePassed,
      timestamp: new Date(),
      startedAt: iterationStartedAt,
      durationMs: Date.now() - iterationStartedAt.getTime(),
      criteriaResults,
      ...(turnHarUrl && { harUrl: turnHarUrl }),
      ...(turnVideoUrls.length > 0 && { videoUrls: turnVideoUrls }),
      ...(turnTokenUsage && { tokenUsage: turnTokenUsage }),
      ...(turnAiCallCount !== undefined && { aiCallCount: turnAiCallCount }),
      ...(turnToolCallsUrl && { toolCallsUrl: turnToolCallsUrl }),
      ...(turnToolCallCount !== undefined && { toolCallCount: turnToolCallCount }),
      ...(turnRawChatUrl && { rawChatUrl: turnRawChatUrl }),
      ...(turnRawChatFormat && { rawChatFormat: turnRawChatFormat }),
      ...(turnChatResultUrl && { chatResultUrl: turnChatResultUrl }),
      ...(turnChatResultFormat && { chatResultFormat: turnChatResultFormat }),
    };
    turns.push(turn);

    // Persist incrementally
    if (onTurnComplete) {
      await onTurnComplete(turn);
    }

    if (judgePassed) {
      await iterLog("info", `Judge PASSED on iteration ${iteration}`, {
        totalIterations: iteration,
        feedback: judgeFeedback,
      });
      return {
        turns,
        passed: true,
        hadError: false,
        finalResult: codingResponse ?? "",
      } as MultiTurnResult;
    }

    // Step 5: Use judge feedback as next coding prompt
    await iterLog("info", `Judge feedback (iteration ${iteration}): continuing...`, {
      feedbackLength: judgeFeedback.length,
      feedback: judgeFeedback.substring(0, 500),
    });
    nextPrompt = judgeFeedback;

    // Per-iteration timeout: if this iteration alone exceeded the budget,
    // abort the loop rather than starting another iteration that is likely
    // to overrun as well. The completed iteration's turn is preserved.
    const iterationElapsedMs = Date.now() - iterationStartedAt.getTime();
    if (iterationElapsedMs > MULTI_TURN_DEFAULTS.ITERATION_TIMEOUT_MS) {
      const elapsedSec = Math.round(iterationElapsedMs / 1000);
      const budgetSec = Math.round(MULTI_TURN_DEFAULTS.ITERATION_TIMEOUT_MS / 1000);
      await iterLog(
        "warn",
        `Iteration ${iteration} exceeded timeout (${elapsedSec}s > ${budgetSec}s)`,
        { elapsedMs: iterationElapsedMs, budgetMs: MULTI_TURN_DEFAULTS.ITERATION_TIMEOUT_MS },
      );
      return {
        turns,
        passed: false,
        hadError: true,
        finalResult: `Iteration ${iteration} exceeded timeout (${elapsedSec}s > ${budgetSec}s)`,
      };
    }
  }

  // Max iterations exhausted
  await log("warn", `Max iterations (${maxIterations}) reached without passing`, {
    iteration: maxIterations,
    totalIterations: maxIterations,
  });
  return {
    turns,
    passed: false,
    hadError: false,
    finalResult: `Max iterations (${maxIterations}) reached. Last coding response: ${
      turns[turns.length - 1]?.codingAgentResponse?.substring(0, 200) || "none"
    }`,
  };
}
