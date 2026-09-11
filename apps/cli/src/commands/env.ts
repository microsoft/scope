// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { EnvironmentStore, environmentKey, type ScopeEnvironment } from "../utils/environments.js";
import { selectedEnvironmentName } from "../utils/connection.js";
import { configureHelp } from "../utils/helpFormatter.js";
import { withOutputOption } from "../utils/shared.js";
import { formatData } from "../utils/formatters.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";

interface EnvironmentRow { name: string; active: boolean; url: string; project: string; token: string }
const fields: DisplayField<EnvironmentRow>[] = [
  { key: "name", label: "Name" }, { key: "active", label: "Active" },
  { key: "url", label: "URL" }, { key: "project", label: "Project" }, { key: "token", label: "Token" },
];

function row(environment: ScopeEnvironment, active?: string): EnvironmentRow {
  return { name: environment.name, active: environment.name === active, url: environment.url, project: environment.project ?? "", token: environment.token ? "[REDACTED]" : "" };
}

function selected(command: Command, store: EnvironmentStore): string {
  const name = selectedEnvironmentName(command, store);
  if (!name) throw new Error("No environment selected. Pass root --env <name> or run `scope env use <name>`.");
  return name;
}

export function registerEnvCommands(program: Command): void {
  const env = program.command("env").description("Manage named CLI connections (separate from process environment variables)");
  configureHelp(env);
  env.action(() => { env.help(); });
  env.command("add").argument("<name>").requiredOption("--url <url>", "Scope API URL")
    .option("--token <token>", "Optional Scope bearer token")
    .action((name: string, options: { url: string; token?: string }) => {
      new EnvironmentStore().add(name, options.url, options.token);
      console.log(`Environment "${name}" added. Select it with \`scope env use ${name}\`.`);
    });
  withOutputOption(env.command("list").description("List saved environments (tokens are redacted)"))
    .action((options: { output: OutputFormat }) => {
      const store = new EnvironmentStore();
      console.log(formatData(store.list().map((entry) => row(entry, store.active())), fields, options.output));
    });
  withOutputOption(env.command("show").argument("[name]").description("Show a named or selected environment (token redacted)"))
    .action((name: string | undefined, options: { output: OutputFormat }, command: Command) => {
      const store = new EnvironmentStore();
      console.log(formatData([row(store.read(name ?? selected(command, store)), store.active())], fields, options.output));
    });
  env.command("use").argument("[name]").option("--clear", "Clear selection and return to legacy configuration")
    .action((name: string | undefined, options: { clear?: boolean }) => {
      if (Boolean(name) === Boolean(options.clear)) throw new Error("Pass an environment name or --clear, not both.");
      new EnvironmentStore().use(name);
      console.log(name ? `Active environment: ${name}` : "Environment selection cleared; using legacy configuration.");
    });
  env.command("set").argument("<key>", "url, token, project, or the corresponding SCOPE_* key")
    .argument("[value]", "Value (omit to read from piped stdin)")
    .action((key: string, value: string | undefined, _options: unknown, command: Command) => {
      const store = new EnvironmentStore();
      const name = selected(command, store);
      const resolvedKey = environmentKey(key);
      if (value === undefined) {
        if (process.stdin.isTTY) throw new Error("Provide a value or pipe it on stdin (recommended for tokens).");
        value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
      }
      store.set(name, resolvedKey, value);
      console.log(`${resolvedKey} updated in "${name}".`);
    });
  env.command("unset").argument("<key>")
    .action((key: string, _options: unknown, command: Command) => {
      const store = new EnvironmentStore();
      const name = selected(command, store);
      store.set(name, environmentKey(key));
      console.log(`${environmentKey(key)} cleared in "${name}".`);
    });
  env.command("remove").argument("<name>").description("Remove an environment; clear selection if it was active")
    .action((name: string) => {
      new EnvironmentStore().remove(name);
      console.log(`Environment "${name}" removed.`);
    });
}
