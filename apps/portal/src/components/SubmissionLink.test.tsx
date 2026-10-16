// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SubmissionLink } from "./SubmissionLink";

describe("SubmissionLink", () => {
  it("provides a labeled, accessible path to Submission Detail", () => {
    render(
      <MemoryRouter>
        <SubmissionLink submissionId="submission-123" />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", {
      name: "Open submission submission-123",
    });
    expect(link.getAttribute("href")).toBe("/submissions/submission-123");
    expect(screen.getByText("Submission")).toBeDefined();
  });
});
