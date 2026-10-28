// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Element identity and implementation used in progress messages. */
export interface ProgressElement {
  /** Stable authored element ID. */
  id: string;
  /** Human-facing authored label. */
  label: string;
  /** Prompt elements may call a model; deterministic elements never do. */
  implementation: "prompt" | "deterministic";
}

/** Returns the accessible implementation/model-call label. */
export function elementProgressLabel(element: ProgressElement): string {
  return element.implementation === "prompt"
    ? `Prompt ${element.label} (${element.id}); model calls possible`
    : `Code/Deterministic ${element.label} (${element.id}); no model calls`;
}
