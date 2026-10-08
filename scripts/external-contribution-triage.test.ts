// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

interface Issue {
  number: number;
  state: string;
  title: string;
  body: string;
  user: { type: string; login: string };
  author_association: string;
  labels: Array<{ name: string }>;
  pull_request?: { url: string };
}
interface Pull {
  state: string;
  draft: boolean;
  head: { sha: string };
}
interface Comment {
  id: number;
  body: string;
  user: { type: string; login: string };
}
const issue: Issue = {
  number: 42, state: "open", title: "CLI output crashes", body: "Steps and environment",
  user: { type: "User", login: "contributor" }, author_association: "CONTRIBUTOR", labels: [],
};
const pull: Pull = { state: "open", draft: false, head: { sha: "abc" } };
const proposal = { type: "publish_triage", body: "The CLI needs a reproduction with the exact version.", labels: '["type: bug","area: cli"]' };

function harness(current: Issue = issue, comments: Comment[] = []) {
  const summary = {
    addHeading: vi.fn(), addRaw: vi.fn(), write: vi.fn().mockResolvedValue(undefined),
  };
  summary.addHeading.mockReturnValue(summary);
  summary.addRaw.mockReturnValue(summary);
  const listComments = vi.fn();
  const listLabelsForRepo = vi.fn();
  return {
    github: {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: current }),
          listForRepo: vi.fn().mockResolvedValue({ data: [current] }),
          listComments, listLabelsForRepo,
          addLabels: vi.fn().mockResolvedValue({}),
          createComment: vi.fn().mockResolvedValue({}),
          updateComment: vi.fn().mockResolvedValue({}),
        },
        pulls: { get: vi.fn().mockResolvedValue({ data: pull }) },
      },
      paginate: vi.fn(async (method: unknown) => {
        if (method === listComments) return comments;
        if (method === listLabelsForRepo) return [{ name: "type: bug" }, { name: "area: cli" }];
        throw new Error("Unexpected pagination method");
      }),
    },
    context: {
      repo: { owner: "microsoft", repo: "scope" },
      eventName: "workflow_dispatch",
      payload: { inputs: { item_number: "42" } },
      serverUrl: "https://github.com", runId: 123,
    },
    core: { setOutput: vi.fn(), notice: vi.fn(), summary },
  };
}
const require = createRequire(import.meta.url);
const triage: {
  ALLOWED_LABELS: string[];
  MARKER: string;
  eligible: (issue: Issue, pull?: Pull) => boolean;
  fingerprint: (issue: Issue, pull?: Pull) => string;
  completed: (comments: Comment[], revision: string) => boolean;
  select: (options: ReturnType<typeof harness>) => Promise<{ number: number; revision: string } | undefined>;
  validateProposal: (value: unknown) => { body: string; labels: string[] };
  publish: (options: ReturnType<typeof harness> & {
    number: number; revision: string; staged: boolean; output: unknown;
  }) => Promise<void>;
} = require("./external-contribution-triage.cjs");

function ownComment(revision: string): Comment {
  return {
    id: 7, user: { type: "Bot", login: "github-actions[bot]" },
    body: `${triage.MARKER}\n<!-- scope-triage-revision: ${revision} -->`,
  };
}

