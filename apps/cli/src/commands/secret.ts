// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { NetworkError } from "ky";
import {
  isKeyType, KEY_TYPES, parseAzureAiFoundrySecret,
  type CreateKeyRequest, type KeyDocument, type KeyValidationResult,
  type UpdateKeyRequest,
} from "shared/token-manager";
// Subpath imports keep server-only code (Redis, Mongo, Azure SDKs) out of the CLI bundle.
import { withRetry } from "shared/retry";
import { ApiError, apiFetch, readApiError, type ApiFetchInit } from "../utils/api-client.js";
import { formatData } from "../utils/formatters.js";
import { configureHelp } from "../utils/helpFormatter.js";
import { getDefaultApiUrl, withOutputOption } from "../utils/shared.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";

type KeyMetadata = Pick<KeyDocument, "_id" | "type" | "enabled" | "capabilities" | "lastValidationStatus" | "lastValidationError" | "comment">;
const keyFields: DisplayField<KeyMetadata>[] = [
  { key: "_id", label: "ID" }, { key: "type", label: "Type" },
  { key: "enabled", label: "Enabled" }, { key: "lastValidationStatus", label: "Validation" },
  { key: "capabilities", label: "Capabilities", formatter: (key) => key.capabilities?.join(", ") ?? "" },
  { key: "comment", label: "Comment" }, { key: "lastValidationError", label: "Error" },
];
const validationFields: DisplayField<KeyValidationResult>[] = [
  { key: "status", label: "Status" }, { key: "capabilities", label: "Capabilities", formatter: (result) => result.capabilities?.join(", ") ?? "" },
  { key: "error", label: "Error" },
];
interface ConnectionOptions { url: string; output: OutputFormat }
interface CredentialOptions extends ConnectionOptions {
  type: string;
  value?: string;
  valueStdin?: boolean;
  apiKey?: string;
  apiKeyStdin?: boolean;
  endpoint?: string;
  model?: string;
  enabled?: boolean;
  comment?: string;
  expiresAt?: string;
}

async function request(url: string, path: string, init?: ApiFetchInit): Promise<Response> {
  const send = async () => {
    const response = await apiFetch(url, path, init);
    if (!response.ok) throw await readApiError(response);
    return response;
  };
  // Creates and validation probes may store a second key or repeat provider
  // work. Only reads and idempotent metadata replacements retry.
  return !init?.method || init.method === "GET" || init.method === "PUT"
    ? withRetry(send, {
      maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000,
      isRetryable: (error: unknown) => error instanceof TypeError || error instanceof NetworkError
        || (error instanceof ApiError && [429, 500, 502, 503, 504].includes(error.status)),
    })
    : send();
}

function readStdin(): string {
  if (process.stdin.isTTY) throw new Error("Pipe the credential on stdin; interactive credential entry is not supported.");
  return readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

function credential(options: CredentialOptions): CreateKeyRequest {
  if (!isKeyType(options.type)) throw new Error(`Invalid key type. Choose ${KEY_TYPES.join(", ")}.`);
  const sources = [options.value !== undefined, options.valueStdin, options.apiKey !== undefined, options.apiKeyStdin].filter(Boolean);
  if (sources.length !== 1) throw new Error("Provide exactly one of --value, --value-stdin, --api-key, or --api-key-stdin.");
  if (options.value !== undefined) console.error("Warning: --value exposes secrets in shell history and process listings; prefer --value-stdin.");
  if (options.apiKey !== undefined) console.error("Warning: --api-key exposes secrets in shell history and process listings; prefer --api-key-stdin.");
  const type = options.type;
  let value = options.valueStdin || options.apiKeyStdin ? readStdin() : options.value ?? options.apiKey ?? "";
  if (!value.trim()) throw new Error("A nonempty credential is required.");
  const structured = type === "azure-ai-foundry";
  if (options.value !== undefined || options.valueStdin) {
    if (options.endpoint !== undefined || options.model !== undefined) throw new Error("--value contains the full secret; use --api-key with --endpoint/--model instead.");
  } else if (structured) {
    value = JSON.stringify({ endpoint: options.endpoint, apiKey: value, ...(options.model ? { model: options.model } : {}) });
  } else if (options.endpoint !== undefined || options.model !== undefined) {
    throw new Error("--endpoint/--model apply only to Azure AI Foundry credentials.");
  }
  if (structured) {
    const parsed = parseAzureAiFoundrySecret(value);
    if (!parsed) throw new Error("Foundry credentials require endpoint and apiKey (model is optional).");
    value = JSON.stringify(parsed);
  }
  if (options.expiresAt !== undefined && !Number.isFinite(Date.parse(options.expiresAt))) throw new Error("--expires-at must be a valid date.");
  return {
    type, value,
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.comment !== undefined ? { comment: options.comment } : {}),
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  };
}

