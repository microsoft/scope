// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface RunNavigationState {
  returnTo: string;
  returnLabel: string;
}

export function isSafeInternalReturnTarget(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !value.includes("://")
  );
}

export function runNavigationState(
  returnTo: string,
  returnLabel: string,
): RunNavigationState {
  return { returnTo, returnLabel };
}

export function resolveRunReturnState(
  state: unknown,
): RunNavigationState {
  if (!state || typeof state !== "object") {
    return { returnTo: "/runs", returnLabel: "Back to runs" };
  }
  const candidate = state as Partial<RunNavigationState>;
  if (!isSafeInternalReturnTarget(candidate.returnTo)) {
    return { returnTo: "/runs", returnLabel: "Back to runs" };
  }
  return {
    returnTo: candidate.returnTo,
    returnLabel:
      typeof candidate.returnLabel === "string" &&
      candidate.returnLabel.trim().length > 0
        ? candidate.returnLabel
        : "Back",
  };
}
