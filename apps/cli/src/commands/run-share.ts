// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command, Option } from "commander";
import { writeFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import { withRetry } from "shared/retry";
import {
  CreateRunShareSchema, UpdateRunShareSchema, RunShareSchema, RunShareLinkSchema, RunShareListSchema,
  RunShareTokenSchema, SharedRunSchema, SharedRunLogsSchema, SharedRunReportsSchema,
  SUMMARY_SHARE_CONTENT, FULL_SHARE_CONTENT, RUN_SHARE_HEADER, RUN_SHARE_PAGE,
  type RunShareContent, type RunShare, type RunShareLink, type RunShareList,
} from "shared/run-sharing";
import { apiFetch, ApiError, readApiError, type ApiFetchInit } from "../utils/api-client.js";
import { configureHelp } from "../utils/helpFormatter.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import { getDefaultApiUrl, withOutputOption } from "../utils/shared.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";

interface Options {
  url?: string;
  attempt: string;
  output: OutputFormat;
  label?: string;
  preset?: "summary" | "full";
  include?: string;
  exclude?: string;
  expiresAt?: string;
  expiry?: boolean;
  acknowledgeSensitiveContent?: boolean;
  portalUrl?: string;
  after?: string;
}

const readRetry = {
  maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5000,
  isRetryable: (error: unknown) => error instanceof TypeError ||
    (error instanceof ApiError && error.status >= 500),
};

function targetPath(id: string, attempt: string): string {
  return `/requests/${encodeURIComponent(id)}/runs/${encodeURIComponent(attempt)}/shares`;
}

function contentPolicy(options: Options): RunShareContent | undefined {
  if (!options.preset) {
    if (options.include || options.exclude) throw new Error("--include/--exclude require --preset so the replacement content policy is explicit");
    return undefined;
  }
  const content: RunShareContent = { ...(options.preset === "full" ? FULL_SHARE_CONTENT : SUMMARY_SHARE_CONTENT) };
  for (const [input, enabled] of [[options.include, true], [options.exclude, false]] as const) {
    for (const key of input?.split(",").map((item) => item.trim()).filter(Boolean) ?? []) {
      if (!Object.hasOwn(content, key)) throw new Error(`Unknown shared content category: ${key}`);
      // The key is checked against the canonical, closed content policy above.
      content[key as keyof RunShareContent] = enabled;
    }
  }
  return content;
}

function policy(options: Options) {
  const noExpiry = options.expiry === false;
  if (noExpiry && options.expiresAt) throw new Error("Choose either --no-expiry or --expires-at");
  return {
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.preset ? { content: contentPolicy(options) } : {}),
    ...(noExpiry ? { expiresAt: null } : options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.acknowledgeSensitiveContent ? { acknowledgeSensitiveContent: true } : {}),
  };
}

async function json<T>(
  baseUrl: string | undefined, path: string, schema: { parse: (value: unknown) => T }, init?: ApiFetchInit,
): Promise<T> {
  const read = async () => {
    const response = await apiFetch(baseUrl, path, { ...init, sensitiveBody: true });
    if (!response.ok) throw await readApiError(response);
    const value: unknown = await response.json();
    return schema.parse(value);
  };
  // Creating/rotating links is deliberately not retried after an ambiguous write.
  if (init?.method && init.method !== "GET") return read();
  return withRetry(read, readRetry);
}

function managementOptions(command: Command): Command {
  return withOutputOption(command
    .requiredOption("--attempt <run-id>", "Exact execution attempt ID (not its attempt number)")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl()));
}

function policyOptions(command: Command): Command {
  return command
    .option("--label <label>", "Public display label")
    .addOption(new Option("--preset <preset>", "Complete replacement content policy").choices(["summary", "full"]))
    .option("--include <categories>", "Enable comma-separated prompts,evaluationDetails,conversations,logs,reports,snapshots,network,video")
    .option("--exclude <categories>", "Disable comma-separated content categories")
    .option("--expires-at <iso-date>", "Expiry as an ISO-8601 date with timezone")
    .option("--no-expiry", "Keep the link valid until revoked")
    .option("--acknowledge-sensitive-content", "Confirm selected detailed/raw content is safe to publish");
}

