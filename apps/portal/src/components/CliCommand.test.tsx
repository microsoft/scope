// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectProvider } from "@/contexts/ProjectContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { CLI_INSTALL_COMMAND, buildRunSubmit } from "@/lib/cli/buildCommand";
import { CliCommand } from "./CliCommand";

const command = buildRunSubmit({ task: "t", worker: "coder-acp-copilot", priority: 2 });

async function openModal(withProvider: boolean) {
  const ui = (
    <TooltipProvider>
      <CliCommand command={command} />
    </TooltipProvider>
  );
  render(withProvider ? <ProjectProvider>{ui}</ProjectProvider> : ui);
  await userEvent.click(screen.getByRole("button", { name: /show cli equivalent/i }));
  return screen.getByRole("dialog").textContent ?? "";
}

describe("CliCommand", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows the public installer, project env and generated command with notes", async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, "proj_42");
    const text = await openModal(true);

    expect(text).toContain(CLI_INSTALL_COMMAND);
    expect(text).toContain("export SCOPE_PROJECT=proj_42");
    expect(text).toContain("scope run submit");
    expect(text).toContain("Priority (2)");
    expect(text).not.toMatch(/SCOPE_TOKEN=/);
  });

  it("omits SCOPE_PROJECT outside a ProjectProvider", async () => {
    const text = await openModal(false);

    expect(text).toContain("export SCOPE_API_URL=");
    expect(text).not.toContain("SCOPE_PROJECT");
  });
});
