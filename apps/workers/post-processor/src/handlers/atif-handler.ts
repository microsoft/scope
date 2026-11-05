// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "../types.js";
import { POST_PROCESSOR_VERSION } from "../version.js";

/**
 * Extracts the blob name (path within the container) from a full blob storage URL.
 * Handles both Azure and Azurite URL formats.
 *
 * Note: The container name ("snapshots") is coupled to the BlobStorage client config.
 * Both use the same container — HAR blobs and ATIF blobs live in "snapshots".
 */
function extractBlobName(url: string, container = "snapshots"): string | null {
  const parsed = new URL(url);
  const prefix = `/${container}/`;
  const idx = parsed.pathname.indexOf(prefix);
  if (idx === -1) return null;
  return parsed.pathname.substring(idx + prefix.length);
}

/**
 * ATIF Handler: converts per-iteration HAR captures into ATIF trajectory JSON files.
 *
 * For each iteration turn that has a `harUrl`, downloads the HAR from blob storage,
 * converts it to ATIF v1.7 using the `atifact` package, and uploads the resulting
 * trajectory.json back to blob storage.
 */
export class AtifHandler implements PostProcessHandler {
  readonly type = "atif";
  readonly version = POST_PROCESSOR_VERSION;
  readonly autoBackfill = true;

  async process(message: PostProcessorMessage, ctx: HandlerContext): Promise<void> {
    const { requestId, runId, iteration } = message;

    // Fetch the current document to get turn data
    const doc = await ctx.collection.findOne({ _id: requestId } as any) as any;
    if (!doc?.run?.turns?.length) {
      await ctx.log("info", "No turns found, skipping ATIF generation");
      return;
    }

    const turns: Array<{ iteration: number; harUrl?: string; atifUrl?: string }> = doc.run.turns;
    const turnsToProcess = iteration
      ? turns.filter((t) => t.iteration === iteration)
      : turns;

    // Lazily import parseHar (atifact is a CLI package with ESM parser modules)
    const { parseHar } = await import("atifact/dist/src/parsers/har.js");

    let processedCount = 0;

    for (const turn of turnsToProcess) {
      if (!turn.harUrl) {
        await ctx.log("info", `Iteration ${turn.iteration}: no HAR available, skipping`);
        continue;
      }

      const blobName = extractBlobName(turn.harUrl);
      if (!blobName) {
        await ctx.log("warn", `Iteration ${turn.iteration}: invalid HAR URL format`);
        continue;
      }

      // Download HAR to temp file (parseHar requires a file path)
      const tempDir = await mkdtemp(join(tmpdir(), "atif-"));
      const tempHarPath = join(tempDir, "capture.har");

      try {
        // Download HAR blob content
        const harContent = await ctx.blobStorage.downloadBlobToBuffer(blobName);
        await writeFile(tempHarPath, harContent);

        // Parse HAR → ATIF trajectory
        const result = await parseHar(tempHarPath);

        // Upload trajectory.json
        const trajectoryBlobName = `${requestId}/runs/${runId}/iteration-${turn.iteration}/atif.trajectory.json`;
        const trajectoryUrl = await ctx.blobStorage.uploadJson(
          trajectoryBlobName,
          result.trajectory,
        );

        // Update the turn's atifUrl in the document
        await ctx.collection.updateOne(
          { _id: requestId, "run.turns.iteration": turn.iteration } as any,
          { $set: { "run.turns.$.atifUrl": trajectoryUrl } } as any,
        );

        processedCount++;
        await ctx.log("info", `Iteration ${turn.iteration}: ATIF generated`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // "No LLM API calls found" is expected for some HARs (e.g. setup-only iterations)
        if (errMsg.includes("No LLM API calls found")) {
          await ctx.log("info", `Iteration ${turn.iteration}: no LLM calls in HAR, skipping`);
        } else {
          await ctx.log("warn", `Iteration ${turn.iteration}: ATIF generation failed: ${errMsg}`);
        }
      } finally {
        // Clean up temp files
        await rm(tempDir, { recursive: true }).catch((e) => {
          ctx.log("info", `Cleanup failed for ${tempDir}: ${e}`);
        });
      }
    }

    await ctx.log("info", `ATIF generation complete: ${processedCount}/${turnsToProcess.length} iterations processed`);
  }
}
