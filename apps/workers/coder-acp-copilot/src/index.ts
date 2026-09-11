// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import { startCopilotWorker } from "./worker.js";

export { buildSubprocessEnv, isFirstAiCallSignal } from "./worker.js";

startCopilotWorker().catch((error: unknown) => {
  console.error("coder-acp-copilot failed to start:", error);
  process.exit(1);
});
