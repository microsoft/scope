// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import type { ResourceDocument, ResourceParameter, ResourceRevisionDocument, ResourceScript } from "shared";
import { configureHelp } from "../utils/helpFormatter.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";
import { getDefaultApiUrl, withOutputOption, withProjectOption } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { errorText, label, successText, value, warnBanner } from "../utils/style.js";
import { buildResourceParameters, collectRepeatable, formatParameterContract } from "../utils/resources.js";

type JsonDate = string | Date;
type ResourceApiDocument = Omit<ResourceDocument, "createdAt" | "updatedAt" | "deletedAt"> & {
  id?: string;
  createdAt: JsonDate;
  updatedAt?: JsonDate;
  deletedAt?: JsonDate;
  firstRevision?: ResourceRevisionApiDocument;
};
type ResourceRevisionApiDocument = Omit<ResourceRevisionDocument, "createdAt" | "deletedAt"> & {
  id?: string;
  createdAt: JsonDate;
  deletedAt?: JsonDate;
  deduplicated?: boolean;
};

interface ApiErrorBody {
  error?: string;
}

interface LifecycleOptions {
  setupSh?: string;
  setupFile?: string;
  teardownSh?: string;
  teardownFile?: string;
  exports?: string[];
  param?: string[];
  creator?: string;
}

function resourceId(resource: ResourceApiDocument): string {
  return resource.id ?? resource._id;
}

async function readError(response: Response): Promise<string> {
  const error = (await response.json().catch((): ApiErrorBody => ({ error: response.statusText }))) as ApiErrorBody;
  return error.error ?? JSON.stringify(error);
}

async function fetchJson<T>(baseUrl: string, path: string, projectId: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(baseUrl, path, { ...init, projectId });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

function readTextFile(path: string): string {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) {
    throw new Error(`Path not found: ${fullPath}`);
  }
  return readFileSync(fullPath, "utf8");
}

function buildLifecycleBody(options: LifecycleOptions): {
  setup: ResourceScript;
  teardown?: ResourceScript;
  exports?: string[];
  parameters?: ResourceParameter[];
  creator?: string;
} {
  if (options.setupSh && options.setupFile) {
    throw new Error("Use either --setup-sh or --setup-file, not both");
  }
  if (options.teardownSh && options.teardownFile) {
    throw new Error("Use either --teardown-sh or --teardown-file, not both");
  }
  const setupBody = options.setupSh ?? (options.setupFile ? readTextFile(options.setupFile) : undefined);
  if (!setupBody) {
    throw new Error("Provide --setup-sh or --setup-file");
  }
  const teardownBody = options.teardownSh ?? (options.teardownFile ? readTextFile(options.teardownFile) : undefined);
  return {
    setup: { sh: setupBody },
    ...(teardownBody ? { teardown: { sh: teardownBody } } : {}),
    ...(options.exports && options.exports.length > 0 ? { exports: options.exports } : {}),
    ...(options.param && options.param.length > 0 ? { parameters: buildResourceParameters(options.param) } : {}),
    ...(options.creator ? { creator: options.creator } : {}),
  };
}

function resourceFields(): DisplayField<ResourceApiDocument>[] {
  return [
    { key: "slug", label: "Slug", tableFormatter: (resource) => value(resource.slug) },
    { key: "name", label: "Name" },
    { key: "latestRevisionNumber", label: "Latest", formatter: (resource) => resource.latestRevisionNumber?.toString() ?? "—" },
    { key: "latestRevisionId", label: "Latest Revision", formatter: (resource) => resource.latestRevisionId ?? "—" },
    { key: "createdAt", label: "Created", formatter: (resource) => new Date(resource.createdAt).toLocaleString() },
  ];
}

function revisionFields(): DisplayField<ResourceRevisionApiDocument>[] {
  return [
    { key: "ref", label: "Ref", tableFormatter: (revision) => value(revision.ref) },
    { key: "revisionNumber", label: "Revision", formatter: (revision) => revision.revisionNumber.toString() },
    { key: "exports", label: "Exports", formatter: (revision) => revision.exports.join(", ") || "—" },
    { key: "parameters", label: "Parameters", formatter: (revision) => formatParameterContract(revision.parameters) },
    { key: "contentSha256", label: "Content SHA", formatter: (revision) => revision.contentSha256.substring(0, 12) },
    { key: "createdAt", label: "Created", formatter: (revision) => new Date(revision.createdAt).toLocaleString() },
  ];
}

function parseRevisionRef(spec: string): { slug: string; revisionNumber: number } | null {
  const match = /^(.+)@r(\d+)$/.exec(spec);
  if (!match) return null;
  return { slug: match[1], revisionNumber: Number(match[2]) };
}

async function resolveResource(baseUrl: string, projectId: string, idOrSlug: string): Promise<ResourceApiDocument> {
  return fetchJson<ResourceApiDocument>(baseUrl, `/resources/${encodeURIComponent(idOrSlug)}`, projectId);
}

function addLifecycleOptions(command: Command): Command {
  return command
    .option("--setup-sh <script>", "Shell setup script body")
    .option("--setup-file <path>", "Read shell setup script body from a file")
    .option("--teardown-sh <script>", "Shell teardown script body")
    .option("--teardown-file <path>", "Read shell teardown script body from a file")
    .option("--exports <name...>", "Environment variable names exported by setup")
    .option("--param <NAME[:default][!]>", "Declare a parameter (repeatable): NAME! is required, NAME:default has a default", collectRepeatable, [])
    .option("--creator <creator>", "Revision creator/provenance");
}

