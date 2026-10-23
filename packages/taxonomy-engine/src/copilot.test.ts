// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { copilotAI, closeTransports } from "./copilot.js";
import { executeSdkCall } from "./sdk-call.js";

/** @returns Observable SDK session/ledger mocks for lifecycle failure tests. */
function fixture() {
  const session: Pick<CopilotSession, "on" | "sendAndWait" | "abort" | "disconnect" | "sessionId"> = {
    sessionId: "mock",
    on: vi.fn(() => () => { }),
    sendAndWait: vi.fn(async () => undefined),
    abort: vi.fn(async () => { }),
    disconnect: vi.fn(async () => { }),
  };
  const ledger = { reserve: vi.fn(async () => 1), finish: vi.fn(async () => { }) };
  const deleted = vi.fn(async () => { });
  return { session, ledger, deleted };
}
describe("Ax custom SDK provider contract (offline)", () => {
  it("forwards cancellation and rejects unsupported tools/streaming", async () => {
    const complete = vi.fn(async (_system: string, _user: string, _signal?: AbortSignal) => ({ content: "ok" }));
    const ai = copilotAI({ complete, close: async () => { } });
    const controller = new AbortController();
    await ai.chat({ chatPrompt: [{ role: "user", content: "data" }] }, { abortSignal: controller.signal });
    expect(complete.mock.calls[0]?.[2]).toBe(controller.signal);
    await expect(ai.chat({ chatPrompt: [], functions: [{ name: "tool", description: "" }] })).rejects.toThrow("tools");
    await expect(ai.chat({ chatPrompt: [] }, { stream: true })).rejects.toThrow("Streaming");
    await expect(ai.chat({ chatPrompt: [], responseFormat: { type: "json_schema", schema: {} } })).rejects.toThrow("Native structured");
    await expect(ai.chat({ chatPrompt: [], model: "different-model" })).rejects.toThrow("pinned");
  });
});
describe("SDK lifecycle failures (offline)", () => {
  it("closes student and teacher independently and preserves the original optimization error", async () => {
    const student = {
      close: vi.fn(async () => {
        throw new Error("student cleanup");
      })
    };
    const teacher = {
      close: vi.fn(async () => {
        throw new Error("teacher cleanup");
      })
    };
    const failure: unknown = await closeTransports([student, teacher], new Error("optimization failed")).catch(e => e);
    expect(student.close).toHaveBeenCalledOnce();
    expect(teacher.close).toHaveBeenCalledOnce();
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate cleanup failure");
    expect(failure.errors.map((e: Error) => e.message)).toEqual(["optimization failed", "student cleanup", "teacher cleanup"]);
  });
  it("still disconnects/deletes when ledger completion fails, preserving both errors", async () => {
    const { session, ledger, deleted } = fixture();
    vi.mocked(session.sendAndWait).mockRejectedValue(new Error("primary inference failure"));
    ledger.finish.mockRejectedValue(new Error("ledger I/O failure"));
    const failure: unknown = await executeSdkCall(session, ledger, "mock", "test", "input", deleted).catch(e => e);
    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError) expect(failure.errors.map((e: Error) => e.message)).toEqual(["primary inference failure", "ledger I/O failure"]);
    expect(session.abort).toHaveBeenCalled();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledOnce();
  });
  it("aborts on caller cancellation and timeout, then accounts and cleans up", async () => {
    // Exercise both external cancellation and the internal request deadline through the same cleanup path.
    for (const cancelled of [true, false]) {
      const { session, ledger, deleted } = fixture();
      vi.mocked(session.sendAndWait).mockImplementation(() => new Promise(() => { }));
      const controller = new AbortController();
      const promise = executeSdkCall(session, ledger, "mock", "test", "input", deleted, controller.signal, 10);
      if (cancelled) setTimeout(() => controller.abort(), 1);
      await expect(promise).rejects.toThrow(cancelled ? "cancelled" : "timed out");
      expect(session.abort).toHaveBeenCalled();
      expect(ledger.reserve).toHaveBeenCalledOnce();
      expect(ledger.finish).toHaveBeenCalledOnce();
      expect(session.disconnect).toHaveBeenCalledOnce();
      expect(deleted).toHaveBeenCalledOnce();
    }
  });
  it("never sends after budget exhaustion or pre-cancellation", async () => {
    const { session, ledger, deleted } = fixture();
    ledger.reserve.mockRejectedValue(new Error("budget exhausted"));
    await expect(executeSdkCall(session, ledger, "mock", "test", "input", deleted)).rejects.toThrow("budget exhausted");
    expect(session.sendAndWait).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(executeSdkCall(session, ledger, "mock", "test", "input", deleted, controller.signal)).rejects.toThrow("cancelled before");
    expect(session.sendAndWait).not.toHaveBeenCalled();
  });
  it("has no unhandled rejection during slow reservation cancellation/timeout", async () => {
    // Cancellation can arrive before reservation completes, so the stop promise must already be safely observed.
    for (const cancelled of [true, false]) {
      const { session, ledger, deleted } = fixture();
      ledger.reserve.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return 1;
      });
      const controller = new AbortController();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const promise = executeSdkCall(session, ledger, "mock", "test", "input", deleted, controller.signal, cancelled ? 1000 : 5);
        if (cancelled) setTimeout(() => controller.abort(), 1);
        await expect(promise).rejects.toThrow(cancelled ? "cancelled" : "timed out");
        expect(unhandled).not.toHaveBeenCalled();
        expect(session.sendAndWait).not.toHaveBeenCalled();
        expect(ledger.finish).toHaveBeenCalledOnce();
        expect(deleted).toHaveBeenCalledOnce();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    }
  });
  it("aborts any model failure immediately rather than inviting a runtime retry", async () => {
    const { session, ledger, deleted } = fixture();
    vi.mocked(session.on).mockImplementation(handler => {
      vi.mocked(session.sendAndWait).mockImplementation(async () => {
        handler({ type: "model.call_failure", data: {} } as SessionEvent);
        throw new Error("model failed");
      });
      return () => { };
    });
    await expect(executeSdkCall(session, ledger, "mock", "test", "input", deleted)).rejects.toThrow("model failed");
    expect(session.abort).toHaveBeenCalled();
    expect(ledger.finish).toHaveBeenCalledWith(1, false, expect.any(Number), null, 1);
  });
});
