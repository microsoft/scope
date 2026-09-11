// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "dotenv";

export interface ScopeEnvironment {
  name: string;
  url: string;
  token?: string;
  project?: string;
}

export type EnvironmentKey = "SCOPE_API_URL" | "SCOPE_TOKEN" | "SCOPE_PROJECT";

export function environmentConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "scope");
  return join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config"), "scope");
}

export function environmentKey(key: string): EnvironmentKey {
  const aliases: Record<string, EnvironmentKey> = {
    url: "SCOPE_API_URL", token: "SCOPE_TOKEN", project: "SCOPE_PROJECT",
    SCOPE_API_URL: "SCOPE_API_URL", SCOPE_TOKEN: "SCOPE_TOKEN", SCOPE_PROJECT: "SCOPE_PROJECT",
  };
  const resolved = aliases[key];
  if (!resolved) throw new Error("Unknown environment key. Use url, token, project, or their SCOPE_* names.");
  return resolved;
}

function validateName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) {
    throw new Error("Environment names must be 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit (not a reserved filename).");
  }
}

function validateUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Environment URL must be an absolute http:// or https:// URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Environment URL must use HTTP(S), without embedded credentials, a query or a fragment.");
  }
  return value.replace(/\/+$/, "");
}

function quote(value: string): string {
  // dotenv does not implement JSON escaping. Pick a delimiter absent from the
  // value and verify the round-trip, rather than silently changing credentials.
  for (const delimiter of ["'", '"', "`"]) {
    if (value.includes(delimiter)) continue;
    const quoted = `${delimiter}${value}${delimiter}`;
    if (parse(`VALUE=${quoted}`).VALUE === value) return quoted;
  }
  throw new Error("Value cannot be represented safely in a dotenv file.");
}

export class EnvironmentStore {
  constructor(readonly directory = environmentConfigDir()) {}

  private file(name: string): string {
    validateName(name);
    return join(this.directory, "environments", `${name}.env`);
  }

  private writePrivate(file: string, content: string, directory = this.directory): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staging = `${file}.${randomUUID()}.new`;
    try {
      writeFileSync(staging, content, { flag: "wx", mode: 0o600 });
      renameSync(staging, file);
      if (process.platform !== "win32") chmodSync(file, 0o600);
    } finally {
      rmSync(staging, { force: true });
    }
  }

  active(): string | undefined {
    const file = join(this.directory, "active-environment");
    if (!existsSync(file)) return undefined;
    const name = readFileSync(file, "utf8").trim();
    if (!name) return undefined;
    validateName(name);
    return name;
  }

  use(name?: string): void {
    const file = join(this.directory, "active-environment");
    if (name === undefined) {
      rmSync(file, { force: true });
      return;
    }
    this.read(name);
    this.writePrivate(file, `${name}\n`);
  }

  private values(name: string): Record<string, string> {
    const file = this.file(name);
    if (!existsSync(file)) throw new Error(`Environment "${name}" does not exist. Add it with \`scope env add ${name} --url <url>\`.`);
    return parse(readFileSync(file, "utf8"));
  }

  read(name: string): ScopeEnvironment {
    const values = this.values(name);
    if (!values.SCOPE_API_URL) throw new Error(`Environment "${name}" has no SCOPE_API_URL. Set it with \`scope --env ${name} env set url <url>\`.`);
    return {
      name,
      url: validateUrl(values.SCOPE_API_URL),
      ...(values.SCOPE_TOKEN ? { token: values.SCOPE_TOKEN } : {}),
      ...(values.SCOPE_PROJECT?.trim() ? { project: values.SCOPE_PROJECT.trim() } : {}),
    };
  }

  list(): ScopeEnvironment[] {
    const directory = join(this.directory, "environments");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((file) => file.endsWith(".env")).sort().map((file) => this.read(file.slice(0, -4)));
  }

  add(name: string, url: string, token?: string): void {
    if (existsSync(this.file(name))) throw new Error(`Environment "${name}" already exists. Use \`scope --env ${name} env set\` to edit it.`);
    this.save({ name, url: validateUrl(url), token });
  }

  private save(environment: ScopeEnvironment): void {
    const entries: [EnvironmentKey, string | undefined][] = [
      ["SCOPE_API_URL", validateUrl(environment.url)],
      ["SCOPE_TOKEN", environment.token],
      ["SCOPE_PROJECT", environment.project],
    ];
    if (entries.some(([, value]) => value !== undefined && /[\0\r\n]/.test(value))) {
      throw new Error("Environment values must be single-line strings.");
    }
    const content = entries.filter((entry): entry is [EnvironmentKey, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${quote(value)}\n`).join("");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.writePrivate(this.file(environment.name), content, join(this.directory, "environments"));
  }

  set(name: string, key: EnvironmentKey, value?: string): void {
    if (value?.includes("\0") || value?.includes("\n") || value?.includes("\r")) throw new Error("Environment values must be single-line strings.");
    const values = this.values(name);
    const environment: ScopeEnvironment = {
      name, url: values.SCOPE_API_URL ?? "", token: values.SCOPE_TOKEN, project: values.SCOPE_PROJECT,
    };
    if (key === "SCOPE_API_URL") {
      if (!value) throw new Error("An environment requires its URL. Remove the environment instead of unsetting its URL.");
      environment.url = validateUrl(value);
    } else if (key === "SCOPE_TOKEN") {
      environment.token = value || undefined;
    } else {
      environment.project = value?.trim() || undefined;
    }
    this.save(environment);
  }

  remove(name: string): void {
    const file = this.file(name);
    if (!existsSync(file)) throw new Error(`Environment "${name}" does not exist.`);
    if (this.active() === name) this.use(undefined);
    rmSync(file);
  }
}
