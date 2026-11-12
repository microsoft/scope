// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Minimal process signal surface used by production and tests. */
export interface SignalEmitter {
  once(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

/** Installs one SIGINT handler that aborts evaluation and reports interruption. */
export function installEvaluationCancellation(
  controller: AbortController,
  onInterrupt: () => void,
  emitter: SignalEmitter = process,
): () => void {
  const handler = () => {
    onInterrupt();
    controller.abort();
  };
  emitter.once("SIGINT", handler);
  return () => {
    emitter.off("SIGINT", handler);
  };
}
