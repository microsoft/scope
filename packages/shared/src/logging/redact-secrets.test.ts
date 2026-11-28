// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { redactLogData, redactSecrets } from "./redact-secrets.js";

// Fake secrets are assembled at runtime so the source file never contains a
// literal token shape (keeps secret scanners / push protection quiet).
const fake = {
  aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  github: "gh" + "p_" + "a1B2".repeat(9),
  githubFineGrained: "github" + "_pat_" + "11ABCDEFG0".repeat(3),
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  openai: "sk" + "-proj-" + "Ab1".repeat(10),
  anthropic: "sk" + "-ant-" + "api03-" + "Xy9".repeat(10),
  google: "AI" + "za" + "S".repeat(35),
  stripe: "sk" + "_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  npm: "np" + "m_" + "z".repeat(36),
  huggingface: "h" + "f_" + "Q".repeat(34),
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9" + ".ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  storageKey: "Q".repeat(86) + "==",
  sasSig: "a%2Bb%2Fc" + "d".repeat(40) + "%3D",
  bearer: "abc.DEF_ghi-" + "J".repeat(20),
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----",
};

describe("redactSecrets", () => {
  it.each([
    ["aws-access-key-id", `export AWS_ACCESS_KEY_ID=${fake.aws}`],
    ["github-token", `git clone https://x:${fake.github}@github.com/o/r`],
    ["github-fine-grained-pat", `token ${fake.githubFineGrained}`],
    ["slack-token", `SLACK=${fake.slack}`],
    ["openai-anthropic-key", `OPENAI_API_KEY=${fake.openai}`],
    ["openai-anthropic-key", `ANTHROPIC_API_KEY=${fake.anthropic}`],
    ["google-api-key", `key=${fake.google}`],
    ["stripe-key", `stripe ${fake.stripe}`],
    ["npm-token", `//registry.npmjs.org/:_authToken=${fake.npm}`],
    ["huggingface-token", `HF_TOKEN=${fake.huggingface}`],
    ["jwt", `cookie: session=${fake.jwt}`],
    ["private-key", `wrote id_rsa:\n${fake.pem}\ndone`],
  ])("redacts a %s found under an innocent context", (ruleId, text) => {
    const result = redactSecrets(text);

    expect(result).toContain(`[REDACTED:${ruleId}]`);
    expect(result).not.toMatch(/AKIA[A-Z]{16}|ghp_|github_pat_|xoxb-|sk-proj-|sk-ant-|AIzaS|sk_live_|npm_z|hf_Q|eyJzdWIi|MIIEpA/);
  });

  it("keeps the descriptive prefix for Bearer, AccountKey and SAS signatures", () => {
    expect(redactSecrets(`command="curl -H 'Authorization: Bearer ${fake.bearer}'"`))
      .toBe(`command="curl -H 'Authorization: Bearer [REDACTED:authorization-bearer]'"`);
    expect(redactSecrets(`DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${fake.storageKey};EndpointSuffix=core.windows.net`))
      .toBe("DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[REDACTED:azure-storage-key];EndpointSuffix=core.windows.net");
    expect(redactSecrets(`https://acct.blob.core.windows.net/c/b.tar.gz?sv=2024-01-01&sr=b&sig=${fake.sasSig}&se=2026`))
      .toBe("https://acct.blob.core.windows.net/c/b.tar.gz?sv=2024-01-01&sr=b&sig=[REDACTED:azure-sas-signature]&se=2026");
  });

  it("redacts every occurrence in a line", () => {
    const result = redactSecrets(`${fake.github} and ${fake.github}`);
    expect(result).toBe("[REDACTED:github-token] and [REDACTED:github-token]");
  });

  it.each([
    "Iteration 3 complete — 4/5 criteria passed",
    "Uploaded snapshot https://acct.blob.core.windows.net/snapshots/req-1/iteration-1/workspace.tar.gz",
    "commit 44d16d6a8f3e2b1c0d9e8f7a6b5c4d3e2f1a0b9c on branch high-priority-task-prompts",
    "run 0199a3f2-7c4b-7d1e-9a2b-3c4d5e6f7a8b sk-learn style naming in task-skills",
    "Authorization: Bearer <token>",
    "GitHub ghp_short is not a token",
  ])("leaves ordinary log text untouched: %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactLogData", () => {
  it("redacts strings nested in objects and arrays without mutating the input", () => {
    const data = {
      tool: "bash",
      args: { command: `curl -H "Authorization: Bearer ${fake.bearer}"`, cwd: "/workspace" },
      outputs: ["ok", `AWS_ACCESS_KEY_ID=${fake.aws}`],
      exitCode: 0,
    };
    const snapshot = structuredClone(data);

    const result = redactLogData(data);

    expect(result).toEqual({
      tool: "bash",
      args: { command: 'curl -H "Authorization: Bearer [REDACTED:authorization-bearer]"', cwd: "/workspace" },
      outputs: ["ok", "AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key-id]"],
      exitCode: 0,
    });
    expect(data).toEqual(snapshot);
  });

  it("leaves non-plain objects and primitives as they are", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    expect(redactLogData({ when, n: 1, ok: true, none: null }).when).toBe(when);
    expect(redactLogData(42)).toBe(42);
  });

  it("stops descending past the depth limit", () => {
    let deep: Record<string, unknown> = { secret: fake.github };
    for (let i = 0; i < 10; i++) deep = { next: deep };

    // Deeper than the limit: returned by reference, not walked.
    expect(JSON.stringify(redactLogData(deep))).toContain(fake.github);
  });
});
