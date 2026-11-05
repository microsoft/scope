// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { apiFetch } from "../utils/api-client.js";
import { getDefaultApiUrl } from "../utils/shared.js";

interface AccessOptions { url: string; operationId?: string; revision?: string; role?: string; cursor?: string; limit?: string }

export function registerAccessCommands(program: Command): void {
  const access = program.command("access").description("Account and project membership administration (raw IdP SCOPE_TOKEN)");
  function command(name: string, description: string): Command {
    return access.command(name).description(description).option("-u, --url <url>", "API base URL", getDefaultApiUrl());
  }
  function mutation(command: Command): Command {
    return command.option("--operation-id <id>", "Stable idempotency key (reuse only for identical input)")
      .requiredOption("--revision <number>", "Expected current target revision (0 for a new membership)");
  }
  function revision(options: AccessOptions): number {
    const value = Number(options.revision);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Revision must be a nonnegative integer");
    return value;
  }
  async function request(options: AccessOptions, path: string, method = "GET", body?: unknown): Promise<void> {
    const id = options.operationId ?? randomUUID();
    if (method !== "GET" && path !== "/users/me") console.error(`Operation ID: ${id} (reuse only for identical input)`);
    const response = await apiFetch(options.url, path, {
      method, headers: { "Content-Type": "application/json", ...(method !== "GET" ? { "Idempotency-Key": id } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
    console.log(JSON.stringify(data, null, 2));
    if (response.status === 202) {
      console.error("Operation pending: retry only identical input with the same operation ID, or give that ID to an operator for repair. No completion claimed.");
      process.exitCode = 2;
    }
  }
  function action<Args extends unknown[]>(run: (...args: Args) => Promise<void>): (...args: Args) => Promise<void> {
    return async (...args: Args) => {
      try { await run(...args); }
      catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
    };
  }
  function search(options: AccessOptions, path: string, query?: string): Promise<void> {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Limit must be an integer from 1 to 50");
    const params = new URLSearchParams({ q: query ?? "", limit: String(limit) });
    if (options.cursor) params.set("cursor", options.cursor);
    return request(options, `${path}?${params}`);
  }
  command("me", "Read own account and current capabilities").action(action((options: AccessOptions) => request(options, "/users/me")));
  command("enroll", "Explicitly enroll after a successful IdP login").action(action((options: AccessOptions) => request(options, "/users/me", "POST")));
  command("find-user <userId>", "Exact enrolled Scope UUID lookup (platform admin)")
    .action(action((userId: string, options: AccessOptions) => request(options, `/admin/users?userId=${encodeURIComponent(userId)}`)));
  command("find-member <projectId> <userId>", "Exact enrolled Scope UUID lookup for adding a member (project or platform admin)")
    .action(action((projectId: string, userId: string, options: AccessOptions) =>
      request(options, `/projects/${encodeURIComponent(projectId)}/members/lookup/${encodeURIComponent(userId)}`)));
  command("search-users [query]", "Search enrolled platform users by name, email or Scope UUID (platform admin)")
    .option("--cursor <id>", "Continue from the previous response's nextCursor")
    .option("--limit <number>", "Maximum users per page (1-50)", "20")
    .action(action((query: string | undefined, options: AccessOptions) => search(options, "/admin/users/search", query)));
  command("search-members <projectId> [query]", "Find enrolled users by name, email or Scope UUID to add to a project (project or platform admin)")
    .option("--cursor <id>", "Continue from the previous response's nextCursor")
    .option("--limit <number>", "Maximum users per page (1-50)", "20")
    .action(action((projectId: string, query: string | undefined, options: AccessOptions) =>
      search(options, `/projects/${encodeURIComponent(projectId)}/members/search`, query)));
  command("projects", "Platform-only project control-plane inventory")
    .action(action((options: AccessOptions) => request(options, "/projects?controlPlane=true&includeDeleted=true")));
  command("platform-admins", "List platform administrators, including disabled accounts and pending changes")
    .option("--cursor <id>", "Continue from the previous response's nextCursor")
    .option("--limit <number>", "Maximum administrators per page (1-50)", "20")
    .action(action((options: AccessOptions) => {
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Limit must be an integer from 1 to 50");
      const params = new URLSearchParams({ limit: String(limit) });
      if (options.cursor) params.set("cursor", options.cursor);
      return request(options, `/admin/platform-admins?${params}`);
    }));
  mutation(command("promote-admin <userId>", "Grant platform-wide administration to an enabled enrolled user (no project membership)"))
    .action(action((userId: string, options: AccessOptions) =>
      request(options, `/admin/users/${encodeURIComponent(userId)}/promote`, "POST", { revision: revision(options) })));
  command("members <projectId>", "Membership roster (project or platform admin)")
    .action(action((projectId: string, options: AccessOptions) => request(options, `/projects/${encodeURIComponent(projectId)}/members`)));
  mutation(command("set-member <projectId> <userId>", "Explicitly assign or change a project membership")
    .requiredOption("--role <role>", "reader, contributor or admin"))
    .action(action((projectId: string, userId: string, options: AccessOptions) =>
      request(options, `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, "PUT", { role: options.role, revision: revision(options) })));
  mutation(command("revoke-member <projectId> <userId>", "Soft-revoke a membership"))
    .action(action((projectId: string, userId: string, options: AccessOptions) =>
      request(options, `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, "DELETE", { revision: revision(options) })));
  mutation(command("disable-user <userId>", "Disable an ordinary user; administrator disable and demotion remain operator-only"))
    .action(action((userId: string, options: AccessOptions) => request(options, `/admin/users/${encodeURIComponent(userId)}/disable`, "POST", { revision: revision(options) })));
}
