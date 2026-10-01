// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { parseAllDocuments, stringify as yamlStringify } from "yaml";
import { configureHelp } from "../utils/helpFormatter.js";
import { dimTimestamp, errorText, successText, label, value, warnBanner, styleText } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { mapYamlCriterion } from "../utils/yaml-mappers.js";
import { formatGateList, parseGateListOption, type GateId } from "../utils/gates.js";

export function registerCriteriaCommands(program: Command): void {
// ─── Criteria management ─────────────────────────────────────────────────────

const criteria = program
  .command("criteria")
  .description("Manage evaluation criteria (CRUD, import, graph)")
  .action(() => {
    criteria.help();
  });

configureHelp(criteria);

withProjectOption(withOutputOption(
criteria
  .command("list")
  .description("List all criteria")
  .option("-q, --query <search>", "Filter by ID or prompt text")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams();
      if (options.query) params.set("q", options.query);
      const qs = params.toString();
      const response = await apiFetch(options.url, `/criteria${qs ? `?${qs}` : ""}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{ id: string; prompt: string; dependsOn?: string[]; gates?: GateId[] }>;
      if (items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No criteria found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} criteria:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          tableFormatter: (c: any) => value(c.id),
        },
        { key: 'dependsOn', label: 'Deps', formatter: (c: any) => String((c.dependsOn ?? []).length) },
        { key: 'gates', label: 'Gates', formatter: (c: any) => formatGateList(c.gates) },
        { key: 'prompt', label: 'Prompt', tableFormatter: (c: any) => {
          const prompt = c.prompt.replace(/\n/g, ' ');
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
criteria
  .command("get")
  .description("Get details of a single criterion")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/criteria/${options.id}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const c = await response.json() as {
        id: string; prompt: string; dependsOn?: string[]; gates?: GateId[];
        dependents: string[]; createdAt: string; updatedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'prompt', label: 'Prompt' },
          { key: 'dependsOn', label: 'Depends On', formatter: (item: any) => (item.dependsOn ?? []).join(', ') || '(none)' },
          { key: 'gates', label: 'Gates', formatter: (item: any) => formatGateList(item.gates) },
          { key: 'dependents', label: 'Dependents', formatter: (item: any) => (item.dependents ?? []).join(', ') || '(none)' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([c], fields, format));
        return;
      }

      console.log(`${label('ID:')}        ${value(c.id)}`);
      console.log(`${label('Prompt:')}`);
      for (const line of c.prompt.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      if ((c.dependsOn ?? []).length > 0) {
        console.log(`${label('Depends on:')} ${c.dependsOn!.map(d => value(d)).join(', ')}`);
      } else {
        console.log(`${label('Depends on:')} ${dimTimestamp('(none — root criterion)')}`);
      }
      console.log(`${label('Gates:')}      ${value(formatGateList(c.gates))}`);
      if (c.dependents.length > 0) {
        console.log(`${label('Dependents:')} ${c.dependents.map(d => value(d)).join(', ')}`);
      }
      console.log(`${label('Created:')}   ${value(c.createdAt)}`);
      if (c.updatedAt) console.log(`${label('Updated:')}   ${value(c.updatedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("create")
  .description("Create a new criterion")
  .requiredOption("--id <id>", "Criterion ID (lowercase snake_case)")
  .requiredOption("--prompt <prompt>", "Evaluation prompt for the judge")
  .option("-d, --depends-on <ids...>", "IDs of parent criteria")
  .option("--gates <gates...>", "Compatible gates (space/comma separated), or all/* for unrestricted")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {
        id: options.id,
        prompt: options.prompt,
      };
      if (options.dependsOn && options.dependsOn.length > 0) {
        body.dependsOn = options.dependsOn;
      }
      const gates = parseGateListOption(options.gates);
      if (gates !== undefined) body.gates = gates;

      const response = await apiFetch(options.url, `/criteria`, {
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
      console.log(`${successText('Created criterion')} ${value(created.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
criteria
  .command("update")
  .description("Update an existing criterion")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("--prompt <prompt>", "New evaluation prompt")
  .option("-d, --depends-on <ids...>", "New parent criteria IDs (replaces all)")
  .option("--gates <gates...>", "New compatible gates (space/comma separated), or all/* for unrestricted")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {};
      if (options.prompt !== undefined) body.prompt = options.prompt;
      if (options.dependsOn !== undefined) body.dependsOn = options.dependsOn;
      const gates = parseGateListOption(options.gates);
      if (gates !== undefined) body.gates = gates;

      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide --prompt, --depends-on, and/or --gates"));
        process.exit(1);
      }

      const response = await apiFetch(options.url, `/criteria/${options.id}`, {
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

      console.log(`${successText('Updated criterion')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
criteria
  .command("delete")
  .description("Delete a criterion (soft-delete; fails if other criteria depend on it)")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/criteria/${options.id}`, {
        method: "DELETE",
        projectId,
      });

      if (!response.ok) {
        const error = await response.json();
        if (error.dependents) {
          console.error(errorText(`Cannot delete '${options.id}': depended on by ${error.dependents.join(', ')}`));
        } else {
          console.error(errorText("Error:"), error.error || JSON.stringify(error));
        }
        process.exit(1);
      }

      console.log(`${successText('Deleted criterion')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
criteria
  .command("graph")
  .description("Display the criteria dependency graph as ASCII")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/criteria/graph`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const graph = await response.json() as {
        nodes: Array<{ id: string; prompt: string; dependsOn: string[] }>;
        edges: Array<{ source: string; target: string }>;
      };

      if (isMachineReadable(format)) {
        console.log(format === 'json' ? JSON.stringify(graph, null, 2) : format === 'yaml' ? yamlStringify(graph).trimEnd() : JSON.stringify(graph));
        return;
      }

      if (graph.nodes.length === 0) {
        console.log(warnBanner("No criteria in the graph."));
        return;
      }

      console.log(label(`Criteria DAG — ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`));

      // Topological layering (Kahn's algorithm)
      const inDegree = new Map<string, number>();
      const children = new Map<string, string[]>();
      for (const n of graph.nodes) {
        inDegree.set(n.id, 0);
        children.set(n.id, []);
      }
      for (const e of graph.edges) {
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
        children.get(e.source)?.push(e.target);
      }

      const layers: string[][] = [];
      let queue = graph.nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
      while (queue.length > 0) {
        layers.push([...queue]);
        const next: string[] = [];
        for (const id of queue) {
          for (const child of children.get(id) ?? []) {
            const deg = (inDegree.get(child) ?? 1) - 1;
            inDegree.set(child, deg);
            if (deg === 0) next.push(child);
          }
        }
        queue = next;
      }

      // Render layers
      for (let i = 0; i < layers.length; i++) {
        const layerNodes = layers[i];
        const row = layerNodes.map(id => value(id)).join('  ');
        console.log(`  ${dimTimestamp(`Layer ${i}:`)}  ${row}`);
      }

      // Show edges
      if (graph.edges.length > 0) {
        console.log(`\n  ${label('Edges:')}`);
        for (const e of graph.edges) {
          console.log(`    ${value(e.source)} ${styleText('gray', '→')} ${value(e.target)}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("export")
  .description("Export criteria as import-compatible multi-document YAML")
  .option("--ids <ids...>", "Export only these criteria and their dependency ancestors")
  .option("-o, --output-file <path>", "Write to file instead of stdout")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      // Build query params for server-side filtering
      const params = new URLSearchParams();
      if (options.ids && options.ids.length > 0) {
        params.set("ids", options.ids.join(","));
        params.set("ancestors", "true");
      }
      const qs = params.toString();
      const response = await apiFetch(options.url, `/criteria${qs ? `?${qs}` : ""}`, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{ id: string; prompt: string; dependsOn?: string[] }>;

      if (items.length === 0) {
        console.error(errorText("No criteria found to export."));
        process.exit(1);
      }

      // Topological sort: parents before children
      const byId = new Map(items.map(c => [c.id, c]));
      const sorted: typeof items = [];
      const visited = new Set<string>();

      const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const c = byId.get(id);
        if (!c) return;
        for (const dep of c.dependsOn ?? []) {
          visit(dep);
        }
        sorted.push(c);
      };

      for (const c of items) {
        visit(c.id);
      }

      // Format as multi-document YAML with snake_case field names
      const docs = sorted.map(c => {
        const doc: Record<string, unknown> = {
          id: c.id,
          prompt: c.prompt,
        };
        if (c.dependsOn && c.dependsOn.length > 0) {
          doc.depends_on = c.dependsOn;
        }
        return doc;
      });

      const yamlOutput = docs
        .map(doc => yamlStringify(doc, { lineWidth: 0 }).trimEnd())
        .join('\n---\n');

      if (options.outputFile) {
        const outputPath = resolve(process.env.INIT_CWD || process.cwd(), options.outputFile);
        writeFileSync(outputPath, yamlOutput + '\n', 'utf-8');
        console.error(`${successText('Exported')} ${value(String(sorted.length))} criteria to ${value(options.outputFile)}`);
      } else {
        process.stdout.write(yamlOutput + '\n');
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("import")
  .description("Import criteria from YAML file(s) into the database (upsert — won't overwrite existing)")
  .argument("<path>", "Path to a .yaml file or a directory of .yaml files")
  .option("--dry-run", "Preview what would be imported without sending to API")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (inputPath: string, options) => {
    try {
      const absPath = resolve(process.env.INIT_CWD || process.cwd(), inputPath);
      if (!existsSync(absPath)) {
        console.error(errorText(`Path not found: ${absPath}`));
        process.exit(1);
      }

      // Collect YAML files
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

      // Parse all criteria from files (supports multi-document YAML)
      const allCriteria: Array<{ id: string; prompt: string; dependsOn?: string[]; gates?: GateId[] }> = [];
      const parseErrors: string[] = [];

      for (const file of yamlFiles) {
        const content = readFileSync(file, 'utf-8');
        const fname = basename(file);

        try {
          // Try multi-document parse first (handles --- separators)
          const docs = parseAllDocuments(content);
          for (let docIdx = 0; docIdx < docs.length; docIdx++) {
            const doc = docs[docIdx].toJSON();
            if (!doc || typeof doc !== 'object') continue;

            const criterion = mapYamlCriterion(doc, fname, docIdx, { includeGates: true });
            if (criterion) {
              allCriteria.push(criterion);
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

      if (allCriteria.length === 0) {
        console.error(errorText('No valid criteria found to import.'));
        process.exit(1);
      }

      console.log(`\n${label('Parsed:')} ${value(String(allCriteria.length))} criteria`);

      // Show preview
      for (const c of allCriteria) {
        const deps = (c.dependsOn ?? []).length;
        const depsStr = deps > 0 ? ` ${dimTimestamp(`(${deps} dep${deps > 1 ? 's' : ''})`)}` : '';
        const gatesStr = c.gates ? ` ${dimTimestamp(`[${formatGateList(c.gates)}]`)}` : '';
        console.log(`  ${value(c.id)}${depsStr}${gatesStr}`);
      }

      if (options.dryRun) {
        console.log(`\n${warnBanner('Dry run — no changes made.')}`);
        return;
      }

      // Seed via API
      console.log();
      const response = await apiFetch(options.url, `/criteria/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: allCriteria }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json() as { seeded: number; errors: string[] };
      console.log(`${successText('Seeded:')} ${value(String(result.seeded))} criteria`);
      if (result.seeded < allCriteria.length) {
        console.log(`${dimTimestamp(`(${allCriteria.length - result.seeded} already existed — skipped)`)}`);
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

}
