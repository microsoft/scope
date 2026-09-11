// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import { startClaudeCodeWorker } from "./worker.js";

startClaudeCodeWorker().catch((error: unknown) => {
  console.error("coder-acp-claude-code failed to start:", error);
  process.exit(1);
});
