#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn, spawnSync, execSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";

export const DOCKER_IMAGE = "mongo:4.2";
export const EXPECTED_SUBSCRIPTION_ID = "f7de4384-8753-4910-95d7-650b9d23cb6f";

export type EnvName = "int2" | "int" | "prod";
export type Runner = "native" | "docker" | "kubectl";

export class CosmosCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CosmosCliError";
  }
}

export interface PresetOverrides {
  account?: string;
  resourceGroup?: string;
  database?: string;
}

export interface ResolvedPreset {
  env: string;
  account: string;
  resourceGroup: string;
  database: string;
}

const PRESETS: Record<EnvName, { account: string; resourceGroup: string }> = {
  int2: { account: "db-scope-v2-int2", resourceGroup: "rg-scope-v2-int2" },
  int: { account: "db-scope-v2-int", resourceGroup: "rg-scope-v2-int" },
  prod: { account: "db-scope-v2-prd", resourceGroup: "rg-scope-v2-prd" },
};

export function resolvePreset(env: string, overrides: PresetOverrides = {}): ResolvedPreset {
  if (env !== "int2" && env !== "int" && env !== "prod") {
    throw new CosmosCliError(`unknown --env '${env}' (expected int2 | int | prod)`, 2);
  }
  const preset = PRESETS[env];
  return {
    env,
    account: overrides.account || preset.account,
    resourceGroup: overrides.resourceGroup || preset.resourceGroup,
    database: overrides.database || "scope-mt",
  };
}

export function uriWithDb(uri: string, db: string): string {
  const queryAt = uri.indexOf("?");
  const base = queryAt === -1 ? uri : uri.slice(0, queryAt);
  const query = queryAt === -1 ? "" : uri.slice(queryAt + 1);
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  return query ? `${withSlash}${db}?${query}` : `${withSlash}${db}`;
}

export interface RunnerSelectionOptions {
  viaKubectl: boolean;
  forceDocker: boolean;
  hasMongoTool: boolean;
  hasDocker: boolean;
  dockerInfoOk: boolean;
  hasKubectl?: boolean;
  namespaceReachable?: boolean;
  toolName: "mongodump" | "mongorestore";
  kubeNamespace?: string;
  kubeContext?: string;
}

export type RunnerSelection =
  | { ok: true; runner: Runner }
  | { ok: false; exitCode: number; messages: string[] };

export function selectRunner(opts: RunnerSelectionOptions): RunnerSelection {
  if (opts.viaKubectl) {
    if (opts.hasKubectl === false) {
      return { ok: false, exitCode: 1, messages: ["--via-kubectl set but kubectl not found on PATH."] };
    }
    if (opts.namespaceReachable === false) {
      const suffix = opts.toolName === "mongodump" ? " Check kube-context/namespace." : "";
      return {
        ok: false,
        exitCode: 1,
        messages: [`cannot reach namespace '${opts.kubeNamespace ?? "default"}' (context: ${opts.kubeContext || "current"}).${suffix}`],
      };
    }
    return { ok: true, runner: "kubectl" };
  }
  if (!opts.forceDocker && opts.hasMongoTool) {
    return { ok: true, runner: "native" };
  }
  if (opts.hasDocker && opts.dockerInfoOk) {
    return { ok: true, runner: "docker" };
  }
  return {
    ok: false,
    exitCode: 1,
    messages: [
      `no ${opts.toolName} available.`,
      "install native tools:  brew install mongodb-database-tools",
      `or start Docker so the ${DOCKER_IMAGE} fallback can run,`,
      "or use --via-kubectl to run inside the cluster (needed for private-only Cosmos).",
    ],
  };
}

export function timestampUtc(date = new Date()): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function generateKubePodName(prefix: "cosmos-dump" | "cosmos-restore", epochSeconds = Math.floor(Date.now() / 1000), rand = randomInt(0, 32768)): string {
  return `${prefix}-${epochSeconds}-${rand}`;
}

