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
import { buildResourceBindingSpecs, collectRepeatable, formatResourceBindings } from "../utils/resources.js";

export function registerProfileCommands(program: Command): void {
// ─── Profile commands ──────────────────────────────────────────────────────────

const profile = program
  .command("profile")
  .description("Manage run profiles (reusable agent configurations)")
  .action(() => {
    profile.help();
  });

configureHelp(profile);

withProjectOption(withOutputOption(
profile
  .command("list")
  .description("List all profiles")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/profiles`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const items = await response.json();
      if (items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No profiles found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} profile(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (p: any) => value(p._id) },
        { key: 'name', label: 'Name' },
        { key: 'latestVersion', label: 'Version', formatter: (p: any) => `v${p.latestVersion}` },
        { key: 'version.workerType', label: 'Worker', formatter: (p: any) => p.version?.workerType ?? '-' },
        { key: 'version.model', label: 'Model', formatter: (p: any) => p.version?.model ?? '-' },
        { key: 'createdAt', label: 'Created', formatter: (p: any) => new Date(p.createdAt).toLocaleDateString() },
      ];
      console.log(formatData(items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
profile
  .command("get")
  .description("Get details of a profile (latest version)")
  .requiredOption("-i, --id <id>", "Profile ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/profiles/${options.id}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const profile = await response.json();
      if (!isMachineReadable(format)) {
        console.log(label('Profile:'));
        console.log(`  ${label('ID:')}      ${value(profile._id)}`);
        console.log(`  ${label('Name:')}    ${value(profile.name)}`);
        if (profile.description) console.log(`  ${label('Desc:')}    ${dimTimestamp(profile.description)}`);
        console.log(`  ${label('Version:')} ${value(`v${profile.latestVersion}`)}`);
        console.log(`  ${label('Created:')} ${dimTimestamp(new Date(profile.createdAt).toLocaleString())}`);
        if (profile.version) {
          console.log(`\n${label('Configuration (v' + profile.version.version + '):')}`);
          console.log(`  ${label('Worker:')}  ${value(profile.version.workerType)}`);
          console.log(`  ${label('Model:')}   ${value(profile.version.model)}`);
          if (profile.version.agentVersion) console.log(`  ${label('Agent:')}   ${value(profile.version.agentVersion)}`);
          if (profile.version.mcpServers?.length) console.log(`  ${label('MCP:')}     ${profile.version.mcpServers.join(', ')}`);
          if (profile.version.skillRevisions?.length) console.log(`  ${label('Skills:')}  ${profile.version.skillRevisions.join(', ')}`);
          if (profile.version.resources?.length) console.log(`  ${label('Resources:')} ${formatResourceBindings(profile.version.resources)}`);
          if (profile.version.extensions?.length) console.log(`  ${label('Exts:')}    ${profile.version.extensions.join(', ')}`);
        }
      } else {
        const displayFields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'latestVersion', label: 'Version' },
          { key: 'version.workerType', label: 'Worker', formatter: (p: any) => p.version?.workerType ?? '' },
          { key: 'version.model', label: 'Model', formatter: (p: any) => p.version?.model ?? '' },
        ];
        console.log(formatData([profile], displayFields, format));
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

profile
  .command("create")
  .description("Create a new profile")
  .requiredOption("-n, --name <name>", "Profile name")
  .option("-d, --description <desc>", "Profile description")
  .requiredOption("-w, --worker <type>", "Worker type")
  .requiredOption("-m, --model <model>", "Model name")
  .option("--agent-version <version>", "Agent version")
  .option("--mcp-servers <ids...>", "MCP server IDs")
  .option("--skills <refs...>", "Skill revision references")
  .option("--resources <specs...>", "Resource specs to preset (slug, slug@rN, or revision id)")
  .option("--resource-param <slug>:<KEY>=<VALUE>", "Resource parameter preset (repeatable); matches a --resources entry by slug", collectRepeatable, [])
  .option("--extensions <ids...>", "Extension IDs (publisher.name or publisher.name@version)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {
        name: options.name,
        workerType: options.worker,
        model: options.model,
      };
      if (options.description) body.description = options.description;
      if (options.agentVersion) body.agentVersion = options.agentVersion;
      if (options.mcpServers) body.mcpServers = options.mcpServers;
      if (options.skills) body.skillRevisions = options.skills;
      const resources = buildResourceBindingSpecs(options.resources, options.resourceParam);
      if (resources) body.resources = resources;
      if (options.extensions) body.extensions = options.extensions;

      const response = await apiFetch(options.url, `/profiles`, {
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

      const result = await response.json();
      console.log(successText(`Profile "${options.name}" created.`));
      console.log(`  ${label('ID:')}      ${value(result._id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

profile
  .command("delete")
  .description("Delete a profile (soft-delete)")
  .requiredOption("-i, --id <id>", "Profile ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/profiles/${options.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText("Profile deleted."));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Version subcommand ────────────────────────────────────────────────────────

const version = profile
  .command("version")
  .description("Manage profile versions")
  .action(() => {
    version.help();
  });

configureHelp(version);

withOutputOption(
version
  .command("list")
  .description("List all versions of a profile")
  .requiredOption("-i, --id <id>", "Profile ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/profiles/${options.id}/versions`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const versions = await response.json();
      if (versions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No versions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${versions.length} version(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'version', label: 'Version', formatter: (v: any) => `v${v.version}` },
        { key: 'workerType', label: 'Worker' },
        { key: 'model', label: 'Model' },
        { key: 'createdAt', label: 'Created', formatter: (v: any) => new Date(v.createdAt).toLocaleDateString() },
      ];
      console.log(formatData(versions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
version
  .command("get")
  .description("Get details of a specific profile version")
  .requiredOption("-i, --id <id>", "Profile ID")
  .requiredOption("-v, --version <version>", "Version number")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/profiles/${options.id}/versions/${options.version}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const ver = await response.json();
      if (!isMachineReadable(format)) {
        console.log(label(`Version v${ver.version}:`));
        console.log(`  ${label('Worker:')}  ${value(ver.workerType)}`);
        console.log(`  ${label('Model:')}   ${value(ver.model)}`);
        if (ver.agentVersion) console.log(`  ${label('Agent:')}   ${value(ver.agentVersion)}`);
        if (ver.mcpServers?.length) console.log(`  ${label('MCP:')}     ${ver.mcpServers.join(', ')}`);
        if (ver.skillRevisions?.length) console.log(`  ${label('Skills:')}  ${ver.skillRevisions.join(', ')}`);
        if (ver.resources?.length) console.log(`  ${label('Resources:')} ${formatResourceBindings(ver.resources)}`);
        if (ver.extensions?.length) console.log(`  ${label('Exts:')}    ${ver.extensions.join(', ')}`);
        console.log(`  ${label('Created:')} ${dimTimestamp(new Date(ver.createdAt).toLocaleString())}`);
      } else {
        const displayFields: DisplayField[] = [
          { key: 'version', label: 'Version' },
          { key: 'workerType', label: 'Worker' },
          { key: 'model', label: 'Model' },
          { key: 'agentVersion', label: 'Agent Version', formatter: (v: any) => v.agentVersion || '' },
          { key: 'mcpServers', label: 'MCP Servers', formatter: (v: any) => (v.mcpServers || []).join(', ') },
          { key: 'skillRevisions', label: 'Skills', formatter: (v: any) => (v.skillRevisions || []).join(', ') },
          { key: 'resources', label: 'Resources', formatter: (v: any) => formatResourceBindings(v.resources) },
          { key: 'extensions', label: 'Extensions', formatter: (v: any) => (v.extensions || []).join(', ') },
          { key: 'createdAt', label: 'Created' },
        ];
        console.log(formatData([ver], displayFields, format));
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

version
  .command("create")
  .description("Create a new version of a profile")
  .requiredOption("-i, --id <id>", "Profile ID")
  .requiredOption("-w, --worker <type>", "Worker type")
  .requiredOption("-m, --model <model>", "Model name")
  .option("--agent-version <version>", "Agent version")
  .option("--mcp-servers <ids...>", "MCP server IDs")
  .option("--skills <refs...>", "Skill revision references")
  .option("--resources <specs...>", "Resource specs to preset (slug, slug@rN, or revision id)")
  .option("--resource-param <slug>:<KEY>=<VALUE>", "Resource parameter preset (repeatable); matches a --resources entry by slug", collectRepeatable, [])
  .option("--extensions <ids...>", "Extension IDs (publisher.name or publisher.name@version)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {
        workerType: options.worker,
        model: options.model,
      };
      if (options.agentVersion) body.agentVersion = options.agentVersion;
      if (options.mcpServers) body.mcpServers = options.mcpServers;
      if (options.skills) body.skillRevisions = options.skills;
      const resources = buildResourceBindingSpecs(options.resources, options.resourceParam);
      if (resources) body.resources = resources;
      if (options.extensions) body.extensions = options.extensions;

      const response = await apiFetch(options.url, `/profiles/${options.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json();
      console.log(successText(`Version v${result.version} created.`));
      console.log(`  ${label('ID:')} ${value(result._id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

} // end registerProfileCommands
