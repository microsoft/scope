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
const SCRIPT_TEST_TIMEOUT_MS = 30_000;

interface FakeResponse {
  statuses?: number[];
  exitCode?: number;
  body?: string;
  diagnostics?: string;
}

function fixture(responses: FakeResponse[]) {
  const directory = mkdtempSync(join(tmpdir(), "scope-register-agent-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const responsesFile = join(directory, "responses");
  const callsFile = join(directory, "calls");
  const payloadsFile = join(directory, "payloads");
  const agentManifest = join(directory, "agent.yaml");
  const versionManifest = join(directory, "version.yaml");
  writeFileSync(
    responsesFile,
    responses
      .map((response) =>
        [
          response.statuses?.join(",") ?? "",
          response.exitCode ?? 0,
          response.body ?? "",
          response.diagnostics ?? "",
        ].join("|"),
      )
      .join("\n") + "\n",
  );
  writeFileSync(callsFile, "");
  writeFileSync(payloadsFile, "");
  writeFileSync(agentManifest, "_id: test-worker\n");
  writeFileSync(versionManifest, "agentVersion: test-v1\n");

  const wget = join(bin, "wget");
  writeFileSync(
    wget,
    `#!/bin/sh
set -eu
echo "$*" >> "$FAKE_WGET_CALLS_FILE"
response=$(sed -n '1p' "$FAKE_WGET_RESPONSES_FILE")
tail -n +2 "$FAKE_WGET_RESPONSES_FILE" > "$FAKE_WGET_RESPONSES_FILE.next"
mv "$FAKE_WGET_RESPONSES_FILE.next" "$FAKE_WGET_RESPONSES_FILE"
old_ifs=$IFS
IFS='|'
read -r statuses exit_code body diagnostics <<EOF
$response
EOF
IFS=$old_ifs
output=""
post_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -O)
      shift
      output=$1
      ;;
    --post-file)
      shift
      post_file=$1
      ;;
  esac
  shift
done
if [ -n "$post_file" ]; then
  cat "$post_file" >> "$FAKE_WGET_PAYLOADS_FILE"
  printf '\\n' >> "$FAKE_WGET_PAYLOADS_FILE"
fi
old_ifs=$IFS
IFS=,
for status in $statuses; do
  printf '  HTTP/1.1 %s Fake Status\\n' "$status" >&2
done
IFS=$old_ifs
if [ -n "$diagnostics" ]; then
  printf '%s\\n' "$diagnostics" >&2
fi
printf '%s' "$body" > "$output"
exit "$exit_code"
`,
  );
  chmodSync(wget, 0o755);

  const timeout = join(bin, "timeout");
  writeFileSync(
    timeout,
    `#!/bin/sh
set -eu
shift
exec "$@"
`,
  );
  chmodSync(timeout, 0o755);

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
    callsFile,
    payloadsFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_WGET_RESPONSES_FILE: responsesFile,
      FAKE_WGET_CALLS_FILE: callsFile,
      FAKE_WGET_PAYLOADS_FILE: payloadsFile,
      SCOPE_REGISTRATION_MAX_ATTEMPTS: "4",
    },
  };
}

function runFixture(
  test: ReturnType<typeof fixture>,
  extraArguments: string[] = [],
) {
  return spawnSync(
    "sh",
    [
      script,
      "http://scope-api",
      test.agentManifest,
      ...extraArguments,
    ],
    { encoding: "utf8", env: test.env },
  );
}

function callCount(callsFile: string) {
  const calls = readFileSync(callsFile, "utf8").trim();
  return calls === "" ? 0 : calls.split("\n").length;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("register-agent.sh", () => {
  it("retries readiness and idempotent POSTs only for transient failures", () => {
    const test = fixture([
      { statuses: [503], exitCode: 1, body: "starting" },
      { statuses: [200] },
      { statuses: [503], exitCode: 1, body: "retry agent" },
      { statuses: [201], body: "agent created" },
      { statuses: [200], body: "version created" },
    ]);
    const result = runFixture(test, [test.versionManifest]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registered agent test-worker");
    expect(result.stdout).toContain("Registered version test-worker@test-v1");
    expect(callCount(test.callsFile)).toBe(5);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it.each([408, 425, 429, 500, 502, 503, 504])(
    "retries transient HTTP %s responses",
    (status) => {
      const test = fixture([
        { statuses: [200] },
        { statuses: [status], exitCode: 1 },
        { statuses: [201] },
      ]);
      const result = runFixture(test);

      expect(result.status).toBe(0);
      expect(callCount(test.callsFile)).toBe(3);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  it("uses the final status after redirects", () => {
    const test = fixture([
      { statuses: [301, 200] },
      { statuses: [307, 201], body: "created" },
    ]);
    const result = runFixture(test);

    expect(result.status).toBe(0);
    expect(callCount(test.callsFile)).toBe(2);
  });

  it("fails immediately and preserves the response body on permanent errors", () => {
    const test = fixture([
      { statuses: [200] },
      {
        statuses: [422],
        exitCode: 1,
        body: '{"error":"invalid manifest"}',
      },
    ]);
    const result = runFixture(test);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Permanent agent test-worker registration failure (HTTP 422): {"error":"invalid manifest"}',
    );
    expect(callCount(test.callsFile)).toBe(2);
  });

  it.each([
    ["DNS failure", 1, "bad address 'scope-api'", undefined],
    ["connection failure", 1, "connection refused", undefined],
    ["timeout", 143, "Terminated", undefined],
    ["interrupted transfer", 1, "connection reset by peer", [200]],
  ])(
    "retries %s failures without a completed HTTP response",
    (_, exitCode, diagnostics, statuses) => {
      const test = fixture([
        { statuses, exitCode, diagnostics },
        { statuses: [200] },
        { statuses: [201] },
      ]);
      const result = runFixture(test);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("no HTTP response");
      expect(result.stderr).toContain(diagnostics);
      expect(callCount(test.callsFile)).toBe(3);
    },
  );

  it("posts exact JSON bytes through a temporary file with the JSON content type", () => {
    const test = fixture([{ statuses: [200] }, { statuses: [201] }]);
    const result = runFixture(test);
    const calls = readFileSync(test.callsFile, "utf8");
    const payloads = readFileSync(test.payloadsFile, "utf8");

    expect(result.status).toBe(0);
    expect(calls).toContain("--header Content-Type: application/json");
    expect(calls).toContain("--post-file");
    expect(payloads).toBe(
      '{"_id":"test-worker","name":"Test Worker","available":true}\n',
    );
  });

  it("overrides agent availability in memory", () => {
    const test = fixture([
      { statuses: [200] },
      { statuses: [200] },
      { statuses: [200] },
    ]);
    const result = runFixture(test, [
      "--available",
      "false",
      test.versionManifest,
    ]);

    expect(result.status).toBe(0);
    expect(readFileSync(test.payloadsFile, "utf8")).toContain(
      '{"_id":"test-worker","name":"Test Worker","available":false}',
    );
  });

  it("rejects invalid availability overrides before contacting the API", () => {
    const test = fixture([{ statuses: [200] }]);
    const result = runFixture(test, ["--available", "sometimes"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--available must be true or false");
    expect(callCount(test.callsFile)).toBe(0);
  });

  it("rejects unsupported URL schemes before contacting the API", () => {
    const test = fixture([{ statuses: [200] }]);
    const result = spawnSync(
      "sh",
      [script, "file:///tmp/api", test.agentManifest],
      { encoding: "utf8", env: test.env },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("API URL must use http or https");
    expect(callCount(test.callsFile)).toBe(0);
  });
});
