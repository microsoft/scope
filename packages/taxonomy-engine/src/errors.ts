// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const MAX_ERROR_MESSAGE = 2_000;

/** Redacts common credential and signed-URL forms from persisted diagnostics. */
export function redactErrorText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s;,]+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s'"]+/gi, "[redacted-url]")
    .slice(0, MAX_ERROR_MESSAGE);
}

/** Converts ordinary or aggregate failures to one bounded redacted message. */
export function boundedErrorMessage(error: unknown): string {
  const message = error instanceof AggregateError
    ? `${error.message}: ${error.errors.slice(0, 10).map(cause =>
      cause instanceof Error ? cause.message : String(cause)
    ).join("; ")}`
    : error instanceof Error ? error.message : String(error);
  return redactErrorText(message);
}
