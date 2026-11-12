// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { parseAllDocuments } from "yaml";
import { configureHelp } from "../utils/helpFormatter.js";
import { dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { mapYamlReportTemplate } from "../utils/yaml-mappers.js";

export function registerReportTemplateCommands(program: Command): void {
// ─── Report Template management ──────────────────────────────────────────────

const reportTemplate = program
  .command("report-template")
  .description("Manage report templates (CRUD, import)")
  .action(() => {
    reportTemplate.help();
  });

configureHelp(reportTemplate);

reportTemplate
  .command("models")
  .description("List models available for report generation")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/report-templates/available-models`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const models = await response.json() as Array<{ modelId: string }>;
      if (models.length === 0) {
        console.log(warnBanner("No models available. Run the copilot model scanner first."));
        return;
      }
      console.log(label(`Available models for report generation:\n`));
      for (const m of models) {
        console.log(`  ${value(m.modelId)}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
reportTemplate
  .command("list")
  .description("List all report templates")
  .option("--subject <subject>", "Filter by subject: run or experiment")
  .option("--include-disabled", "Include disabled templates")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams();
      if (options.subject) params.set("subject", options.subject);
      if (options.includeDisabled) params.set("includeDisabled", "true");
      const response = await apiFetch(
        options.url,
        `/report-templates${params.size ? `?${params}` : ""}`,
        { projectId },
      );

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{
        id: string; name: string; description?: string;
        userPrompt: string; systemPrompt?: { mode: string; content: string };
        trigger?: { type: string; [k: string]: unknown };
        createdAt: string;
      }>;

      if (items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No report templates found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} report templates:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID', tableFormatter: (t: any) => value(t.id) },
        { key: 'name', label: 'Name' },
        { key: 'subject', label: 'Subject' },
        { key: 'enabled', label: 'Enabled' },
        { key: 'currentVersion', label: 'Version' },
        { key: 'trigger', label: 'Trigger', formatter: (t: any) => t.trigger?.type ?? 'always' },
        { key: 'systemPrompt', label: 'SysPrompt', formatter: (t: any) => t.systemPrompt ? t.systemPrompt.mode : '—' },
        { key: 'userPrompt', label: 'UserPrompt', formatter: (t: any) => {
          const p = t.userPrompt.replace(/\n/g, ' ');
          return p.length > 50 ? p.substring(0, 50) + '…' : p;
        }, tableFormatter: (t: any) => {
          const p = t.userPrompt.replace(/\n/g, ' ');
          const truncated = p.length > 50 ? p.substring(0, 50) + '…' : p;
          return dimTimestamp(truncated);
        }},
      ];

      console.log(formatData(items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
reportTemplate
  .command("get")
  .description("Get details of a single report template")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/report-templates/${options.id}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const t = await response.json() as {
        id: string; name: string; description?: string;
        userPrompt: string; systemPrompt?: { mode: string; content: string };
        trigger?: { type: string; [k: string]: unknown };
        createdAt: string; updatedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Description', formatter: (item: any) => item.description || '' },
          { key: 'trigger', label: 'Trigger', formatter: (item: any) => item.trigger?.type ?? 'always' },
          { key: 'userPrompt', label: 'User Prompt' },
          { key: 'systemPrompt', label: 'System Prompt', formatter: (item: any) => item.systemPrompt ? `${item.systemPrompt.mode}: ${item.systemPrompt.content}` : '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([t], fields, format));
        return;
      }

      console.log(`${label('ID:')}          ${value(t.id)}`);
      console.log(`${label('Name:')}        ${t.name}`);
      if (t.description) console.log(`${label('Description:')} ${t.description}`);
      console.log(`${label('Trigger:')}     ${value(t.trigger?.type ?? 'always')}`);
      if (t.trigger && t.trigger.type !== 'always') {
        console.log(`${label('Trigger cfg:')} ${dimTimestamp(JSON.stringify(t.trigger))}`);
      }
      console.log(`${label('User prompt:')}`);
      for (const line of t.userPrompt.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      if (t.systemPrompt) {
        console.log(`${label('Sys prompt:')}  ${value(t.systemPrompt.mode)}`);
        for (const line of t.systemPrompt.content.trim().split('\n')) {
          console.log(`  ${line}`);
        }
      }
      console.log(`${label('Created:')}     ${value(t.createdAt)}`);
      if (t.updatedAt) console.log(`${label('Updated:')}     ${value(t.updatedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
reportTemplate
  .command("versions")
  .description("List immutable versions of a report template")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("--version <versionId>", "Get one exact immutable version")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const suffix = options.version
        ? `/versions/${encodeURIComponent(options.version)}`
        : "/versions";
      const response = await apiFetch(
        options.url,
        `/report-templates/${encodeURIComponent(options.id)}${suffix}`,
        { projectId },
      );
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exitCode = 1;
        return;
      }
      const result = await response.json();
      const items = Array.isArray(result) ? result : [result];
      console.log(formatData(
        items,
        [
          { key: "_id", label: "Version ID" },
          { key: "version", label: "Version" },
          { key: "contentFingerprint", label: "Fingerprint" },
          { key: "createdAt", label: "Created" },
        ],
        (options.output || "table") as OutputFormat,
      ));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

reportTemplate
  .command("create")
  .description("Create a new report template")
  .requiredOption("--id <id>", "Template ID slug (lowercase, hyphens)")
  .requiredOption("--name <name>", "Display name for the template")
  .requiredOption("--user-prompt <prompt>", "User prompt (the instruction for the report agent)")
  .option("--subject <subject>", "Template subject: run or experiment", "run")
  .option("--disabled", "Create the template disabled")
  .option("--description <desc>", "Optional description")
  .option("--system-prompt-mode <mode>", "System prompt mode: append or override")
  .option("--system-prompt-content <content>", "System prompt content")
  .option("--model <model>", "LLM model to use for this template (overrides global REPORT_MODEL)")
  .option("--timeout-ms <ms>", "Session timeout in milliseconds (overrides global SESSION_TIMEOUT_MS)")
  .option("--trigger-type <type>", "Trigger type: always, criteria, taskPrompt, promptFeature, run-report-templates")
  .option("--trigger-ids <ids...>", "Trigger IDs (criteria IDs, task prompt IDs, or feature IDs)")
  .option("--trigger-match <match>", "Trigger match mode: any or all (default: all)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {
        id: options.id,
        name: options.name,
        userPrompt: options.userPrompt,
        subject: options.subject,
        enabled: !options.disabled,
      };
      if (options.description) body.description = options.description;
      if (options.model) body.model = options.model;
      if (options.timeoutMs) body.timeoutMs = Number(options.timeoutMs);
      if (options.systemPromptMode && options.systemPromptContent) {
        body.systemPrompt = {
          mode: options.systemPromptMode,
          content: options.systemPromptContent,
        };
      }
      if (options.triggerType) {
        const trigger: Record<string, unknown> = { type: options.triggerType };
        if (options.triggerType === 'criteria' && options.triggerIds) {
          trigger.criteriaIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        } else if (options.triggerType === 'taskPrompt' && options.triggerIds) {
          trigger.taskPromptIds = options.triggerIds;
        } else if (options.triggerType === 'promptFeature' && options.triggerIds) {
          trigger.featureIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        } else if (options.triggerType === 'run-report-templates' && options.triggerIds) {
          trigger.reportTemplateIds = options.triggerIds;
        }
        body.trigger = trigger;
      }

      const response = await apiFetch(options.url, `/report-templates`, {
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
      console.log(`${successText('Created report template')} ${value(created.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("update")
  .description("Update an existing report template")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("--name <name>", "New display name")
  .option("--description <desc>", "New description")
  .option("--user-prompt <prompt>", "New user prompt")
  .option("--system-prompt-mode <mode>", "System prompt mode: append or override")
  .option("--system-prompt-content <content>", "System prompt content")
  .option("--model <model>", "LLM model to use for this template (overrides global REPORT_MODEL)")
  .option("--timeout-ms <ms>", "Session timeout in milliseconds (overrides global SESSION_TIMEOUT_MS)")
  .option("--enabled <enabled>", "Enable or disable the template (true/false)")
  .option("--trigger-type <type>", "New trigger type: always, criteria, taskPrompt, promptFeature, run-report-templates")
  .option("--trigger-ids <ids...>", "Trigger IDs")
  .option("--trigger-match <match>", "Trigger match mode: any or all")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {};
      if (options.name !== undefined) body.name = options.name;
      if (options.description !== undefined) body.description = options.description;
      if (options.userPrompt !== undefined) body.userPrompt = options.userPrompt;
      if (options.model !== undefined) body.model = options.model;
      if (options.timeoutMs !== undefined) body.timeoutMs = Number(options.timeoutMs);
      if (options.enabled !== undefined) body.enabled = options.enabled === "true";
      if (options.systemPromptMode && options.systemPromptContent) {
        body.systemPrompt = {
          mode: options.systemPromptMode,
          content: options.systemPromptContent,
        };
      }
      if (options.triggerType) {
        const trigger: Record<string, unknown> = { type: options.triggerType };
        if (options.triggerType === 'criteria' && options.triggerIds) {
          trigger.criteriaIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        } else if (options.triggerType === 'taskPrompt' && options.triggerIds) {
          trigger.taskPromptIds = options.triggerIds;
        } else if (options.triggerType === 'promptFeature' && options.triggerIds) {
          trigger.featureIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        } else if (options.triggerType === 'run-report-templates' && options.triggerIds) {
          trigger.reportTemplateIds = options.triggerIds;
        }
        body.trigger = trigger;
      }

      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update"));
        process.exit(1);
      }

      const response = await apiFetch(options.url, `/report-templates/${options.id}`, {
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

      console.log(`${successText('Updated report template')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("delete")
  .description("Delete a report template (soft-delete)")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/report-templates/${options.id}`, {
        method: "DELETE",
        projectId,
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Deleted report template')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("import")
  .description("Import report templates from a YAML file (upsert via create/update)")
  .argument("<path>", "Path to a .yaml file or directory of .yaml files")
  .option("--dry-run", "Preview what would be imported without sending to API")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID that newly created templates are filed into (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (inputPath: string, options) => {
    try {
      const absPath = resolve(inputPath);
      if (!existsSync(absPath)) {
        console.error(errorText(`Path not found: ${absPath}`));
        process.exit(1);
      }

      let yamlFiles: string[];
      if (statSync(absPath).isDirectory()) {
        yamlFiles = readdirSync(absPath)
          .filter(f => extname(f) === '.yaml' || extname(f) === '.yml')
          .sort()
          .map(f => join(absPath, f));
        if (yamlFiles.length === 0) {
          console.error(errorText(`No .yaml files found in ${absPath}`));
          process.exit(1);
        }
        console.log(`${label('Directory:')} ${value(absPath)} (${yamlFiles.length} files)`);
      } else {
        yamlFiles = [absPath];
        console.log(`${label('File:')} ${value(absPath)}`);
      }

      const allTemplates: Array<Record<string, unknown>> = [];
      const parseErrors: string[] = [];

      for (const file of yamlFiles) {
        const content = readFileSync(file, 'utf-8');
        const fname = basename(file);

        try {
          const docs = parseAllDocuments(content);
          for (let docIdx = 0; docIdx < docs.length; docIdx++) {
            const doc = docs[docIdx].toJSON();
            if (!doc || typeof doc !== 'object') continue;

            const template = mapYamlReportTemplate(doc, fname, docIdx);
            if (template) {
              allTemplates.push(template);
            } else {
              parseErrors.push(`${fname}${docs.length > 1 ? ` (doc ${docIdx + 1})` : ''}: missing id, name, or user_prompt`);
            }
          }
        } catch (e) {
          parseErrors.push(`${fname}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (parseErrors.length > 0) {
        console.log(`\n${warnBanner('Parse warnings:')}`);
        for (const err of parseErrors) {
          console.log(`  ${errorText('⚠')} ${err}`);
        }
      }

      if (allTemplates.length === 0) {
        console.error(errorText('No valid report templates found to import.'));
        process.exit(1);
      }

      console.log(`\n${label('Parsed:')} ${value(String(allTemplates.length))} report templates`);
      for (const t of allTemplates) {
        const triggerStr = t.trigger ? ` ${dimTimestamp(`(trigger: ${(t.trigger as any).type})`)}` : '';
        console.log(`  ${value(t.id as string)} — ${t.name}${triggerStr}`);
      }

      if (options.dryRun) {
        console.log(`\n${warnBanner('Dry run — no changes made.')}`);
        return;
      }

      // Newly created templates are root creates and must be filed into a project.
      const projectId = requireProjectId(options.project);

      console.log();
      let created = 0;
      let updated = 0;
      const errors: string[] = [];

      for (const t of allTemplates) {
        const id = t.id as string;
        // Try to GET existing
        const getResp = await apiFetch(options.url, `/report-templates/${id}`, { projectId });
        if (getResp.ok) {
          // Update
          const { id: _id, ...updateBody } = t;
          const resp = await apiFetch(options.url, `/report-templates/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updateBody),
            projectId,
          });
          if (resp.ok) {
            updated++;
            console.log(`  ${dimTimestamp('updated')} ${value(id)}`);
          } else {
            const err = await resp.json();
            errors.push(`${id}: ${err.error || JSON.stringify(err)}`);
          }
        } else if (getResp.status === 404) {
          // Create
          const resp = await apiFetch(options.url, `/report-templates`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(t),
            projectId,
          });
          if (resp.ok) {
            created++;
            console.log(`  ${successText('created')} ${value(id)}`);
          } else {
            const err = await resp.json();
            errors.push(`${id}: ${err.error || JSON.stringify(err)}`);
          }
        } else {
          errors.push(`${id}: failed to check existence (status ${getResp.status})`);
        }
      }

      console.log(`\n${successText('Import complete:')} ${value(String(created))} created, ${value(String(updated))} updated`);
      if (errors.length > 0) {
        console.log(`\n${warnBanner('Errors:')}`);
        for (const err of errors) {
          console.log(`  ${errorText('⚠')} ${err}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
