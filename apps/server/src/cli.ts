// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command, CommanderError } from "commander";
import { Docker, Orchestrator } from "docker-orchestrator";
import { banner, errorText, label, styleText, value } from "shared/style";
import { AgentManager, type AgentSettings } from "./agents.js";
import { parseScannerModels, registerAgent, registerModels, setAgentAvailable } from "./api.js";
import { startControl, type ServerStatus } from "./control.js";
import { controlAddress, isLocalControlAddress } from "./control-address.js";
import { HostWorkers } from "./host.js";
import {
  backendServices,
  buildEnvironment,
  dockerWorker,
  modelScanner,
  providerEnv,
  readAssetManifest,
  storageConnection,
  targetIds,
  type AssetManifest,
  type StackOptions,
  type TargetId,
} from "./manifest.js";
import { acquireLock, isMissing, preparePaths, readPorts, serverPaths, writeJson } from "./paths.js";

const exec = promisify(execFile);
const SERVER_VERSION = process.env.SCOPE_SERVER_VERSION ?? "0.1.0-dev";
const SERVER_COMMANDS = ["start", "stop", "restart", "status"] as const;

type ServerCommandName = typeof SERVER_COMMANDS[number];
type ServerPaths = ReturnType<typeof serverPaths>;

type ExecuteServerCommand = (invocation: ServerCliInvocation) => Promise<void>;

interface RunningServer {
  pid: number;
  controlUrl: string;
  dataDir: string;
}

interface ServerCliOptions {
  dataDir?: string;
  apiPort?: string;
  portalPort?: string;
  nonInteractive?: boolean;
}

interface ServerCliInvocation {
  command: ServerCommandName;
  options: ServerCliOptions;
}

interface RawCliOptions {
  dataDir?: unknown;
  apiPort?: unknown;
  portalPort?: unknown;
  nonInteractive?: unknown;
}

interface LaunchPaths {
  paths: ServerPaths;
  runtimeFile: string;
}

interface StartedBackend {
  apiUrl: string;
  portalUrl: string;
  hostEnv: Record<string, string>;
}

interface CleanupContext {
  backendReady: boolean;
  agents?: AgentManager;
  engineConnected: boolean;
  orchestrator?: Orchestrator;
  control?: Awaited<ReturnType<typeof startControl>>;
  runtimeFile: string;
  release: () => Promise<void>;
  startupError?: unknown;
}

function runningServer(value: unknown): RunningServer {
  if (typeof value !== "object" || value === null ||
    !("pid" in value) || typeof value.pid !== "number" ||
    !("controlUrl" in value) || typeof value.controlUrl !== "string" ||
    !("dataDir" in value) || typeof value.dataDir !== "string") {
    throw new Error("Invalid local server runtime file");
  }
  const url = new URL(value.controlUrl);
  if (!isLocalControlAddress(url.hostname) || url.protocol !== "http:") {
    throw new Error("Invalid local control address");
  }
  return value as RunningServer;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Ports must be integers between 0 and 65535");
  }
  return port;
}

function stringOption(valueToCheck: unknown, name: string): string | undefined {
  if (valueToCheck === undefined) return undefined;
  if (typeof valueToCheck !== "string") throw new Error(`Expected ${name} to be a string`);
  return valueToCheck;
}

function booleanOption(valueToCheck: unknown, name: string): boolean | undefined {
  if (valueToCheck === undefined) return undefined;
  if (typeof valueToCheck !== "boolean") throw new Error(`Expected ${name} to be a boolean`);
  return valueToCheck;
}

function collectOptions(command: Command): ServerCliOptions {
  const raw = { ...command.parent?.opts(), ...command.opts() } as RawCliOptions;
  return {
    dataDir: stringOption(raw.dataDir, "--data-dir"),
    apiPort: stringOption(raw.apiPort, "--api-port"),
    portalPort: stringOption(raw.portalPort, "--portal-port"),
    nonInteractive: booleanOption(raw.nonInteractive, "--non-interactive"),
  };
}

function addServerOptions(command: Command): Command {
  return command
    .option("--data-dir <path>", "persistent service data directory")
    .option("--api-port <port>", "API host port, or 0 for an ephemeral port")
    .option("--portal-port <port>", "Portal host port, or 0 for an ephemeral port")
    .option("--non-interactive", "skip the first-run agent setup prompt");
}

interface CommandHelpEntry {
  name: string;
  description: string;
  args: string[];
  options: string[];
}

