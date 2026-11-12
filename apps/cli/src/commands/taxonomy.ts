// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { configureHelp } from "../utils/helpFormatter.js";
import {
  getDefaultApiUrl,
  normalizeUrl,
  withProjectOption,
} from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { errorText, successText } from "../utils/style.js";

interface ApiError {
  error?: string;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${normalizeUrl(baseUrl)}/api/v1${path}`, init);
  const body = await responseBody(response);
  if (!response.ok) {
    const error = body as ApiError | undefined;
    throw new Error(error?.error ?? `HTTP ${response.status}`);
  }
  return body;
}

function projectPath(path: string, projectId: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function contentFromFile(path: string): unknown {
  return parseYaml(readFileSync(resolve(path), "utf8")) as unknown;
}

/** Registers API-backed taxonomy and taxonomy-element commands. */
export function registerTaxonomyCommands(program: Command): void {
  const taxonomy = program
    .command("taxonomy")
    .description("Manage Taxonome taxonomies and immutable revisions")
    .action(() => taxonomy.help());
  configureHelp(taxonomy);

  withProjectOption(
    taxonomy
      .command("list")
      .description("List project taxonomies")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    try {
      print(
        await request(
          options.url,
          projectPath("/taxonomies", requireProjectId(options.project)),
        ),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  withProjectOption(
    taxonomy
      .command("show")
      .description("Show taxonomy detail with exact ordered element revisions")
      .argument("<id>", "Taxonomy root database ID")
      .option("--revision <id>", "Exact taxonomy revision ID, ref, or number")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id, options) => {
      try {
        const detailPath = options.revision
          ? `/taxonomies/${encodeURIComponent(id)}/detail?revisionId=${encodeURIComponent(options.revision)}`
          : `/taxonomies/${encodeURIComponent(id)}/detail`;
        print(
          await request(
            options.url,
            projectPath(detailPath, requireProjectId(options.project)),
          ),
        );
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });

  withProjectOption(
    taxonomy
      .command("create")
      .description("Create a user taxonomy with revision 1")
      .requiredOption("--name <name>", "Display name")
      .requiredOption("--file <yaml>", "Portable taxonomy YAML")
      .option("--description <text>", "Description")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    try {
      const body = {
        name: options.name,
        ...(options.description ? { description: options.description } : {}),
        sourceType: "user",
        content: contentFromFile(options.file),
      };
      print(
        await request(
          options.url,
          projectPath("/taxonomies", requireProjectId(options.project)),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  withProjectOption(
    taxonomy
      .command("import")
      .description("Import taxonomy YAML and referenced element YAML")
      .requiredOption("--name <name>", "Display name")
      .requiredOption("--taxonomy <yaml>", "Taxonomy YAML path")
      .option(
        "--element <path=file>",
        "Map a manifest path to an element YAML file (repeatable)",
        (value, previous: string[]) => [...previous, value],
        [],
      )
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    try {
      const elements = Object.fromEntries(
        (options.element as string[]).map((mapping) => {
          const separator = mapping.indexOf("=");
          if (separator <= 0) throw new Error(`Invalid --element mapping '${mapping}'`);
          return [
            mapping.slice(0, separator),
            readFileSync(resolve(mapping.slice(separator + 1)), "utf8"),
          ];
        }),
      );
      print(
        await request(
          options.url,
          projectPath("/taxonomies/import", requireProjectId(options.project)),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: options.name,
              taxonomyYaml: readFileSync(resolve(options.taxonomy), "utf8"),
              elements,
            }),
          },
        ),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  taxonomy
    .command("revisions")
    .description("List immutable revisions")
    .argument("<id>", "Taxonomy root database ID")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id, options) => {
      try {
        print(
          await request(
            options.url,
            `/taxonomies/${encodeURIComponent(id)}/revisions`,
          ),
        );
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });

  taxonomy
    .command("revise")
    .description("Append an immutable user taxonomy revision")
    .argument("<id>", "Taxonomy root database ID")
    .requiredOption("--file <yaml>", "Portable taxonomy YAML")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id, options) => {
      try {
        print(
          await request(
            options.url,
            `/taxonomies/${encodeURIComponent(id)}/revisions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: contentFromFile(options.file) }),
            },
          ),
        );
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });

  withProjectOption(
    taxonomy
      .command("copy")
      .description("Copy an exact built-in revision to a user taxonomy")
      .argument("<revisionId>", "Built-in taxonomy revision database ID")
      .requiredOption("--name <name>", "New taxonomy name")
      .option("--id <businessId>", "Portable taxonomy business ID")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (revisionId, options) => {
    try {
      print(
        await request(
          options.url,
          projectPath(
            `/taxonomy-revisions/${encodeURIComponent(revisionId)}/copy`,
            requireProjectId(options.project),
          ),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: options.name,
              ...(options.id ? { id: options.id } : {}),
            }),
          },
        ),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  taxonomy
    .command("export")
    .description("Export an exact taxonomy revision as YAML")
    .argument("<revisionId>", "Taxonomy revision database ID")
    .requiredOption("-o, --output <path>", "Destination YAML file")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (revisionId, options) => {
      try {
        const response = await fetch(
          `${normalizeUrl(options.url)}/api/v1/taxonomy-revisions/${encodeURIComponent(revisionId)}/export`,
        );
        if (!response.ok) throw new Error(String(await responseBody(response)));
        writeFileSync(resolve(options.output), await response.text(), "utf8");
        console.log(successText(`Exported taxonomy revision to ${options.output}`));
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });

  for (const action of ["delete", "restore"] as const) {
    taxonomy
      .command(action)
      .description(`${action === "delete" ? "Soft-delete" : "Restore"} a user taxonomy`)
      .argument("<id>", "Taxonomy root database ID")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
      .action(async (id, options) => {
        try {
          const path =
            action === "delete"
              ? `/taxonomies/${encodeURIComponent(id)}`
              : `/taxonomies/${encodeURIComponent(id)}/restore`;
          const result = await request(options.url, path, {
            method: action === "delete" ? "DELETE" : "POST",
          });
          if (result !== undefined) print(result);
          else console.log(successText(`Taxonomy ${action}d.`));
        } catch (error) {
          console.error(errorText("Error:"), error instanceof Error ? error.message : error);
          process.exitCode = 1;
        }
      });
  }

  const element = taxonomy
    .command("element")
    .description("Manage taxonomy elements")
    .action(() => element.help());
  configureHelp(element);

  withProjectOption(
    element
      .command("list")
      .description("List project taxonomy elements")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    try {
      print(
        await request(
          options.url,
          projectPath(
            "/taxonomy-elements",
            requireProjectId(options.project),
          ),
        ),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  withProjectOption(
    element
      .command("create")
      .description("Create a user taxonomy element with revision 1")
      .requiredOption("--name <name>", "Display name")
      .requiredOption("--file <yaml>", "Portable element YAML")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options) => {
    try {
      print(
        await request(
          options.url,
          projectPath(
            "/taxonomy-elements",
            requireProjectId(options.project),
          ),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: options.name,
              sourceType: "user",
              content: contentFromFile(options.file),
            }),
          },
        ),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  element
    .command("revisions")
    .description("List immutable taxonomy element revisions")
    .argument("<id>", "Element root database ID")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id, options) => {
      try {
        print(
          await request(
            options.url,
            `/taxonomy-elements/${encodeURIComponent(id)}/revisions`,
          ),
        );
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });

  element
    .command("revise")
    .description("Append an immutable user element revision")
    .argument("<id>", "Element root database ID")
    .requiredOption("--file <yaml>", "Portable element YAML")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id, options) => {
      try {
        print(
          await request(
            options.url,
            `/taxonomy-elements/${encodeURIComponent(id)}/revisions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: contentFromFile(options.file) }),
            },
          ),
        );
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
}
