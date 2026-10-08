// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const script = resolve("scripts/register-agent.sh");
const SCRIPT_TEST_TIMEOUT_MS = 15_000;

function fixture(statuses: number[], exitCodes: number[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "scope-register-agent-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const statusFile = join(directory, "statuses");
  const callsFile = join(directory, "calls");
  const exitCodesFile = join(directory, "exit-codes");
  const agentManifest = join(directory, "agent.yaml");
  const versionManifest = join(directory, "version.yaml");
  writeFileSync(statusFile, `${statuses.join("\n")}\n`);
  writeFileSync(callsFile, "");
  writeFileSync(exitCodesFile, `${exitCodes.join("\n")}\n`);
  writeFileSync(agentManifest, "_id: test-worker\n");
  writeFileSync(versionManifest, "agentVersion: test-v1\n");

  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh
set -eu
echo "$*" >> "$FAKE_CURL_CALLS_FILE"
exit_code=$(sed -n '1p' "$FAKE_CURL_EXIT_CODES_FILE")
tail -n +2 "$FAKE_CURL_EXIT_CODES_FILE" > "$FAKE_CURL_EXIT_CODES_FILE.next"
mv "$FAKE_CURL_EXIT_CODES_FILE.next" "$FAKE_CURL_EXIT_CODES_FILE"
if [ -n "$exit_code" ] && [ "$exit_code" -ne 0 ]; then
  exit "$exit_code"
fi
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    output=$1
  fi
  shift
done
status=$(sed -n '1p' "$FAKE_CURL_STATUS_FILE")
tail -n +2 "$FAKE_CURL_STATUS_FILE" > "$FAKE_CURL_STATUS_FILE.next"
mv "$FAKE_CURL_STATUS_FILE.next" "$FAKE_CURL_STATUS_FILE"
printf '{"status":%s}' "$status" > "$output"
printf '%s' "$status"
`,
  );
  chmodSync(curl, 0o755);

  const yq = join(bin, "yq");
  writeFileSync(
    yq,
    `#!/bin/sh
set -eu
if [ "$1" = "-r" ]; then
  case "$2" in
    *agentVersion*) printf 'test-v1\\n' ;;
    *) printf 'test-worker\\n' ;;
  esac
  exit 0
fi
case "$*" in
  *version.yaml*) printf '{"agentVersion":"test-v1","workerVersion":"build","components":{},"gitCommit":"abc","buildTime":"now","imageTag":"build","queueName":"custom-queue"}\\n' ;;
  *strenv*) printf '{"_id":"test-worker","name":"Test Worker","available":%s}\\n' "$SCOPE_AGENT_AVAILABLE" ;;
  *) printf '{"_id":"test-worker","name":"Test Worker","available":true}\\n' ;;
esac
`,
  );
  chmodSync(yq, 0o755);

  const sleep = join(bin, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
  chmodSync(sleep, 0o755);

  return {
    agentManifest,
    versionManifest,
    statusFile,
    callsFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_CURL_STATUS_FILE: statusFile,
      FAKE_CURL_CALLS_FILE: callsFile,
      FAKE_CURL_EXIT_CODES_FILE: exitCodesFile,
      SCOPE_REGISTRATION_MAX_ATTEMPTS: "4",
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("register-agent.sh", () => {
  it("retries readiness and idempotent POSTs only for transient failures", () => {
    const test = fixture([503, 200, 503, 201, 200]);
    const result = spawnSync(
      "sh",
      [
        script,
        "http://scope-api",
        test.agentManifest,
        test.versionManifest,
      ],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registered agent test-worker");
    expect(result.stdout).toContain("Registered version test-worker@test-v1");
    expect(readFileSync(test.callsFile, "utf8").trim().split("\n")).toHaveLength(
      5,
    );
  }, SCRIPT_TEST_TIMEOUT_MS);

  it("fails immediately and non-zero on permanent agent errors", () => {
    const test = fixture([200, 400, 201, 201]);
    const result = spawnSync(
      "sh",
      [
        script,
        "http://scope-api",
        test.agentManifest,
        test.versionManifest,
      ],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Permanent agent test-worker");
    expect(readFileSync(test.callsFile, "utf8").trim().split("\n")).toHaveLength(
      2,
    );
  }, SCRIPT_TEST_TIMEOUT_MS);

  it("fails immediately and non-zero on permanent version errors", () => {
    const test = fixture([200, 200, 422, 201]);
    const result = spawnSync(
      "sh",
      [
        script,
        "http://scope-api",
        test.agentManifest,
        test.versionManifest,
      ],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Permanent version test-worker@test-v1 registration failure",
    );
    expect(readFileSync(test.callsFile, "utf8").trim().split("\n")).toHaveLength(
      3,
    );
  }, SCRIPT_TEST_TIMEOUT_MS);

  it("fails immediately on a permanent curl configuration error", () => {
    const test = fixture([200], [3]);
    const result = spawnSync(
      "sh",
      [script, "invalid://scope-api", test.agentManifest],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Permanent API readiness failure (curl exit 3)",
    );
    expect(readFileSync(test.callsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("retries transient curl connection failures", () => {
    const test = fixture([200, 200], [7, 0, 0]);
    const result = spawnSync(
      "sh",
      [script, "http://scope-api", test.agentManifest],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(test.callsFile, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("overrides agent availability in memory", () => {
    const test = fixture([200, 200, 200]);
    const result = spawnSync(
      "sh",
      [
        script,
        "http://scope-api",
        test.agentManifest,
        "--available",
        "false",
        test.versionManifest,
      ],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(test.callsFile, "utf8")).toContain(
      '{"_id":"test-worker","name":"Test Worker","available":false}',
    );
  });

  it("rejects invalid availability overrides before contacting the API", () => {
    const test = fixture([200]);
    const result = spawnSync(
      "sh",
      [
        script,
        "http://scope-api",
        test.agentManifest,
        "--available",
        "sometimes",
      ],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--available must be true or false");
    expect(readFileSync(test.callsFile, "utf8")).toBe("");
  });
});
