// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface RuntimeEntry {
  name: string;
  directory: string;
  kind: "service" | "worker" | "utility" | "tool" | "rust";
  port?: number;
  inspector?: number;
  entry?: string;
  dockerfile?: string;
  native?: boolean;
  secrets?: string[];
}

/** Reviewed runtime inventory shared by startup, image builds, and debugger routing. */
export const runtimes: RuntimeEntry[] = [
  { name: "api", directory: "apps/api", kind: "service", port: 3100, inspector: 9230, entry: "src/index.ts", dockerfile: "apps/api/Dockerfile", native: true, secrets: ["GITHUB_MODELS_API_KEY", "AZURE_AI_INFERENCE_ENDPOINT", "AZURE_AI_INFERENCE_API_KEY"] },
  { name: "portal", directory: "apps/portal", kind: "service", port: 5100, native: true },
  { name: "judge", directory: "apps/judge", kind: "service", port: 3101, inspector: 9231, entry: "src/index.ts", dockerfile: "apps/judge/Dockerfile", native: true, secrets: ["GITHUB_TOKEN"] },
  { name: "token-manager", directory: "apps/token-manager", kind: "service", port: 3102, inspector: 9232, entry: "src/index.ts", dockerfile: "apps/token-manager/Dockerfile", native: true },
  { name: "scheduler", directory: "apps/scheduler", kind: "service", port: 3103, inspector: 9233, entry: "src/index.ts", dockerfile: "apps/scheduler/Dockerfile", native: true },
  { name: "gateway", directory: "apps/gateway", kind: "rust", port: 18000, dockerfile: "apps/gateway/Dockerfile", native: true },
  { name: "coder-acp-copilot", directory: "apps/workers/coder-acp-copilot", kind: "worker", inspector: 9240, entry: "src/index.ts", dockerfile: "apps/workers/coder-acp-copilot/Dockerfile", secrets: ["GITHUB_TOKEN"] },
  { name: "coder-acp-claude-code", directory: "apps/workers/coder-acp-claude-code", kind: "worker", inspector: 9241, entry: "src/index.ts", dockerfile: "apps/workers/coder-acp-claude-code/Dockerfile", secrets: ["ANTHROPIC_API_KEY"] },
  { name: "report-generator", directory: "apps/workers/report-generator", kind: "worker", inspector: 9242, entry: "src/index.ts", dockerfile: "apps/workers/report-generator/Dockerfile", secrets: ["GITHUB_TOKEN"] },
  { name: "post-processor", directory: "apps/workers/post-processor", kind: "worker", inspector: 9243, entry: "src/index.ts", dockerfile: "apps/workers/post-processor/Dockerfile" },
  { name: "model-scanner-copilot", directory: "apps/model-scanners/copilot", kind: "utility", inspector: 9250, entry: "src/index.ts", dockerfile: "apps/model-scanners/copilot/Dockerfile", secrets: ["GITHUB_TOKEN"] },
  { name: "model-scanner-anthropic", directory: "apps/model-scanners/anthropic", kind: "utility", inspector: 9251, entry: "src/index.ts", dockerfile: "apps/model-scanners/anthropic/Dockerfile", secrets: ["ANTHROPIC_API_KEY"] },
  { name: "version-checker-acp-copilot", directory: "apps/version-checkers/acp-copilot", kind: "utility", inspector: 9252, entry: "src/check-versions.ts", secrets: ["GITHUB_TOKEN"] },
  { name: "version-checker-claude-code", directory: "apps/version-checkers/claude-code", kind: "utility", inspector: 9253, entry: "src/check-versions.ts", secrets: ["GITHUB_TOKEN"] },
  { name: "github-cookie-updater", directory: "apps/key-updaters/github-cookie-updater", kind: "utility", inspector: 9254, entry: "src/github-cookie-updater.ts", secrets: ["GITHUB_USERNAME", "GITHUB_PASSWORD", "GITHUB_TOTP_SECRET"] },
  { name: "cli", directory: "apps/cli", kind: "tool", inspector: 9260, entry: "src/index.ts", native: true, secrets: ["SCOPE_TOKEN"] },
  { name: "db-migrations", directory: "packages/db-migrations", kind: "tool", inspector: 9261, entry: "src/migrate.ts", native: true },
  { name: "tests", directory: ".", kind: "tool", inspector: 9262, native: true },
  { name: "prompt-evaluations", directory: "evaluations/static-prompts", kind: "tool", native: true },
  { name: "storybook", directory: "apps/portal", kind: "tool", port: 6100, native: true },
  { name: "website", directory: "website", kind: "tool", port: 4321, inspector: 9263, native: true },
];

export function runtimeByName(name: string): RuntimeEntry {
  const entry = runtimes.find((runtime) => runtime.name === name);
  if (!entry) throw new Error(`Unknown runtime ${name}; available: ${runtimes.map((runtime) => runtime.name).join(", ")}`);
  return entry;
}