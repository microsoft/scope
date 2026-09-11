// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Docker, Orchestrator } from "docker-orchestrator";
import { AgentManager, type AgentSettings } from "./agents.js";
import { parseScannerModels, registerAgent, registerModels, setAgentAvailable } from "./api.js";
import { startControl, type ServerStatus } from "./control.js";
import { controlAddress, isLocalControlAddress } from "./control-address.js";
import { HostWorkers } from "./host.js";
import {
  backendServices, buildEnvironment, dockerWorker, modelScanner, providerEnv, readAssetManifest,
  storageConnection, targetIds, type StackOptions, type TargetId,
} from "./manifest.js";
import { acquireLock, isMissing, preparePaths, readPorts, serverPaths, writeJson } from "./paths.js";

const exec = promisify(execFile);

interface RunningServer {
  pid: number;
  controlUrl: string;
  dataDir: string;
}

function runningServer(value: unknown): RunningServer {
  if (typeof value !== "object" || value === null ||
    !("pid" in value) || typeof value.pid !== "number" ||
    !("controlUrl" in value) || typeof value.controlUrl !== "string" ||
    !("dataDir" in value) || typeof value.dataDir !== "string") {
    throw new Error("Invalid local server runtime file");
  }
  const url = new URL(value.controlUrl);
  if (!isLocalControlAddress(url.hostname) || url.protocol !== "http:") throw new Error("Invalid local control address");
  return value as RunningServer;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Ports must be integers between 0 and 65535");
  return port;
}

async function dockerClient(): Promise<InstanceType<typeof Docker>> {
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint || process.env.DOCKER_CONTEXT) {
    try {
      const { stdout } = await exec("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 10_000 });
      endpoint = stdout.trim();
    } catch (error) {
      if (!endpoint) throw new Error("Docker is required. Install/start a local Docker engine and ensure the docker command is on PATH.", { cause: error });
    }
  }
  if (!endpoint.startsWith("unix://")) {
    throw new Error("Scope Server requires a local Unix-socket Docker engine because its persistent data uses host bind mounts.");
  }
  const socketPath = endpoint.slice("unix://".length);
  return new Docker({ socketPath });
}

async function npmRegistry(): Promise<string> {
  const configured = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  const registry = configured || (await exec("npm", ["config", "get", "registry"], { timeout: 10_000 })).stdout.trim();
  const url = new URL(registry);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("npm registry must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Do not embed npm credentials in the registry URL; use your npm registry authentication configuration.");
  return registry;
}

async function firstRun(agents: AgentManager, nonInteractive: boolean): Promise<void> {
  if (!nonInteractive && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("\nConfigure coding agents now, or press Enter to configure them later in Portal → Agents.");
      agents.controlStatus().agents.forEach((agent, index) => console.log(`  ${index + 1}. ${agent.label} - ${agent.workerType}`));
      const choices = (await prompt.question("Agent numbers (comma separated; Enter = later): ")).trim();
      const ids = choices ? choices.split(",").map(number => {
        const index = Number(number.trim()) - 1;
        if (!Number.isInteger(index) || !targetIds[index]) throw new Error(`Invalid agent choice: ${number}`);
        return targetIds[index];
      }) : [];
      for (const id of new Set(ids)) {
        let consent = false;
        if (id.endsWith("-host")) {
          consent = (await prompt.question(`${id} runs with YOUR files, permissions and existing CLI login. Allow this target? [y/N] `)).trim().toLowerCase() === "y";
          if (!consent) continue;
        }
        agents.choose(id, consent);
      }
    } finally { prompt.close(); }
  }
  await agents.persist();
}

