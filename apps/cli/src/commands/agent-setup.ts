// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { NetworkError } from "ky";
import { stringify as stringifyYaml } from "yaml";
import { withRetry } from "shared";
import {
  ConfigureServerAgentSchema,
  ServerStatusSchema,
  ServerWorkerTypeSchema,
  type ServerAgentStatus,
  type ServerStatus,
  type ServerWorkerType,
} from "shared/server";
import { ApiError, apiFetch, readApiError } from "../utils/api-client.js";
import { formatData } from "../utils/formatters.js";
import { getDefaultApiUrl, withOutputOption } from "../utils/shared.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";

const fields: DisplayField<ServerAgentStatus>[] = [
  { key: "workerType", label: "Worker" },
  { key: "label", label: "Agent" },
  { key: "runtime", label: "Runtime" },
  { key: "enabled", label: "Enabled" },
  { key: "available", label: "Available" },
  { key: "executable", label: "Executable" },
  { key: "version", label: "Version" },
  { key: "error", label: "Error" },
];

/** Print setup state using the requested output format, with a friendly disabled message. */
function printStatus(status: ServerStatus, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(status, null, 2));
  } else if (output === "yaml") {
    console.log(stringifyYaml(status).trimEnd());
  } else if (!status.enabled && output === "table") {
    console.log("Local agent setup is not enabled on this server.");
  } else {
    console.log(formatData(status.agents, fields, output));
  }
}

/** Parse and validate the local-server setup status returned by the API. */
async function readStatus(response: Response): Promise<ServerStatus> {
  if (!response.ok) throw await readApiError(response);
  const data: unknown = await response.json();
  return ServerStatusSchema.parse(data);
}

/** Read setup status with short retries for transient launcher/API availability gaps. */
async function fetchStatus(url: string, signal = AbortSignal.timeout(30_000)): Promise<ServerStatus> {
  return withRetry(
    async () => {
      signal.throwIfAborted();
      return readStatus(await apiFetch(url, "/server", { signal }));
    },
    {
      maxRetries: 2,
      baseDelayMs: 250,
      maxDelayMs: 2000,
      isRetryable: (error: unknown) =>
        !signal.aborted &&
        (
          error instanceof TypeError ||
          error instanceof NetworkError ||
          (error instanceof ApiError && [429, 500, 502, 503, 504].includes(error.status))
        ),
    },
  );
}

interface StatusOptions { url: string; output: OutputFormat }
interface SetupOptions extends StatusOptions {
  enable?: boolean;
  disable?: boolean;
  executable?: string;
  consent?: boolean;
  wait?: boolean;
  timeout: number;
}

/** Poll after an accepted setup mutation without replaying the mutation itself. */
async function waitForSetup(
  initial: ServerStatus,
  worker: ServerWorkerType,
  options: SetupOptions,
): Promise<ServerStatus> {
  const deadline = Date.now() + options.timeout * 1000;
  const timeoutMessage = `Timed out waiting for ${worker}. ` +
    "Setup may still be running; inspect `agent status` before retrying setup.";
  let status = initial;
  while (true) {
    if (!status.enabled) throw new Error("Local agent setup is not enabled on this server.");
    const target = status.agents.find((entry) => entry.workerType === worker);
    if (!target) throw new Error(`Server status did not include ${worker}.`);
    if (target.error) throw new Error(target.error);
    if ((options.disable && !target.enabled) || (options.enable && target.enabled && target.available)) return status;
    if (options.enable && !target.enabled) throw new Error(`${worker} was disabled before becoming available.`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(timeoutMessage);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
    const readTimeout = deadline - Date.now();
    if (readTimeout <= 0) throw new Error(timeoutMessage);
    try {
      status = await fetchStatus(
        options.url,
        AbortSignal.timeout(Math.max(1, Math.min(30_000, Math.ceil(readTimeout)))),
      );
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      throw error;
    }
  }
}

/** Register `scope agent status/setup` local-server setup commands. */
export function registerAgentSetupCommands(agent: Command): void {
  withOutputOption(
    agent.command("status")
      .description("Show local server host/Docker agent setup, discovery and errors")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (options: StatusOptions) => {
    const status = await fetchStatus(options.url);
    printStatus(status, options.output);
  });

  withOutputOption(
    agent.command("setup")
      .description("Enable or disable a local server coding agent")
      .argument("<workerType>", `Worker type: ${ServerWorkerTypeSchema.options.join(", ")}`)
      .option("--enable", "Enable this worker")
      .option("--disable", "Disable this worker")
      .option("--executable <path>", "Installed executable for a host worker")
      .option("--consent", "Allow this host worker to execute on your machine using its existing login")
      .option("--wait", "Poll status until the target is available, disabled, or reports an error")
      .option("--timeout <seconds>", "Maximum wait after setup is accepted", Number, 300)
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (worker: string, options: SetupOptions) => {
    const parsed = ServerWorkerTypeSchema.safeParse(worker);
    if (!parsed.success) {
      throw new Error(`Unknown worker type "${worker}". Choose ${ServerWorkerTypeSchema.options.join(", ")}.`);
    }
    if (Boolean(options.enable) === Boolean(options.disable)) {
      throw new Error("Pass exactly one of --enable or --disable.");
    }
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
      throw new Error("--timeout must be a positive number of seconds.");
    }
    if ((options.executable !== undefined || options.consent) && (!options.enable || !parsed.data.endsWith("-host"))) {
      throw new Error("--executable and --consent are only valid when enabling a host worker.");
    }
    const body = ConfigureServerAgentSchema.parse({
      enabled: options.enable === true,
      ...(options.executable !== undefined ? { executable: options.executable } : {}),
      ...(options.consent ? { consent: true } : {}),
    });
    // A setup mutation may start an image build or a host process. Do not replay
    // it on transport/5xx failures; users can inspect `agent status` before retrying.
    let status = await readStatus(await apiFetch(options.url, `/server/agents/${encodeURIComponent(parsed.data)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    if (options.wait) {
      if (options.output === "table") console.error(`Waiting for ${parsed.data} setup...`);
      status = await waitForSetup(status, parsed.data, options);
    }
    printStatus(status, options.output);
    if (!status.enabled) throw new Error("Local agent setup is not enabled on this server.");
    const configured = status.agents.find((entry) => entry.workerType === parsed.data);
    if (configured?.error) throw new Error(configured.error);
  });
}
