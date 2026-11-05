// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { AccessCapabilitiesSchema, ApiAuthModeSchema } from "shared/rbac";
import type { ProjectDocument } from "shared";
import { configureHelp } from "../utils/helpFormatter.js";
import { dimTimestamp, errorText, label, successText, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";
import { getDefaultApiUrl, getCliName, withOutputOption } from "../utils/shared.js";
import { apiFetch } from "../utils/api-client.js";
import { getSelectedProjectId, resolveProjectId, setSelectedProjectId } from "../utils/config.js";

/** Project as returned by the API — dates arrive as JSON strings, `id` mirrors `_id`. */
type ProjectApiDocument = Omit<ProjectDocument, "createdAt" | "updatedAt" | "deletedAt"> & {
  revision?: number;
  id?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
};

interface ApiErrorBody {
  error?: string;
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch((): ApiErrorBody => ({ error: response.statusText }))) as ApiErrorBody;
  return body.error ?? JSON.stringify(body);
}

function mutationHeaders(operationId?: string): Record<string, string> {
  const id = operationId ?? randomUUID();
  console.error(dimTimestamp(`Operation ID: ${id} (reuse only for identical input)`));
  return { "Content-Type": "application/json", "Idempotency-Key": id };
}

async function requireCompleted(response: Response): Promise<void> {
  if (response.status !== 202) return;
  const pending: { operationId?: string } = await response.json();
  throw new Error(`Operation ${pending.operationId ?? "unknown"} is pending; retry only identical input with the same ID, or give it to an operator for repair. Completion is not confirmed.`);
}

function projectId(project: ProjectApiDocument): string {
  return project.id ?? project._id;
}

function projectFields(
  selectedId?: string,
  opts?: { includeDeleted?: boolean },
): DisplayField<ProjectApiDocument>[] {
  const fields: DisplayField<ProjectApiDocument>[] = [
    {
      key: "_id",
      label: "ID",
      formatter: (p) => projectId(p),
      // Mark the active selection so `project list` shows which one is in use.
      tableFormatter: (p) => (projectId(p) === selectedId ? successText(`${projectId(p)} *`) : value(projectId(p))),
    },
    { key: "name", label: "Name" },
    { key: "description", label: "Description", formatter: (p) => p.description ?? "—" },
    { key: "creator", label: "Creator", formatter: (p) => p.creator ?? "—" },
    { key: "createdAt", label: "Created", formatter: (p) => new Date(p.createdAt).toLocaleString() },
  ];
  if (opts?.includeDeleted) {
    fields.push({
      key: "deletedAt",
      label: "Deleted",
      formatter: (p) => (p.deletedAt ? new Date(p.deletedAt).toLocaleString() : "—"),
      tableFormatter: (p) => (p.deletedAt ? errorText(new Date(p.deletedAt).toLocaleString()) : dimTimestamp("—")),
    });
  }
  return fields;
}

