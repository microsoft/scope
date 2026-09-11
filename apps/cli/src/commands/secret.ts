// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { NetworkError } from "ky";
import {
  PORTAL_AI_PROVIDERS, parseAzureAiFoundrySecret, parseOpenAiSecret, withRetry,
  type CreateKeyRequest, type KeyDocument, type KeyType, type KeyValidationResult,
  type PortalAiSettings, type UpdateKeyRequest,
} from "shared";
import { ApiError, apiFetch, readApiError, type ApiFetchInit } from "../utils/api-client.js";
import { formatData } from "../utils/formatters.js";
import { configureHelp } from "../utils/helpFormatter.js";
import { getDefaultApiUrl, withOutputOption } from "../utils/shared.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";

const KEY_TYPES: KeyType[] = [
  "github-pat-classic", "github-pat-fine-grained", "github-oauth", "github-oauth-cookie-state",
  "anthropic-api-key", "anthropic-oauth", "azure-ai-foundry",
  "openai-api-key", "openrouter-api-key", "openai-compatible",
];
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
const providerFields: DisplayField<PortalAiSettings>[] = [
  { key: "provider", label: "Provider" }, { key: "keyId", label: "Key ID" }, { key: "model", label: "Model" },
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
  // work. Only reads and idempotent metadata/settings replacements retry.
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
  if (!KEY_TYPES.includes(options.type as KeyType)) throw new Error(`Invalid key type. Choose ${KEY_TYPES.join(", ")}.`);
  const sources = [options.value !== undefined, options.valueStdin, options.apiKey !== undefined, options.apiKeyStdin].filter(Boolean);
  if (sources.length !== 1) throw new Error("Provide exactly one of --value, --value-stdin, --api-key, or --api-key-stdin.");
  const type = options.type as KeyType;
  let value = options.valueStdin || options.apiKeyStdin ? readStdin() : options.value ?? options.apiKey ?? "";
  if (!value.trim()) throw new Error("A nonempty credential is required.");
  const structured = ["azure-ai-foundry", "openai-api-key", "openrouter-api-key", "openai-compatible"].includes(type);
  if (options.value !== undefined || options.valueStdin) {
    if (options.endpoint !== undefined || options.model !== undefined) throw new Error("--value contains the full secret; use --api-key with --endpoint/--model instead.");
  } else if (structured) {
    const endpoint = options.endpoint ?? (type === "openai-api-key" ? "https://api.openai.com/v1" : type === "openrouter-api-key" ? "https://openrouter.ai/api/v1" : undefined);
    const model = options.model ?? (type === "openai-api-key" ? "gpt-4.1" : type === "openrouter-api-key" ? "openai/gpt-4.1" : undefined);
    value = JSON.stringify({ endpoint, apiKey: value, ...(model ? { model } : {}) });
  } else if (options.endpoint !== undefined || options.model !== undefined) {
    throw new Error("--endpoint/--model apply only to structured provider credentials.");
  }
  if (structured) {
    const parsed = type === "azure-ai-foundry" ? parseAzureAiFoundrySecret(value) : parseOpenAiSecret(value);
    if (!parsed) throw new Error(type === "azure-ai-foundry"
      ? "Foundry credentials require endpoint and apiKey (model is optional)."
      : "Provider credentials require endpoint, apiKey and model. Use HTTPS; HTTP is allowed only for localhost.");
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
    .option("--value <value>", "Raw secret, or complete JSON for structured provider credentials")
    .option("--value-stdin", "Read the raw secret or complete JSON from piped stdin")
    .option("--api-key <key>", "Provider API key (prefer --api-key-stdin to avoid shell history)")
    .option("--api-key-stdin", "Read the provider API key from piped stdin")
    .option("--endpoint <url>", "Provider endpoint; OpenAI/OpenRouter have presets")
    .option("--model <model>", "Provider model; OpenAI/OpenRouter have presets")
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

  const portal = secret.command("portal-ai").description("Read/set the instance-wide Portal AI provider (not worker or Judge settings)");
  configureHelp(portal);
  portal.action(() => { portal.help(); });
  withOutputOption(portal.command("show").option("-u, --url <url>", "API base URL", getDefaultApiUrl()))
    .action(async (options: ConnectionOptions) => {
      const data: PortalAiSettings = await (await request(options.url, "/keys/portal-ai")).json();
      console.log(formatData([data], providerFields, options.output));
    });
  withOutputOption(portal.command("set").argument("<provider>", PORTAL_AI_PROVIDERS.join(", "))
    .option("--key-id <id>", "Pin a registered valid key instead of provider round-robin")
    .option("--model <model>", "Override the Portal authoring model")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl()))
    .action(async (provider: string, options: ConnectionOptions & { keyId?: string; model?: string }) => {
      if (!PORTAL_AI_PROVIDERS.includes(provider as PortalAiSettings["provider"])) throw new Error(`Choose a provider: ${PORTAL_AI_PROVIDERS.join(", ")}.`);
      if (provider === "auto" && (options.keyId !== undefined || options.model !== undefined)) throw new Error("Automatic selection does not accept --key-id or --model.");
      if ((options.keyId !== undefined && !options.keyId.trim()) || (options.model !== undefined && !options.model.trim())) throw new Error("Key ID and model must not be blank.");
      const body: PortalAiSettings = {
        provider: provider as PortalAiSettings["provider"],
        ...(options.keyId !== undefined ? { keyId: options.keyId.trim() } : {}),
        ...(options.model !== undefined ? { model: options.model.trim() } : {}),
      };
      const data: PortalAiSettings = await (await request(options.url, "/keys/portal-ai", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).json();
      console.log(formatData([data], providerFields, options.output));
    });
}
