// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Token Manager — Shared Type Definitions
 *
 * These types are shared between the Token Manager service and its clients
 * (workers, judge, API proxy).
 */
/**
 * The kind of credential stored (key format).
 */
export type KeyType =
  "github-pat-classic" | "github-pat-fine-grained" | "github-oauth" | "github-oauth-cookie-state" | "anthropic-api-key" | "anthropic-oauth" | "azure-ai-foundry";

/**
 * What a key can do — derived from (type + detected scopes/permissions).
 * Workers acquire keys by capability, not by type.
 */
export type KeyCapability =
  "github-models" | "github-public-api" | "copilot-models" | "copilot-sdk" | "copilot-cli" | "claude-code-cli" | "anthropic-api" | "azure-ai-inference";

/**
 * Validation status of a key.
 */
export type KeyValidationStatus =
  | "valid"
  | "invalid"
  | "expired"
  | "error"
  | "unknown";

/**
 * Key metadata stored in MongoDB. Secret values are never stored here —
 * they live in Azure KeyVault (or in-memory store for local dev).
 */
export interface KeyDocument {
  _id: string;
  type: KeyType;
  /** Auto-detected capabilities based on key type and validated scopes/permissions. */
  capabilities: KeyCapability[];
  /** Auto-derived: token-{type}-{_id.substring(0,8)} */
  secretName: string;
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastValidationStatus: KeyValidationStatus;
  lastValidationError?: string;
  enabled: boolean;
  /** Optional free-text annotation (e.g. "John's CI key"). */
  comment?: string;
  /** Number of times this key has been acquired via /acquire. */
  acquireCount: number;
  /** Timestamp of the last acquisition. */
  lastAcquiredAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

/**
 * Response from POST /api/v1/keys/acquire.
 * Only returned to internal callers (workers inside the cluster).
 */
export interface AcquireKeyResponse {
  value: string;
  keyId: string;
  keyType: KeyType;
  capability: KeyCapability;
  expiresAt?: Date;
}

/**
 * Result of validating a key against its provider's API.
 */
export interface KeyValidationResult {
  status: KeyValidationStatus;
  scopes?: string[];
  capabilities?: KeyCapability[];
  expiresAt?: Date;
  error?: string;
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: Date;
  };
}

/**
 * Request body for POST /api/v1/keys.
 * Capabilities are auto-detected during validation — not user-specified.
 */
export interface CreateKeyRequest {
  type: KeyType;
  value: string;
  expiresAt?: string;
  enabled?: boolean;
  comment?: string;
}

/**
 * Request body for PUT /api/v1/keys/:id.
 * Only metadata — secret value is immutable.
 */
export interface UpdateKeyRequest {
  enabled?: boolean;
  expiresAt?: string | null;
  comment?: string | null;
}

/**
 * Request body for POST /api/v1/keys/acquire.
 */
export interface AcquireKeyRequest {
  capability: KeyCapability;
  /** Optional: prefer keys of this type. Falls back to any type if none available. */
  keyType?: KeyType;
}

/**
 * Maps each KeyCapability to the environment variable that workers check
 * for a local fallback (e.g., Docker Compose with env vars).
 */
export const KEY_CAPABILITY_ENV_VARS: Record<KeyCapability, string> = {
  "copilot-sdk": "GITHUB_TOKEN",
  "copilot-cli": "GITHUB_TOKEN",
  "copilot-models": "GITHUB_TOKEN",
  "github-models": "GITHUB_TOKEN",
  "github-public-api": "GITHUB_TOKEN",
  "claude-code-cli": "ANTHROPIC_API_KEY",
  "anthropic-api": "ANTHROPIC_API_KEY",
  // The API does its own resolution for azure-ai-inference (it needs the
  // endpoint AND the key, not just one env var). This entry keeps the
  // capability matrix exhaustive; the env-var path is intentionally not
  // wired up to a single string because the credential is a JSON blob.
  "azure-ai-inference": "AZURE_AI_INFERENCE_API_KEY",
};

