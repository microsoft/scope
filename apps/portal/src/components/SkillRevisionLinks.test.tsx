// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { SkillRevisionLinks } from "./SkillRevisionLinks";

afterEach(cleanup);

function renderLinks(references: string[]) {
  return render(
    <MemoryRouter>
      <SkillRevisionLinks references={references} />
    </MemoryRouter>,
  );
}

describe("SkillRevisionLinks", () => {
  it("shows the short revision while linking by unversioned skill slug", () => {
    renderLinks(["microsoft/example-skills/react-testing@1234567890abcdef"]);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/skills/microsoft/example-skills/react-testing");
    expect(link.textContent).toContain("microsoft/example-skills/react-testing");
    expect(link.textContent).toContain("@1234567");
    expect(screen.getByTitle("1234567890abcdef")).toBeTruthy();
  });

  it("continues to render legacy unversioned skill slugs", () => {
    renderLinks(["legacy/skill"]);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/skills/legacy/skill");
    expect(link.textContent).toBe("legacy/skill");
  });
});
