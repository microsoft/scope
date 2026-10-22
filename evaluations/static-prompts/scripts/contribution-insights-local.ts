// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { withRetry } from "../../../packages/shared/src/utils/retry.js";
import {
  collectContext, MAX_CONTEXT_BYTES, parseSelection, readPolicies, redact, type GitHubReader,
} from "../../../scripts/contribution-insights/collect.mjs";
import { composeContributionRequest, executeContributionRequest } from "../adapter/targets/contribution-insights.js";
import { createLocalCopilotContext } from "./local-copilot.js";
import { addFinalDecisions, readDecisionConfig } from "../../../scripts/contribution-insights/decision.mjs";
import { renderReport } from "../../../scripts/contribution-insights/report.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const HELP = `Usage: pnpm contribution-insights:local --pr NUMBER_OR_SCOPE_URL [options]

Run a real, report-only Copilot assessment locally. Does not dispatch Actions or write to GitHub.

  --pr                 Open microsoft/scope community PR number or URL (required)
  --model              Copilot model (default: auto)
  --timeout-seconds    Copilot timeout, 1-1200 seconds (default: 300)
  --output             New output directory (default: ignored evaluation results)
  --decision           Require the configured Microsoft-Decision-1 final-decision stage
  --help               Show this help

Requires gh authentication, an installed Copilot CLI, and a Copilot-entitled token.
COPILOT_GITHUB_TOKEN overrides the gh token for inference only. No .env files are loaded.
Decision-1 uses CONTRIBUTION_DECISION_ENDPOINT, CONTRIBUTION_DECISION_DEPLOYMENT,
and exactly one of CONTRIBUTION_DECISION_API_KEY / CONTRIBUTION_DECISION_ENTRA_TOKEN.
Without an enabled Decision-1 stage, only insights are produced; there is no Copilot fallback decision.
`;

export function parseLocalOptions(argv: string[]) {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    options: {
      pr: { type: "string" }, model: { type: "string", default: "auto" },
      "timeout-seconds": { type: "string", default: "300" },
      output: { type: "string" }, help: { type: "boolean", default: false },
      decision: { type: "boolean", default: false },
    },
    strict: true, allowPositionals: false,
  });
  if (values.help) return { help: true as const };
  const rawPr = values.pr;
  if (!rawPr) throw new Error("--pr is required");
  let number = rawPr;
  if (rawPr.startsWith("https://")) {
    const url = new URL(rawPr);
    const match = /^\/microsoft\/scope\/pull\/([1-9]\d{0,8})\/?$/.exec(url.pathname);
    if (url.origin !== "https://github.com" || !match || url.search || url.hash || url.username || url.password) {
      throw new Error("--pr must be a microsoft/scope PR number or canonical GitHub URL");
    }
    number = match[1];
  }
  const selection = parseSelection(number, "1");
  if (selection.prNumber === undefined) throw new Error("--pr is required");
  const seconds = Number(values["timeout-seconds"]);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1_200) {
    throw new Error("--timeout-seconds must be an integer from 1 to 1200");
  }
  if (!values.model?.trim()) throw new Error("--model cannot be empty");
  if (values.output !== undefined && !values.output.trim()) throw new Error("--output cannot be empty");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  return {
    help: false as const, prNumber: selection.prNumber, model: values.model,
    timeoutMs: seconds * 1_000,
    decision: values.decision,
    output: values.output ? resolve(ROOT, values.output) :
      resolve(ROOT, "evaluations/static-prompts/results/contribution-insights-local", runId),
  };
}

class GitHubReadError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number) {
    super(`GitHub metadata read failed: HTTP ${status}${retryAfterMs > 30_000 ? "; retry later after the rate limit resets" : ""}`);
  }
}

export function createLocalGitHubReader(token: string, fetcher: typeof fetch = fetch): GitHubReader {
  return {
    async request(route, parameters) {
      if (!route.startsWith("GET /") || route.includes("://")) throw new Error("Local GitHub reader only permits API GET routes");
      const consumed = new Set<string>();
      const path = route.slice(4).replace(/\{(\w+)\}/g, (_match, key: string) => {
        consumed.add(key);
        const value = parameters[key];
        if (typeof value !== "string" && typeof value !== "number") throw new Error(`Invalid route parameter ${key}`);
        return encodeURIComponent(String(value));
      });
      const url = new URL(`https://api.github.com${path}`);
      if (url.origin !== "https://api.github.com") throw new Error("GitHub API origin cannot be overridden");
      for (const [key, value] of Object.entries(parameters)) {
        if (consumed.has(key) || key === "request") continue;
        if (typeof value !== "string" && typeof value !== "number") throw new Error(`Invalid query parameter ${key}`);
        url.searchParams.set(key, String(value));
      }
      let nextAttemptAt = 0;
      return withRetry(async () => {
        const wait = nextAttemptAt - Date.now();
        if (wait > 0) await sleep(wait);
        const response = await fetcher(url, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        });
        if (!response.ok) {
          const header = response.headers.get("retry-after");
          const parsed = header === null ? 0 :
            /^\d+$/.test(header) ? Number(header) * 1_000 : Date.parse(header) - Date.now();
          const retryAfterMs = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
          nextAttemptAt = Date.now() + retryAfterMs;
          await response.body?.cancel();
          throw new GitHubReadError(response.status, retryAfterMs);
        }
        const data: unknown = await response.json();
        return { data };
      }, {
        maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5_000,
        isRetryable: (error) => error instanceof GitHubReadError
          ? error.retryAfterMs <= 30_000 && [429, 500, 502, 503, 504].includes(error.status)
          : error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)),
      });
    },
  };
}