export function parseStringFlag(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new CosmosCliError(`missing value for ${flag}`, 2);
  }
  return value;
}

export function repoRoot(cwd = process.cwd()): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

export function gitSha(repo: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function assertNonEmptyFile(path: string): Promise<void> {
  const s = await stat(path);
  if (!s.isFile() || s.size === 0) {
    throw new CosmosCliError(`archive is missing or empty: ${path}`, 1);
  }
}

export function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], { stdio: "ignore" });
  return result.status === 0;
}

export function dockerInfoOk(): boolean {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
}

export function kubeContextArgs(kubeContext: string): string[] {
  return kubeContext ? ["--context", kubeContext] : [];
}

export function kubeNamespaceReachable(kubeContext: string, namespace: string): boolean {
  const result = spawnSync("kubectl", [...kubeContextArgs(kubeContext), "get", "ns", namespace], { stdio: "ignore" });
  return result.status === 0;
}

export function resolveRunnerOrThrow(opts: Omit<RunnerSelectionOptions, "hasMongoTool" | "hasDocker" | "dockerInfoOk" | "hasKubectl" | "namespaceReachable">): Runner {
  const selection = selectRunner({
    ...opts,
    hasMongoTool: commandExists(opts.toolName),
    hasDocker: commandExists("docker"),
    dockerInfoOk: commandExists("docker") ? dockerInfoOk() : false,
    hasKubectl: opts.viaKubectl ? commandExists("kubectl") : undefined,
    namespaceReachable: opts.viaKubectl && commandExists("kubectl") ? kubeNamespaceReachable(opts.kubeContext ?? "", opts.kubeNamespace ?? "default") : undefined,
  });
  if (!selection.ok) {
    throw new CosmosCliError(selection.messages.join("\n"), selection.exitCode);
  }
  return selection.runner;
}

interface AccountJson {
  id: string;
  name: string;
}

function parseAccountJson(raw: string): AccountJson {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "id" in parsed &&
    "name" in parsed &&
    typeof parsed.id === "string" &&
    typeof parsed.name === "string"
  ) {
    return { id: parsed.id, name: parsed.name };
  }
  throw new Error("unexpected az account JSON");
}

