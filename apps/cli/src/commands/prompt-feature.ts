// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { parse as yamlParse, parseAllDocuments, stringify as yamlStringify } from "yaml";
import { configureHelp } from "../utils/helpFormatter.js";
import { criterionIcon, dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { mapYamlCriterion } from "../utils/yaml-mappers.js";

export function registerPromptFeatureCommands(program: Command): void {
// ─── Prompt Feature management ───────────────────────────────────────────────

const promptFeature = program
  .command("prompt-feature")
  .description("Manage prompt features (CRUD, import, extract)")
  .action(() => {
    promptFeature.help();
  });

configureHelp(promptFeature);

withProjectOption(withOutputOption(
promptFeature
  .command("list")
  .description("List all prompt features")
  .option("-q, --query <search>", "Filter by ID or prompt text")
  .option("--type <type>", "Filter by feature type ('select' or 'agents.md')")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams();
      if (options.query) params.set("q", options.query);
      if (options.type) params.set("type", options.type);
      const qs = params.toString();
      const response = await apiFetch(options.url, `/prompt-features${qs ? `?${qs}` : ""}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{ id: string; prompt: string; type?: string }>;
      if (items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No prompt features found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} prompt features:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          tableFormatter: (f: any) => value(f.id),
        },
        { key: 'type', label: 'Type', formatter: (f: any) => f.type ?? 'select',
          tableFormatter: (f: any) => value(f.type ?? 'select') },
        { key: 'prompt', label: 'Prompt', formatter: (f: any) => {
          const prompt = f.prompt.replace(/\n/g, ' ');
          return prompt.length > 60 ? prompt.substring(0, 60) + '…' : prompt;
        }, tableFormatter: (f: any) => {
          const prompt = f.prompt.replace(/\n/g, ' ');
          const truncated = prompt.length > 60 ? prompt.substring(0, 60) + '…' : prompt;
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
promptFeature
  .command("get")
  .description("Get details of a single prompt feature")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/prompt-features/${options.id}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const f = await response.json() as {
        id: string; prompt: string;
        createdAt: string; updatedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'prompt', label: 'Prompt' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([f], fields, format));
        return;
      }

      console.log(`${label('ID:')}        ${value(f.id)}`);
      console.log(`${label('Prompt:')}`);
      for (const line of f.prompt.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      console.log(`${label('Created:')}   ${value(f.createdAt)}`);
      if (f.updatedAt) console.log(`${label('Updated:')}   ${value(f.updatedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("create")
  .description("Create a new prompt feature")
  .requiredOption("--id <id>", "Prompt feature ID (lowercase snake_case)")
  .requiredOption("--prompt <prompt>", "Detection prompt for the feature")
  .option("--type <type>", "Feature type ('select' default, or 'agents.md')")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {
        id: options.id,
        prompt: options.prompt,
      };
      if (options.type) body.type = options.type;

      const response = await apiFetch(options.url, `/prompt-features`, {
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
      console.log(`${successText('Created prompt feature')} ${value(created.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
promptFeature
  .command("update")
  .description("Update an existing prompt feature")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("--prompt <prompt>", "New detection prompt")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {};
      if (options.prompt !== undefined) body.prompt = options.prompt;

      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide --prompt"));
        process.exit(1);
      }

      const response = await apiFetch(options.url, `/prompt-features/${options.id}`, {
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

      console.log(`${successText('Updated prompt feature')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
promptFeature
  .command("delete")
  .description("Delete a prompt feature (soft-delete)")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/prompt-features/${options.id}`, {
        method: "DELETE",
        projectId,
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Deleted prompt feature')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("import")
  .description("Import prompt features from YAML file(s) into the database (upsert)")
  .argument("<path>", "Path to a .yaml file or a directory of .yaml files")
  .option("--dry-run", "Preview what would be imported without sending to API")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (inputPath: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
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

      const allFeatures: Array<{ id: string; prompt: string; dependsOn?: string[] }> = [];
      const parseErrors: string[] = [];

      for (const file of yamlFiles) {
        const content = readFileSync(file, 'utf-8');
        const fname = basename(file);

        try {
          const docs = parseAllDocuments(content);
          for (let docIdx = 0; docIdx < docs.length; docIdx++) {
            const doc = docs[docIdx].toJSON();
            if (!doc || typeof doc !== 'object') continue;

            // Reuse the same YAML mapping logic
            const feature = mapYamlCriterion(doc, fname, docIdx);
            if (feature) {
              allFeatures.push(feature);
            } else {
              parseErrors.push(`${fname}${docs.length > 1 ? ` (doc ${docIdx + 1})` : ''}: missing id or prompt`);
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

      if (allFeatures.length === 0) {
        console.error(errorText('No valid prompt features found to import.'));
        process.exit(1);
      }

      console.log(`\n${label('Parsed:')} ${value(String(allFeatures.length))} prompt features`);

      for (const f of allFeatures) {
        console.log(`  ${value(f.id)}`);
      }

      if (options.dryRun) {
        console.log(`\n${warnBanner('Dry run — no changes made.')}`);
        return;
      }

      console.log();
      const response = await apiFetch(options.url, `/prompt-features/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: allFeatures }),
        projectId,
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json() as { seeded: number; errors: string[] };
      console.log(`${successText('Seeded:')} ${value(String(result.seeded))} prompt features`);
      if (result.seeded < allFeatures.length) {
        console.log(`${dimTimestamp(`(${allFeatures.length - result.seeded} already existed — skipped)`)}`);
      }
      if (result.errors.length > 0) {
        console.log(`\n${warnBanner('Seed errors:')}`);
        for (const err of result.errors) {
          console.log(`  ${errorText('⚠')} ${err}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
promptFeature
  .command("extract")
  .description("Extract prompt features from a task text or scenario file (uses task prompt pipeline)")
  .option("-t, --task <text>", "Task text to analyze")
  .option("-s, --scenario <path>", "Path to scenario YAML file (uses its task text)")
  .option("--model <model>", "LLM model to use for extraction")
  .option("--force", "Force re-extraction even if already extracted")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      let taskText = options.task;

      if (!taskText && options.scenario) {
        const absPath = resolve(options.scenario);
        if (!existsSync(absPath)) {
          console.error(errorText(`Scenario file not found: ${absPath}`));
          process.exit(1);
        }
        const content = readFileSync(absPath, 'utf-8');
        const parsed = yamlParse(content);
        taskText = parsed?.task || parsed?.scenario?.task;
        if (!taskText) {
          console.error(errorText("Could not find 'task' field in scenario file"));
          process.exit(1);
        }
        if (!isMachineReadable(format)) console.log(`${label('Scenario:')} ${value(basename(absPath))}`);
      }

      if (!taskText) {
        console.error(errorText("Error: provide --task or --scenario"));
        process.exit(1);
      }

      // Step 1: Register task prompt (idempotent)
      if (!isMachineReadable(format)) console.log(`${label('Registering task prompt...')}`);
      const createResponse = await apiFetch(options.url, `/task-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: taskText }),
        projectId,
      });

      if (!createResponse.ok) {
        const error = await createResponse.json();
        console.error(errorText("Error creating task prompt:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const taskPromptDoc = await createResponse.json() as { _id: string };
      if (!isMachineReadable(format)) console.log(`${label('Task prompt ID:')} ${value(taskPromptDoc._id)}`);

      // Step 2: Extract features on the task prompt entity
      if (!isMachineReadable(format)) console.log(`${label('Extracting prompt features...')}`);

      const qs = options.force ? "?force=true" : "";
      const body: Record<string, unknown> = {};
      if (options.model) body.model = options.model;

      const response = await apiFetch(options.url, `/task-prompts/${encodeURIComponent(taskPromptDoc._id)}/extract-features${qs}`, {
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
        features: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        cached: boolean;
      };

      if (isMachineReadable(format)) {
        console.log(format === 'json' ? JSON.stringify(extraction, null, 2) : format === 'yaml' ? yamlStringify(extraction).trimEnd() : JSON.stringify(extraction));
        return;
      }

      if (extraction.cached) {
        console.log(dimTimestamp('(cached — use --force to re-extract)'));
      }

      const detected = extraction.features.filter(r => r.detected);
      const notDetected = extraction.features.filter(r => !r.detected && r.evaluated);
      const skipped = extraction.features.filter(r => !r.evaluated);

      console.log(`\n${label('Results:')}`);
      if (detected.length > 0) {
        console.log(`  ${successText('Detected:')}`);
        for (const r of detected) {
          console.log(`    ${criterionIcon(true, true)} ${value(r.featureId)}`);
        }
      }
      if (notDetected.length > 0) {
        console.log(`  ${dimTimestamp('Not detected:')}`);
        for (const r of notDetected) {
          console.log(`    ${criterionIcon(true, false)} ${dimTimestamp(r.featureId)}`);
        }
      }
      if (skipped.length > 0) {
        console.log(`  ${warnBanner('Skipped (not evaluated):')}`);
        for (const r of skipped) {
          console.log(`    ○ ${dimTimestamp(r.featureId)}`);
        }
      }

      console.log(`\n${label('Summary:')} ${value(String(detected.length))} detected, ${dimTimestamp(String(notDetected.length))} not detected, ${dimTimestamp(String(skipped.length))} skipped`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
