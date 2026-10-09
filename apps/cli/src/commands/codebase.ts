// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, existsSync } from "fs";
import { basename, resolve } from "path";
import { Command } from "commander";
import type { CodebaseDocument, CodebaseRevisionDocument, CodebaseSourceType } from "shared";
import { configureHelp } from "../utils/helpFormatter.js";
import { errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";
import { getDefaultApiUrl, withOutputOption, withProjectOption } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch, type ApiFetchInit } from "../utils/api-client.js";

type JsonDate = string | Date;
type CodebaseApiDocument = Omit<CodebaseDocument, "createdAt" | "updatedAt" | "deletedAt"> & {
  id?: string;
  createdAt: JsonDate;
  updatedAt?: JsonDate;
  deletedAt?: JsonDate;
};
type CodebaseRevisionApiDocument = Omit<CodebaseRevisionDocument, "commitTimestamp" | "resolvedAt" | "createdAt"> & {
  id?: string;
  commitTimestamp?: JsonDate;
  resolvedAt: JsonDate;
  createdAt: JsonDate;
  /**
   * Response-only flag returned by resolve/upload endpoints (not stored);
   * true when the revision was reused rather than newly created.
   */
  deduplicated?: boolean;
};

/**
 * HTTP request body for `POST /api/v1/codebases`. Mirrors `CreateCodebaseInputSchema`
 * (server-side); `projectId` is NOT part of the body — it is passed as the
 * `?projectId=` query param and written onto the doc by the API.
 */
interface CreateCodebaseBody {
  name: string;
  sourceType: CodebaseSourceType;
  source?: string;
  description?: string;
  defaultBranch?: string;
}
interface ApiErrorBody {
  error?: string;
}

function codebaseId(codebase: CodebaseApiDocument): string {
  return codebase.id ?? codebase._id;
}

async function readError(response: Response): Promise<string> {
  const error = (await response.json().catch((): ApiErrorBody => ({ error: response.statusText }))) as ApiErrorBody;
  return error.error ?? JSON.stringify(error);
}

