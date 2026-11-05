// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectProvider } from "@/contexts/ProjectContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { CLI_INSTALL_COMMAND, buildEnvCommand, buildRunSubmit } from "@/lib/cli/buildCommand";
import { CliCommand } from "./CliCommand";
import * as stories from "./CliCommand.stories";

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
    vi.restoreAllMocks();
  });

  it.each(Object.entries(composeStories(stories)))("renders the %s story with its providers", async (_name, Story) => {
    render(<Story />);
    await userEvent.click(screen.getByRole("button", { name: /show cli equivalent/i }));

    expect(screen.getByRole("dialog")).not.toBeNull();
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

  it.each([
    { name: "Copy install command", value: CLI_INSTALL_COMMAND },
    { name: "Copy environment variables", value: buildEnvCommand(window.location.origin) },
    { name: "Copy cli command", value: command.command },
  ])("copies the correct block through the distinct '$name' button", async ({ name, value }) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await openModal(false);

    const button = screen.getByRole("button", { name });
    await user.click(button);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(value);
    expect(screen.getByRole("button", { name })).toBe(button);
  });

  it("preserves multiline submit content and notes while copying the exact command", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const { SubmitLongContent } = composeStories(stories);
    const longCommand = stories.SubmitLongContent.args.command;
    render(<SubmitLongContent />);
    await user.click(screen.getByRole("button", { name: /show cli equivalent/i }));

    expect(screen.getByText(/Requirement 30:/).textContent).toBe(longCommand.display);
    expect(screen.getByText(longCommand.notes[0])).not.toBeNull();
    expect(screen.getByRole("link", { name: "Read the CLI documentation" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy cli command" }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(longCommand.command);
  });
});
