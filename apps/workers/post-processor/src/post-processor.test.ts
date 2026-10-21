// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, expect, it, vi } from "vitest";
import { PostProcessor } from "./post-processor.js";

vi.mock("shared", () => ({
  BaseQueueProcessor: class {},
  BlobStorage: class {},
  Retry: () => (_target: object, _key: string, _descriptor: PropertyDescriptor) => undefined,
}));
afterEach(() => vi.unstubAllGlobals());

it("does not call the report API after post-processing while service authorization is deferred", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const processor = new PostProcessor({
    mongoUri: "mongodb://unused", mongoDatabase: "unused", mongoCollection: "requests",
    storageAccountName: "unused", storageConnectionString: "", queueName: "unused", batchSize: 1, pollIntervalMs: 1,
    redisHost: "", redisPort: 6379, redisPassword: "", apiBaseUrl: "http://api.invalid",
  });
  const log = vi.fn().mockResolvedValue(undefined);
  const trigger: (id: string, logger: typeof log) => Promise<void> = Reflect.get(processor, "triggerReportGeneration");
  await trigger.call(processor, "accepted-fixture", log);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("info", "Report generation disabled for the project RBAC MVP");
});
