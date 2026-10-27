// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { parseHarFile, extractToolCalls, extractTokenUsage } from "./har-parser.js";

/**
 * Smoke test (#1253): a realistic HAR mirroring the exact gateway
 * `_webSocketMessages` envelope — a gpt-5.x agent session whose Responses API
 * `/responses` traffic is carried over a WebSocket — must yield a non-empty,
 * correctly-matched tool-call history through the real on-disk loader.
 *
 * The fixture is hand-authored (mirroring the committed real gateway capture in
 * `apps/workers/post-processor/.../websocket-capture.har.json`). It is a
 * placeholder to be replaced with a captured real integration HAR once #723
 * (route the Linux copilot worker through the gateway) lands.
 */
describe("extractToolCalls — WebSocket Responses API smoke test (real gateway envelope)", () => {
  const fixturePath = fileURLToPath(
    new URL("./__fixtures__/websocket-responses-toolcalls.har.json", import.meta.url),
  );

  it("extracts the full, matched tool-call history from a WebSocket-only HAR", async () => {
    const har = await parseHarFile(fixturePath);
    const calls = extractToolCalls(har);

    // The core regression guard: an empty history is the #1253 bug.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(4);

    const byId = Object.fromEntries(calls.map((c) => [c.id, c]));

    // Calls carried in receive frames, with results matched from later send
    // transcript frames.
    expect(byId["call_build"]).toMatchObject({
      name: "bash",
      arguments: { command: "npm run build", description: "Build the project" },
      response: "Build succeeded in 3.1s",
    });
    expect(byId["call_patch"]).toMatchObject({
      name: "apply_patch",
      // custom_tool_call input is preserved verbatim under `_raw`.
      arguments: { _raw: expect.stringContaining("*** Begin Patch") },
      response: "Applied patch to src/index.ts",
    });
    expect(byId["call_view"]).toMatchObject({
      name: "view",
      arguments: { path: "src/index.ts" },
      response: "const x = 2;",
    });

    // The terminal call appears only in the response stream (never echoed into a
    // later request), so it has no matched result.
    expect(byId["call_done"]).toMatchObject({ name: "task_complete" });
    expect(byId["call_done"].response).toBeUndefined();
  });

  it("sums token usage from the response.completed frames (#472)", async () => {
    const har = await parseHarFile(fixturePath);

    // Two responses in the fixture: 120 + 400 input, 40 + 60 output tokens.
    expect(extractTokenUsage(har)).toEqual({ promptTokens: 520, completionTokens: 100, totalTokens: 620 });
  });
});
