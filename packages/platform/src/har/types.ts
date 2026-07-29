// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ToolCall is the canonical definition in @scope/core; re-export for backward compat
export type { ToolCall } from "@scope/core";

/**
 * Minimal HAR 1.2 types — just enough for parsing DevProxy output.
 * For full HAR types, use @types/har-format.
 */

export interface HarFile {
  log: HarLog;
}

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  entries: HarEntry[];
}

export interface HarEntry {
  startedDateTime: string;
  request: HarRequest;
  response: HarResponse;
  time: number;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarNameValue[];
  queryString: HarNameValue[];
  headersSize: number;
  bodySize: number;
  postData?: {
    mimeType: string;
    text?: string;
    params?: HarNameValue[];
  };
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarNameValue[];
  content: {
    size: number;
    compression?: number;
    mimeType: string;
    text?: string;
    encoding?: string;
  };
  headersSize: number;
  bodySize: number;
  redirectURL: string;
}

export interface HarNameValue {
  name: string;
  value: string;
}
