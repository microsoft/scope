// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  ConfigureServerAgentSchema,
  ServerControlStatusSchema,
  ServerStatusSchema,
  ServerWorkerTypeSchema,
} from "shared/server";
import { withRetry } from "shared";
import type { RouteContext } from "../route-context.js";
import { apiRoute } from "../openapi/api-route.js";

class ServerControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function registerServerRoutes(
  ctx: Pick<RouteContext, "app" | "registry">,
  controlUrl = process.env.SCOPE_SERVER_CONTROL_URL,
): void {
  async function control(path: string, body?: z.infer<typeof ConfigureServerAgentSchema>) {
    if (!controlUrl) throw new ServerControlError(404, "Local agent setup is not enabled on this server");
    const url = new URL(path, `${controlUrl.replace(/\/$/, "")}/`);
    const send = async () => {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "PUT",
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => {
        if (error instanceof TypeError
          || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))) {
          throw new ServerControlError(503, "Cannot reach the local Scope launcher. Check that scope-server is running.");
        }
        throw error;
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(data);
        throw new ServerControlError(response.status, failure.success ? failure.data.error : "Local agent setup failed");
      }
      return ServerControlStatusSchema.parse(data);
    };
    // A setup mutation can start a build; check status instead of replaying it.
    const status = body === undefined
      ? await withRetry(send, {
        maxRetries: 2,
        baseDelayMs: 200,
        isRetryable: (error: unknown) => error instanceof TypeError
          || (error instanceof ServerControlError && [502, 503, 504].includes(error.status)),
      })
      : await send();
    return { enabled: true, agents: status.agents };
  }

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/server",
    tags: ["Agents"],
    summary: "Get local server agent setup status",
    response: ServerStatusSchema,
    errorResponses: { 503: { description: "Local server control is unavailable" } },
    handler: async (_req, res, next) => {
      if (!controlUrl) {
        res.json({ enabled: false, agents: [] });
        return;
      }
      try {
        res.json(await control("status"));
      } catch (error) {
        if (error instanceof ServerControlError) {
          res.status(error.status).json({ error: error.message });
        } else {
          next(error);
        }
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "put",
    path: "/api/v1/server/agents/:workerType",
    tags: ["Agents"],
    summary: "Configure a local host or Docker agent",
    params: z.object({ workerType: ServerWorkerTypeSchema }),
    body: ConfigureServerAgentSchema,
    response: ServerStatusSchema,
    errorResponses: {
      400: { description: "Invalid setup or missing host consent" },
      404: { description: "Local agent setup is not enabled" },
      409: { description: "Agent has active work or setup is in progress" },
      503: { description: "Local server control is unavailable" },
    },
    handler: async (req, res, next) => {
      try {
        res.json(await control(`agents/${req.params.workerType}`, req.body));
      } catch (error) {
        if (error instanceof ServerControlError) {
          res.status(error.status).json({ error: error.message });
        } else {
          next(error);
        }
      }
    },
  });
}
