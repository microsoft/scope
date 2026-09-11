// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AsyncLocalStorage } from "node:async_hooks";
import { Command } from "commander";
import { EnvironmentStore, type ScopeEnvironment } from "./environments.js";

const connections = new AsyncLocalStorage<Readonly<ScopeEnvironment> | undefined>();

export function currentEnvironment(): Readonly<ScopeEnvironment> | undefined {
  return connections.getStore();
}

export function resolveApiUrl(legacyUrl: string): string {
  return currentEnvironment()?.url ?? legacyUrl;
}

export function rootCommand(command: Command): Command {
  while (command.parent) command = command.parent;
  return command;
}

export function selectedEnvironmentName(command: Command, store = new EnvironmentStore()): string | undefined {
  const root = rootCommand(command);
  // Never read optsWithGlobals(): MCP owns a distinct, variadic --env option.
  const flag: unknown = root.opts().env;
  return typeof flag === "string" ? flag : store.active();
}

export function resolveCommandEnvironment(command: Command, store = new EnvironmentStore()): ScopeEnvironment | undefined {
  let group = command;
  while (group.parent?.parent) group = group.parent;
  if (group.name() === "env" || group.name() === "update" || command === rootCommand(command)) return undefined;

  // The caller owns its API selector. In MCP create/update --url is a resource
  // property; only -u/--api-url selects the Scope API. Defaults are not explicit.
  const apiOption = command.options.find((option) =>
    option.short === "-u" && (option.long === "--url" || option.long === "--api-url"),
  );
  if (apiOption && command.getOptionValueSource(apiOption.attributeName()) === "cli") return undefined;
  const name = selectedEnvironmentName(command, store);
  return name ? store.read(name) : undefined;
}

/**
 * Each action runs in its own immutable connection scope. Async descendants
 * (polling, retries, downloads and SSE callbacks) retain it after action return;
 * neither process.env nor another invocation's selection can change it.
 */
export class ScopeCommand extends Command {
  constructor(name?: string) {
    super(name);
    // Stop each group's option parser at its subcommand so MCP's --env is
    // consumed by MCP, not by the root named-environment selector.
    this.enablePositionalOptions();
  }

  override createCommand(name?: string): Command {
    return new ScopeCommand(name);
  }

  override action(handler: Parameters<Command["action"]>[0]): this {
    return super.action(function (this: Command, ...args: unknown[]) {
      const environment = resolveCommandEnvironment(this);
      return connections.run(environment ? Object.freeze(environment) : undefined, () => handler.apply(this, args));
    });
  }
}
