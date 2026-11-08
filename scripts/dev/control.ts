import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { browserSettings, resolveDevConfig, resolveRuntimeEnv, type RuntimeInputs } from "./config.js";
import { runtimeByName, runtimes, type RuntimeEntry } from "./inventory.js";
import { workspaceName } from "./spike.js";

export const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const stateDirectory = resolve(root, ".dev-state/runtime");
export const project = workspaceName(root).replace("spike", "dev");

const MIN_BUILD_DISK_SPACE = 10 * 2 ** 30;

interface ManagedProcess { pid: number; identity: string }
interface State { mode: "native" | "kind"; active: boolean; restore: boolean; services?: string[]; phase?: "starting" | "ready" | "failed"; processes: Record<string, ManagedProcess> }

/** Warn when a requested image build has less than 10 GiB available. */
export function buildDiskSpaceWarning(availableBytes: number): string | undefined {
  if (availableBytes >= MIN_BUILD_DISK_SPACE) return undefined;
  return "Less than 10 GiB of disk space is available; Kind image builds may fail.";
}

/** Give Codespaces users the configured port-forwarding step after Kind startup. */
export function codespacesForwardingTip(environment: NodeJS.ProcessEnv, port: number): string | undefined {
  if (environment.CODESPACES !== "true") return undefined;
  return `Codespaces: forward port ${port} in the Ports panel to access the Kind environment.`;
}

/** Preserve ownership on failure; an explicit down is required before changing modes. */
export function startupState(previous: State | undefined, mode: State["mode"], services: string[] | undefined, restore: boolean): State {
  if (previous?.active && previous.mode !== mode) throw new Error(`Mode ${previous.mode} is active; run dev:down before switching`);
  const selected = services ?? (previous?.mode === mode ? previous.services : undefined) ?? (mode === "native" ? ["api", "portal"] : ["api", "portal", "judge", "token-manager", "scheduler", "gateway"]);
  for (const name of selected) runtimeByName(name);
  return { mode, active: true, restore, services: selected, phase: "starting", processes: previous?.mode === mode ? { ...previous.processes } : {} };
}

export function loadInputs(directory = root, processEnv = process.env): RuntimeInputs {
  const load = (name: string): NodeJS.ProcessEnv => {
    const path = resolve(directory, name);
    return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  };
  return { generated: load(".env"), local: load(".env.local"), process: processEnv };
}

function mergedInputs(inputs = loadInputs()): NodeJS.ProcessEnv {
  return { ...inputs.generated, ...inputs.local, ...inputs.process };
}

/** Forward ambient tool settings, never ambient provider secrets or global inspector options. */
export function consumerEnvironment(entry: RuntimeEntry, inputs: RuntimeInputs, settings: Record<string, string>): NodeJS.ProcessEnv {
  const source = mergedInputs(inputs);
  const ambient = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "CI", "PNPM_HOME", "COREPACK_HOME", "CARGO_HOME", "RUSTUP_HOME", "VIRTUAL_ENV", "DISPLAY"];
  const keys = [...ambient, ...(entry.secrets || [])];
  const selected = Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return { ...selected, ...(entry.name === "portal" || entry.name === "storybook" ? browserSettings(settings) : settings) };
}

export function execute(command: string, args: string[], env = process.env, cwd = root, timeout = 900_000): void {
  execFileSync(command, args, { stdio: "inherit", env, cwd, timeout });
}

function output(command: string, args: string[], env = process.env): string {
  return execFileSync(command, args, { encoding: "utf8", env, cwd: root, timeout: 30_000 }).trim();
}

function processIdentity(pid: number): string {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return fields[0] === "Z" ? "" : fields[19];
  }
  catch { return ""; }
}

function readState(): State | undefined {
  const path = resolve(stateDirectory, "mode.json");
  if (!existsSync(path)) return;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || !("mode" in value) || (value.mode !== "native" && value.mode !== "kind") || !("processes" in value) || typeof value.processes !== "object" || !value.processes) throw new Error("Invalid runtime state; inspect .dev-state/runtime/mode.json before continuing");
  return value as State;
}

