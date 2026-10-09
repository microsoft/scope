// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerAgentStatus } from "shared/server";
import { ServerAgentSetupView } from "./ServerAgentSetup";

afterEach(cleanup);

const agents: ServerAgentStatus[] = [
  { workerType: "coder-acp-copilot-host", label: "Copilot host", runtime: "host", enabled: false, available: false },
  { workerType: "coder-acp-claude-code", label: "Claude Docker", runtime: "docker", enabled: false, available: false },
];

describe("local agent setup", () => {
  it("requires target-specific consent before enabling a host CLI", async () => {
    const configure = vi.fn();
    const user = userEvent.setup();
    render(<ServerAgentSetupView agents={agents} onConfigure={configure} />);
    await user.click(screen.getByRole("button", { name: "Set up local agents" }));
    const host = within(screen.getByRole("region", { name: "Copilot host" }));
    const enable = host.getByRole("button", { name: "Enable Copilot host" });
    expect(enable.hasAttribute("disabled")).toBe(true);
    await user.type(host.getByRole("textbox", { name: "CLI executable" }), "/opt/copilot");
    await user.click(host.getByRole("checkbox"));
    await user.click(enable);
    expect(configure).toHaveBeenCalledWith("coder-acp-copilot-host", {
      enabled: true, consent: true, executable: "/opt/copilot",
    });
  });

  it("enables a Docker worker without host consent", async () => {
    const configure = vi.fn();
    const user = userEvent.setup();
    render(<ServerAgentSetupView agents={agents} onConfigure={configure} />);
    await user.click(screen.getByRole("button", { name: "Set up local agents" }));
    await user.click(screen.getByRole("button", { name: "Enable Claude Docker" }));
    expect(configure).toHaveBeenCalledWith("coder-acp-claude-code", { enabled: true });
  });

  it("shows errors and lets an enabled target be stopped", async () => {
    const configure = vi.fn();
    const user = userEvent.setup();
    render(<ServerAgentSetupView agents={[{ ...agents[0], enabled: true, error: "CLI exited" }]}
      error="Setup did not complete" onConfigure={configure} />);
    await user.click(screen.getByRole("button", { name: "Set up local agents" }));
    expect(screen.getAllByRole("alert").map(node => node.textContent)).toEqual([
      "Setup did not complete", "CLI exited",
    ]);
    await user.click(screen.getByRole("button", { name: "Stop Copilot host" }));
    expect(configure).toHaveBeenCalledWith("coder-acp-copilot-host", { enabled: false });
  });
});
