// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ReportGenerationControls } from "./ReportGenerationControls";
import * as stories from "./ReportGenerationControls.stories";

afterEach(cleanup);

function renderControls(overrides: Partial<React.ComponentProps<typeof ReportGenerationControls>> = {}) {
  const props = { loading: false, error: false, pending: false, onGenerate: vi.fn(), onRetry: vi.fn(), ...overrides };
  render(<MemoryRouter><ReportGenerationControls {...props} /></MemoryRouter>);
  return props;
}

describe("ReportGenerationControls", () => {
  it.each([
    ["no templates", stories.NoTemplates.args],
    ["no matches", stories.NoMatchingTriggers.args],
    ["loading", stories.Loading.args],
    ["failed", stories.CheckFailed.args],
    ["generating", stories.Generating.args],
  ])("disables generation when %s", async (_name, args) => {
    const props = renderControls(args);
    const button = screen.getByRole("button", { name: "Generate Report" });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(props.onGenerate).not.toHaveBeenCalled();
  });

  it("explains missing templates and links to configuration", () => {
    renderControls(stories.NoTemplates.args);
    expect(screen.getByText(/No active report templates are configured/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Configure report templates" }).getAttribute("href")).toBe("/reports/templates");
  });

  it("explains trigger mismatches rather than claiming no templates exist", () => {
    renderControls(stories.NoMatchingTriggers.args);
    expect(screen.getByText(/No active report template triggers match/)).toBeTruthy();
    expect(screen.queryByText(/No active report templates are configured/)).toBeNull();
  });

  it("lists exactly the applicable templates and enables generation", async () => {
    const props = renderControls(stories.MatchingTemplates.args);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Quality review (quality)", "Prompt feature analysis (features)",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Generate Report" }));
    expect(props.onGenerate).toHaveBeenCalledOnce();
  });

  it("disables stale matches after an error and allows retry", async () => {
    const props = renderControls({ ...stories.MatchingTemplates.args, error: true });
    expect(screen.getByRole("alert").textContent).toContain("Unable to check report templates");
    expect(screen.getByRole("button", { name: "Generate Report" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Retry template check" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
});
