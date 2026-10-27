// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Value-based secret redaction for run logs (issue #1141).
 *
 * Name-based filters (e.g. the ACP workers' `formatToolArgs`) only catch a
 * secret stored under a sensitive-looking key. This module inspects the
 * *value*, so a token is caught wherever it appears — inside a `command`
 * argument, a free-text message, or a nested `data` field.
 *
 * It is applied once, centrally, in `LogPublisher` / `RedisLogPublisher`, the
 * boundary where log lines are persisted to Blob storage and fanned out to
 * SSE subscribers via Redis.
 *
 * The rule set is a small, curated subset of high-confidence token shapes in
 * the spirit of OWASP `secrets-patterns-db` (the corpus behind Gitleaks and
 * TruffleHog): every rule matches a distinctive prefix or structure, so false
 * positives on ordinary debug output stay rare. Generic high-entropy and PII
 * detection are intentionally not included yet.
 */

/** One value-based detection rule. */
interface SecretRule {
  /** Stable rule id, shown in the replacement marker (`[REDACTED:<id>]`). */
  id: string;
  /** Global regex. When it has a `prefix` named group, that part is kept. */
  pattern: RegExp;
}

/**
 * Curated high-confidence secret patterns. Order matters: broader structures
 * (PEM blocks, connection strings) run before the token shapes they contain.
 */
const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { id: "azure-storage-key", pattern: /(?<prefix>\bAccountKey=)[A-Za-z0-9+/]{40,}={0,2}/g },
  // SAS signature only — the rest of the blob URL stays readable for debugging.
  { id: "azure-sas-signature", pattern: /(?<prefix>[?&]sig=)[A-Za-z0-9%+/=]{16,}/g },
  { id: "authorization-bearer", pattern: /(?<prefix>\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  // Covers OpenAI (`sk-`, `sk-proj-`) and Anthropic (`sk-ant-`) API keys.
  { id: "openai-anthropic-key", pattern: /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{34,}\b/g },
];

/**
 * Cheap substring pre-filter. A string containing none of these can't match
 * any rule, so the common case (ordinary log text) skips every regex.
 */
const RULE_HINTS: readonly string[] = [
  "PRIVATE KEY", "AccountKey=", "sig=", "Bearer", "eyJ", "AKIA", "ASIA", "ABIA", "ACCA",
  "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xox", "_live_", "_test_", "sk-", "AIza", "npm_", "hf_",
];

/** Maximum nesting depth walked by {@link redactLogData}; deeper values are kept as-is. */
const MAX_DATA_DEPTH = 8;

/**
 * Replace every known secret shape in `text` with `[REDACTED:<rule-id>]`.
 * A rule's `prefix` group (e.g. `Bearer `, `AccountKey=`) is preserved so the
 * line still shows *what kind* of value was removed.
 *
 * @param text - Arbitrary log text.
 * @returns The text with secrets replaced; the same string when nothing matched.
 */
export function redactSecrets(text: string): string {
  if (!RULE_HINTS.some((hint) => text.includes(hint))) return text;

  let result = text;
  for (const rule of SECRET_RULES) {
    result = result.replace(rule.pattern, (...args: unknown[]) => {
      // The last replacer argument is the named-groups object when the regex has any.
      const groups = args[args.length - 1] as { prefix?: string } | undefined;
      const prefix = typeof groups === "object" && groups?.prefix ? groups.prefix : "";
      return `${prefix}[REDACTED:${rule.id}]`;
    });
  }
  return result;
}

/**
 * Deep-copy `value`, applying {@link redactSecrets} to every string inside
 * plain objects and arrays. Non-plain objects (Dates, class instances) and
 * values nested deeper than {@link MAX_DATA_DEPTH} are returned unchanged.
 *
 * @param value - A log event's structured `data` payload (or any part of it).
 * @param depth - Current nesting depth; callers omit it.
 * @returns A redacted copy; never mutates the input.
 */
export function redactLogData<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (depth >= MAX_DATA_DEPTH || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactLogData(item, depth + 1)) as T;
  }

  // Only walk plain objects; leave Dates, Buffers, etc. untouched.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = redactLogData(item, depth + 1);
  }
  return copy as T;
}
