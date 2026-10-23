// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { evaluateWorkspace } from "./judge-agent.js";
import { verifyCopilotProtocol } from "./protocol-check.js";
import { resolveCurrentIteration, mapIterationToolCallUrls } from "./tool-call-history.js";
import { BlobStorage, RedisLogPublisher } from "shared";
import { forwardableRunToken } from "./run-token-forwarding.js";
import { initTelemetry, trackMetric, trackEvent } from "telemetry";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

dotenv.config();

// Initialize telemetry before any other setup
initTelemetry("scope-judge");

const app = express();
app.use(express.json({ limit: "10mb" }));

const port = parseInt(process.env.PORT || "3000", 10);
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const storageConnectionString =
  process.env.STORAGE_CONNECTION_STRING ||
  process.env.AZURE_STORAGE_CONNECTION_STRING ||
  "";

const blobStorage = new BlobStorage({
  storageAccountName,
  storageConnectionString: storageConnectionString || undefined,
});

// Redis-only log publisher for real-time criterion progress (optional — no-op if Redis not configured)
const redisHost = process.env.REDIS_HOST || "";
const redisPort = parseInt(process.env.REDIS_PORT || "6300", 10);
const redisPassword = process.env.REDIS_PASSWORD || "";

let logPublisher: RedisLogPublisher | null = null;
if (redisHost) {
  logPublisher = new RedisLogPublisher({ redisHost, redisPort, redisPassword });
  console.log(`[judge] Redis log publisher connected to ${redisHost}:${redisPort}`);
} else {
  console.log("[judge] Redis not configured — criterion progress will not be streamed");
}

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", service: "judge", version: "1.0.0" });
});

