// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/ensure-dev-certs.sh");
const directories: string[] = [];

function fixture(existing = false) {
  const directory = mkdtempSync(join(tmpdir(), "scope-dev-certs-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const caRoot = join(directory, "ca-root");
  const certDir = join(directory, "certs");
  for (const path of [bin, caRoot, certDir]) mkdirSync(path);
  writeFileSync(join(caRoot, "rootCA.pem"), "public CA");
  writeFileSync(join(caRoot, "rootCA-key.pem"), "private CA key");
  const cert = join(certDir, "entra-local.pem");
  const key = join(certDir, "entra-local-key.pem");
  if (existing) {
    writeFileSync(cert, "existing certificate");
    writeFileSync(key, "existing key");
  }
  const calls = join(directory, "calls");
  writeFileSync(calls, "");
  const mkcert = join(bin, "mkcert");
  writeFileSync(mkcert, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  -install) exit 0 ;;
  -CAROOT) printf '%s\\n' "$CAROOT" ;;
  -cert-file)
    if [ "\${MINT_FAIL:-0}" = "1" ]; then exit 1; fi
    printf 'new certificate' > "$2"
    printf 'new key' > "$4"
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(mkcert, 0o755);
  const openssl = join(bin, "openssl");
  writeFileSync(openssl, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *-checkend*) exit "\${EXPIRY_FAIL:-0}" ;;
  *-verify_hostname\\ entra-local*) exit "\${HOSTNAME_FAIL:-0}" ;;
  *) exit "\${VERIFY_FAIL:-0}" ;;
esac
`);
  chmodSync(openssl, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    CAROOT: caRoot,
    DEV_CERT_DIR: certDir,
    CALLS: calls,
  };
  return {
    cert,
    key,
    certDir,
    caRoot,
    calls: () => readFileSync(calls, "utf8"),
    run: (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", [script], {
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

describe("ensure-dev-certs.sh", () => {
  it("mints browser and Compose hostnames and exports only the public CA", () => {
    const test = fixture();
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.calls()).toContain("localhost 127.0.0.1 ::1 entra-local");
    expect(readFileSync(join(test.certDir, "rootCA.pem"), "utf8")).toBe("public CA");
    expect(existsSync(join(test.certDir, "rootCA-key.pem"))).toBe(false);
    expect(statSync(test.key).mode & 0o777).toBe(0o600);
    expect(statSync(join(test.certDir, "rootCA.pem")).mode & 0o777).toBe(0o644);
  });

  it("reuses valid certificates while restoring the exported CA and key permissions", () => {
    const test = fixture(true);
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.calls()).not.toContain("-cert-file");
    expect(test.calls()).toContain("-verify_hostname localhost");
    expect(test.calls()).toContain("-verify_hostname entra-local");
    expect(readFileSync(test.cert, "utf8")).toBe("existing certificate");
    expect(readFileSync(join(test.certDir, "rootCA.pem"), "utf8")).toBe("public CA");
    expect(statSync(test.key).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["localhost-only certificate", { HOSTNAME_FAIL: "1" }],
    ["expiring certificate", { EXPIRY_FAIL: "1" }],
    ["untrusted certificate after CA rotation", { VERIFY_FAIL: "1" }],
  ])("renews an existing %s", (_reason, overrides) => {
    const test = fixture(true);
    const result = test.run(overrides);
    expect(result.status, result.stderr).toBe(0);
    expect(test.calls()).toContain("-cert-file");
    expect(readFileSync(test.cert, "utf8")).toBe("new certificate");
  });

  it("renews when the private key is missing", () => {
    const test = fixture(true);
    rmSync(test.key);
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(test.calls()).toContain("-cert-file");
    expect(existsSync(test.key)).toBe(true);
  });

  it("fails rather than reporting success when certificate generation fails", () => {
    const test = fixture();
    const result = test.run({ MINT_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("[ensure-dev-certs] done.");
  });

  it("fails if the public CA cannot be exported", () => {
    const test = fixture();
    rmSync(join(test.caRoot, "rootCA.pem"));
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(test.calls()).not.toContain("-cert-file");
    expect(result.stderr).toContain("rootCA.pem");
  });
});
