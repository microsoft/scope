// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AsyncLocalStorage } from "node:async_hooks";
import { Command } from "commander";
import { EnvironmentStore, type ScopeEnvironment } from "./environments.js";

const connections = new AsyncLocalStorage<Readonly<ScopeEnvironment> | undefined>();

/** Return the named environment selected for the current command action, if any. */
export function currentEnvironment(): Readonly<ScopeEnvironment> | undefined {
  return connections.getStore();
}

/** Prefer the action-scoped named URL over the legacy URL passed by older commands. */
export function resolveApiUrl(legacyUrl: string | undefined): string | undefined {
  return currentEnvironment()?.url ?? legacyUrl;
}

/** Walk from a subcommand to the root program where global options live. */
export function rootCommand(command: Command): Command {
  while (command.parent) command = command.parent;
  return command;
}

/** Resolve the root --env selection, falling back to the saved active environment. */
export function selectedEnvironmentName(command: Command, store = new EnvironmentStore()): string | undefined {
  const root = rootCommand(command);
  // Never read optsWithGlobals(): MCP owns a distinct, variadic --env option.
  const flag: unknown = root.opts().env;
  return typeof flag === "string" ? flag : store.active();
}

/**
 * Resolve the named environment a command should run under.
 *
 * Commands with an explicit API selector keep legacy behavior, and `env` itself
 * must never be scoped by the environment it is editing.
 */
export function resolveCommandEnvironment(
  command: Command,
  store = new EnvironmentStore(),
): ScopeEnvironment | undefined {
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

  /** Wrap actions in AsyncLocalStorage so all async API calls share the selection. */
  override action(handler: Parameters<Command["action"]>[0]): this {
    return super.action(function (this: Command, ...args: unknown[]) {
      const environment = resolveCommandEnvironment(this);
      const scopedEnvironment = environment ? Object.freeze(environment) : undefined;
      return connections.run(scopedEnvironment, () => handler.apply(this, args));
    });
  }
}
