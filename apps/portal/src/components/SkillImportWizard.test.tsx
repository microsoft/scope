// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SkillImportWizard } from "./SkillImportWizard";
import type { SkillDiscoveryResult } from "@/types";

// ─── Mock the api module ────────────────────────────────────────────
const mockDiscoverSkills = vi.fn<(source: string) => Promise<SkillDiscoveryResult[]>>();
const mockCreateSkill = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    discoverSkills: (...args: unknown[]) => mockDiscoverSkills(args[0] as string),
    createSkill: (...args: unknown[]) => mockCreateSkill(...args),
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────
function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWizard(props: { onClose?: () => void } = {}) {
  const qc = createQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SkillImportWizard {...props} />
    </QueryClientProvider>,
  );
}

const fakeSkills: SkillDiscoveryResult[] = [
  { skillName: "skill-a", skillPath: "skills/skill-a/SKILL.md", name: "Skill A", description: "desc A" },
  { skillName: "skill-b", skillPath: "skills/skill-b/SKILL.md", name: "Skill B", existsInLibrary: true, updateAvailable: true, currentRevisionCommitSha: "abc1234", latestUpstreamCommitSha: "def5678" },
  { skillName: "skill-c", skillPath: "skills/skill-c/SKILL.md", name: "Skill C", existsInLibrary: true, updateAvailable: false, lastImportedAt: "2026-05-10T00:00:00.000Z" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// Step 1: Repository input
// ═══════════════════════════════════════════════════════════════════
describe("Step 1 — Repository input", () => {
  it("renders the source input and Discover button", () => {
    renderWizard();
    expect(screen.getByLabelText("GitHub Repository")).toBeDefined();
    expect(screen.getByText("Discover")).toBeDefined();
  });

  it("disables Discover when source is empty", () => {
    renderWizard();
    const btn = screen.getByText("Discover").closest("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("enables Discover for a valid owner/repo slug", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "Azure/some-repo" },
    });
    const btn = screen.getByText("Discover").closest("button")!;
    expect(btn.disabled).toBe(false);
  });

  it("keeps Discover disabled for invalid slugs", () => {
    renderWizard();
    const input = screen.getByLabelText("GitHub Repository");
    for (const bad of ["noslash", "has spaces/repo", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      const btn = screen.getByText("Discover").closest("button")!;
      expect(btn.disabled).toBe(true);
    }
  });

  it("shows Cancel when onClose is provided", () => {
    const onClose = vi.fn();
    renderWizard({ onClose });
    expect(screen.getByText("Cancel")).toBeDefined();
  });

  it("does not show Cancel when onClose is omitted", () => {
    renderWizard();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    renderWizard({ onClose });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls discoverSkills on Enter key in input", async () => {
    mockDiscoverSkills.mockResolvedValue([]);
    renderWizard();
    const input = screen.getByLabelText("GitHub Repository");
    fireEvent.change(input, { target: { value: "owner/repo" } });
    // Wait for React to re-render with sourceValid = true
    await waitFor(() => {
      expect(screen.getByText("Discover").closest("button")!.disabled).toBe(false);
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(mockDiscoverSkills).toHaveBeenCalledWith("owner/repo");
    });
  });

  it("shows an error when discovery fails", async () => {
    mockDiscoverSkills.mockRejectedValue(new Error("Repository not found"));
    renderWizard();
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByText("Discover").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("Repository not found")).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Step 2: Skill selection & import
// ═══════════════════════════════════════════════════════════════════
describe("Step 2 — Skill selection", () => {
  beforeEach(async () => {
    mockDiscoverSkills.mockResolvedValue(fakeSkills);
  });

  async function goToStep2() {
    renderWizard();
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByText("Discover").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("skill-a")).toBeDefined();
    });
  }

  it("moves to step 2 after successful discovery", async () => {
    await goToStep2();
    expect(screen.getByText(/3 skills found/)).toBeDefined();
  });

  it("shows the full description instead of truncating it (#1285)", async () => {
    const longDescription = "A very long description that should wrap onto several lines ".repeat(4).trim();
    mockDiscoverSkills.mockResolvedValue([{ ...fakeSkills[0], description: longDescription }]);
    await goToStep2();

    const description = screen.getByText(new RegExp(longDescription));
    expect(description.className).not.toContain("truncate");
    expect(description.className).toContain("break-words");
  });

  it("lets long unbroken skill names and paths wrap (#1285)", async () => {
    await goToStep2();

    expect(screen.getByText("skill-a").className).toContain("break-all");
    expect(screen.getByText("skills/skill-a/SKILL.md").className).toContain("break-all");
  });

  it("shows library status badges", async () => {
    await goToStep2();
    expect(screen.getByText("New")).toBeDefined();
    expect(screen.getByText("Update available")).toBeDefined();
    expect(screen.getByText("Up to date")).toBeDefined();
  });

  it("default-selects new and update-available skills, not up-to-date", async () => {
    await goToStep2();
    // skill-a (new) and skill-b (update) should be checked,
    // skill-c (up-to-date) should not — verified via the import button count
    expect(screen.getByText("Import 2 skills")).toBeDefined();
  });

  it("toggles selection when clicking a skill row checkbox", async () => {
    await goToStep2();
    // Uncheck skill-a by clicking its checkbox
    const checkboxA = screen.getByRole("checkbox", { name: /skill-a/ });
    fireEvent.click(checkboxA);
    expect(screen.getByText("Import 1 skill")).toBeDefined();
    // Re-check
    fireEvent.click(checkboxA);
    expect(screen.getByText("Import 2 skills")).toBeDefined();
  });

  it("select all skips up-to-date skills", async () => {
    await goToStep2();
    fireEvent.click(screen.getByText("Select none"));
    expect(screen.getByText(/Import 0 skill/s)).toBeDefined();
    fireEvent.click(screen.getByText("Select all"));
    expect(screen.getByText("Import 2 skills")).toBeDefined();
  });

  it("select none deselects everything", async () => {
    await goToStep2();
    fireEvent.click(screen.getByText("Select none"));
    // The Import button should show 0 and be disabled
    const btn = screen.getByText(/Import 0 skill/s).closest("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("shows 'No skills found' for empty discovery results", async () => {
    mockDiscoverSkills.mockResolvedValue([]);
    renderWizard();
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "owner/empty-repo" },
    });
    fireEvent.click(screen.getByText("Discover").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("No skills found in this repository.")).toBeDefined();
    });
  });

  it("goes back to step 1 when clicking Back", async () => {
    await goToStep2();
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByLabelText("GitHub Repository")).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Step 2: Import execution
// ═══════════════════════════════════════════════════════════════════
describe("Step 2 — Import execution", () => {
  beforeEach(() => {
    mockDiscoverSkills.mockResolvedValue(fakeSkills);
  });

  async function goToStep2AndImport() {
    renderWizard();
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByText("Discover").closest("button")!);
    await waitFor(() => expect(screen.getByText("skill-a")).toBeDefined());
    return screen;
  }

  it("shows Done button and summary after successful import", async () => {
    mockCreateSkill.mockResolvedValue({ _id: "test" });
    await goToStep2AndImport();
    fireEvent.click(screen.getByText("Import 2 skills").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText(/Imported 2\/2/)).toBeDefined();
      expect(screen.getByText("Done")).toBeDefined();
    });
  });

  it("shows Retry failed button when some imports fail", async () => {
    mockCreateSkill
      .mockResolvedValueOnce({ _id: "ok" })
      .mockRejectedValueOnce(new Error("Server error"));
    await goToStep2AndImport();
    fireEvent.click(screen.getByText("Import 2 skills").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText(/1 failed/)).toBeDefined();
      expect(screen.getByText("Retry failed")).toBeDefined();
    });
  });

  it("shows error message for failed imports", async () => {
    mockCreateSkill.mockRejectedValue(new Error("Rate limited"));
    await goToStep2AndImport();
    // Select only skill-a
    fireEvent.click(screen.getByText("Select none"));
    fireEvent.click(screen.getByRole("checkbox", { name: /skill-a/ }));
    fireEvent.click(screen.getByText("Import 1 skill").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("Rate limited")).toBeDefined();
    });
  });

  it("resets to step 1 when Done is clicked", async () => {
    mockCreateSkill.mockResolvedValue({ _id: "test" });
    const onClose = vi.fn();
    const qc = createQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <SkillImportWizard onClose={onClose} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByText("Discover").closest("button")!);
    await waitFor(() => expect(screen.getByText("skill-a")).toBeDefined());
    fireEvent.click(screen.getByText("Import 2 skills").closest("button")!);
    await waitFor(() => expect(screen.getByText("Done")).toBeDefined());
    fireEvent.click(screen.getByText("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════
// LibraryStatusBadge (internal component)
// ═══════════════════════════════════════════════════════════════════
describe("LibraryStatusBadge", () => {
  beforeEach(() => {
    mockDiscoverSkills.mockResolvedValue(fakeSkills);
  });

  it("shows SHA tooltip for update-available skills", async () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("GitHub Repository"), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByText("Discover").closest("button")!);
    await waitFor(() => expect(screen.getByText("Update available")).toBeDefined());
    const badge = screen.getByText("Update available");
    expect(badge.title).toContain("abc1234");
    expect(badge.title).toContain("def5678");
  });
});