export function registerResourceCommands(program: Command): void {
  const resource = program
    .command("resource")
    .description("Manage resources")
    .action(() => {
      resource.help();
    });

  configureHelp(resource);

  withProjectOption(withOutputOption(
    resource
      .command("list")
      .description("List resources")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const resources = await fetchJson<ResourceApiDocument[]>(options.url, "/resources", projectId);
      if (resources.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No resources found."));
        return;
      }
      if (!isMachineReadable(format)) console.log(label(`Found ${resources.length} resource(s):\n`));
      console.log(formatData(resources, resourceFields(), format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    addLifecycleOptions(
      resource
        .command("create")
        .description("Create a resource and its first revision")
        .requiredOption("--name <name>", "Display name")
        .option("--slug <slug>", "Stable URL/ref slug")
        .option("--description <description>", "Description")
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    )
  )).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const lifecycle = buildLifecycleBody(options);
      const body = {
        name: options.name as string,
        ...(options.slug ? { slug: options.slug as string } : {}),
        ...(options.description ? { description: options.description as string } : {}),
        ...lifecycle,
      };
      const created = await fetchJson<ResourceApiDocument>(options.url, "/resources", projectId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (isMachineReadable(format)) {
        console.log(formatData([created], resourceFields(), format));
        return;
      }
      console.log(successText(`Resource "${created.slug}" created.`));
      console.log(`${label("ID:")} ${value(resourceId(created))}`);
      console.log(`${label("Slug:")} ${value(created.slug)}`);
      if (created.firstRevision) console.log(`${label("First revision:")} ${value(created.firstRevision.ref)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    resource
      .command("get")
      .description("Get a resource or revision by slug, slug@rN, resource id, or revision id")
      .argument("<spec>", "Resource slug/id, resource revision ref, or revision id")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  )).action(async (spec: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const parsed = parseRevisionRef(spec);
      if (parsed) {
        const revision = await fetchJson<ResourceRevisionApiDocument>(
          options.url,
          `/resources/${encodeURIComponent(parsed.slug)}/revisions/${parsed.revisionNumber}`,
          projectId
        );
        console.log(formatData([revision], revisionFields(), format));
        return;
      }

      try {
        const found = await resolveResource(options.url, projectId, spec);
        console.log(formatData([found], resourceFields(), format));
        return;
      } catch (resourceError) {
        const revision = await fetchJson<ResourceRevisionApiDocument>(
          options.url,
          `/resources/revisions/${encodeURIComponent(spec)}`,
          projectId
        );
        console.log(formatData([revision], revisionFields(), format));
        if (resourceError instanceof Error && revision._id === spec) return;
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(
    resource
      .command("update")
      .description("Update resource metadata")
      .argument("<resourceIdOrSlug>", "Resource ID or slug")
      .option("--name <name>", "New display name")
      .option("--description <description>", "New description")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  ).action(async (resourceIdOrSlug: string, options) => {
    const projectId = requireProjectId(options.project);
    try {
      const body: Record<string, string> = {};
      if (options.name !== undefined) body.name = options.name;
      if (options.description !== undefined) body.description = options.description;
      if (Object.keys(body).length === 0) throw new Error("Provide --name or --description");
      const updated = await fetchJson<ResourceApiDocument>(
        options.url,
        `/resources/${encodeURIComponent(resourceIdOrSlug)}`,
        projectId,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      console.log(successText(`Resource "${updated.slug}" updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(
    resource
      .command("delete")
      .description("Delete a resource (soft-delete)")
      .argument("<resourceIdOrSlug>", "Resource ID or slug")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  ).action(async (resourceIdOrSlug: string, options) => {
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/resources/${encodeURIComponent(resourceIdOrSlug)}`, {
        method: "DELETE",
        projectId,
      });
      if (!response.ok) throw new Error(await readError(response));
      console.log(successText(`Resource "${resourceIdOrSlug}" deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  withProjectOption(withOutputOption(
    addLifecycleOptions(
      resource
        .command("revisions")
        .description("List revisions for a resource, or create one when --setup-sh/--setup-file is provided")
        .argument("<resourceIdOrSlug>", "Resource ID or slug")
        .option("--limit <number>", "Maximum list results", Number.parseInt)
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    )
  )).action(async (resourceIdOrSlug: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const isCreate = Boolean(options.setupSh || options.setupFile);
      if (isCreate) {
        const body = buildLifecycleBody(options);
        const revision = await fetchJson<ResourceRevisionApiDocument>(
          options.url,
          `/resources/${encodeURIComponent(resourceIdOrSlug)}/revisions`,
          projectId,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        if (isMachineReadable(format)) {
          console.log(formatData([revision], revisionFields(), format));
          return;
        }
        if (revision.deduplicated) {
          console.log(successText("No changes — reused existing resource revision:"));
        } else {
          console.log(successText("Resource revision created:"));
        }
        console.log(`${label("Ref:")} ${value(revision.ref)}`);
        console.log(`${label("Content SHA:")} ${value(revision.contentSha256)}`);
        return;
      }

      if (options.teardownSh || options.teardownFile || (options.exports && options.exports.length > 0) || options.creator) {
        throw new Error("Revision creation options require --setup-sh or --setup-file");
      }

      const params = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
      const list = await fetchJson<ResourceRevisionApiDocument[]>(
        options.url,
        `/resources/${encodeURIComponent(resourceIdOrSlug)}/revisions${params}`,
        projectId
      );
      if (list.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No resource revisions found."));
        return;
      }
      if (!isMachineReadable(format)) console.log(label(`Found ${list.length} revision(s):\n`));
      console.log(formatData(list, revisionFields(), format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
}