/** Fetch a single project by id, returning `undefined` on 404. */
async function fetchProject(baseUrl: string, id: string): Promise<ProjectApiDocument | undefined> {
  const response = await apiFetch(baseUrl, `/projects/${encodeURIComponent(id)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as ProjectApiDocument;
}

async function requireMembership(baseUrl: string, id: string): Promise<void> {
  const version = await apiFetch(baseUrl, "/version");
  if (!version.ok) throw new Error(await readError(version));
  const mode: unknown = await version.json();
  if (!ApiAuthModeSchema.parse(mode).authEnabled) return;
  const own = await apiFetch(baseUrl, "/users/me");
  if (!own.ok) throw new Error(await readError(own));
  const account: { capabilities?: unknown } = await own.json();
  const capabilities = AccessCapabilitiesSchema.parse(account.capabilities);
  if (!capabilities.memberships.some(membership => membership.projectId === id)) {
    throw new Error("Selecting project content requires an explicit active membership, including for platform admins");
  }
}

export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Manage projects and the CLI's selected project")
    .action(() => {
      project.help();
    });

  configureHelp(project);

  // ─── list ──────────────────────────────────────────────────────────────────
  withOutputOption(
    project
      .command("list")
      .description("List all projects (the active selection is marked with *)")
      .option("--include-deleted", "Also list soft-deleted projects")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    try {
      const includeDeleted = options.includeDeleted === true;
      const path = includeDeleted ? "/projects?includeDeleted=true" : "/projects";
      const response = await apiFetch(options.url, path);
      if (!response.ok) throw new Error(await readError(response));
      const projects = (await response.json()) as ProjectApiDocument[];
      if (projects.length === 0) {
        if (!isMachineReadable(format)) {
          console.log(warnBanner(`No projects found. Create one with \`${getCliName()} project create --name <name>\`.`));
        }
        return;
      }
      const selectedId = getSelectedProjectId();
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${projects.length} project(s):\n`));
      }
      console.log(formatData(projects, projectFields(selectedId, { includeDeleted }), format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  // ─── create ────────────────────────────────────────────────────────────────
  withOutputOption(
    project
      .command("create")
      .description("Create a project")
      .requiredOption("--name <name>", "Display name")
      .option("--description <description>", "Description")
      .option("--use", "Select the new project as the active project after creating it")
      .option("--operation-id <id>", "Stable idempotency key for identical retries")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    try {
      const body: { name: string; description?: string } = { name: options.name };
      if (options.description) body.description = options.description;
      const response = await apiFetch(options.url, "/projects", {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response));
      await requireCompleted(response);
      const created = (await response.json()) as ProjectApiDocument;
      if (options.use) {
        await requireMembership(options.url, projectId(created));
        setSelectedProjectId(projectId(created));
      }

      if (isMachineReadable(format)) {
        console.log(formatData([created], projectFields(), format));
        return;
      }
      console.log(successText(`Project "${created.name}" created.`));
      console.log(`${label("ID:")}   ${value(projectId(created))}`);
      console.log(`${label("Name:")} ${value(created.name)}`);
      console.log(dimTimestamp(options.use
        ? "Selected as the active project."
        : `Select with \`${getCliName()} project use ${projectId(created)}\`.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  // ─── use ───────────────────────────────────────────────────────────────────
  project
    .command("use")
    .description("Select the active project for scoped commands (persisted)")
    .argument("<id>", "Project ID to select")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id: string, options) => {
      try {
        const found = await fetchProject(options.url, id);
        if (!found) {
          console.error(errorText(`Project not found: ${id}`));
          process.exit(1);
        }
        await requireMembership(options.url, id);
        setSelectedProjectId(projectId(found));
        console.log(successText(`Active project set to "${found.name}" (${projectId(found)}).`));
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ─── show ──────────────────────────────────────────────────────────────────
  withOutputOption(
    project
      .command("show")
      .description("Show the active project (resolves SCOPE_PROJECT / saved selection)")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    const format = (options.output ?? "table") as OutputFormat;
    try {
      const resolved = resolveProjectId();
      if (!resolved) {
        if (!isMachineReadable(format)) {
          console.log(
            warnBanner(
              `No project selected. Pick one with \`${getCliName()} project use <id>\`, set SCOPE_PROJECT, or pass --project.`,
            ),
          );
        }
        return;
      }
      const found = await fetchProject(options.url, resolved);
      if (!found) {
        console.error(errorText(`Selected project not found: ${resolved}`));
        process.exit(1);
      }
      if (isMachineReadable(format)) {
        console.log(formatData([found], projectFields(resolved), format));
        return;
      }
      console.log(label("Active project:\n"));
      console.log(`${label("ID:")}          ${value(projectId(found))}`);
      console.log(`${label("Name:")}        ${value(found.name)}`);
      if (found.description) console.log(`${label("Description:")} ${value(found.description)}`);
      if (found.creator) console.log(`${label("Creator:")}     ${value(found.creator)}`);
      console.log(`${label("Created:")}     ${value(new Date(found.createdAt).toLocaleString())}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  // ─── update (rename / describe) ──────────────────────────────────────────────
  withOutputOption(
    project
      .command("update")
      .description("Rename or re-describe a project")
      .argument("<id>", "Project ID to update")
      .option("--name <name>", "New display name")
      .option("--description <description>", "New description")
      .requiredOption("--revision <number>", "Expected project revision")
      .option("--operation-id <id>", "Stable idempotency key for identical retries")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    try {
      const patch: { name?: string; description?: string; revision?: number } = {};
      if (options.name !== undefined) patch.name = options.name;
      if (options.description !== undefined) patch.description = options.description;
      if (Object.keys(patch).length === 0) {
        console.error(errorText("Error: provide --name and/or --description to update"));
        process.exit(1);
      }
      patch.revision = Number(options.revision);
      const response = await apiFetch(options.url, `/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: mutationHeaders(options.operationId),
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(await readError(response));
      await requireCompleted(response);
      const updated = (await response.json()) as ProjectApiDocument;
      if (isMachineReadable(format)) {
        console.log(formatData([updated], projectFields(getSelectedProjectId()), format));
        return;
      }
      console.log(successText(`Project "${updated.name}" updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

  // ─── delete ──────────────────────────────────────────────────────────────────
  project
    .command("delete")
    .description("Soft-delete a project (restore later with `project restore`)")
    .argument("<id>", "Project ID to delete")
    .requiredOption("--revision <number>", "Expected project revision")
    .option("--operation-id <id>", "Stable idempotency key for identical retries")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id: string, options) => {
      try {
        const response = await apiFetch(options.url, `/projects/${encodeURIComponent(id)}`, {
          method: "DELETE", headers: mutationHeaders(options.operationId), body: JSON.stringify({ revision: Number(options.revision) }),
        });
        if (!response.ok) throw new Error(await readError(response));
        await requireCompleted(response);
        // Clear the persisted selection if we just deleted the active project.
        if (getSelectedProjectId() === id) setSelectedProjectId(undefined);
        console.log(successText(`Project ${id} deleted.`));
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // ─── restore ─────────────────────────────────────────────────────────────────
  withOutputOption(
    project
      .command("restore")
      .description("Restore a soft-deleted project")
      .argument("<id>", "Project ID to restore")
      .requiredOption("--revision <number>", "Expected project revision")
      .option("--operation-id <id>", "Stable idempotency key for identical retries")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    const format = (options.output ?? "table") as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/projects/${encodeURIComponent(id)}/restore`, {
        method: "POST", headers: mutationHeaders(options.operationId), body: JSON.stringify({ revision: Number(options.revision) }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await requireCompleted(response);
      const restored = (await response.json()) as ProjectApiDocument;
      if (isMachineReadable(format)) {
        console.log(formatData([restored], projectFields(getSelectedProjectId()), format));
        return;
      }
      console.log(successText(`Project "${restored.name}" restored.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
}