export function azPreflight(subscription: string): void {
  if (!commandExists("az")) {
    throw new CosmosCliError("azure CLI (az) not found on PATH.", 1);
  }
  if (subscription) {
    const set = spawnSync("az", ["account", "set", "--subscription", subscription], { stdio: "ignore" });
    if (set.status !== 0) {
      throw new CosmosCliError(`could not set subscription '${subscription}'.`, 1);
    }
  }
  const show = spawnSync("az", ["account", "show", "-o", "json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  if (show.status !== 0) {
    throw new CosmosCliError("not logged in to Azure. Run: az login", 1);
  }
  const account = parseAccountJson(show.stdout);
  if (account.id !== EXPECTED_SUBSCRIPTION_ID) {
    console.error(`WARNING: active subscription is '${account.name}' (${account.id}),`);
    console.error(`         expected 'Project Scope' (${EXPECTED_SUBSCRIPTION_ID}). Continuing.`);
  }
}

export function readCosmosConnectionString(account: string, resourceGroup: string): string {
  const result = spawnSync("az", [
    "cosmosdb",
    "keys",
    "list",
    "-n",
    account,
    "-g",
    resourceGroup,
    "--type",
    "connection-strings",
    "--query",
    "connectionStrings[0].connectionString",
    "-o",
    "tsv",
  ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const uri = result.stdout.trim();
  if (result.status !== 0 || !uri) {
    throw new CosmosCliError(`could not read a connection string for account '${account}' in '${resourceGroup}'.\ncheck the account/resource-group names and your permissions.`, 1);
  }
  return uri;
}

export function listCosmosCollections(account: string, resourceGroup: string, database: string): string[] {
  const result = spawnSync("az", [
    "cosmosdb",
    "mongodb",
    "collection",
    "list",
    "-a",
    account,
    "-g",
    resourceGroup,
    "-d",
    database,
    "--query",
    "[].name",
    "-o",
    "tsv",
  ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

export function mongoToolVersion(toolName: "mongodump" | "mongorestore"): string {
  const result = spawnSync(toolName, ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return result.stdout.split("\n")[0]?.trim() || toolName;
}

export interface KubePodOptions {
  prefix: "cosmos-dump" | "cosmos-restore";
  namespace: string;
  kubeContext: string;
  image?: string;
}

export function kubePodUp(opts: KubePodOptions): string {
  const pod = generateKubePodName(opts.prefix);
  const contextArgs = kubeContextArgs(opts.kubeContext);
  const image = opts.image ?? DOCKER_IMAGE;
  console.log(`  Starting in-cluster pod ${pod} (ns:${opts.namespace}, image:${image})...`);
  const run = spawnSync("kubectl", [...contextArgs, "run", pod, "-n", opts.namespace, `--image=${image}`, "--restart=Never", "--command", "--", "sleep", "3600"], { stdio: "ignore" });
  if (run.status !== 0) {
    throw new CosmosCliError("failed to start in-cluster pod.", 1);
  }
  const wait = spawnSync("kubectl", [...contextArgs, "wait", "--for=condition=Ready", `pod/${pod}`, "-n", opts.namespace, "--timeout=180s"], { stdio: "ignore" });
  if (wait.status !== 0) {
    // The caller only owns the pod after this function returns. Reclaim it here
    // when readiness fails, before its name can reach the caller's finally block.
    kubePodDelete(pod, opts.namespace, opts.kubeContext);
    throw new CosmosCliError("in-cluster pod did not become ready.", 1);
  }
  return pod;
}

export function kubePodDelete(pod: string, namespace: string, kubeContext: string): void {
  if (!pod) return;
  spawnSync("kubectl", [...kubeContextArgs(kubeContext), "delete", "pod", pod, "-n", namespace, "--wait=false"], { stdio: "ignore" });
}

export interface RunCommandOptions {
  command: string;
  args: string[];
  logPath: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runStreamingCommand(opts: RunCommandOptions): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const log = createWriteStream(opts.logPath, { flags: "w" });
    log.on("open", () => resolve());
    log.on("error", reject);
  });

  return new Promise((resolve) => {
    const log = createWriteStream(opts.logPath, { flags: "a" });
    const child = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on("error", (err) => {
      log.write(`${err.message}\n`);
      log.end();
      resolve(1);
    });
    child.on("close", (code) => {
      log.end();
      resolve(code ?? 1);
    });
    if (opts.input !== undefined) {
      child.stdin.end(opts.input.endsWith("\n") ? opts.input : `${opts.input}\n`);
    } else {
      child.stdin.end();
    }
  });
}

export interface RunBinaryToFilesOptions {
  command: string;
  args: string[];
  input: string;
  stdoutPath: string;
  stderrPath: string;
}

export async function runBinaryToFiles(opts: RunBinaryToFilesOptions): Promise<number> {
  return new Promise((resolve) => {
    const out = createWriteStream(opts.stdoutPath, { flags: "w" });
    const err = createWriteStream(opts.stderrPath, { flags: "w" });
    const child = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.on("error", (error) => {
      err.write(`${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => {
      out.end();
      err.end();
      resolve(code ?? 1);
    });
    child.stdin.end(opts.input.endsWith("\n") ? opts.input : `${opts.input}\n`);
  });
}

export async function gzipIntegrityOk(path: string): Promise<boolean> {
  const { createGunzip } = await import("node:zlib");
  return new Promise((resolve) => {
    const input = createReadStream(path);
    const gunzip = createGunzip();
    input.on("error", () => resolve(false));
    gunzip.on("error", () => resolve(false));
    gunzip.on("end", () => resolve(true));
    input.pipe(gunzip).resume();
  });
}

export function archiveBase(path: string): string {
  return basename(path);
}