const fields: DisplayField<RunShare>[] = [
  { key: "id", label: "ID" }, { key: "label", label: "Label" },
  { key: "runId", label: "Attempt" },
  { key: "expiresAt", label: "Expires", formatter: (share) => share.expiresAt ?? "Never" },
  { key: "revokedAt", label: "Revoked", formatter: (share) => share.revokedAt ?? "" },
];

function print(result: RunShare | RunShareLink | RunShareList, options: Options) {
  let output = result;
  if ("path" in result && options.portalUrl) {
    output = { ...result, path: new URL(result.path, options.portalUrl).href };
  }

  if (options.output === "json") console.log(JSON.stringify(output, null, 2));
  else if (options.output === "yaml") console.log(stringifyYaml(output));
  else {
    const shares = "data" in output ? output.data : "share" in output ? [output.share] : [output];
    const path = "path" in output ? output.path : undefined;
    const columns = options.output === "tsv" && path
      ? [...fields, { key: "path", label: "URL", formatter: () => path }] : fields;
    console.log(formatData(shares, columns, options.output));
    if (!isMachineReadable(options.output)) {
      if (path) console.log(`Shared URL: ${path}`);
      if ("next" in output && output.next) console.log(`Next page: --after ${output.next}`);
    }
  }
}

function portalOrigin(input: string): string {
  const origin = new URL(input);
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("--portal-url must be an HTTP(S) Portal URL without credentials");
  }
  return origin.origin;
}

function publicTarget(input: string, configuredApiUrl?: string) {
  if (RunShareTokenSchema.safeParse(input).success) return { token: input, baseUrl: configuredApiUrl };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Provide a valid shared run URL or share token");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      ![RUN_SHARE_PAGE, `${RUN_SHARE_PAGE}/`].includes(url.pathname)) {
    throw new Error("Provide a valid Scope shared run URL");
  }
  const token = RunShareTokenSchema.parse(url.hash.slice(1));
  return { token, baseUrl: configuredApiUrl ?? url.origin };
}