function saveState(state: State): void {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const path = resolve(stateDirectory, "mode.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function compose(env: NodeJS.ProcessEnv, ...args: string[]): void {
  execute("docker", ["compose", "--project-name", project, "--env-file", "/dev/null", "--file", resolve(root, ".devcontainer/native.compose.yaml"), ...args], env);
}

function spike(env: NodeJS.ProcessEnv, command: string): void {
  execute("pnpm", ["exec", "tsx", "scripts/dev/spike.ts", command], env);
}

/** Separate local vault PKI from Entra's CA; never disable client certificate checks. */
function prepareVault(env: NodeJS.ProcessEnv): void {
  const certs = resolve(stateDirectory, "certs");
  mkdirSync(certs, { recursive: true, mode: 0o755 });
  const authority = resolve(process.env.SCOPE_DEV_DATA || stateDirectory, "lowkey-authority");
  mkdirSync(authority, { recursive: true, mode: 0o700 });
  const certEnv = { ...env, CAROOT: authority };
  execute("mkcert", ["-cert-file", resolve(certs, "lowkey.pem"), "-key-file", resolve(certs, "lowkey-key.pem"), "localhost", "lowkey-vault"], certEnv);
  execute("openssl", ["pkcs12", "-export", "-in", resolve(certs, "lowkey.pem"), "-inkey", resolve(certs, "lowkey-key.pem"), "-out", resolve(certs, "lowkey.p12"), "-name", "lowkey-vault", "-passout", "pass:scope-local-development"]);
  writeFileSync(resolve(certs, "lowkey-ca.pem"), readFileSync(resolve(authority, "rootCA.pem")));
}

function servicePort(entry: RuntimeEntry, env: NodeJS.ProcessEnv): number | undefined {
  if (!entry.port) return;
  const port = Number(env[`${entry.name.toUpperCase().replaceAll("-", "_")}_PORT`] || entry.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid ${entry.name} port`);
  return port;
}

export function launchCommand(entry: RuntimeEntry, debug: boolean, args: string[] = []): string[] {
  if (entry.name === "tests") return debug ? ["node", `--inspect-brk=127.0.0.1:${entry.inspector}`, "node_modules/vitest/vitest.mjs", "run", "--no-file-parallelism", ...args] : ["pnpm", "exec", "vitest", "run", ...args];
  if (entry.name === "prompt-evaluations") return ["pnpm", "--filter", "static-prompt-evals", "evaluate:quality", ...args];
  if (entry.name === "storybook") return ["pnpm", "--filter", "portal", "storybook", ...args];
  if (entry.name === "website") return debug ? ["node", `--inspect-brk=127.0.0.1:${entry.inspector}`, "node_modules/astro/astro.js", "dev", ...args] : ["pnpm", "dev", ...args];
  if (entry.name === "portal") return ["pnpm", "--filter", "portal", "dev", "--host", "127.0.0.1", "--strictPort", ...args];
  if (entry.kind === "rust") return ["cargo", "run", "--locked", "--", "--port", "18000", "--api-port", "18897", ...args];
  if (!entry.entry) throw new Error(`Missing entrypoint for ${entry.name}`);
  return ["node", ...(debug ? [`--inspect-brk=127.0.0.1:${entry.inspector}`] : entry.kind === "service" ? ["--watch"] : []), "--conditions=source", "--enable-source-maps", "--import", "tsx", resolve(root, entry.directory, entry.entry), ...(entry.name === "db-migrations" && !args.length ? ["up"] : entry.name === "cli" && !args.length ? ["--help"] : args)];
}

async function startNative(name: string, state: State, env: NodeJS.ProcessEnv): Promise<void> {
  const existing = state.processes[name];
  if (existing && processIdentity(existing.pid) === existing.identity) return;
  const log = openSync(resolve(stateDirectory, `${name}.log`), "a", 0o600);
  const child = spawn("pnpm", ["exec", "tsx", "scripts/dev/control.ts", "run", `--service=${name}`], { cwd: root, env, detached: true, stdio: ["ignore", log, log] });
  await new Promise<void>((resolvePromise, reject) => { child.once("spawn", resolvePromise); child.once("error", reject); });
  closeSync(log);
  if (!child.pid) throw new Error(`Could not launch ${name}`);
  state.processes[name] = { pid: child.pid, identity: processIdentity(child.pid) };
  child.unref();
  saveState(state);
}

async function stopNative(state: State): Promise<void> {
  for (const [name, managed] of Object.entries(state.processes)) {
    if (processIdentity(managed.pid) !== managed.identity) continue;
    process.kill(-managed.pid, "SIGTERM");
    const deadline = Date.now() + 60_000;
    while (processIdentity(managed.pid) === managed.identity && Date.now() < deadline) await delay(200);
    if (processIdentity(managed.pid) === managed.identity) throw new Error(`${name} has not stopped gracefully; inspect it before resetting data`);
  }
  state.processes = {};
}

async function waitForNative(name: string, state: State, env: NodeJS.ProcessEnv): Promise<void> {
  const entry = runtimeByName(name);
  if (name !== "api" && name !== "portal") return;
  const url = `http://127.0.0.1:${servicePort(entry, env)}${name === "api" ? "/ready" : "/"}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const managed = state.processes[name];
    if (!managed || processIdentity(managed.pid) !== managed.identity) throw new Error(`${name} exited during startup; run pnpm dev:logs --service=${name}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; }
    catch { /* The process may still be binding its listener. */ }
    await delay(500);
  }
  throw new Error(`${name} did not become ready at ${url}; run pnpm dev:logs --service=${name}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] || "doctor";
  const option = (name: string): string | undefined => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const inputs = loadInputs();
  const inputEnv = mergedInputs(inputs);
  const config = resolveDevConfig(inputEnv);
  const settings = resolveRuntimeEnv(inputs, "native");
  const env = { ...inputEnv, ...settings, DEV_CERT_DIR: resolve(stateDirectory, "certs"), COMPOSE_PARALLEL_LIMIT: "2" };
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  if (command === "doctor" || command === "status") {
    console.log(`Workspace: ${project}\nOrigin: ${config.publicOrigin}\nMode: ${readState()?.mode || "not selected"}`);
    const disk = statfsSync(root);
    console.log(`CPUs ${cpus().length}; RAM ${(totalmem() / 2 ** 30).toFixed(1)} GiB; available disk ${(disk.bavail * disk.bsize / 2 ** 30).toFixed(1)} GiB`);
    if (cpus().length < 4 || totalmem() < 15 * 2 ** 30) console.warn("Below the initial 4-core/16-GB fast-mode sizing target");
    if (disk.bavail * disk.bsize < 80 * 2 ** 30) console.warn("Below the 80-GB available-disk full-Kind sizing target; full builds may exhaust disk");
    for (const tool of ["docker", "kind", "kubectl", "mkcert", "cargo", "uv", "helm", "skaffold", "az", "pwsh", "gh"]) {
      try { console.log(`${tool}: ${output("sh", ["-c", 'command -v "$1"', "--", tool])}`); }
      catch { console.warn(`${tool}: unavailable`); }
    }
    console.log(`Docker: ${output("docker", ["info", "--format", "{{.ServerVersion}}"])}; live provider credentials/entitlements are not validated.`);
    return;
  }
  if (command === "config") {
    for (const target of ["native", "compose", "kind"] as const) writeFileSync(resolve(stateDirectory, `${target}.json`), JSON.stringify(resolveRuntimeEnv(inputs, target), null, 2));
    console.log(`Generated non-secret settings in ${stateDirectory}`);
    return;
  }
  if (command === "workers") {
    const state = readState();
    if (!state?.active || state.mode !== "native" || state.phase !== "ready") throw new Error("Start native mode successfully before launching container workers");
    const selected = option("services")?.split(",");
    if (!selected?.length) throw new Error("Select workers explicitly with --services=<name,...>; this may consume provider credits");
    const workers = await import("./workers.js");
    const model = workers.renderNativeWorkers(workers.existingWorkerModel(root, inputEnv), selected, inputs, project);
    const path = resolve(stateDirectory, "workers.json");
    writeFileSync(path, JSON.stringify(model, null, 2), { mode: 0o600 });
    execute("pnpm", ["exec", "tsx", "scripts/dev/bootstrap.ts", "register-agents"], env);
    execute("docker", ["compose", "--project-name", project, "--file", path, "up", "--detach", ...(process.argv.includes("--build") ? ["--build"] : [])], { ...env, COMPOSE_PARALLEL_LIMIT: "1" }, root, 0);
    return;
  }
  if (command === "images" || command === "job") {
    const cluster = await import("./cluster.js");
    if (command === "images") cluster.buildImages(env, process.argv.includes("--all") ? ["tools", ...runtimes.filter((entry) => entry.dockerfile).map((entry) => entry.name)] : (option("services") || "tools,api").split(","));
    else {
      const name = option("service") || "tests";
      const entry = runtimeByName(name);
      if (entry.kind !== "utility" && entry.kind !== "tool") throw new Error("dev:job requires a one-shot tool or utility");
      cluster.kubectl(["patch", "job", name, "--type=merge", "-p", '{"spec":{"suspend":false}}'], env);
      cluster.kubectl(["wait", "--for=condition=complete", `job/${name}`, "--timeout=600s"], env);
    }
    return;
  }
  if (command === "start" || command === "attach" || command === "create") {
    if (command === "create") {
      execute("pnpm", ["install", "--frozen-lockfile"]);
      execute("pnpm", ["-r", "--filter", "./packages/**", "--if-present", "build"]);
      execute("pnpm", ["--dir", "website", "install", "--frozen-lockfile"]);
      execute("uv", ["venv", "--python", "3.11", resolve(root, ".venv")]);
      execute("uv", ["pip", "install", "--python", resolve(root, ".venv/bin/python"), "debugpy==1.8.14"]);
      for (const name of ["github-auth", "github-cookie-updater"]) execute("pnpm", ["--filter", name, "exec", "playwright", "install", "chromium"]);
      execute("pnpm", ["--dir", "website", "exec", "playwright", "install", "chromium"]);
      execute("pnpm", ["dev:config"]);
    } else if (command === "start") {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { output("docker", ["info", "--format", "{{.ServerVersion}}"]); ready = true; break; }
        catch { await delay(1000); }
      }
      if (!ready) throw new Error("Docker is not ready; check outer-container privileged support");
      const saved = readState();
      if (saved?.restore) execute("pnpm", ["dev:up", `--mode=${saved.mode}`, ...(saved.services ? [`--services=${saved.services.join(",")}`] : []), "--restore"], process.env, root, 0);
    }
    console.log(`Scope development: ${config.publicOrigin}\nMode ${readState()?.mode || "not selected"}. Use pnpm dev:doctor for diagnostics.`);
    return;
  }
  if (command === "run") {
    const entry = runtimeByName(option("service") || "api");
    const forwarded = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];
    if (option("mode") === "kind") {
      if (!process.argv.includes("--debug")) throw new Error("Use dev:debug for a Kind inspector session, or dev:job for one-shot execution");
      const cluster = await import("./cluster.js");
      await cluster.debugRuntime(inputEnv, entry.name, forwarded);
      return;
    }
    const selected = consumerEnvironment(entry, inputs, settings);
    selected.PORT = String(servicePort(entry, inputEnv) || "3000");
    selected.NODE_EXTRA_CA_CERTS = resolve(root, ".dev-state/spike/certs/rootCA.pem");
    if (entry.name === "token-manager") {
      selected.NODE_EXTRA_CA_CERTS = resolve(stateDirectory, "certs/lowkey-ca.pem");
      selected.AZURE_KEYVAULT_URI = `https://localhost:${inputEnv.LOWKEY_VAULT_PORT || "18444"}`;
      selected.IDENTITY_ENDPOINT = `http://localhost:${inputEnv.LOWKEY_IDENTITY_PORT || "18082"}/metadata/identity/oauth2/token`;
      selected.IDENTITY_HEADER = "header";
    }
    const [executable, ...args] = launchCommand(entry, process.argv.includes("--debug"), entry.name === "portal" ? ["--port", selected.PORT, ...forwarded] : forwarded);
    execute(executable, args, selected, entry.name === "website" || entry.kind === "rust" ? resolve(root, entry.directory) : root, 0);
    return;
  }
  const state = readState();
  if (command === "logs") {
    const name = option("service") || "api";
    runtimeByName(name);
    const path = resolve(stateDirectory, `${name}.log`);
    if (existsSync(path)) execute("tail", ["-n", "100", path]);
    else compose(env, "logs", "--tail", "100");
    return;
  }
  if (command === "down" || command === "reset-data") {
    if (command === "reset-data" && option("confirm") !== project) throw new Error(`Destructive reset requires --confirm=${project}`);
    if (state?.mode === "kind") {
      const cluster = await import("./cluster.js");
      execute("kind", ["delete", "cluster", "--name", project, "--kubeconfig", cluster.kubeconfig], env);
      saveState({ ...state, active: false, restore: false });
      if (command === "reset-data") throw new Error("Kind node deleted; retained host-mounted state was not deleted. Back it up and remove only the workspace state directory explicitly.");
      return;
    }
    if (state) await stopNative(state);
    const workers = resolve(stateDirectory, "workers.json");
    if (existsSync(workers)) execute("docker", ["compose", "--project-name", project, "--file", workers, "down", "--timeout", "120", ...(command === "reset-data" ? ["--volumes"] : [])], env);
    compose(env, "down", "--timeout", "60", ...(command === "reset-data" ? ["--volumes"] : []));
    spike(env, "down");
    if (command === "reset-data") execute("pnpm", ["exec", "tsx", "scripts/dev/spike.ts", "reset-data", `--confirm=${workspaceName(root)}`], env);
    if (state) saveState({ ...state, active: false, restore: false });
    return;
  }
  if (command !== "up") throw new Error("Usage: pnpm dev:<doctor|config|up|down|logs|reset-data|run>");
  const mode = option("mode") || "native";
  if (mode !== "native" && mode !== "kind") throw new Error("Mode must be native or kind");
  if (state?.active && state.mode !== mode) throw new Error(`Mode ${state.mode} is active; run dev:down before switching`);
  if (mode === "kind" && process.argv.includes("--build")) {
    const disk = statfsSync(root);
    const warning = buildDiskSpaceWarning(disk.bavail * disk.bsize);
    if (warning) console.warn(warning);
  }
  const next = startupState(state, mode, option("services")?.split(","), process.argv.includes("--restore"));
  const lock = resolve(stateDirectory, "operation.lock");
  try { mkdirSync(lock); } catch { throw new Error("Another lifecycle operation is active; inspect .dev-state/runtime/operation.lock"); }
  try {
    saveState(next);
    prepareVault(env);
    if (mode === "kind") {
      spike(env, "config");
      if (!existsSync(resolve(root, ".dev-state/spike/certs/edge.pem"))) {
        spike(env, "up");
        spike(env, "down");
      }
      const cluster = await import("./cluster.js");
      cluster.startCluster(inputEnv, next.services!, process.argv.includes("--build"));
      next.phase = "ready";
      saveState(next);
      const tip = codespacesForwardingTip(inputEnv, config.edgePort);
      if (tip) console.log(tip);
      return;
    }
    compose(env, "up", "--detach", "--wait", "--wait-timeout", "180", "mongodb", "redis", "azurite", "lowkey-vault");
    compose(env, "run", "--rm", "mongo-init");
    execute("pnpm", ["-r", "--filter", "./packages/**", "--if-present", "build"], env);
    execute("pnpm", ["--filter", "db-migrations", "migrate:up"], env);
    execute("pnpm", ["exec", "tsx", "scripts/dev/bootstrap.ts", "storage-init"], env);
    const edge = output("docker", ["ps", "--filter", `label=com.docker.compose.project=${workspaceName(root)}`, "--filter", "label=com.docker.compose.service=dev-edge", "--format", "{{.ID}}"]);
    spike(env, "config");
    spike(env, edge ? "probe" : "up");
    for (const name of next.services!) {
      const entry = runtimeByName(name);
      if (!entry.native || entry.kind === "tool") throw new Error(`${name} requires an explicit on-demand/container launch`);
      await startNative(name, next, env);
    }
    for (const name of next.services!) await waitForNative(name, next, inputEnv);
    next.phase = "ready";
    saveState(next);
    console.log(`Development processes ready. Browser: ${config.publicOrigin}\nLogs: pnpm dev:logs --service=api`);
  } catch (error) {
    next.phase = "failed";
    next.restore = false;
    saveState(next);
    throw error;
  } finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}