function getAllCommands(command: Command, prefix = ""): CommandHelpEntry[] {
  const commands: CommandHelpEntry[] = [];
  for (const subCommand of command.commands) {
    const fullName = prefix ? `${prefix} ${subCommand.name()}` : subCommand.name();
    commands.push({
      name: fullName,
      description: subCommand.description(),
      args: subCommand.registeredArguments.map(argument =>
        `<${argument.name()}>${argument.required ? "" : "?"} - ${argument.description}`),
      options: subCommand.options
        .filter(option => !option.hidden)
        .map(option => `${option.flags} - ${option.description}`),
    });
    commands.push(...getAllCommands(subCommand, fullName));
  }
  return commands;
}

function configureServerHelp(program: Command): void {
  program.configureHelp({
    styleTitle: str => styleText("bold", str),
    styleCommandText: str => styleText("cyan", str),
    styleCommandDescription: str => styleText("magenta", str),
    styleDescriptionText: str => styleText("italic", str),
    styleOptionText: str => styleText("green", str),
    styleArgumentText: str => styleText("yellow", str),
    styleSubcommandText: str => styleText("blue", str),
    formatHelp(command, helper) {
      const termWidth = helper.padWidth(command, helper);
      let output = "";
      if (command.description()) output += styleText("bold", command.description()) + "\n\n";
      output += styleText("bold", "Usage:") + "\n";
      output += "  " + helper.commandUsage(command) + "\n\n";

      const visibleOptions = command.options.filter(option => !option.hidden);
      if (visibleOptions.length > 0) {
        output += styleText("bold", "Global Options:") + "\n";
        for (const option of visibleOptions) {
          const term = helper.optionTerm(option);
          output += "  " + styleText("green", term.padEnd(termWidth)) + "  " + helper.optionDescription(option) + "\n";
        }
        output += "\n";
      }

      const allCommands = getAllCommands(command);
      if (allCommands.length > 0) {
        output += styleText("bold", "All Commands:") + "\n";
        for (const serverCommand of allCommands) {
          output += "  " + styleText("cyan", serverCommand.name.padEnd(termWidth)) + "  " +
            styleText("magenta", serverCommand.description) + "\n";
          for (const argument of serverCommand.args) output += "    " + styleText("yellow", argument) + "\n";
          for (const option of serverCommand.options) output += "    " + styleText("green", option) + "\n";
        }
        output += "\n";
      }
      return output;
    },
  });
}

function createSubcommand(program: Command, command: ServerCommandName, execute: ExecuteServerCommand): void {
  const descriptions: Record<ServerCommandName, string> = {
    start: "Start the local Scope API and Portal",
    stop: "Stop the running local Scope Server",
    restart: "Stop and then start the local Scope Server",
    status: "Print the running local Scope Server status",
  };
  const subCommand = addServerOptions(program.command(command))
    .description(descriptions[command])
    .allowExcessArguments(false)
    .action(async function (this: Command) {
      await execute({ command, options: collectOptions(this) });
    });
  configureServerHelp(subCommand);
}

/**
 * Create the packaged Scope Server Commander program.
 *
 * The root action intentionally maps to `start` so existing `scope-server` invocations keep working.
 */
export function createServerProgram(execute: ExecuteServerCommand = executeServerCommand): Command {
  const program = addServerOptions(new Command())
    .name("scope-server")
    .description("Starts the local Scope API and Portal. Docker and Node.js 22+ are required.")
    .version(SERVER_VERSION)
    .showHelpAfterError()
    .showSuggestionAfterError(false)
    .allowExcessArguments(false)
    .configureOutput({
      outputError: (message, write) => write(errorText(message)),
    })
    .action(async () => {
      await execute({ command: "start", options: collectOptions(program) });
    });

  for (const command of SERVER_COMMANDS) createSubcommand(program, command, execute);
  program.addHelpText("after", "\nDefault command: start\n" +
    "Agent setup is also available later in Portal → Agents and scope agent setup.\n" +
    "Ctrl+C or scope-server stop stops owned services without removing persistent data.\n");
  configureServerHelp(program);
  program.exitOverride();
  return program;
}