// Evaluate endpoint — called by coding workers after each iteration
app.post(
  "/api/v1/evaluate",
  async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    try {
      const { snapshotUrl, criteria, conversationHistory, personaInstructions, requestId, gate, toolCallsUrl, iteration, projectId, currentAgentResponse } = req.body;

      // Validate required fields
      if (!snapshotUrl || typeof snapshotUrl !== "string") {
        res.status(400).json({ error: "snapshotUrl is required and must be a string" });
        return;
      }

      if (
        !criteria ||
        !Array.isArray(criteria) ||
        criteria.length === 0 ||
        !criteria.every((c: unknown) => typeof c === "string")
      ) {
        res.status(400).json({
          error: "criteria is required and must be a non-empty array of strings",
        });
        return;
      }

      if (conversationHistory && !Array.isArray(conversationHistory)) {
        res.status(400).json({ error: "conversationHistory must be an array" });
        return;
      }

      if (currentAgentResponse !== undefined && typeof currentAgentResponse !== "string") {
        res.status(400).json({ error: "currentAgentResponse must be a string" });
        return;
      }

      console.log(
        `[judge] Evaluating snapshot: ${snapshotUrl} (${criteria.length} criteria, ${conversationHistory?.length || 0} prior turns)`
      );

      trackEvent({
        name: "judge.evaluation_started",
        properties: {
          requestId: requestId || "unknown",
          criteriaCount: String(criteria.length),
          gate: gate || "select",
        },
      });

      // Download and extract workspace snapshot to temp directory
      const workDir = mkdtempSync(join(tmpdir(), "judge-workspace-"));

      try {
        const downloadStart = Date.now();
        await blobStorage.downloadAndExtractSnapshot(snapshotUrl, workDir);
        const downloadMs = Date.now() - downloadStart;

        trackMetric({
          name: "judge.blob_download_ms",
          value: downloadMs,
          properties: { requestId: requestId || "unknown" },
        });

        console.log(`[judge] Snapshot extracted to ${workDir}`);

        // Assemble the coding agent's captured tool calls across the WHOLE run,
        // not just the current iteration. Each prior turn in conversationHistory
        // carries its own toolCallsUrl; the current iteration's log arrives as the
        // top-level toolCallsUrl. We fetch them all in parallel and label each by
        // its iteration number so a one-time action performed in an earlier
        // iteration (bootstrap, scaffold, install, one-off command) stays visible
        // to the judge in every later iteration. Missing/legacy logs (404 → [])
        // are skipped, never fatal — the judge can still evaluate the workspace.
        const currentIteration = resolveCurrentIteration(iteration, conversationHistory);

        // Fetch every iteration's tool-calls log in parallel, in ascending
        // iteration order. Missing/legacy logs (404 → []) are skipped, never
        // fatal — the judge can still evaluate the workspace.
        const iterationToolCalls: import("shared").IterationToolCalls[] = (
          await Promise.all(
            mapIterationToolCallUrls(
              conversationHistory,
              toolCallsUrl,
              currentIteration,
            ).map(async ({ iteration: iterNum, url }) => {
              try {
                const toolCalls = await blobStorage.getToolCalls(url);
                return { iteration: iterNum, toolCalls };
              } catch (err) {
                console.warn(
                  `[judge] Failed to load tool calls for iteration ${iterNum} from ${url}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return { iteration: iterNum, toolCalls: [] };
              }
            }),
          )
        ).filter((g) => g.toolCalls.length > 0);

        const totalToolCalls = iterationToolCalls.reduce((n, g) => n + g.toolCalls.length, 0);
        console.log(
          `[judge] Loaded ${totalToolCalls} tool call(s) across ${iterationToolCalls.length} iteration(s) for gate '${gate ?? "select"}'`,
        );

        // Build onProgress callback that publishes criterion results via Redis
        const onProgress = (requestId && logPublisher)
          ? (result: import("shared").CriterionResult) => {
              const statusIcon = !result.evaluated ? "⏭️" : result.passed ? "✅" : "❌";
              logPublisher!.publish(requestId, "info", `${statusIcon} Criterion: ${result.criterionId}`, {
                type: "criterion_result",
                criterionId: result.criterionId,
                passed: result.passed,
                evaluated: result.evaluated,
                feedback: result.feedback,
              });
            }
          : undefined;

        // Run the judge agent
        const result = await evaluateWorkspace({
          workspacePath: workDir,
          criteria,
          conversationHistory: conversationHistory || [],
          personaInstructions,
          onProgress,
          gate,
          iterationToolCalls,
          projectId,
          currentAgentResponse,
          runToken: forwardableRunToken(req.headers.authorization),
        });

        const elapsed = Date.now() - startTime;
        console.log(
          `[judge] Evaluation complete in ${elapsed}ms: passed=${result.passed}`
        );

        trackMetric({
          name: "judge.evaluation_duration_ms",
          value: elapsed,
          properties: { requestId: requestId || "unknown", gate: gate || "select" },
        });

        trackMetric({
          name: "judge.criteria_count",
          value: criteria.length,
          properties: { requestId: requestId || "unknown" },
        });

        trackEvent({
          name: "judge.evaluation_completed",
          properties: {
            requestId: requestId || "unknown",
            passed: String(result.passed),
            criteriaCount: String(criteria.length),
          },
        });

        res.json(result);
      } finally {
        // Clean up extracted workspace
        rmSync(workDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error("[judge] Evaluation error:", error);
      next(error);
    }
  }
);

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[judge] Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

async function main(): Promise<void> {
  // Fail fast on Copilot SDK<->CLI protocol drift instead of surfacing it as an
  // opaque per-evaluation HTTP 500. Set JUDGE_SKIP_PROTOCOL_CHECK=true to bypass.
  if (process.env.JUDGE_SKIP_PROTOCOL_CHECK !== "true") {
    try {
      await verifyCopilotProtocol();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        "[judge] FATAL: Copilot SDK<->CLI protocol self-check failed — refusing to start.\n" +
          "[judge] The installed @github/copilot-sdk and the bundled @github/copilot CLI disagree on the ACP protocol version.\n" +
          "[judge] Fix: align @github/copilot-sdk with the @github/copilot override in package.json, then rebuild the judge image.\n" +
          "[judge] (Set JUDGE_SKIP_PROTOCOL_CHECK=true to bypass — not recommended.)\n" +
          `[judge] Detail: ${msg}`
      );
      process.exit(1);
    }
  }

  app.listen(port, () => {
    console.log(`[judge] Judge service listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("[judge] Failed to start:", error);
  process.exit(1);
});
