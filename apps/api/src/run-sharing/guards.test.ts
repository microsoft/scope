// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { useTestServer } from "../test-server.js";
import { shareRateLimit } from "./guards.js";

describe("share request budgets", () => {
  let now = 0;
  const app = express();
  app.use(shareRateLimit(2, () => now));
  app.get("/", (_req, res) => res.json({ ok: true }));
  const server = useTestServer(app);

  it("throttles before work and permits reads again after the window", async () => {
    await request(server()).get("/").expect(200);
    await request(server()).get("/").expect(200);
    const denied = await request(server()).get("/").set("X-Forwarded-For", "attacker-selected").expect(429);
    expect(denied.headers["retry-after"]).toBe("60");
    now = 60_001;
    await request(server()).get("/").expect(200);
  });
});