describe("contribution selection", () => {
  it.each(["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR"])("includes human %s authors", (association) => {
    expect(triage.eligible({ ...issue, author_association: association })).toBe(true);
  });
  it.each(["OWNER", "MEMBER", "COLLABORATOR", "UNKNOWN"])("excludes %s authors", (association) => {
    expect(triage.eligible({ ...issue, author_association: association })).toBe(false);
  });
  it("excludes bots, closed items, and draft PRs", () => {
    expect(triage.eligible({ ...issue, user: { type: "Bot", login: "bot" } })).toBe(false);
    expect(triage.eligible({ ...issue, state: "closed" })).toBe(false);
    expect(triage.eligible(issue, { ...pull, draft: true })).toBe(false);
    expect(triage.eligible(issue, { ...pull, state: "closed" })).toBe(false);
  });
  it("fingerprints issue content and PR heads, not labels or bot comments", () => {
    expect(triage.fingerprint(issue)).not.toBe(triage.fingerprint({ ...issue, body: "Edited" }));
    expect(triage.fingerprint(issue, pull)).not.toBe(triage.fingerprint(issue, { ...pull, head: { sha: "def" } }));
    expect(triage.fingerprint(issue)).toBe(triage.fingerprint({ ...issue, labels: [{ name: "type: bug" }] }));
  });
  it("ignores contributor-spoofed completion markers", () => {
    const revision = triage.fingerprint(issue);
    const comment = ownComment(revision);
    expect(triage.completed([comment], revision)).toBe(true);
    expect(triage.completed([{ ...comment, user: issue.user }], revision)).toBe(false);
    expect(triage.completed([{ ...comment, user: { type: "Bot", login: "other[bot]" } }], revision)).toBe(false);
  });
  it.each(["0", "-1", "42; rm", "1.5", "9007199254740992"])("rejects invalid dispatch input %s", async (value) => {
    const h = harness();
    h.context.payload.inputs.item_number = value;
    await expect(triage.select(h)).rejects.toThrow("positive safe integer");
    expect(h.github.rest.issues.get).not.toHaveBeenCalled();
  });
  it("selects one trusted target and skips already triaged revisions", async () => {
    const h = harness();
    await expect(triage.select(h)).resolves.toEqual({ number: 42, revision: triage.fingerprint(issue) });
    expect(h.core.setOutput).toHaveBeenCalledWith("selected", "true");
    const done = harness(issue, [ownComment(triage.fingerprint(issue))]);
    await expect(triage.select(done)).resolves.toBeUndefined();
    expect(done.core.setOutput).not.toHaveBeenCalledWith("selected", "true");
  });
  it("checks PR draft status even when listing returns issue metadata", async () => {
    const h = harness({ ...issue, pull_request: { url: "pull/42" } });
    h.context.eventName = "schedule";
    h.github.rest.pulls.get.mockResolvedValue({ data: { ...pull, draft: true } });
    await expect(triage.select(h)).resolves.toBeUndefined();
  });
  it("surfaces API failures instead of treating them as an empty queue", async () => {
    const h = harness();
    h.github.rest.issues.get.mockRejectedValue(new Error("API unavailable"));
    await expect(triage.select(h)).rejects.toThrow("API unavailable");
  });
});