async function dockerClient(): Promise<InstanceType<typeof Docker>> {
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint || process.env.DOCKER_CONTEXT) {
    try {
      const { stdout } = await exec(
        "docker",
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { timeout: 10_000 },
      );
      endpoint = stdout.trim();
    } catch (error) {
      if (!endpoint) {
        throw new Error(
          "Docker is required. Install/start a local Docker engine and ensure the docker command is on PATH.",
          { cause: error },
        );
      }
    }
  }
  if (!endpoint.startsWith("unix://")) {
    throw new Error(
      "Scope Server requires a local Unix-socket Docker engine because its persistent data uses host bind mounts.",
    );
  }
  const socketPath = endpoint.slice("unix://".length);
  return new Docker({ socketPath, timeout: 120_000 });
}

async function npmRegistry(): Promise<string> {
  const configured = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  const registry = configured || (await exec("npm", ["config", "get", "registry"], { timeout: 10_000 })).stdout.trim();
  const url = new URL(registry);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("npm registry must use HTTP or HTTPS");
  if (url.username || url.password) {
    throw new Error(
      "Do not embed npm credentials in the registry URL; use your npm registry authentication configuration.",
    );
  }
  return registry;
}

async function firstRun(agents: AgentManager, nonInteractive: boolean): Promise<void> {
  if (!nonInteractive && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("\nConfigure coding agents now, or press Enter to configure them later in Portal → Agents.");
      agents.controlStatus().agents.forEach((agent, index) => {
        console.log(`  ${index + 1}. ${agent.label} - ${agent.workerType}`);
      });
      const choices = (await prompt.question("Agent numbers (comma separated; Enter = later): ")).trim();
      const ids = choices ? choices.split(",").map(number => {
        const index = Number(number.trim()) - 1;
        if (!Number.isInteger(index) || !targetIds[index]) throw new Error(`Invalid agent choice: ${number}`);
        return targetIds[index];
      }) : [];
      for (const id of new Set(ids)) {
        let consent = false;
        if (id.endsWith("-host")) {
          const question = `${id} runs with YOUR files, permissions and existing CLI login. ` +
            "Allow this target? [y/N] ";
          consent = (await prompt.question(question)).trim().toLowerCase() === "y";
          if (!consent) continue;
        }
        agents.choose(id, consent);
      }
    } finally { prompt.close(); }
  }
  await agents.persist();
}

