// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterAll, beforeAll } from "vitest";
import { type Server } from "node:http";
import type { Express } from "express";

/**
 * Bind an Express app to a single, long-lived ephemeral server for the whole
 * test file and return a getter for it.
 *
 * Passing an Express *app* to supertest (`supertest(app)` / `request(app)`)
 * makes supertest spin up — and asynchronously tear down — a fresh server on
 * every call. Across a file's many sequential requests those per-call servers
 * and their sockets close asynchronously, so churn from one test can corrupt
 * the next test's request, producing intermittent HTTP "Parse Error", spurious
 * 400s, and 5s timeouts with a different victim each run. Handing supertest an
 * already-listening server (which it reuses and never closes) removes the churn
 * and makes these suites deterministic.
 *
 * Call once inside a test file's top-level `describe` (or at module scope) and
 * pass the result to supertest, e.g. `request(testServer())`.
 */
export function useTestServer(app: Express): () => Server {
  let server: Server;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return () => server;
}
