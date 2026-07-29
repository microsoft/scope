// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { evaluateWorkspace } from "./judge-agent.js";
import { BlobStorage } from "@scope/platform";
import { RedisLogPublisher } from "@scope/worker-runtime";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

dotenv.config();

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
      const { snapshotUrl, criteria, conversationHistory, personaInstructions, requestId } = req.body;

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

      console.log(
        `[judge] Evaluating snapshot: ${snapshotUrl} (${criteria.length} criteria, ${conversationHistory?.length || 0} prior turns)`
      );

      // Download and extract workspace snapshot to temp directory
      const workDir = mkdtempSync(join(tmpdir(), "judge-workspace-"));

      try {
        await blobStorage.downloadAndExtractSnapshot(snapshotUrl, workDir);

        console.log(`[judge] Snapshot extracted to ${workDir}`);

        // Build onProgress callback that publishes criterion results via Redis
        const onProgress = (requestId && logPublisher)
          ? (result: import("@scope/core").CriterionResult) => {
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
        });

        const elapsed = Date.now() - startTime;
        console.log(
          `[judge] Evaluation complete in ${elapsed}ms: passed=${result.passed}`
        );

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
  app.listen(port, () => {
    console.log(`[judge] Judge service listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("[judge] Failed to start:", error);
  process.exit(1);
});
