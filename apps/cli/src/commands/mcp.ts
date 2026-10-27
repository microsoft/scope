// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { configureHelp } from "../utils/helpFormatter.js";
import { dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { parseEnvPairs, parseHeaderPairs } from "../utils/parsers.js";

export function registerMcpCommands(program: Command): void {
// ─── MCP server management ──────────────────────────────────────────────────

const mcp = program
  .command("mcp")
  .description("Manage MCP (Model Context Protocol) resources")
  .action(() => {
    mcp.help();
  });

configureHelp(mcp);

const mcpServer = mcp
  .command("server")
  .description("Manage remote MCP servers (SSE and streamable HTTP)")
  .action(() => {
    mcpServer.help();
  });

configureHelp(mcpServer);

withProjectOption(withOutputOption(
mcpServer
  .command("list")
  .description("List all MCP servers")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/mcp/servers`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const servers = await response.json() as Array<{ _id: string; name: string; type: string; url: string; description?: string }>;
      if (servers.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No MCP servers found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${servers.length} MCP server(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'Slug', tableFormatter: (s: any) => value(s._id) },
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Type' },
        { key: 'url', label: 'URL' },
        { key: 'description', label: 'Description', formatter: (s: any) => s.description || '—' },
      ];
      console.log(formatData(servers, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
mcpServer
  .command("get")
  .description("Get details of an MCP server")
  .requiredOption("-i, --id <id>", "MCP server slug")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/mcp/servers/${encodeURIComponent(options.id)}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const server = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'Slug' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type' },
          { key: 'url', label: 'URL' },
          { key: 'version', label: 'Package Version' },
          { key: 'description', label: 'Description', formatter: (s: any) => s.description || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([server], fields, format));
        return;
      }

      console.log(`${label('Slug:')} ${value(server._id)}`);
      console.log(`${label('Name:')} ${value(server.name)}`);
      console.log(`${label('Type:')} ${value(server.type)}`);
      if (server.type === 'stdio') {
        console.log(`${label('Command:')} ${value(server.command)}`);
        if (server.args && server.args.length > 0) {
          console.log(`${label('Args:')} ${value(server.args.join(' '))}`);
        }
        if (server.version) console.log(`${label('Package version:')} ${value(server.version)}`);
        if (server.env && Object.keys(server.env).length > 0) {
          console.log(`${label('Env:')}`);
          for (const [k, v] of Object.entries(server.env)) {
            console.log(`  ${k}=${v}`);
          }
        }
      } else {
        console.log(`${label('URL:')} ${value(server.url)}`);
        if (server.headers && server.headers.length > 0) {
          console.log(`${label('Headers:')}`);
          for (const h of server.headers) {
            console.log(`  ${h.name}: ${h.value}`);
          }
        }
      }
      if (server.description) console.log(`${label('Description:')} ${server.description}`);
      console.log(`${label('Created:')} ${new Date(server.createdAt).toLocaleString()}`);
      if (server.updatedAt) console.log(`${label('Updated:')} ${new Date(server.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

mcpServer
  .command("create")
  .description("Create a new MCP server")
  .requiredOption("--id <slug>", "Slug identifier (lowercase, hyphens allowed)")
  .requiredOption("--name <name>", "Display name")
  .requiredOption("--type <type>", "Transport type (sse, http, or stdio)")
  .option("--url <url>", "Server URL (required for sse/http)")
  .option("--command <command>", "Executable to spawn (required for stdio)")
  .option("--args <args>", "Space-separated CLI arguments for stdio command")
  .option("--pkg-version <version>", "Package version for stdio command")
  .option("--env <env...>", "Environment variables in KEY=VALUE format (repeatable)")
  .option("--description <desc>", "Description")
  .option("--header <header...>", "Headers in name:value format (repeatable)")
  .option("-u, --api-url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const isStdio = options.type === "stdio";

      if (isStdio && !options.command) {
        console.error(errorText("Error: --command is required for stdio transport"));
        process.exit(1);
      }
      if (!isStdio && !options.url) {
        console.error(errorText("Error: --url is required for sse/http transport"));
        process.exit(1);
      }

      const headers = options.header ? parseHeaderPairs(options.header) : undefined;
      const env = options.env ? parseEnvPairs(options.env) : undefined;

      const body: Record<string, unknown> = {
        _id: options.id,
        name: options.name,
        type: options.type,
      };
      if (isStdio) {
        body.command = options.command;
        if (options.args) body.args = options.args.trim().split(/\s+/);
        if (options.pkgVersion) body.version = options.pkgVersion;
        if (env && Object.keys(env).length > 0) body.env = env;
      } else {
        body.url = options.url;
        if (headers && headers.length > 0) body.headers = headers;
      }
      if (options.description) body.description = options.description;

      const response = await apiFetch(options.apiUrl, `/mcp/servers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const created = await response.json();
      console.log(successText(`MCP server "${created._id}" created.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
mcpServer
  .command("update")
  .description("Update an MCP server")
  .requiredOption("-i, --id <id>", "MCP server slug")
  .option("--name <name>", "Display name")
  .option("--type <type>", "Transport type (sse, http, or stdio)")
  .option("--url <url>", "Server URL")
  .option("--command <command>", "Executable to spawn (stdio)")
  .option("--args <args>", "Space-separated CLI arguments for stdio command")
  .option("--pkg-version <version>", "Package version for stdio command")
  .option("--env <env...>", "Environment variables in KEY=VALUE format (replaces all env vars)")
  .option("--description <desc>", "Description")
  .option("--header <header...>", "Headers in name:value format (replaces all headers)")
  .option("-u, --api-url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.type) body.type = options.type;
      if (options.url) body.url = options.url;
      if (options.command) body.command = options.command;
      if (options.args) body.args = options.args.trim().split(/\s+/);
      if (options.pkgVersion) body.version = options.pkgVersion;
      if (options.env) body.env = parseEnvPairs(options.env);
      if (options.description) body.description = options.description;
      if (options.header) body.headers = parseHeaderPairs(options.header);
      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update"));
        process.exit(1);
      }
      const response = await apiFetch(options.apiUrl, `/mcp/servers/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`MCP server "${updated._id}" updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
mcpServer
  .command("delete")
  .description("Delete an MCP server (soft-delete)")
  .requiredOption("-i, --id <id>", "MCP server slug")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/mcp/servers/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`MCP server "${options.id}" deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