async function initializeData(data: string): Promise<void> {
  for (const directory of ["mongodb", "redis", "azurite", "vault", ...targetIds.map(id => `workspaces/${id}`)]) {
    const path = join(data, directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    // The parent is user-private. Non-root container users need access to these bind roots.
    if (directory === "vault" || (directory.startsWith("workspaces/") && !directory.endsWith("-host"))) {
      await chmod(path, 0o777);
    }
  }
  const vault = join(data, "vault", "export.json");
  try {
    await writeFile(vault, JSON.stringify({ vaults: [{
      attributes: {
        baseUri: "https://lowkey-vault:8443", recoveryLevel: "Recoverable+Purgeable",
        recoverableDays: 90, created: 0, deleted: null,
      },
      keys: {}, secrets: {}, certificates: {},
    }] }), { flag: "wx", mode: 0o666 });
    await chmod(vault, 0o666);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "data-dir": { type: "string" },
      "api-port": { type: "string" },
      "portal-port": { type: "string" },
      "non-interactive": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: scope-server [start|stop|restart|status] [--data-dir PATH] [--api-port PORT] [--portal-port PORT] [--non-interactive]\n\nStarts the local Scope API and Portal. Docker and Node.js 22+ are required.\nAgent setup is also available later in Portal → Agents and scope agent setup.\nCtrl+C or scope-server stop stops owned services without removing persistent data.");
    return;
  }
  const command = positionals[0] ?? "start";
  if (positionals.length > 1 || !["start", "stop", "restart", "status"].includes(command)) throw new Error(`Unknown command: ${positionals.join(" ")}`);
  const paths = serverPaths(values["data-dir"]);
  await preparePaths(paths);
  const runtimeFile = join(paths.runtime, "server.json");
  if (command !== "start") {
    let running: RunningServer;
    try { running = runningServer(JSON.parse(await readFile(runtimeFile, "utf8")) as unknown); }
    catch (error) {
      if (isMissing(error)) { console.log("Scope Server is not running."); return; }
      throw error;
    }
    try {
      const response = await fetch(new URL(command === "status" ? "health" : "stop", running.controlUrl), {
        method: command === "status" ? "GET" : "POST",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Launcher returned ${response.status}`);
      const status: unknown = await response.json();
      console.log(JSON.stringify(status, null, 2));
      if (command !== "status") {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          try { await readFile(join(paths.runtime, "launcher.lock"), "utf8"); }
          catch (error) { if (isMissing(error)) break; throw error; }
          await sleep(250);
        }
        if (Date.now() >= deadline) throw new Error("Server is still stopping; inspect the launcher's output before restarting.");
      }
    } catch (error) {
      throw new Error("The saved launcher is not responding. Start scope-server again to recover stopped services.", { cause: error });
    }
    if (command !== "restart") return;
    if (!values["data-dir"]) paths.data = running.dataDir;
    await preparePaths(paths);
  }

  const release = await acquireLock(paths);
  const dist = dirname(fileURLToPath(import.meta.url));
  const assets = join(dist, "../assets");
  let orchestrator: Orchestrator | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let agents: AgentManager | undefined;
  let closing = false;
  let engineConnected = false;
  let backendReady = false;
  let startupError: unknown;
  const status: ServerStatus = { status: "starting", dataDir: paths.data };
  let requestStop: () => void = () => {};
  const stopped = new Promise<void>(resolve => {
    requestStop = () => { closing = true; orchestrator?.cancel(); resolve(); };
  });
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    const manifest = await readAssetManifest(assets);
    const savedPorts = await readPorts(paths.config);
    const docker = await dockerClient();
    orchestrator = new Orchestrator(docker, paths.owner, event => {
      console.log(`[${event.service}] ${event.phase}${event.message ? ` ${event.message}` : ""}`);
    });
    const runtime = orchestrator;
    await initializeData(paths.data);
    let options: StackOptions;
    let hostEnv: Record<string, string> = {};
    const hosts = new HostWorkers(dist, paths.data, (id, error) => {
      agents?.failed(id, error);
      if (status.apiUrl && !closing) void setAgentAvailable(status.apiUrl, id, false).catch(console.error);
    });
    const stopAgent = async (id: TargetId): Promise<void> => {
      try {
        if (backendReady && status.apiUrl) await setAgentAvailable(status.apiUrl, id, false);
      } finally {
        if (id.endsWith("-host")) await hosts.stop(id);
        else await runtime.stopService(id);
      }
    };
    const startAgent = async (id: TargetId, settings: AgentSettings) => {
      if (!status.apiUrl || closing) throw new Error("Server is not ready for agent setup");
      if (id.endsWith("-host")) {
        const detected = await hosts.discover(id, settings, hostEnv);
        if (closing) throw new Error("Server is stopping");
        await registerAgent(status.apiUrl, assets, id, manifest, detected.agentVersion, detected.componentVersions);
        await registerModels(status.apiUrl, id, detected);
        await hosts.start(id, { ...settings, executable: detected.executable }, hostEnv);
        await setAgentAvailable(status.apiUrl, id, true);
        return { executable: detected.executable, version: detected.version };
      }
      const version = id === "coder-acp-copilot"
        ? `copilot-${manifest.versions.COPILOT_CLI_VERSION}`
        : `claude-agent-acp-${manifest.versions.CLAUDE_CODE_ACP_VERSION}-sdk-${manifest.versions.CLAUDE_AGENT_SDK_VERSION}`;
      await registerAgent(status.apiUrl, assets, id, manifest, version, manifest.versions);
      const scanner = modelScanner(id, options);
      await runtime.startService(scanner);
      await registerModels(status.apiUrl, id, parseScannerModels(await runtime.output(scanner.name)));
      await runtime.startService(dockerWorker(id, options));
      await setAgentAvailable(status.apiUrl, id, true);
      return { version };
    };
    agents = new AgentManager(paths.config, startAgent, stopAgent);
    if (!await agents.load()) await firstRun(agents, values["non-interactive"] ?? false);
    await runtime.connect();
    engineConnected = true;
    // Clean up only this OS user's stale resources, preserving all host data.
    await runtime.stop();
    await runtime.connect();
    const address = controlAddress(
      process.platform,
      process.platform === "linux" ? await runtime.bridgeGateway() : undefined,
    );
    control = await startControl(agents, () => status, requestStop, address.listenHost);
    options = {
      source: join(assets, "source"), data: paths.data, manifest,
      registry: await npmRegistry(),
      controlUrl: `http://${address.containerHost}:${control.port}/`,
      apiPort: parsePort(values["api-port"]) ?? savedPorts.api,
      portalPort: parsePort(values["portal-port"]) ?? savedPorts.portal,
    };
    await writeJson(runtimeFile, {
      pid: process.pid, controlUrl: `http://${address.listenHost}:${control.port}/`, dataDir: paths.data,
    });
    if (!closing) await runtime.start(backendServices(options));
    if (!closing) {
      status.apiUrl = `http://127.0.0.1:${await runtime.hostPort("api", 80)}`;
      status.portalUrl = `http://127.0.0.1:${await runtime.hostPort("portal", 80)}`;
      await writeJson(join(paths.config, "ports.json"), {
        api: await runtime.hostPort("api", 80), portal: await runtime.hostPort("portal", 80),
      });
      hostEnv = {
        ...providerEnv(process.env),
        MONGO_CONNECTION_STRING: `mongodb://127.0.0.1:${await runtime.hostPort("mongodb", 27017)}`,
        MONGO_DATABASE: "requests-db", MONGO_COLLECTION: "requests",
        REDIS_HOST: "127.0.0.1", REDIS_PORT: String(await runtime.hostPort("redis", 6379)), REDIS_PASSWORD: "",
        AZURE_STORAGE_ACCOUNT_NAME: "devstoreaccount1",
        STORAGE_CONNECTION_STRING: storageConnection("127.0.0.1", await runtime.hostPort("azurite", 10000), await runtime.hostPort("azurite", 10001)),
        SCOPE_MT_API_URL: status.apiUrl,
        JUDGE_SERVICE_URL: `http://127.0.0.1:${await runtime.hostPort("judge", 80)}`,
        TOKEN_MANAGER_URL: `http://127.0.0.1:${await runtime.hostPort("token-manager", 80)}`,
        AZURE_STORAGE_QUEUE_POSTPROCESSOR: "post-processor-queue",
        ...buildEnvironment(manifest),
      };
      backendReady = true;
      await agents.activate();
      status.status = "ready";
      console.log(`\nScope Server is ready.\nPortal: ${status.portalUrl}\nAPI: ${status.apiUrl}\nData: ${paths.data}`);
      console.log(`\nConnect your packaged Scope CLI:\n  scope env add local --url ${status.apiUrl}\n  scope env use local\nConfigure agents in Portal → Agents. Ctrl+C stops services; your data is retained.`);
      for (const agent of agents.snapshot().agents) {
        if (agent.error) console.error(`[${agent.workerType}] Setup failed: ${agent.error}`);
      }
      await stopped;
    }
  } catch (error) {
    startupError = error;
    if (!closing) throw error;
  } finally {
    closing = true;
    status.status = "stopping";
    const errors: unknown[] = [];
    try { if (backendReady) await agents?.close(); } catch (error) { errors.push(error); }
    try { if (engineConnected) await orchestrator?.stop(); } catch (error) { errors.push(error); }
    try { await control?.close(); } catch (error) { errors.push(error); }
    await rm(runtimeFile, { force: true });
    await release();
    // npx may forward a second terminal signal while asynchronous cleanup is still running.
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    if (errors.length) {
      const cleanupError = new AggregateError(errors, "Scope stopped with cleanup errors; persistent data was retained");
      if (startupError) console.error(cleanupError.message);
      else throw cleanupError;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
