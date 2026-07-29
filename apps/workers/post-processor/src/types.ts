// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import type { BlobStorage } from "@scope/platform";
import type { LogEvent } from "@scope/core";

/** Queue message dispatched by the PostProcessorDispatcher in the scheduler. */
export interface PostProcessorMessage {
  type: string;        // "atif" | future handler types
  requestId: string;
  runId: string;
  iteration?: number;  // If omitted, process all iterations in the run
}

/** Context passed to each handler's `process()` method. */
export interface HandlerContext {
  blobStorage: BlobStorage;
  collection: Collection;
  log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>;
}

/** Interface for post-processing handlers (extensibility point). */
export interface PostProcessHandler {
  readonly type: string;
  process(message: PostProcessorMessage, ctx: HandlerContext): Promise<void>;
}