export async function findLocalCopilot(path = process.env.PATH ?? ""): Promise<string> {
  const names = process.platform === "win32" ? ["copilot.exe", "copilot.cmd", "copilot"] : ["copilot"];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch (error: unknown) {
        if (!error || typeof error !== "object" || !("code" in error) ||
          !["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))) throw error;
      }
    }
  }
  throw new Error("Copilot CLI is not on PATH. Install/sign in to Copilot CLI before running this command.");
}

export async function runLocal(argv: string[]): Promise<void> {
  const options = parseLocalOptions(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.output);
  const startedAt = new Date().toISOString();
  let tokens: string[] = [];
  try {
    const decisionConfig = readDecisionConfig(process.env, options.decision);
    if (decisionConfig) tokens.push(decisionConfig.auth.value);
    else console.log("Microsoft-Decision-1 is not configured: this run will provide Copilot insights only, with no final decision.");
    const cliPath = await findLocalCopilot();
    const { stdout } = await exec("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 15_000 });
    const githubToken = stdout.trim();
    if (!githubToken) throw new Error("gh returned no token; run gh auth login first");
    const modelToken = process.env.COPILOT_GITHUB_TOKEN?.trim() || githubToken;
    tokens.push(githubToken, modelToken);
    const { stdout: revision } = await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT, timeout: 15_000 });
    console.log(`Collecting microsoft/scope#${options.prNumber} without executing PR code...`);
    const captured = await collectContext(createLocalGitHubReader(githubToken), {
      repository: "microsoft/scope", trustedRevision: revision.trim(),
      policies: await readPolicies(ROOT), prNumber: options.prNumber, limit: 1,
    });
    captured.policySource = "working-tree";
    const composed = await composeContributionRequest({ snapshot: JSON.stringify(captured) });
    const snapshot = JSON.stringify(composed.snapshot, null, 2);
    if (Buffer.byteLength(snapshot, "utf8") > MAX_CONTEXT_BYTES) throw new Error("Composed local snapshot exceeds the context byte limit");
    await writeFile(join(options.output, "context.json"), snapshot, { flag: "wx", mode: 0o600 });
    console.log(`Running isolated local Copilot (${options.model}); output: ${options.output}`);
    const result = await executeContributionRequest(composed, createLocalCopilotContext({
      token: modelToken, cliPath, model: options.model, timeoutMs: options.timeoutMs,
    }));
    const final = await addFinalDecisions(result.output.report, composed.snapshot, decisionConfig);
    await writeFile(join(options.output, "report.json"), JSON.stringify(final.report, null, 2), { flag: "wx", mode: 0o600 });
    await writeFile(join(options.output, "report.md"), renderReport(final.report, composed.snapshot), { flag: "wx", mode: 0o600 });
    if (final.failed) throw new Error("Microsoft-Decision-1 failed; no final decision is available. Copilot insights are preserved in report.md.");
    await writeFile(join(options.output, "run.json"), JSON.stringify({
      status: decisionConfig ? "completed" : "insights-only", mode: "local-report-only", fidelity: "partial", startedAt, completedAt: new Date().toISOString(),
      prNumber: options.prNumber, headSha: composed.snapshot.contributions[0]?.headSha,
      policySource: "working-tree",
      policyHashes: Object.fromEntries(composed.snapshot.policies.map((policy) => [
        policy.path, createHash("sha256").update(policy.content).digest("hex"),
      ])),
      inference: result.invocationMetadata,
      decision: decisionConfig ? "Microsoft-Decision-1" : "not-configured",
      limitations: ["No GitHub Actions execution, gh-aw sandbox, or hosted threat-detection job was run."],
    }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Saved report: ${join(options.output, "report.md")}`);
  } catch (error: unknown) {
    let message = error instanceof Error ? error.message : String(error);
    for (const token of tokens) message = message.split(token).join("[REDACTED_TOKEN]");
    message = redact(message);
    await writeFile(join(options.output, "run.json"), JSON.stringify({
      status: "failed", mode: "local-report-only", startedAt, completedAt: new Date().toISOString(), error: message,
    }, null, 2), { flag: "wx", mode: 0o600 });
    throw new Error(`${message}\nLocal diagnostic: ${join(options.output, "run.json")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocal(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