/**
 * Shape of the secret stored for `azure-ai-foundry` key types.
 * The value field in CreateKeyRequest is a JSON-stringified version of this.
 */
export interface AzureAiFoundrySecretValue {
  /** Base endpoint URL (e.g. https://<resource>.services.ai.azure.com/models). */
  endpoint: string;
  /** Resource API key. */
  apiKey: string;
  /** Optional deployment / model name override (e.g. gpt-4.1-mini). */
  model?: string;
}

/**
 * Remove all trailing forward slashes from a string. Used to normalize
 * user-supplied endpoint URLs/paths before appending suffixes.
 */
export function trimTrailingSlashes(value: string): string {
  let result = value;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Parse a JSON-encoded Foundry secret value. Returns null when the input
 * is not a well-formed AzureAiFoundrySecretValue.
 */
export function parseAzureAiFoundrySecret(raw: string): AzureAiFoundrySecretValue | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "endpoint" in parsed &&
      "apiKey" in parsed &&
      typeof parsed.endpoint === "string" &&
      typeof parsed.apiKey === "string" &&
      parsed.endpoint.trim() !== "" &&
      parsed.apiKey.trim() !== ""
    ) {
      return {
        endpoint: trimTrailingSlashes(parsed.endpoint.trim()),
        apiKey: parsed.apiKey.trim(),
        model:
          "model" in parsed && typeof parsed.model === "string" && parsed.model.trim()
            ? parsed.model.trim()
            : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Derive the KeyVault secret name from a key's type and ID.
 */
export function deriveSecretName(type: KeyType, id: string): string {
  return `token-${type}-${id.substring(0, 8)}`;
}

// =============================================================================
// Accounts — credential storage for key-updater automation
// =============================================================================

/**
 * The kind of service account stored.
 */
export type AccountType = "github";

/**
 * Account metadata stored in MongoDB. Secret values (username, password,
 * totpUri) are stored as a single JSON blob in Azure KeyVault.
 */
export interface AccountDocument {
  _id: string;
  type: AccountType;
  /** Auto-derived: account-{type}-{_id.substring(0,8)} */
  secretName: string;
  enabled: boolean;
  /** Optional free-text annotation (e.g. "CI bot account"). */
  comment?: string;
  /** Number of times this account has been acquired via /acquire. */
  acquireCount: number;
  /** Timestamp of the last acquisition. */
  lastAcquiredAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

/**
 * The secret value stored in KeyVault for an account.
 * All fields are sensitive — none are stored in MongoDB.
 */
export interface AccountSecretValue {
  username: string;
  password: string;
  /** Full otpauth:// URI (preserves issuer, algorithm, digits, period). */
  totpUri: string;
}

/**
 * Request body for POST /api/v1/accounts.
 */
export interface CreateAccountRequest {
  type: AccountType;
  username: string;
  password: string;
  /** Full otpauth:// URI or bare base32 secret. */
  totpUri: string;
  enabled?: boolean;
  comment?: string;
}

/**
 * Request body for PUT /api/v1/accounts/:id.
 */
export interface UpdateAccountRequest {
  enabled?: boolean;
  comment?: string | null;
  /** If provided, rotates the secrets in KeyVault. */
  username?: string;
  password?: string;
  totpUri?: string;
}

/**
 * Request body for POST /api/v1/accounts/acquire.
 */
export interface AcquireAccountRequest {
  type: AccountType;
}

/**
 * Response from POST /api/v1/accounts/acquire.
 * Returns the account's secret credentials.
 */
export interface AcquireAccountResponse {
  accountId: string;
  type: AccountType;
  username: string;
  password: string;
  totpUri: string;
}

/**
 * Derive the KeyVault secret name from an account's type and ID.
 */
export function deriveAccountSecretName(type: AccountType, id: string): string {
  return `account-${type}-${id.substring(0, 8)}`;
}
