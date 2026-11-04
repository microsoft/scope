// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/verify-dev-stack.sh");
const wrapper = resolve("scripts/dev-compose.sh");
const directories: string[] = [];

interface FixtureOptions {
  apiCodes?: string;
  composeCreateAfter?: number;
  composeUpStatus?: number;
  gatewayCodes?: string;
  portalCodes?: string;
  services?: string;
  states?: Partial<Record<"api" | "coder-acp-copilot" | "gateway" | "portal", string>>;
  workerReady?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scope-verify-stack-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const counters = join(directory, "counters");
  mkdirSync(bin);
  mkdirSync(counters);

  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/bash
set -eu
if [ "$1" = "inspect" ]; then
  container_id="\${@: -1}"
  service="\${container_id#container-}"
  variable="STATE_\${service//-/_}"
  printf '%s\\n' "\${!variable:-running}"
  exit 0
fi
[ "$1" = "compose" ]
shift
arguments=("$@")
command_index=-1
for index in "\${!arguments[@]}"; do
  case "\${arguments[$index]}" in
    up|ps|port|logs|config)
      command_index="$index"
      break
      ;;
  esac
done
[ "$command_index" -ge 0 ]
command="\${arguments[$command_index]}"
if [ "$command" = "ps" ]; then
  last_index=$((\${#arguments[@]} - 1))
  service="\${arguments[$last_index]}"
  ps_counter_file="$COUNTERS/PS"
  ps_count=0
  [ -f "$ps_counter_file" ] && ps_count="$(cat "$ps_counter_file")"
  ps_count=$((ps_count + 1))
  printf '%s' "$ps_count" > "$ps_counter_file"
  if [ "$ps_count" -le "\${COMPOSE_CREATE_AFTER:-0}" ]; then
    exit 0
  fi
  [ -n "\${COMPOSE_CREATED_FILE:-}" ] && : > "$COMPOSE_CREATED_FILE"
  printf 'container-%s\\n' "$service"
elif [ "$command" = "port" ]; then
  service="\${arguments[$((command_index + 1))]}"
  case "$service" in
    portal) printf '0.0.0.0:5100\\n' ;;
    api) printf '0.0.0.0:3100\\n' ;;
    gateway) printf '0.0.0.0:18900\\n' ;;
  esac
elif [ "$command" = "logs" ]; then
  if [ "\${WORKER_READY:-1}" = "1" ]; then
    printf '%s\\n' \
      '[coder-acp-copilot] Ensured queue exists: queue-coder-acp-copilot' \
      '[coder-acp-copilot] Connected to MongoDB'
  else
    printf '%s\\n' '[coder-acp-copilot] Starting worker...'
  fi
elif [ "$command" = "config" ]; then
  printf '%s\\n' "\${SCOPE_DEV_VERIFY_SERVICES:-}"
elif [ "$command" = "up" ]; then
  if [ "\${COMPOSE_UP_STATUS:-0}" -ne 0 ]; then
    /bin/sleep 0.05
    exit "$COMPOSE_UP_STATUS"
  fi
  if [ "\${COMPOSE_CREATE_AFTER:-0}" -gt 0 ]; then
    while [ ! -f "$COMPOSE_CREATED_FILE" ]; do
      /bin/sleep 0.02
    done
  fi
  exit 0
else
  exit 1
