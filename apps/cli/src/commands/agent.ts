// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { configureHelp } from "../utils/helpFormatter.js";
import { dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, getDefaultApiUrl } from "../utils/shared.js";
import { apiFetch } from "../utils/api-client.js";
import { registerAgentSetupCommands } from "./agent-setup.js";

export function registerAgentCommands(program: Command): void {
// ─── Agent management ────────────────────────────────────────────────────────

const agent = program
  .command("agent")
  .description("Manage coding agent definitions and their supported models")
  .action(() => {
    agent.help();
  });

configureHelp(agent);
registerAgentSetupCommands(agent);

withOutputOption(
agent
  .command("list")
  .description("List all coding agents")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/agents`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agents = await response.json() as Array<{ _id: string; name: string; supportedModels: string[]; defaultModel?: string }>;
      if (agents.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No agents found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${agents.length} agents:\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (a: any) => value(a._id) },
        { key: 'name', label: 'Name' },
        { key: 'supportedModels', label: 'Models', formatter: (a: any) => (a.supportedModels || []).join(', ') || '—' },
        { key: 'defaultModel', label: 'Default', formatter: (a: any) => a.defaultModel || '—' },
      ];
      console.log(formatData(agents, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
agent
  .command("get")
  .description("Get details of a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Description', formatter: (a: any) => a.description || '' },
          { key: 'supportedModels', label: 'Supported Models', formatter: (a: any) => (a.supportedModels || []).join(', ') },
          { key: 'defaultModel', label: 'Default Model', formatter: (a: any) => a.defaultModel || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([agentDoc], fields, format));
        return;
      }

      console.log(`${label('ID:')} ${value(agentDoc._id)}`);
      console.log(`${label('Name:')} ${value(agentDoc.name)}`);
      if (agentDoc.description) console.log(`${label('Description:')} ${agentDoc.description}`);
      console.log(`${label('Supported Models:')} ${(agentDoc.supportedModels || []).join(', ') || '(none)'}`);
      console.log(`${label('Default Model:')} ${agentDoc.defaultModel || '(none)'}`);
      console.log(`${label('Created:')} ${new Date(agentDoc.createdAt).toLocaleString()}`);
      if (agentDoc.updatedAt) console.log(`${label('Updated:')} ${new Date(agentDoc.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agent
  .command("update")
  .description("Update a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("--name <name>", "Display name")
  .option("--description <desc>", "Description")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update (--name, --description)"));
        process.exit(1);
      }
      const response = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`Agent ${updated._id} updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agent
  .command("delete")
  .description("Delete a coding agent (soft-delete)")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Agent ${options.id} deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Agent model sub-commands ────────────────────────────────────────────────

const agentModel = agent
  .command("model")
  .description("Manage supported models for a coding agent")
  .action(() => {
    agentModel.help();
  });

configureHelp(agentModel);

withOutputOption(
agentModel
  .command("list")
  .description("List supported models for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await response.json();
      const models = (agentDoc.supportedModels || []) as string[];
      if (models.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner(`Agent ${agentDoc._id} has no supported models.`));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Models for ${agentDoc._id}:\n`));
      }
      const items = models.map((m: string) => ({ model: m, default: m === agentDoc.defaultModel ? '✓' : '' }));
      const displayFields: DisplayField[] = [
        { key: 'model', label: 'Model', tableFormatter: (r: any) => value(r.model) },
        { key: 'default', label: 'Default' },
      ];
      console.log(formatData(items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agentModel
  .command("add")
  .description("Add a supported model to a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .requiredOption("--model <model>", "Model name to add")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      // Fetch current agent
      const getResp = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`);
      if (!getResp.ok) {
        const error = await getResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await getResp.json();
      const models: string[] = agentDoc.supportedModels || [];
      if (models.includes(options.model)) {
        console.log(warnBanner(`Model ${options.model} is already supported by ${agentDoc._id}.`));
        return;
      }
      models.push(options.model);
      const putResp = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supportedModels: models }),
      });
      if (!putResp.ok) {
        const error = await putResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Model ${options.model} added to ${agentDoc._id}.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agentModel
  .command("remove")
  .description("Remove a supported model from a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .requiredOption("--model <model>", "Model name to remove")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const getResp = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`);
      if (!getResp.ok) {
        const error = await getResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await getResp.json();
      const models: string[] = agentDoc.supportedModels || [];
      const idx = models.indexOf(options.model);
      if (idx === -1) {
        console.log(warnBanner(`Model ${options.model} is not supported by ${agentDoc._id}.`));
        return;
      }
      models.splice(idx, 1);
      const body: Record<string, unknown> = { supportedModels: models };
      // If removed model was the default, clear defaultModel
      if (agentDoc.defaultModel === options.model) {
        body.defaultModel = null;
      }
      const putResp = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!putResp.ok) {
        const error = await putResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Model ${options.model} removed from ${agentDoc._id}.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agentModel
  .command("set-default")
  .description("Set the default model for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .requiredOption("--model <model>", "Model name to set as default")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      // Verify the model is supported
      const getResp = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`);
      if (!getResp.ok) {
        const error = await getResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await getResp.json();
      const models: string[] = agentDoc.supportedModels || [];
      if (!models.includes(options.model)) {
        console.error(errorText(`Error: model ${options.model} is not in the supported models for ${agentDoc._id}. Add it first with: agent model add -i ${agentDoc._id} --model ${options.model}`));
        process.exit(1);
      }
      const putResp = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: options.model }),
      });
      if (!putResp.ok) {
        const error = await putResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Default model for ${agentDoc._id} set to ${options.model}.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Agent version sub-commands ──────────────────────────────────────────────

const agentVersion = agent
  .command("version")
  .description("Manage agent versions")
  .action(() => {
    agentVersion.help();
  });

configureHelp(agentVersion);

withOutputOption(
agentVersion
  .command("list")
  .description("List versions for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("--status <status>", "Filter by status (active, retired)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = options.status ? `?status=${encodeURIComponent(options.status)}` : '';
      const response = await apiFetch(options.url, `/agents/${encodeURIComponent(options.id)}/versions${params}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const versions = await response.json() as Array<{
        agentVersion: string;
        workerVersion: string;
        components: Record<string, string>;
        queueName: string;
        status: string;
        createdAt: string;
      }>;
      if (versions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner(`No versions found for agent ${options.id}.`));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`${versions.length} version(s) for ${options.id}:\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'agentVersion', label: 'Version', tableFormatter: (v: any) => value(v.agentVersion) },
        { key: 'status', label: 'Status', formatter: (v: any) => v.status },
        { key: 'components', label: 'Components', formatter: (v: any) => Object.entries(v.components || {}).map(([k, val]) => `${k}=${val}`).join(', ') },
        { key: 'queueName', label: 'Queue' },
        { key: 'createdAt', label: 'Created', formatter: (v: any) => new Date(v.createdAt).toLocaleString() },
      ];
      console.log(formatData(versions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
