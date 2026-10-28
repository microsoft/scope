// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { redactErrorText } from "../errors.js";

export type AtifSourceVersion = "ATIF-v1.6" | "ATIF-v1.7" | "ATIF-v1.8";
export const CANONICAL_ATIF_VERSION = "ATIF-v1.8" as const;

export interface AtifImageSource {
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  path: string;
}

export interface AtifAudioSource {
  media_type:
    | "audio/wav"
    | "audio/mpeg"
    | "audio/mp4"
    | "audio/aac"
    | "audio/ogg"
    | "audio/flac"
    | "audio/webm"
    | "audio/aiff";
  path: string;
  duration_sec?: number | null;
}

export type AtifContentPart =
  | { type: "text"; text: string; source?: null }
  | { type: "image"; source: AtifImageSource; text?: null }
  | { type: "audio"; source: AtifAudioSource; text?: null };

export interface AtifV18ToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown> | null;
}

export interface AtifV18ObservationResult {
  source_call_id?: string | null;
  content?: string | AtifContentPart[] | null;
  subagent_trajectory_ref?: Array<Record<string, unknown>> | null;
  extra?: Record<string, unknown> | null;
}

export interface AtifV18Step {
  step_id: number;
  timestamp?: string | null;
  source: "system" | "user" | "agent";
  model_name?: string | null;
  reasoning_effort?: string | number | null;
  message: string | AtifContentPart[];
  reasoning_content?: string | null;
  tool_calls?: AtifV18ToolCall[] | null;
  observation?: { results: AtifV18ObservationResult[] } | null;
  metrics?: Record<string, unknown> | null;
  is_copied_context?: boolean | null;
  llm_call_count?: number | null;
  extra?: Record<string, unknown> | null;
}

export interface AtifV18Canonical {
  schema_version: "ATIF-v1.8";
  session_id?: string | null;
  trajectory_id?: string | null;
  agent: Record<string, unknown> & { name: string; version: string };
  steps: AtifV18Step[];
  notes?: string | null;
  final_metrics?: Record<string, unknown> | null;
  continued_trajectory_ref?: string | null;
  subagent_trajectories?: unknown[] | null;
  extra?: Record<string, unknown> | null;
}

/** Immutable original input locator retained outside normalized evidence. */
export interface AtifSourceDescriptor {
  file?: string;
  archive_entry?: string;
  jsonl_line?: number;
  json_path_prefix?: string;
  label?: string;
}

/** One adjacent upcaster applied during ingestion. */
export interface AtifUpcastStep {
  name: "v1.6-to-v1.7" | "v1.7-to-v1.8";
  source_version: AtifSourceVersion;
  target_version: AtifSourceVersion;
}

/** Compact normalized-to-original source mapping operation. */
export interface AtifSourceMapping {
  normalized_prefix: string;
  original_prefix: string;
  generated_by?: string;
  source?: AtifSourceDescriptor;
  mode?: "prefix" | "anchor";
}

/** Source provenance retained independently of the normalized ATIF value. */
export interface AtifProvenance {
  source: AtifSourceDescriptor;
  source_version: AtifSourceVersion;
  container_prefix: string;
  upcasters: readonly AtifUpcastStep[];
  mappings: readonly AtifSourceMapping[];
  components?: readonly AtifProvenanceComponent[];
}

/** One independently validated source document composed into a canonical root. */
export interface AtifProvenanceComponent {
  source: AtifSourceDescriptor;
  source_version: AtifSourceVersion;
  upcasters: readonly AtifUpcastStep[];
}

export type AtifDiagnosticStage =
  | "decoding"
  | "container"
  | "version"
  | "source_validation"
  | "upcasting"
  | "target_validation"
  | "scope_normalization"
  | "result_validation";

/** Bounded location-aware ingestion diagnostic. */
export interface AtifIngestionDiagnostic {
  code: string;
  stage: AtifDiagnosticStage;
  message: string;
  file?: string;
  archive_entry?: string;
  jsonl_line?: number;
  original_path: string;
  normalized_path?: string;
  source_version?: AtifSourceVersion;
  target_version?: AtifSourceVersion;
  upcaster?: string;
  generated_by?: string;
}

export interface AtifIngestionResult<Atif> {
  atif: Atif;
  provenance: AtifProvenance;
}

function boundedSourceLocator(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().slice(0, 2_000);
    } catch {
      return "[redacted-url]";
    }
  }
  return redactErrorText(value);
}

/** Structured ingestion failure preserved through CLI/error records. */
export class AtifIngestionError extends Error {
  readonly diagnostic: AtifIngestionDiagnostic;

  constructor(diagnostic: AtifIngestionDiagnostic) {
    const bounded = {
      ...diagnostic,
      message: redactErrorText(diagnostic.message),
      ...(diagnostic.file
        ? { file: boundedSourceLocator(diagnostic.file) }
        : {}),
      ...(diagnostic.archive_entry
        ? { archive_entry: redactErrorText(diagnostic.archive_entry) }
        : {}),
      original_path: redactErrorText(diagnostic.original_path),
      ...(diagnostic.normalized_path
        ? { normalized_path: redactErrorText(diagnostic.normalized_path) }
        : {}),
    };
    super(formatAtifDiagnostic(bounded));
    this.name = "AtifIngestionError";
    this.diagnostic = bounded;
  }
}

/** Formats one diagnostic without exposing raw invalid payloads. */
export function formatAtifDiagnostic(
  diagnostic: AtifIngestionDiagnostic,
): string {
  const source = diagnostic.file ?? diagnostic.archive_entry ?? "<memory>";
  const line = diagnostic.jsonl_line
    ? `:${diagnostic.jsonl_line}`
    : "";
  const entry = diagnostic.archive_entry && diagnostic.file
    ? `#${diagnostic.archive_entry}`
    : "";
  return `${source}${entry}${line} ${diagnostic.original_path}: ${diagnostic.message}`;
}