fi
`);
  chmodSync(docker, 0o755);

  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/bin/bash
set -eu
url="\${@: -1}"
case "$url" in
  *:5100/*) service=PORTAL ;;
  *:3100/*) service=API ;;
  *:18900/*) service=GATEWAY ;;
  *) exit 2 ;;
esac
sequence_variable="\${service}_CODES"
sequence="\${!sequence_variable:-200}"
counter_file="$COUNTERS/$service"
count=0
[ -f "$counter_file" ] && count="$(cat "$counter_file")"
count=$((count + 1))
printf '%s' "$count" > "$counter_file"
code="$(printf '%s' "$sequence" | cut -d, -f"$count")"
[ -n "$code" ] || code="$(printf '%s' "$sequence" | awk -F, '{print $NF}')"
printf '%s' "$code"
[ "$code" != "000" ] || exit 7
`);
  chmodSync(curl, 0o755);

  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
  chmodSync(sleep, 0o755);

  const services = options.services ?? "portal\napi\ngateway\ncoder-acp-copilot";
  const states = options.states ?? {};
  const composeCreatedFile = join(directory, "compose-created");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    COUNTERS: counters,
    SCOPE_DEV_READY_ATTEMPTS: "3",
    SCOPE_DEV_READY_DELAY_SECONDS: "0",
    SCOPE_DEV_READY_CURL_TIMEOUT_SECONDS: "1",
    SCOPE_DEV_VERIFY_SERVICES: services,
    PORTAL_CODES: options.portalCodes ?? "200",
    API_CODES: options.apiCodes ?? "200",
    COMPOSE_CREATED_FILE: composeCreatedFile,
    COMPOSE_CREATE_AFTER: String(options.composeCreateAfter ?? 0),
    COMPOSE_UP_STATUS: String(options.composeUpStatus ?? 0),
    GATEWAY_CODES: options.gatewayCodes ?? "200",
    WORKER_READY: options.workerReady === false ? "0" : "1",
    STATE_portal: states.portal ?? "running",
    STATE_api: states.api ?? "healthy",
    STATE_gateway: states.gateway ?? "healthy",
    STATE_coder_acp_copilot: states["coder-acp-copilot"] ?? "running",
  };

  return {
    counters,
    run: (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", [script], {
        encoding: "utf8",
        env: { ...env, ...overrides },
      }),
    runWrapper: (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", [wrapper, "up", "api"], {
        encoding: "utf8",
        env: { ...env, ...overrides },
      }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("verify-dev-stack.sh", () => {
  it("verifies all published endpoints and the Copilot worker", () => {
    const result = fixture().run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Portal verified: http://localhost:5100/");
    expect(result.stdout).toContain("API verified: http://localhost:3100/ready");
    expect(result.stdout).toContain("Gateway verified: http://localhost:18900/health/ready");
    expect(result.stdout).toContain("queue ensured, and MongoDB connected");
  });

  it("allows delayed readiness within the bounded attempts", () => {
    const result = fixture({ apiCodes: "503,000,200" }).run();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("API verified");
  });

  it("reports a reachable endpoint that remains non-ready", () => {
    const result = fixture({ apiCodes: "503" }).run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API host endpoint is reachable but not ready (HTTP 503)");
    expect(result.stderr).not.toContain("port-forwarding failure");
  });

  it("reports connection refusal as host unreachability", () => {
    const result = fixture({ apiCodes: "000" }).run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API container is healthy, but its published host endpoint is unreachable");
  });

  it("identifies healthy-container host forwarding failures", () => {
    const result = fixture({ gatewayCodes: "000" }).run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime VM networking or host port-forwarding failure");
    expect(result.stderr).toContain("docker compose port gateway 18000");
  });

  it("reports unhealthy services separately from host endpoint failures", () => {
    const result = fixture({ states: { api: "unhealthy" } }).run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API service is unhealthy or not running (container state: unhealthy)");
    expect(result.stderr).not.toContain("API container is unhealthy, but its published host endpoint is unreachable");
  });

  it("requires the worker queue and MongoDB readiness signals", () => {
    const result = fixture({ workerReady: false }).run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Copilot worker is running but not ready");
    expect(result.stderr).toContain("queue creation, MongoDB connection");
  });

  it("stops after the configured attempt bound", () => {
    const test = fixture({ apiCodes: "000" });
    const result = test.run({ SCOPE_DEV_READY_ATTEMPTS: "2" });

    expect(result.status).toBe(1);
    expect(readFileSync(join(test.counters, "API"), "utf8")).toBe("2");
  });

  it("does not echo secret-bearing environment values", () => {
    const secret = "https://user:super-secret@example.test/path?token=hidden";
    const result = fixture({ apiCodes: "000" }).run({
      GITHUB_TOKEN: "ghp_super_secret",
      STORAGE_CONNECTION_STRING: secret,
    });

    expect(`${result.stdout}\n${result.stderr}`).not.toContain("ghp_super_secret");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("super-secret");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("token=hidden");
  });

  it("integrates with the Compose wrapper and preserves a successful startup exit", () => {
    const result = fixture({ services: "api" }).runWrapper();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("API verified: http://localhost:3100/ready");
  });

  it("makes the Compose startup command fail when verification fails", () => {
    const result = fixture({ apiCodes: "000", services: "api" }).runWrapper({
      SCOPE_DEV_READY_ATTEMPTS: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("published host endpoint is unreachable");
  });

  it("does not consume readiness attempts while Compose is still building", () => {
    const test = fixture({
      composeCreateAfter: 6,
      services: "api",
    });
    const result = test.runWrapper({
      SCOPE_DEV_READY_ATTEMPTS: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(Number(readFileSync(join(test.counters, "PS"), "utf8"))).toBeGreaterThan(6);
    expect(readFileSync(join(test.counters, "API"), "utf8")).toBe("1");
    expect(result.stdout).toContain("API verified: http://localhost:3100/ready");
  });

  it("propagates a Compose build failure without waiting for readiness", () => {
    const test = fixture({
      composeCreateAfter: 100,
      composeUpStatus: 17,
      services: "api",
    });
    const result = test.runWrapper({
      SCOPE_DEV_READY_ATTEMPTS: "1",
    });

    expect(result.status).toBe(17);
    expect(result.stderr).not.toContain("Development stack readiness verification failed");
    expect(() => readFileSync(join(test.counters, "API"), "utf8")).toThrow();
  });
});
