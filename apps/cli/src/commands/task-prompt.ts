// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify as yamlStringify } from "yaml";
import { configureHelp } from "../utils/helpFormatter.js";
import { criterionIcon, dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { parsePromptTypeOption, type PromptType } from "../utils/gates.js";

export function registerTaskPromptCommands(program: Command): void {
// ─── Task Prompt management ─────────────────────────────────────────────────

const taskPrompt = program
  .command("task-prompt")
  .description("Manage task prompts (content-addressed, immutable prompt entities)")
  .action(() => {
    taskPrompt.help();
  });

configureHelp(taskPrompt);

withProjectOption(withOutputOption(
taskPrompt
  .command("list")
  .description("List all task prompts")
  .option("-s, --search <search>", "Filter by text content")
  .option("--type <type>", "Filter by prompt type/gate (select, build, test, run, deploy, agents.md)")
  .option("-l, --limit <n>", "Maximum number of results", "50")
  .option("--offset <n>", "Number of results to skip", "0")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams();
      if (options.search) params.set("search", options.search);
      const type = parsePromptTypeOption(options.type);
      if (type) params.set("type", type);
      if (options.limit) params.set("limit", options.limit);
      if (options.offset) params.set("offset", options.offset);
      const qs = params.toString();
      const response = await apiFetch(options.url, `/task-prompts${qs ? `?${qs}` : ""}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const data = await response.json() as { items: Array<{ _id: string; text: string; type?: PromptType; features?: Array<{ featureId: string; detected: boolean; evaluated: boolean }>; createdAt: string }>; total: number };
      if (data.items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No task prompts found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${data.items.length} of ${data.total} task prompts:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID',
          formatter: (tp: any) => tp._id.substring(0, 8) + '…',
          tableFormatter: (tp: any) => value(tp._id.substring(0, 8) + '…'),
        },
        { key: 'type', label: 'Type', formatter: (tp: any) => tp.type ?? 'select' },
        { key: 'text', label: 'Text', formatter: (tp: any) => {
          const text = (tp.text ?? '').replace(/\n/g, ' ');
          if (!text) return tp.contentBlobUrl ? '(blob)' : '';
          return text.length > 60 ? text.substring(0, 60) + '…' : text;
        }, tableFormatter: (tp: any) => {
          const text = (tp.text ?? '').replace(/\n/g, ' ');
          if (!text) return dimTimestamp(tp.contentBlobUrl ? '(blob)' : '');
          const truncated = text.length > 60 ? text.substring(0, 60) + '…' : text;
          return dimTimestamp(truncated);
        }},
        { key: 'features', label: 'Features', formatter: (tp: any) => {
          if (!tp.features) return '—';
          const detected = tp.features.filter((f: any) => f.detected).length;
          return `${detected}/${tp.features.length}`;
        }},
        { key: 'createdAt', label: 'Created', formatter: (tp: any) => tp.createdAt ? new Date(tp.createdAt).toLocaleDateString() : '—' },
      ];

      console.log(formatData(data.items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
taskPrompt
  .command("get")
  .description("Get details of a single task prompt")
  .requiredOption("-i, --id <id>", "Task prompt ID (UUID)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/task-prompts/${encodeURIComponent(options.id)}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const tp = await response.json() as {
        _id: string; text?: string; type?: PromptType; contentBlobUrl?: string;
        features?: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        featuresExtractedAt?: string;
        createdAt: string; deletedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'text', label: 'Text' },
          { key: 'type', label: 'Type', formatter: (item: any) => item.type ?? 'select' },
          { key: 'features', label: 'Features', formatter: (item: any) => {
            if (!item.features) return '(not extracted)';
            const detected = item.features.filter((f: any) => f.detected).length;
            return `${detected}/${item.features.length} detected`;
          }},
          { key: 'featuresExtractedAt', label: 'Extracted At' },
          { key: 'createdAt', label: 'Created' },
          { key: 'deletedAt', label: 'Deleted' },
        ];
        console.log(formatData([tp], fields, format));
        return;
      }

      console.log(`${label('ID:')}        ${value(tp._id)}`);
      console.log(`${label('Type:')}      ${value(tp.type ?? 'select')}`);
      console.log(`${label('Created:')}   ${value(tp.createdAt)}`);
      if (tp.deletedAt) console.log(`${label('Deleted:')}   ${value(tp.deletedAt)}`);
      console.log(`${label('Text:')}`);
      if (tp.text) {
        for (const line of tp.text.trim().split('\n')) {
          console.log(`  ${line}`);
        }
      } else {
        console.log(`  ${dimTimestamp('(stored in blob — fetch via /api/v1/task-prompts/:id/content)')}`);
      }

      if (tp.features && tp.features.length > 0) {
        const detected = tp.features.filter(f => f.detected);

        console.log(`\n${label('Features:')} ${value(String(detected.length))} detected`);
        if (tp.featuresExtractedAt) console.log(`${label('Extracted:')} ${value(tp.featuresExtractedAt)}`);

        if (detected.length > 0) {
          console.log(`  ${successText('Detected:')}`);
          for (const r of detected) {
            console.log(`    ${criterionIcon(true, true)} ${value(r.featureId)}`);
          }
        }
      } else {
        console.log(`\n${label('Features:')} ${dimTimestamp('(not extracted)')}`);
      }

      console.log(`\n${label('View runs:')} ${dimTimestamp(`scope run list --task-prompt-id ${tp._id}`)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

taskPrompt
  .command("create")
  .description("Register a task prompt (idempotent — same text returns existing entity)")
  .option("-t, --text <text>", "Task prompt text")
  .option("-f, --file <path>", "Read task prompt text from file")
  .option("--type <type>", "Prompt type/gate", "select")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      let text = options.text;
      if (!text && options.file) {
        const absPath = resolve(options.file);
        if (!existsSync(absPath)) {
          console.error(errorText(`File not found: ${absPath}`));
          process.exit(1);
        }
        text = readFileSync(absPath, 'utf-8');
      }
      if (!text) {
        console.error(errorText("Error: provide --text or --file"));
        process.exit(1);
      }

      const type = parsePromptTypeOption(options.type) ?? "select";
      const response = await apiFetch(options.url, `/task-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, type }),
        projectId,
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const tp = await response.json() as { _id: string; text?: string; type?: PromptType; createdAt: string };
      console.log(successText(`Task prompt registered.`));
      console.log(`${label('ID:')}      ${value(tp._id)}`);
      console.log(`${label('Type:')}    ${value(tp.type ?? type)}`);
      console.log(`${label('Created:')} ${value(tp.createdAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

taskPrompt
  .command("delete")
  .description("Soft-delete a task prompt")
  .requiredOption("-i, --id <id>", "Task prompt ID (UUID)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/task-prompts/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(successText(`Task prompt ${options.id} deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
taskPrompt
  .command("extract-features")
  .description("Extract prompt features for a task prompt")
  .requiredOption("-i, --id <id>", "Task prompt ID (UUID)")
  .option("--model <model>", "LLM model to use for extraction")
  .option("--force", "Force re-extraction even if already extracted")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      if (!isMachineReadable(format)) {
        console.log(`${label('Extracting prompt features for task prompt')} ${value(options.id)}${label('...')}`);
      }

      const qs = options.force ? "?force=true" : "";
      const body: Record<string, unknown> = {};
      if (options.model) body.model = options.model;

      const response = await apiFetch(options.url, `/task-prompts/${encodeURIComponent(options.id)}/extract-features${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const extraction = await response.json() as {
        taskPromptId: string;
        features: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        featuresExtractedAt: string;
        cached: boolean;
      };

      if (isMachineReadable(format)) {
        console.log(format === 'json' ? JSON.stringify(extraction, null, 2) : format === 'yaml' ? yamlStringify(extraction).trimEnd() : JSON.stringify(extraction));
        return;
      }

      const detected = extraction.features.filter(r => r.detected);

      if (extraction.cached) {
        console.log(dimTimestamp('(cached — use --force to re-extract)'));
      }

      console.log(`\n${label('Results:')}`);
      if (detected.length > 0) {
        console.log(`  ${successText('Detected:')}`);
        for (const r of detected) {
          console.log(`    ${criterionIcon(true, true)} ${value(r.featureId)}`);
        }
      } else {
        console.log(`  ${dimTimestamp('No features detected')}`);
      }

      console.log(`\n${label('Summary:')} ${value(String(detected.length))} detected`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
}
