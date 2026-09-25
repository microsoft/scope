// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerConfig } from "../types/mcp.js";

/**
 * `${VAR}` interpolation of resource connection details into MCP server config.
 *
 * A stored MCP server record stays static and reusable by referring to a
 * resource's published names rather than a concrete address:
 *
 *     url:     ${MCP_URL}
 *     headers: Authorization: Bearer ${SIM_TOKEN}
 *
 * **Ordering matters.** This must run *after* Token Manager secret hydration and
 * *before* registration with the gateway. Hydration replaces the whole `env` or
 * `headers` object rather than merging into it, so interpolating any earlier is
 * silently undone — which presents as "interpolation doesn't work" with nothing
 * in the logs to explain it.
 */

/** Thrown when a placeholder has no corresponding published value. */
export class UnresolvedPlaceholderError extends Error {
  readonly names: string[];
  readonly serverName: string;

  constructor(serverName: string, names: string[], available: string[]) {
    super(
      `MCP server '${serverName}' references ${names.map((n) => `\${${n}}`).join(", ")}, ` +
        `which no referenced resource published. ` +
        (available.length > 0
          ? `Available: ${available.join(", ")}.`
          : `No resource published any values.`),
    );
    this.name = "UnresolvedPlaceholderError";
    this.names = names;
    this.serverName = serverName;
  }
}

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Collect every placeholder name used in a string. */
function placeholdersIn(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * Substitute `${VAR}` in one string.
 *
 * Unknown names are left intact and reported via `missing` so the caller can
 * fail with every offending name at once rather than one per attempt.
 */
function substitute(value: string, values: Record<string, string>, missing: Set<string>): string {
  return value.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (name in values) return values[name];
    missing.add(name);
    return whole;
  });
}

/**
 * Interpolate published resource values into one MCP server config.
 *
 * Covers every field that can carry a connection detail, which differs by
 * transport:
 * - `stdio` — `command`, `args[]`, `env` values. The gateway launches the
 *   process with that env, so this is how e.g. `GITHUB_HOST` reaches it.
 * - `http`/`sse` — `url` and `headers[].value`.
 *
 * @throws {UnresolvedPlaceholderError} if any placeholder has no value. Failing
 * here is deliberate: a literal `${MCP_URL}` passed through to the gateway fails
 * much later as an opaque transport error.
 */
export function interpolateMcpServerConfig(
  config: McpServerConfig,
  values: Record<string, string>,
): McpServerConfig {
  const missing = new Set<string>();
  const sub = (v: string) => substitute(v, values, missing);

  const next: McpServerConfig = {
    ...config,
    ...(config.url !== undefined ? { url: sub(config.url) } : {}),
    ...(config.command !== undefined ? { command: sub(config.command) } : {}),
    ...(config.args !== undefined ? { args: config.args.map(sub) } : {}),
    ...(config.env !== undefined
      ? { env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, sub(v)])) }
      : {}),
    ...(config.headers !== undefined
      ? { headers: config.headers.map((h) => ({ ...h, value: sub(h.value) })) }
      : {}),
  };

  if (missing.size > 0) {
    throw new UnresolvedPlaceholderError(config.name, [...missing], Object.keys(values).sort());
  }
  return next;
}

/** Interpolate a whole set of MCP server configs. */
export function interpolateMcpServerConfigs(
  configs: McpServerConfig[],
  values: Record<string, string>,
): McpServerConfig[] {
  return configs.map((c) => interpolateMcpServerConfig(c, values));
}

/**
 * Every placeholder name referenced across a set of MCP server configs.
 *
 * Lets a caller check up front that referenced resources can satisfy them,
 * rather than discovering it only once the setup phases have already run.
 */
export function referencedPlaceholders(configs: McpServerConfig[]): string[] {
  const names = new Set<string>();
  for (const c of configs) {
    const strings = [
      c.url,
      c.command,
      ...(c.args ?? []),
      ...Object.values(c.env ?? {}),
      ...(c.headers ?? []).map((h) => h.value),
    ].filter((v): v is string => typeof v === "string");
    for (const s of strings) for (const n of placeholdersIn(s)) names.add(n);
  }
  return [...names].sort();
}
