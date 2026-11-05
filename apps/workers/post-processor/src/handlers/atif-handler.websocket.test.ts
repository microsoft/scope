// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AtifHandler } from "./atif-handler.js";
import type { HandlerContext, PostProcessorMessage } from "../types.js";

// Unlike atif-handler.test.ts, this suite does NOT mock `atifact` or
// `node:fs/promises`. It runs the real `parseHar` against a committed HAR
// fixture so it pins the behavior we actually depend on: extracting an ATIF
// trajectory from WebSocket exchanges (added in atifact 0.10.0). The fixture
// mirrors the `_webSocketMessages` envelope our AI gateway produces
// (`type`/`opcode`/`data`/`time`, `_resourceType: "websocket"`, status 101),
// with realistic OpenAI-responses payloads inside each frame.

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("AtifHandler WebSocket HAR extraction (real atifact)", () => {
  let handler: AtifHandler;
  let ctx: HandlerContext;
  let uploaded: { name: string; json: any } | undefined;

  beforeEach(async () => {
    uploaded = undefined;
    handler = new AtifHandler();

    const harBuffer = await readFile(join(fixtureDir, "websocket-capture.har.json"));

    ctx = {
      blobStorage: {
        downloadBlobToBuffer: async () => harBuffer,
        uploadJson: async (name: string, json: any) => {
          uploaded = { name, json };
          return `https://storage.blob.core.windows.net/snapshots/${name}`;
        },
      } as any,
      collection: {
        findOne: async () => ({
          _id: "req-ws",
          run: {
            _id: "run-ws",
            turns: [
              {
                iteration: 1,
                harUrl:
                  "https://storage.blob.core.windows.net/snapshots/req-ws/runs/run-ws/iteration-1/capture.har",
              },
            ],
          },
        }),
        updateOne: async () => ({ modifiedCount: 1 }),
      } as any,
      criteriaCollection: {} as any,
      log: async () => undefined,
    };
  });

  it("converts WebSocket exchanges into an ATIF v1.7 trajectory", async () => {
    const message: PostProcessorMessage = {
      type: "atif",
      requestId: "req-ws",
      runId: "run-ws",
      iteration: 1,
    };

    await handler.process(message, ctx);

    expect(uploaded).toBeDefined();
    expect(uploaded!.name).toBe("req-ws/runs/run-ws/iteration-1/atif.trajectory.json");

    const trajectory = uploaded!.json;
    expect(trajectory.schema_version).toBe("ATIF-v1.7");
    expect(trajectory.agent.model_name).toBe("gpt-4.1");

    // The send/receive WebSocket frames must yield a user step and an agent step.
    const userStep = trajectory.steps.find((s: any) => s.source === "user");
    const agentStep = trajectory.steps.find((s: any) => s.source === "agent");
    expect(userStep?.message).toBe("Write a haiku about the sea");
    expect(agentStep?.message).toBe("Endless waves whisper");
    expect(agentStep?.metrics).toMatchObject({ prompt_tokens: 12, completion_tokens: 8 });
  });
});
