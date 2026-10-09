// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ServerStatusSchema, type ConfigureServerAgent, type ServerWorkerType } from "shared/server";
import { apiClient } from "./api-client";

async function readStatus(response: Response) {
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === "object" && data !== null
      && "error" in data && typeof data.error === "string" ? data.error : "Local agent setup failed";
    throw new Error(message);
  }
  return ServerStatusSchema.parse(data);
}

export async function getServerStatus() {
  return readStatus(await apiClient.get("/api/v1/server"));
}

export async function configureServerAgent(workerType: ServerWorkerType, input: ConfigureServerAgent) {
  return readStatus(await apiClient.put(`/api/v1/server/agents/${workerType}`, { json: input }));
}
