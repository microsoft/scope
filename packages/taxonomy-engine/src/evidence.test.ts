// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const file = (path: string) => fileURLToPath(
  new URL(`../${path}`, import.meta.url),
);

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(file(path), "utf8")) as unknown;

const sha256 = async (path: string) => createHash("sha256")
  .update(await readFile(file(path)))
  .digest("hex");

describe("committed Taxonome evidence integrity", () => {
  it("preserves the frozen experiment artifacts, cases, and 256-call ledger", async () => {
    const manifest = z.object({
      budget: z.object({
        cap: z.literal(500),
        used: z.literal(256),
        remaining: z.literal(244),
        finished: z.literal(256),
      }).passthrough(),
      artifact_sha256: z.record(z.string()),
      case_packet_sha256: z.record(z.string()),
    }).passthrough().parse(await json("evidence/manifest.json"));

    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(await sha256(`evidence/${name}`)).toBe(expected);
    }
    for (const [name, expected] of Object.entries(manifest.case_packet_sha256)) {
      expect(await sha256(`fixtures/${name}`)).toBe(expected);
    }

    const events = (await readFile(
      file("evidence/call-ledger.jsonl"),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      type: string;
    });
    expect(events.filter(event => event.type === "reserved")).toHaveLength(256);
    expect(events.filter(event => event.type === "finished")).toHaveLength(256);
  });

  it.each([
    {
      directory: "yaml-prompt-demo",
      firstId: 257,
      calls: 11,
    },
    {
      directory: "yaml-prompt-neutral-control",
      firstId: 268,
      calls: 11,
    },
    {
      directory: "yaml-prompt-readable-paths-control",
      firstId: 279,
      calls: 11,
    },
  ])("verifies $directory hashes and ledger delta", async ({
    directory,
    firstId,
    calls,
  }) => {
    const manifest = z.object({
      artifact_sha256: z.record(z.string()),
    }).passthrough().parse(
      await json(`evidence/${directory}/manifest.json`),
    );
    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(await sha256(`evidence/${directory}/${name}`)).toBe(expected);
    }

    const events = (await readFile(
      file(`evidence/${directory}/call-ledger-delta.jsonl`),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      type: string;
      id: number;
      ok?: boolean;
    });
    expect(events.filter(event => event.type === "reserved").map(event => event.id))
      .toEqual(Array.from({ length: calls }, (_, index) => firstId + index));
    expect(events.filter(event => event.type === "finished")).toHaveLength(calls);
    expect(events.filter(event => event.type === "finished")
      .every(event => event.ok === true)).toBe(true);
  });
});
