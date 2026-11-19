// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerReportCommands } from "./report.js";
import { apiFetch } from "../utils/api-client.js";

vi.mock("../utils/api-client.js", () => ({ apiFetch: vi.fn(), getApiBasePath: () => "/api/v1" }));

async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerReportCommands(program);
  await program.parseAsync(["report", "eligibility", "--id", "run /1", "--url", "https://scope.example", ...args], { from: "user" });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({
    activeTemplateCount: 2, templates: [{ id: "quality", name: "Quality review" }],
  })));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("report eligibility CLI", () => {
  it("returns the full preview as JSON without queueing reports", async () => {
    await run("--output", "json");
    expect(apiFetch).toHaveBeenCalledWith("https://scope.example", "/reports/eligibility?requestId=run+%2F1");
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      activeTemplateCount: 2, templates: [{ id: "quality", name: "Quality review" }],
    });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it.each([
    [0, "Configure a report template first"],
    [2, "Review template triggers"],
  ])("explains unavailable generation with %s active templates", async (activeTemplateCount, message) => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ activeTemplateCount, templates: [] })));
    await run();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain(message);
  });

  it("renders matching template names", async () => {
    await run();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Quality review");
  });

  it("reports an HTTP failure and exits unsuccessfully", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("Unavailable", { status: 503 }));
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    await expect(run()).rejects.toThrow("exit");
    expect(console.error).toHaveBeenCalledWith(expect.any(String), "Unable to check report eligibility: HTTP 503");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