function credentialOptions(command: Command): Command {
  return withOutputOption(command
    .requiredOption("--type <type>", `Credential type: ${KEY_TYPES.join(", ")}`)
    .option("--value <value>", "Raw secret, or complete JSON for Azure AI Foundry credentials")
    .option("--value-stdin", "Read the raw secret or complete JSON from piped stdin")
    .option("--api-key <key>", "Provider API key (prefer --api-key-stdin to avoid shell history)")
    .option("--api-key-stdin", "Read the provider API key from piped stdin")
    .option("--endpoint <url>", "Azure AI Foundry inference endpoint")
    .option("--model <model>", "Azure AI Foundry deployment/model name")
    .option("-u, --url <url>", "Scope API base URL", getDefaultApiUrl()));
}

export function registerSecretCommands(program: Command): void {
  const secret = program.command("secret").description("Manage provider credentials through Secrets/Token Manager");
  configureHelp(secret);
  secret.action(() => { secret.help(); });

  withOutputOption(secret.command("list").description("List key metadata, never secret values")
    .option("--capability <capability>", "Filter by capability")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl()))
    .action(async (options: ConnectionOptions & { capability?: string }) => {
      const query = options.capability ? `?capability=${encodeURIComponent(options.capability)}` : "";
      const data: KeyMetadata[] = await (await request(options.url, `/keys${query}`)).json();
      console.log(formatData(data, keyFields, options.output));
    });

  withOutputOption(secret.command("get").argument("<id>").description("Get key metadata without retrieving its value")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl()))
    .action(async (id: string, options: ConnectionOptions) => {
      const data: KeyMetadata = await (await request(options.url, `/keys/${encodeURIComponent(id)}`)).json();
      console.log(formatData([data], keyFields, options.output));
    });

  credentialOptions(secret.command("create").description("Store a new credential; validation runs on the server")
    .option("--no-enabled", "Store the credential disabled")
    .option("--comment <text>", "Metadata annotation")
    .option("--expires-at <date>", "Credential expiration date"))
    .action(async (options: CredentialOptions) => {
      const body = credential(options);
      const data: KeyMetadata = await (await request(options.url, "/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), sensitiveBody: true,
      })).json();
      console.log(formatData([data], keyFields, options.output));
    });

  credentialOptions(secret.command("preview").description("Validate a credential with its provider without storing it"))
    .action(async (options: CredentialOptions) => {
      const body = credential(options);
      const data: KeyValidationResult = await (await request(options.url, "/keys/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: body.type, value: body.value }), sensitiveBody: true,
      })).json();
      console.log(formatData([data], validationFields, options.output));
    });

  withOutputOption(secret.command("update").argument("<id>").description("Update metadata; secret values are immutable")
    .option("--enable", "Enable the key").option("--disable", "Disable the key")
    .option("--comment <text>", "Set comment (empty clears it)")
    .option("--expires-at <date>", "Set expiration").option("--clear-expiry", "Clear expiration")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl()))
    .action(async (id: string, options: ConnectionOptions & { enable?: boolean; disable?: boolean; comment?: string; expiresAt?: string; clearExpiry?: boolean }) => {
      if (options.enable && options.disable) throw new Error("Pass --enable or --disable, not both.");
      if (options.clearExpiry && options.expiresAt !== undefined) throw new Error("Pass --expires-at or --clear-expiry, not both.");
      if (options.expiresAt !== undefined && !Number.isFinite(Date.parse(options.expiresAt))) throw new Error("--expires-at must be a valid date.");
      const body: UpdateKeyRequest = {
        ...(options.enable || options.disable ? { enabled: options.enable === true } : {}),
        ...(options.comment !== undefined ? { comment: options.comment || null } : {}),
        ...(options.clearExpiry ? { expiresAt: null } : options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      };
      if (!Object.keys(body).length) throw new Error("Provide a metadata field to update.");
      const data: KeyMetadata = await (await request(options.url, `/keys/${encodeURIComponent(id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).json();
      console.log(formatData([data], keyFields, options.output));
    });

  secret.command("delete").argument("<id>").description("Soft-delete a key")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id: string, options: { url: string }) => {
      await request(options.url, `/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      console.log(`Key ${id} deleted.`);
    });

  withOutputOption(secret.command("validate").argument("<id>").description("Revalidate an existing key")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl()))
    .action(async (id: string, options: ConnectionOptions) => {
      const data: KeyMetadata = await (await request(options.url, `/keys/${encodeURIComponent(id)}/validate`, { method: "POST", sensitiveBody: true })).json();
      console.log(formatData([data], keyFields, options.output));
    });
}