async function fetchJson<T>(baseUrl: string, path: string, init?: ApiFetchInit): Promise<T> {
  const response = await apiFetch(baseUrl, path, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return await response.json() as T;
}

async function resolveCodebase(baseUrl: string, idOrSlug: string, projectId: string): Promise<CodebaseApiDocument> {
  const directResponse = await apiFetch(baseUrl, `/codebases/${encodeURIComponent(idOrSlug)}`, { projectId });
  if (directResponse.ok) {
    return await directResponse.json() as CodebaseApiDocument;
  }
  if (directResponse.status !== 404) {
    throw new Error(await readError(directResponse));
  }

  const codebases = await fetchJson<CodebaseApiDocument[]>(baseUrl, "/codebases", { projectId });
  const found = codebases.find((codebase) => codebase.slug === idOrSlug || codebase._id === idOrSlug || codebase.id === idOrSlug);
  if (!found) {
    throw new Error(`Codebase not found: ${idOrSlug}`);
  }
  return found;
}

function codebaseFields(): DisplayField<CodebaseApiDocument>[] {
  return [
    { key: "slug", label: "Slug", tableFormatter: (codebase) => value(codebase.slug) },
    { key: "name", label: "Name" },
    { key: "sourceType", label: "Type" },
    { key: "source", label: "Source", formatter: (codebase) => codebase.source ?? "—" },
    { key: "latestRevisionId", label: "Latest Revision", formatter: (codebase) => codebase.latestRevisionId ?? "—" },
    { key: "createdAt", label: "Created", formatter: (codebase) => new Date(codebase.createdAt).toLocaleString() },
  ];
}

function revisionFields(): DisplayField<CodebaseRevisionApiDocument>[] {
  return [
    { key: "ref", label: "Ref", tableFormatter: (revision) => value(revision.ref) },
    { key: "sourceType", label: "Type" },
    { key: "requestedRef", label: "Requested", formatter: (revision) => revision.requestedRef ?? "—" },
    { key: "resolvedCommitSha", label: "Commit", formatter: (revision) => revision.resolvedCommitSha?.substring(0, 8) ?? "—" },
    { key: "contentSha256", label: "Content SHA", formatter: (revision) => revision.contentSha256?.substring(0, 12) ?? "—" },
    { key: "createdAt", label: "Created", formatter: (revision) => new Date(revision.createdAt).toLocaleString() },
  ];
}

export function registerCodebaseCommands(program: Command): void {
  const codebase = program
    .command("codebase")
    .description("Manage codebases")
    .action(() => {
      codebase.help();
    });

  configureHelp(codebase);

  withProjectOption(withOutputOption(
    codebase
      .command("list")
      .description("List codebases")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const codebases = await fetchJson<CodebaseApiDocument[]>(options.url, "/codebases", { projectId });
      if (codebases.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No codebases found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${codebases.length} codebase(s):\n`));
      }
      console.log(formatData(codebases, codebaseFields(), format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    codebase
      .command("create")
      .description("Create a codebase")
      .requiredOption("--name <name>", "Display name")
      .requiredOption("--source-type <git|archive>", "Source type")
      .option("--source <owner/repo>", "GitHub repository for git codebases")
      .option("--archive <path>", "Path to archive file (required for archive codebases)")
      .option("--description <description>", "Description")
      .option("--default-branch <branch>", "Default branch for git codebases")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const sourceType = options.sourceType as CodebaseSourceType;
      if (sourceType !== "git" && sourceType !== "archive") {
        console.error(errorText("Error: --source-type must be 'git' or 'archive'"));
        process.exit(1);
      }
      if (sourceType === "git" && !options.source) {
        console.error(errorText("Error: --source is required for git codebases"));
        process.exit(1);
      }
      if (sourceType === "archive" && !options.archive) {
        console.error(errorText("Error: --archive is required for archive codebases"));
        process.exit(1);
      }

      const baseUrl = options.url;
      let created: CodebaseApiDocument;

      if (sourceType === "archive") {
        const resolvedPath = resolve(options.archive as string);
        if (!existsSync(resolvedPath)) {
          console.error(errorText(`Path not found: ${resolvedPath}`));
          process.exit(1);
        }
        const archiveBuffer = readFileSync(resolvedPath);
        const formData = new FormData();
        formData.append("sourceType", "archive");
        formData.append("name", options.name);
        if (options.description) formData.append("description", options.description);
        const blob = new Blob([archiveBuffer], { type: "application/octet-stream" });
        formData.append("archive", blob, basename(resolvedPath));
        const response = await apiFetch(baseUrl, "/codebases", { method: "POST", body: formData, projectId });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        created = await response.json() as CodebaseApiDocument;
      } else {
        const body: CreateCodebaseBody = {
          name: options.name,
          sourceType,
          ...(options.source ? { source: options.source } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(options.defaultBranch ? { defaultBranch: options.defaultBranch } : {}),
        };
        created = await fetchJson<CodebaseApiDocument>(baseUrl, "/codebases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          projectId,
        });
      }

      if (isMachineReadable(format)) {
        console.log(formatData([created], codebaseFields(), format));
        return;
      }
      console.log(successText(`Codebase "${created.slug}" created.`));
      console.log(`${label("ID:")} ${value(codebaseId(created))}`);
      console.log(`${label("Slug:")} ${value(created.slug)}`);
      console.log(`${label("Type:")} ${value(created.sourceType)}`);
      if (created.source) console.log(`${label("Source:")} ${value(created.source)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    codebase
      .command("revisions")
      .description("List revisions for a codebase")
      .argument("<codebaseIdOrSlug>", "Codebase ID or slug")
      .option("--limit <number>", "Maximum results", Number.parseInt)
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (codebaseIdOrSlug: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const baseUrl = options.url;
    const projectId = requireProjectId(options.project);
    try {
      const resolved = await resolveCodebase(baseUrl, codebaseIdOrSlug, projectId);
      const params = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
      const revisions = await fetchJson<CodebaseRevisionApiDocument[]>(baseUrl, `/codebases/${encodeURIComponent(codebaseId(resolved))}/revisions${params}`, { projectId });
      if (revisions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No revisions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${revisions.length} revision(s) for ${resolved.slug}:\n`));
      }
      console.log(formatData(revisions, revisionFields(), format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    codebase
      .command("resolve")
      .description("Resolve a git codebase revision")
      .argument("<codebaseIdOrSlug>", "Codebase ID or slug")
      .option("--ref <branch|tag|sha|latest>", "Git ref to resolve")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (codebaseIdOrSlug: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const baseUrl = options.url;
    const projectId = requireProjectId(options.project);
    try {
      const resolved = await resolveCodebase(baseUrl, codebaseIdOrSlug, projectId);
      const body = options.ref ? { requestedRef: options.ref as string } : {};
      const revision = await fetchJson<CodebaseRevisionApiDocument>(baseUrl, `/codebases/${encodeURIComponent(codebaseId(resolved))}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        projectId,
      });

      if (isMachineReadable(format)) {
        console.log(formatData([revision], revisionFields(), format));
        return;
      }
      if (revision.deduplicated) {
        console.log(successText("No changes — reused existing revision (commit unchanged):"));
      } else {
        console.log(successText("Codebase resolved to revision:"));
      }
      console.log(`${label("Ref:")} ${value(revision.ref)}`);
      if (revision.resolvedCommitSha) console.log(`${label("Commit:")} ${value(revision.resolvedCommitSha)}`);
      if (revision.archiveUrl) console.log(`${label("Archive:")} ${value(revision.archiveUrl)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    codebase
      .command("upload")
      .description("Upload an archive as a new codebase revision")
      .argument("<codebaseIdOrSlug>", "Codebase ID or slug")
      .argument("<archivePath>", "Path to archive file")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (codebaseIdOrSlug: string, archivePath: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const baseUrl = options.url;
    const projectId = requireProjectId(options.project);
    try {
      const resolvedPath = resolve(archivePath);
      if (!existsSync(resolvedPath)) {
        console.error(errorText(`Path not found: ${resolvedPath}`));
        process.exit(1);
      }
      const resolved = await resolveCodebase(baseUrl, codebaseIdOrSlug, projectId);
      const archiveBuffer = readFileSync(resolvedPath);
      const formData = new FormData();
      const blob = new Blob([archiveBuffer], { type: "application/octet-stream" });
      formData.append("archive", blob, basename(resolvedPath));

      const response = await apiFetch(baseUrl, `/codebases/${encodeURIComponent(codebaseId(resolved))}/upload`, {
        method: "POST",
        body: formData,
        projectId,
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const revision = await response.json() as CodebaseRevisionApiDocument;

      if (isMachineReadable(format)) {
        console.log(formatData([revision], revisionFields(), format));
        return;
      }
      if (revision.deduplicated) {
        console.log(successText("Identical archive — reused existing revision, no new revision created:"));
      } else {
        console.log(successText("Codebase archive uploaded:"));
      }
      console.log(`${label("Ref:")} ${value(revision.ref)}`);
      if (revision.contentSha256) console.log(`${label("Content SHA:")} ${value(revision.contentSha256)}`);
      if (revision.archiveUrl) console.log(`${label("Archive:")} ${value(revision.archiveUrl)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(codebase
    .command("delete")
    .description("Delete a codebase (soft-delete)")
    .argument("<codebaseIdOrSlug>", "Codebase ID or slug")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )
    .action(async (codebaseIdOrSlug: string, options) => {
      const baseUrl = options.url;
      const projectId = requireProjectId(options.project);
      try {
        const resolved = await resolveCodebase(baseUrl, codebaseIdOrSlug, projectId);
        const response = await apiFetch(baseUrl, `/codebases/${encodeURIComponent(codebaseId(resolved))}`, {
          method: "DELETE",
          projectId,
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
        console.log(successText(`Codebase "${resolved.slug}" deleted.`));
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