async function initializeData(data: string): Promise<void> {
  for (const directory of ["mongodb", "redis", "azurite", "vault", "gateway-cert", ...targetIds.map(id => `workspaces/${id}`)]) {
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

async function resolveLaunchPaths(options: ServerCliOptions): Promise<LaunchPaths> {
  const paths = serverPaths(options.dataDir);
  await preparePaths(paths);
  return { paths, runtimeFile: join(paths.runtime, "server.json") };
}

async function readRunningServer(runtimeFile: string): Promise<RunningServer> {
  const parsed: unknown = JSON.parse(await readFile(runtimeFile, "utf8"));
  return runningServer(parsed);
}

async function requestControl(command: Exclude<ServerCommandName, "start">, running: RunningServer): Promise<void> {
  const response = await fetch(new URL(command === "status" ? "health" : "stop", running.controlUrl), {
    method: command === "status" ? "GET" : "POST",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Launcher returned ${response.status}`);
  const status: unknown = await response.json();
  console.log(JSON.stringify(status, null, 2));
}

async function waitForLauncherStop(paths: ServerPaths): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { await readFile(join(paths.runtime, "launcher.lock"), "utf8"); }
    catch (error) { if (isMissing(error)) break; throw error; }
    await sleep(250);
  }
  if (Date.now() >= deadline) {
    throw new Error("Server is still stopping; inspect the launcher's output before restarting.");
  }
}

async function handleNonStartCommand(
  invocation: ServerCliInvocation,
  launch: LaunchPaths,
): Promise<LaunchPaths | undefined> {
  if (invocation.command === "start") return launch;
  let running: RunningServer;
  try {
    running = await readRunningServer(launch.runtimeFile);
  } catch (error) {
    if (isMissing(error)) {
      console.log("Scope Server is not running.");
      return undefined;
    }
    throw error;
  }
  try {
    await requestControl(invocation.command, running);
    if (invocation.command !== "status") await waitForLauncherStop(launch.paths);
  } catch (error) {
    throw new Error("The saved launcher is not responding. Start scope-server again to recover stopped services.", {
      cause: error,
    });
  }
  if (invocation.command !== "restart") return undefined;
  if (!invocation.options.dataDir) launch.paths.data = running.dataDir;
  await preparePaths(launch.paths);
  return launch;
}

async function connectEngine(runtime: Orchestrator): Promise<void> {
  // The initial Docker ping is bounded inside Orchestrator.connect so a stale socket cannot hang startup forever.
  await runtime.connect();
  // Ownership labels let startup remove only this launcher's stale containers while preserving host-backed data.
  await runtime.stop();
  await runtime.connect();
}

function requireStackOptions(options: StackOptions | undefined): StackOptions {
  if (!options) throw new Error("Server stack options are not initialized");
  return options;
}

async function createStackOptions(
  paths: ServerPaths,
  assets: string,
  manifest: AssetManifest,
  savedPorts: Awaited<ReturnType<typeof readPorts>>,
  options: ServerCliOptions,
  controlUrl: string,
): Promise<StackOptions> {
  return {
    source: join(assets, "source"),
    data: paths.data,
    manifest,
    registry: await npmRegistry(),
    controlUrl,
    apiPort: parsePort(options.apiPort) ?? savedPorts.api,
    portalPort: parsePort(options.portalPort) ?? savedPorts.portal,
  };
}

async function startBackend(
  runtime: Orchestrator,
  paths: ServerPaths,
  options: StackOptions,
  closing: () => boolean,
): Promise<StartedBackend | undefined> {
  if (!closing()) await runtime.start(backendServices(options));
  if (closing()) return undefined;

  const apiPort = await runtime.hostPort("api", 80);
  const portalPort = await runtime.hostPort("portal", 80);
  const mongodbPort = await runtime.hostPort("mongodb", 27017);
  const redisPort = await runtime.hostPort("redis", 6379);
  const azuriteBlobPort = await runtime.hostPort("azurite", 10000);
  const azuriteQueuePort = await runtime.hostPort("azurite", 10001);
  const judgePort = await runtime.hostPort("judge", 80);
  const tokenManagerPort = await runtime.hostPort("token-manager", 80);
  const gatewayPort = await runtime.hostPort("gateway", 18000);

  await writeJson(join(paths.config, "ports.json"), { api: apiPort, portal: portalPort });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  return {
    apiUrl,
    portalUrl: `http://127.0.0.1:${portalPort}`,
    hostEnv: {
      ...providerEnv(process.env),
      MONGO_CONNECTION_STRING: `mongodb://127.0.0.1:${mongodbPort}`,
      MONGO_DATABASE: "requests-db",
      MONGO_COLLECTION: "requests",
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: String(redisPort),
      REDIS_PASSWORD: "",
      AZURE_STORAGE_ACCOUNT_NAME: "devstoreaccount1",
      STORAGE_CONNECTION_STRING: storageConnection("127.0.0.1", azuriteBlobPort, azuriteQueuePort),
      SCOPE_MT_API_URL: apiUrl,
      JUDGE_SERVICE_URL: `http://127.0.0.1:${judgePort}`,
      TOKEN_MANAGER_URL: `http://127.0.0.1:${tokenManagerPort}`,
      PROXY_BACKEND: "gateway",
      DEV_PROXY_ENABLED: "true",
      DEV_PROXY_API_URL: `http://127.0.0.1:${gatewayPort}`,
      AZURE_STORAGE_QUEUE_POSTPROCESSOR: "post-processor-queue",
      ...buildEnvironment(options.manifest),
    },
  };
}

async function publishReadyStatus(status: ServerStatus, paths: ServerPaths, agents: AgentManager): Promise<void> {
  status.status = "ready";
  console.log(`\n${banner("Scope Server is ready.")}\n` +
    `${label("Portal:")} ${value(status.portalUrl ?? "")}\n` +
    `${label("API:")} ${value(status.apiUrl ?? "")}\n` +
    `${label("Data:")} ${value(paths.data)}`);
  console.log(`\n${banner("Connect your packaged Scope CLI:")}\n` +
    `  ${value(`scope env add local --url ${status.apiUrl ?? ""}`)}\n` +
    `  ${value("scope env use local")}\n` +
    "Configure agents in Portal → Agents. Ctrl+C stops services; your data is retained.");
  for (const agent of agents.snapshot().agents) {
    if (agent.error) console.error(`${errorText(`[${agent.workerType}] Setup failed:`)} ${agent.error}`);
  }
}

async function shutDown(context: CleanupContext): Promise<void> {
  const errors: unknown[] = [];
  try { if (context.backendReady) await context.agents?.close(); } catch (error) { errors.push(error); }
  // Shutdown is label-scoped: it may remove owned containers, but never the persistent bind-mounted data roots.
  try { if (context.engineConnected) await context.orchestrator?.stop(); } catch (error) { errors.push(error); }
  try { await context.control?.close(); } catch (error) { errors.push(error); }
  await rm(context.runtimeFile, { force: true });
  await context.release();
  if (errors.length) {
    const cleanupError = new AggregateError(errors, "Scope stopped with cleanup errors; persistent data was retained");
    if (context.startupError) console.error(cleanupError.message);
    else throw cleanupError;
  }
}

async function executeServerCommand(invocation: ServerCliInvocation): Promise<void> {
  const initialLaunch = await resolveLaunchPaths(invocation.options);
  const launch = await handleNonStartCommand(invocation, initialLaunch);
  if (!launch) return;
  await startLauncher(launch, invocation.options);
}

async function startLauncher(launch: LaunchPaths, cliOptions: ServerCliOptions): Promise<void> {
  const release = await acquireLock(launch.paths);
  const dist = dirname(fileURLToPath(import.meta.url));
  const assets = join(dist, "../assets");
  let orchestrator: Orchestrator | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let agents: AgentManager | undefined;
  let closing = false;
  let engineConnected = false;
  let backendReady = false;
  let startupError: unknown;
  const status: ServerStatus = { status: "starting", dataDir: launch.paths.data };
  let requestStop: () => void = () => {};
  const stopped = new Promise<void>(resolve => {
    requestStop = () => { closing = true; orchestrator?.cancel(); resolve(); };
  });
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    const manifest = await readAssetManifest(assets);
    const savedPorts = await readPorts(launch.paths.config);
    const docker = await dockerClient();
    orchestrator = new Orchestrator(docker, launch.paths.owner, event => {
      console.log(`${label(`[${event.service}]`)} ${value(event.phase)}${event.message ? ` ${event.message}` : ""}`);
    });
    const runtime = orchestrator;
    await initializeData(launch.paths.data);
    let stackOptions: StackOptions | undefined;
    let hostEnv: Record<string, string> = {};
    const hosts = new HostWorkers(dist, launch.paths.data, (id, error) => {
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
        : `claude-agent-acp-${manifest.versions.CLAUDE_CODE_ACP_VERSION}` +
          `-sdk-${manifest.versions.CLAUDE_AGENT_SDK_VERSION}`;
      await registerAgent(status.apiUrl, assets, id, manifest, version, manifest.versions);
      const scanner = modelScanner(id, requireStackOptions(stackOptions));
      await runtime.startService(scanner);
      await registerModels(status.apiUrl, id, parseScannerModels(await runtime.output(scanner.name)));
      await runtime.startService(dockerWorker(id, requireStackOptions(stackOptions)));
      await setAgentAvailable(status.apiUrl, id, true);
      return { version };
    };
    agents = new AgentManager(launch.paths.config, startAgent, stopAgent);
    if (!await agents.load()) await firstRun(agents, cliOptions.nonInteractive ?? false);
    await connectEngine(runtime);
    engineConnected = true;
    const address = controlAddress(
      process.platform,
      process.platform === "linux" ? await runtime.bridgeGateway() : undefined,
    );
    control = await startControl(agents, () => status, requestStop, address.listenHost);
    stackOptions = await createStackOptions(
      launch.paths,
      assets,
      manifest,
      savedPorts,
      cliOptions,
      `http://${address.containerHost}:${control.port}/`,
    );
    await writeJson(launch.runtimeFile, {
      pid: process.pid,
      controlUrl: `http://${address.listenHost}:${control.port}/`,
      dataDir: launch.paths.data,
    });
    const started = await startBackend(runtime, launch.paths, stackOptions, () => closing);
    if (started) {
      status.apiUrl = started.apiUrl;
      status.portalUrl = started.portalUrl;
      hostEnv = started.hostEnv;
      backendReady = true;
      await agents.activate();
      await publishReadyStatus(status, launch.paths, agents);
      await stopped;
    }
  } catch (error) {
    startupError = error;
    if (!closing) throw error;
  } finally {
    closing = true;
    status.status = "stopping";
    try {
      await shutDown({
        backendReady,
        agents,
        engineConnected,
        orchestrator,
        control,
        runtimeFile: launch.runtimeFile,
        release,
        startupError,
      });
    } finally {
      // npx may forward a second terminal signal while asynchronous cleanup is still running.
      process.off("SIGINT", requestStop);
      process.off("SIGTERM", requestStop);
    }
  }
}

/** Parse process arguments and execute the requested packaged server command. */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  try {
    await createServerProgram().parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

runCli().catch((error: unknown) => {
  console.error(errorText("Error:"), error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
