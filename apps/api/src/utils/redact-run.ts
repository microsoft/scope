// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RunState } from "shared";

/** Return a run without server-only secrets (`tokenHash`). */
export function redactRunState<T extends Partial<RunState>>(run: T): Omit<T, "tokenHash"> {
  if (!("tokenHash" in run)) return run;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tokenHash: _tokenHash, ...rest } = run;
  return rest;
}

/** Return a request-like document whose embedded `run` has no server-only secrets. */
export function redactRunSecrets<T extends { run?: Partial<RunState> | null }>(doc: T): T {
  if (!doc.run || !("tokenHash" in doc.run)) return doc;
  return { ...doc, run: redactRunState(doc.run) };
}
