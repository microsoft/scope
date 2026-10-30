// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TaxonomyStatus } from "./TaxonomyStatus";

describe("TaxonomyStatus", () => {
  afterEach(cleanup);

  it("renders unavailable without a handler entry", () => {
    render(<TaxonomyStatus />);
    expect(screen.getByLabelText("Taxonomy unavailable").textContent).toBe("—");
  });

  it.each([
    ["queued", false, "Queued"],
    ["processing", false, "Processing"],
    ["failed", false, "Failed"],
    ["done", true, "Completed"],
    ["done", false, "Result unavailable"],
  ] as const)("renders %s / result=%s", (status, resultAvailable, label) => {
    render(<TaxonomyStatus summary={{ status, resultAvailable }} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("animates processing", () => {
    render(
      <TaxonomyStatus
        summary={{ status: "processing", resultAvailable: false }}
      />,
    );
    expect(screen.getByText("Processing").className).toContain("animate-shimmer");
  });
});