describe("privileged publisher policy", () => {
  const publish = (h: ReturnType<typeof harness>, output: unknown = { items: [proposal] }, staged = false) =>
    triage.publish({ ...h, output, number: 42, revision: triage.fingerprint(issue), staged });
  it.each([
    { ...proposal, labels: '["priority: critical"]' },
    { ...proposal, labels: '["type: bug","type: question"]' },
    { ...proposal, labels: '["type: bug","type: bug"]' },
    { ...proposal, labels: "{}" },
    { ...proposal, item_number: 99 },
    { ...proposal, body: "Please @maintainer follow https://example.com/details" },
    { ...proposal, body: "Summary <!-- scope-triage-revision: spoof -->" },
    { ...proposal, body: 'Summary <img src="https://example.com/tracker">' },
  ])("rejects out-of-policy output %# before mutations", async (value) => {
    const h = harness();
    await expect(publish(h, { items: [value] })).rejects.toThrow();
    expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
  it("requires exactly one proposal", async () => {
    await expect(publish(harness(), { items: [] })).rejects.toThrow("Exactly one");
    await expect(publish(harness(), { items: [proposal, proposal] })).rejects.toThrow("Exactly one");
  });
  it("preview renders the full proposal but performs no writes", async () => {
    const h = harness();
    await publish(h, undefined, true);
    expect(h.core.summary.write).toHaveBeenCalled();
    expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
  it("fixes the target, discloses automation, and does not retry comment creation", async () => {
    const h = harness();
    await publish(h);
    expect(h.github.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "microsoft", repo: "scope", issue_number: 42, labels: ["type: bug", "area: cli"],
    });
    expect(h.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 42, request: { retries: 0 },
      body: expect.stringContaining("Automated contribution triage"),
    }));
  });
  it("does not replace human classification or remove labels", async () => {
    const h = harness({ ...issue, labels: [{ name: "type: question" }, { name: "area: api" }, { name: "community-contribution" }] });
    await publish(h);
    expect(h.github.rest.issues.addLabels).not.toHaveBeenCalled();
  });
  it("updates its prior comment rather than spamming on new revisions", async () => {
    const h = harness(issue, [ownComment("a".repeat(64))]);
    await publish(h);
    expect(h.github.rest.issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 7 }));
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
  it.each([{ ...issue, state: "closed" }, { ...issue, body: "Updated mid-run" }])("skips stale/ineligible contributions", async (current) => {
    const h = harness(current);
    await publish(h);
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(h.core.notice).toHaveBeenCalledWith(expect.stringContaining("changed or became ineligible"));
  });
  it("skips duplicate revisions and fails on missing repository labels", async () => {
    const h = harness(issue, [ownComment(triage.fingerprint(issue))]);
    await publish(h);
    expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    const missing = harness();
    missing.github.paginate.mockResolvedValue([]);
    await expect(publish(missing)).rejects.toThrow("Repository label does not exist");
    expect(missing.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, {
    if?: string;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    steps: Array<{ uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; run?: string; if?: string }>;
  }>;
}
const { parse }: { parse: (value: string) => unknown } = createRequire(resolve("packages/shared/package.json"))("yaml");
const compiled = parse(readFileSync(".github/workflows/external-contribution-triage.lock.yml", "utf8")) as Workflow;

describe("compiled AW boundaries", () => {
  it("selects CI policy regressions when workflow or publisher changes", () => {
    const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as Workflow;
    const step = ci.jobs["detect-changes"].steps.find((candidate) => candidate.with?.filters);
    const filters = parse(String(step?.with?.filters)) as { typescript: string[] };
    for (const path of [
      ".github/workflows/external-contribution-triage.md",
      ".github/workflows/external-contribution-triage.lock.yml",
      "scripts/external-contribution-triage.cjs",
      "scripts/external-contribution-triage.test.ts",
    ]) expect(filters.typescript).toContain(path);
  });
  it("uses manual and opt-in scheduled activation, not contributor-controlled events", () => {
    expect(Object.keys(compiled.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(compiled.jobs.activation.if).toContain("github.repository == 'microsoft/scope'");
    expect(compiled.jobs.activation.if).toContain("github.event.repository.default_branch");
    expect(compiled.jobs.activation.if).toContain("SCOPE_TRIAGE_SCHEDULE_ENABLED");
    expect(compiled.jobs.activation.if).toContain("candidate_ready_result == 'success'");
  });
  it("keeps the agent read-only except model inference", () => {
    const permissions = compiled.jobs.agent.permissions ?? compiled.permissions ?? {};
    expect(permissions.contents).toBe("read");
    expect(permissions.issues).toBe("read");
    expect(permissions["pull-requests"]).toBe("read");
    expect(Object.entries(permissions).filter(([, value]) => value === "write").map(([key]) => key)).toEqual(["copilot-requests"]);
  });
  it("uses a separate trusted selection artifact, not agent-chosen targets", () => {
    expect(compiled.jobs.pre_activation.outputs?.candidate_ready_result).toBe("${{ steps.candidate_ready.outcome }}");
    const download = compiled.jobs.publish_triage.steps.find((step) => step.with?.name === "trusted-triage-selection");
    expect(download?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/);
    expect(compiled.jobs.publish_triage.permissions).toEqual({ contents: "read", issues: "write", "pull-requests": "read" });
  });
  it("defaults to staged mode and requires explicit publisher enablement", () => {
    const job = compiled.jobs.publish_triage;
    const script = job.steps.find((step) => String(step.with?.script).includes("await publish"));
    expect(script?.env?.TRIAGE_PUBLISH_ENABLED).toBe("${{ vars.SCOPE_TRIAGE_PUBLISH_ENABLED }}");
    expect(String(script?.with?.script)).toContain('mode[1] !== "false"');
    expect(readFileSync(".github/workflows/external-contribution-triage.md", "utf8")).toContain("staged: true");
  });
  it("fails closed when the agent or threat detection did not succeed", () => {
    expect(compiled.jobs.publish_triage.if).toContain("needs.agent.result == 'success'");
    expect(compiled.jobs.publish_triage.if).toContain("needs.detection.result == 'success'");
    expect(compiled.jobs.publish_triage.if).toContain("needs.detection.outputs.detection_success == 'true'");
  });
  it("allows untrusted contribution reads only from Scope", () => {
    const source = readFileSync(".github/workflows/external-contribution-triage.md", "utf8");
    expect(source).toContain("min-integrity: none");
    expect(source).toContain("allowed-repos: [microsoft/scope]");
    expect(source).toContain("bash: false");
  });
  it("checks out trusted revisions in selector and publisher without persisted credentials", () => {
    for (const name of ["pre_activation", "publish_triage"]) {
      const checkout = compiled.jobs[name].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("${{ github.sha }}");
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });
});