export function registerRunShareCommands(run: Command): void {
  const share = run.command("share").description("Publish configurable read-only run links and view them without signing in");
  configureHelp(share);
  share.action(() => share.help());

  policyOptions(managementOptions(share.command("create").argument("<id>", "Request ID")
    .description("Create a public run link (Summary by default; expires in 7 days)")
    .option("--portal-url <url>", "Portal origin used to make the returned URL absolute", portalOrigin)))
    .action(async (id: string, options: Options) => {
      const parsed = CreateRunShareSchema.parse(policy({ ...options, preset: options.preset ?? "summary" }));
      const result = await json(options.url, targetPath(id, options.attempt), RunShareLinkSchema, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed),
      });
      print(result, options);
    });

  managementOptions(share.command("list").argument("<id>", "Request ID").description("List your links for an attempt")
    .option("--after <share-id>", "Continue after a previous page's next ID"))
    .action(async (id: string, options: Options) => {
      const suffix = options.after ? `?after=${encodeURIComponent(options.after)}` : "";
      print(await json(options.url, `${targetPath(id, options.attempt)}${suffix}`, RunShareListSchema), options);
    });

  policyOptions(managementOptions(share.command("update").argument("<id>", "Request ID").argument("<share-id>", "Share ID")
    .description("Replace your link's content policy, label, or expiry")))
    .action(async (id: string, shareId: string, options: Options) => {
      contentPolicy(options);
      const parsed = UpdateRunShareSchema.parse(policy(options));
      print(await json(options.url, `${targetPath(id, options.attempt)}/${encodeURIComponent(shareId)}`, RunShareSchema, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed),
      }), options);
    });

  managementOptions(share.command("revoke").argument("<id>", "Request ID").argument("<share-id>", "Share ID")
    .description("Permanently revoke your public run link"))
    .action(async (id: string, shareId: string, options: Options) => {
      print(await json(options.url, `${targetPath(id, options.attempt)}/${encodeURIComponent(shareId)}`, RunShareSchema, { method: "DELETE" }), options);
    });

  managementOptions(share.command("rotate").argument("<id>", "Request ID").argument("<share-id>", "Share ID")
    .description("Replace your link's secret, immediately invalidating its previous URL")
    .option("--portal-url <url>", "Portal origin used to make the returned URL absolute", portalOrigin))
    .action(async (id: string, shareId: string, options: Options) => {
      print(await json(options.url, `${targetPath(id, options.attempt)}/${encodeURIComponent(shareId)}/rotate`, RunShareLinkSchema, { method: "POST" }), options);
    });

  share.command("view").argument("<shared-url-or-token>", "Public URL (quote it to preserve its fragment), or token")
    .description("View shared results, logs, or reports anonymously; never enrolls or sends your IdP bearer")
    .addOption(new Option("--section <section>", "Content to read").choices(["view", "logs", "reports"]).default("view"))
    .option("--after <report-id>", "Continue a shared report page")
    .option("-u, --url <url>", "API origin (defaults to SCOPE_API_URL, or the shared URL's origin)", getDefaultApiUrl())
    .addOption(new Option("-o, --output <format>", "Output format").choices(["json", "yaml"]).default("json"))
    .action(async (input: string, options: { url?: string; section: string; after?: string; output: string }) => {
      const { token, baseUrl } = publicTarget(input, options.url);
      const query = options.after && options.section === "reports" ? `?after=${encodeURIComponent(options.after)}` : "";
      const init: ApiFetchInit = { skipAuth: true, credentials: "omit", referrerPolicy: "no-referrer", headers: { [RUN_SHARE_HEADER]: token } };
      const path = `/shared/runs/${options.section}${query}`;
      const result = options.section === "logs" ? await json(baseUrl, path, SharedRunLogsSchema, init)
        : options.section === "reports" ? await json(baseUrl, path, SharedRunReportsSchema, init)
        : await json(baseUrl, path, SharedRunSchema, init);
      console.log(options.output === "yaml" ? stringifyYaml(result) : JSON.stringify(result, null, 2));
    });

  share.command("download").argument("<shared-url-or-token>", "Public run URL or token").argument("<artifact-id>", "Artifact ID from share view")
    .description("Download one explicitly shared raw artifact (128 MiB maximum)")
    .requiredOption("--file <path>", "Destination file; existing files are never overwritten")
    .option("-u, --url <url>", "API origin", getDefaultApiUrl())
    .action(async (input: string, artifactId: string, options: { url?: string; file: string }) => {
      const { token, baseUrl } = publicTarget(input, options.url);
      const init: ApiFetchInit = { skipAuth: true, credentials: "omit", referrerPolicy: "no-referrer", sensitiveBody: true, headers: { [RUN_SHARE_HEADER]: token } };
      const view = await json(baseUrl, "/shared/runs/view", SharedRunSchema, init);
      if (!view.artifacts.some((artifact) => artifact.id === artifactId)) throw new Error("Artifact is not shared or unavailable");
      const bytes = await withRetry(async () => {
        const response = await apiFetch(baseUrl, `/shared/runs/artifacts/${encodeURIComponent(artifactId)}`, init);
        if (!response.ok) throw await readApiError(response);
        return new Uint8Array(await response.arrayBuffer());
      }, readRetry);
      await writeFile(options.file, bytes, { flag: "wx" });
      console.log(`Downloaded ${artifactId} to ${options.file}`);
    });
}
