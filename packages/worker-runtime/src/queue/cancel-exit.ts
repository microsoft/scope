// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFileSync } from "node:fs";

// Sentinel file that the dev-entrypoint monitors. When it appears, the
// entrypoint kills tsx watch and exits — stopping the container. In prod
// (node is PID 1) process.exit(1) alone is sufficient, but the sentinel
// is harmless and keeps the code path identical.
const CANCEL_SENTINEL = "/tmp/.scope-cancel-exit";

/**
 * Exit the process in a way that stops the container in both dev and prod.
 *
 * In production, node IS PID 1 so `process.exit(1)` stops the container.
 * In dev mode, tsx watch is PID 1 and restarts the child on exit. Writing
 * a sentinel file tells the dev-entrypoint to kill tsx watch and exit,
 * bringing down the entire container.
 */
export function cancelExit(): never {
  try {
    writeFileSync(CANCEL_SENTINEL, String(Date.now()));
  } catch {
    // Best-effort — prod containers may not have /tmp writable
  }
  process.exit(1);
}
